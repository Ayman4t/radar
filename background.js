/* ==========================================================================
   Noon Pulse | رادار نون  —  background.js (Manifest V3 service worker)
   by Ayman Stack
   Responsibilities:
     1. Parse product snapshots sent by content.js (single parsing path)
     2. Delta & velocity engine (sold units, velocity/hr, peak demand window)
     3. Auto-tracker: chrome.alarms every 30 min -> fetch() radar URLs silently
     4. Low-stock notifications (< 5 units)
     5. Commands relayed from the dashboard bridge
     6. Optional Supabase REST sync
   ========================================================================== */
'use strict';

const DB_KEY = 'pulse_db';
const SETTINGS_KEY = 'pulse_settings';
const META_KEY = 'pulse_meta';
const ALARM_NAME = 'pulse-auto-refresh';

const LOW_STOCK = 5;
const VELOCITY_WINDOW_MS = 6 * 3600e3;   // "short-term" velocity window
const PEAK_WINDOW_MS = 3600e3;           // sliding window used for the peak
const MAX_HISTORY = 600;
const MAX_EVENTS = 400;
const ALERT_COOLDOWN_MS = 6 * 3600e3;
const HISTORY_HEARTBEAT_MS = 20 * 60e3;  // keep the time axis alive when nothing changes
const RUN_BUDGET_MS = 4 * 60e3;          // stay well inside the SW 5-min limit

const DEFAULT_SETTINGS = {
  supabaseEnabled: false,
  supabaseUrl: '',
  supabaseKey: '',
  supabaseTable: 'pulse_products',
  dashboardUrl: ''
};

/* ------------------------------ utilities -------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round(n * 100) / 100;

// Serialise every read-modify-write on the DB so tab snapshots, alarms and
// dashboard commands can never overwrite each other.
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

async function getDB() {
  const o = await chrome.storage.local.get(DB_KEY);
  return o[DB_KEY] || {};
}
function saveDB(db) {
  return chrome.storage.local.set({ [DB_KEY]: db });
}
async function getSettings() {
  const o = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(o[SETTINGS_KEY] || {}) };
}
async function getMeta() {
  const o = await chrome.storage.local.get(META_KEY);
  return o[META_KEY] || {};
}
async function setMeta(patch) {
  const m = await getMeta();
  await chrome.storage.local.set({ [META_KEY]: { ...m, ...patch } });
}
async function getAll() {
  const o = await chrome.storage.local.get([DB_KEY, SETTINGS_KEY, META_KEY]);
  return {
    pulse_db: o[DB_KEY] || {},
    pulse_settings: { ...DEFAULT_SETTINGS, ...(o[SETTINGS_KEY] || {}) },
    pulse_meta: o[META_KEY] || {}
  };
}

function num(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function pick(o, keys) {
  if (!o || typeof o !== 'object') return null;
  for (const k of keys) {
    if (o[k] != null && o[k] !== '') return o[k];
  }
  return null;
}
function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).toUpperCase();
}
function skuFromUrl(url) {
  const m = /\/([NZ][0-9A-Z]{6,})\/p(?:[\/?#]|$)/i.exec(url || '');
  return m ? m[1].toUpperCase() : null;
}
function isNoonProductUrl(u) {
  return /(^|\.)noon\.com$/i.test(u.hostname) && /\/p\/?$/.test(u.pathname);
}

/* ------------------------- product data extraction ------------------------ */
/* Noon is a Next.js app, so everything we need lives in #__NEXT_DATA__.
   The exact JSON shape changes over time, so instead of hard-coding one path
   we locate the product node structurally and try several known key names. */

const SALE_KEYS = ['sale_price', 'salePrice', 'special_price', 'offer_price', 'price_now', 'current_price'];
const REG_KEYS = ['price', 'regular_price', 'list_price', 'was_price', 'original_price', 'price_was'];
const STOCK_KEYS = ['stock', 'stock_net', 'stock_gross', 'available_quantity', 'available_stock', 'quantity', 'qty', 'inventory'];
const MAX_KEYS = ['max_order_quantity', 'max_quantity', 'max_qty', 'max_order_qty', 'order_limit', 'max_per_order', 'maxOrderQuantity'];
const SELLER_KEYS = ['store_name', 'partner_name', 'seller_name', 'seller', 'store', 'partner', 'vendor'];

function findProductNode(root, wantSku) {
  let best = null;
  let bestScore = -1;
  const seen = new WeakSet();
  const stack = [root];
  let guard = 0;
  while (stack.length && guard++ < 80000) {
    const o = stack.pop();
    if (!o || typeof o !== 'object' || seen.has(o)) continue;
    seen.add(o);
    if (!Array.isArray(o) && typeof o.sku === 'string' && (o.name || o.title || o.product_title)) {
      let s = 0;
      if (Array.isArray(o.variants)) s += 3;
      if (o.offers || o.offer) s += 2;
      if (o.brand) s += 1;
      if (o.image_keys || o.image_key || o.images) s += 1;
      if (wantSku && o.sku.toUpperCase() === wantSku) s += 5;
      if (s > bestScore) {
        best = o;
        bestScore = s;
      }
    }
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return best;
}

function collectOffers(prod, wantSku) {
  const out = [];
  const add = (o, sku) => {
    if (Array.isArray(o)) o.forEach((x) => add(x, sku));
    else if (o && typeof o === 'object') out.push({ offer: o, sku });
  };
  if (Array.isArray(prod.variants)) {
    const vs = [...prod.variants].sort(
      (a, b) =>
        ((b && b.sku || '').toUpperCase() === wantSku) - ((a && a.sku || '').toUpperCase() === wantSku)
    );
    vs.forEach((v) => v && add(v.offers || v.offer, v.sku));
  }
  add(prod.offers || prod.offer, prod.sku);
  if (!out.length) out.push({ offer: prod, sku: prod.sku });
  return out;
}

function nameOf(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') return nameOf(v.name || v.title || v.store_name || v.display_name);
  return null;
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch (e) {
    return url;
  }
}

function extractFromNext(next, url) {
  const wantSku = skuFromUrl(url);
  const prod = findProductNode(next, wantSku);
  if (!prod) return null;

  const cands = collectOffers(prod, wantSku);
  const chosen =
    cands.find((c) => num(pick(c.offer, SALE_KEYS)) != null || num(pick(c.offer, REG_KEYS)) != null) || cands[0];
  const offer = chosen.offer;

  let sale = num(pick(offer, SALE_KEYS));
  let reg = num(pick(offer, REG_KEYS));
  if (sale != null && reg != null && sale > reg) [sale, reg] = [reg, sale];
  if (sale == null) sale = reg;
  if (reg == null) reg = sale;

  const r = prod.product_rating || prod.rating || prod.aggregateRating || null;
  let rating = null;
  let reviews = null;
  if (r && typeof r === 'object') {
    rating = num(pick(r, ['value', 'rating', 'ratingValue', 'average', 'avg']));
    reviews = num(pick(r, ['count', 'reviewCount', 'total', 'reviews_count', 'ratings_count']));
  } else {
    rating = num(r);
  }
  if (reviews == null) reviews = num(pick(prod, ['review_count', 'reviews_count', 'rating_count', 'reviewCount']));

  return {
    sku: wantSku || (chosen.sku && String(chosen.sku).toUpperCase()) || String(prod.sku).toUpperCase(),
    title: nameOf(pick(prod, ['name', 'title', 'product_title'])),
    price: sale,
    salePrice: sale,
    regularPrice: reg,
    stock: num(pick(offer, STOCK_KEYS)),
    maxOrder: num(pick(offer, MAX_KEYS)),
    seller: nameOf(pick(offer, SELLER_KEYS)) || nameOf(pick(prod, SELLER_KEYS)),
    rating: rating,
    reviews: reviews,
    url: cleanUrl(url)
  };
}

function extractFromLd(lds, url) {
  const nodes = [];
  const flat = (x) => {
    if (!x) return;
    if (Array.isArray(x)) return x.forEach(flat);
    if (typeof x === 'object') {
      nodes.push(x);
      if (x['@graph']) flat(x['@graph']);
    }
  };
  lds.forEach(flat);
  const prod = nodes.find((n) => {
    const t = n['@type'];
    return t === 'Product' || (Array.isArray(t) && t.includes('Product'));
  });
  if (!prod) return null;
  const offers = Array.isArray(prod.offers) ? prod.offers : prod.offers ? [prod.offers] : [];
  const offer = offers.find((o) => num(o.price != null ? o.price : o.lowPrice) != null) || offers[0] || {};
  const price = num(offer.price != null ? offer.price : offer.lowPrice);
  const ar = prod.aggregateRating || {};
  return {
    sku: skuFromUrl(url) || (prod.sku ? String(prod.sku).toUpperCase() : null),
    title: nameOf(prod.name),
    price: price,
    salePrice: price,
    regularPrice: price,
    stock: null,
    maxOrder: null,
    seller: nameOf(offer.seller),
    rating: num(ar.ratingValue),
    reviews: num(ar.reviewCount != null ? ar.reviewCount : ar.ratingCount),
    url: cleanUrl(url)
  };
}

function buildSnapshot(next, lds, url, ogTitle) {
  let snap = next ? extractFromNext(next, url) : null;
  const ld = extractFromLd(lds, url);
  if (!snap && !ld) return null;
  if (!snap) {
    snap = ld;
  } else if (ld) {
    for (const k of ['title', 'seller', 'rating', 'reviews', 'price', 'salePrice', 'regularPrice']) {
      if (snap[k] == null && ld[k] != null) snap[k] = ld[k];
    }
  }
  if (!snap.title && ogTitle) snap.title = ogTitle;
  if (!snap.sku) return null;
  snap.currency = 'EGP';
  return snap;
}

// Works for both a full HTML document (background fetch) and the concatenated
// <script>/<meta> fragments that content.js collects from the live DOM.
function parseHtml(html, url) {
  if (!html || typeof html !== 'string') return null;
  let next = null;
  const lds = [];
  const m = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (m) {
    try {
      next = JSON.parse(m[1]);
    } catch (e) {
      next = null;
    }
  }
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let x;
  while ((x = re.exec(html))) {
    try {
      lds.push(JSON.parse(x[1]));
    } catch (e) {
      /* ignore malformed block */
    }
  }
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(html);
  return buildSnapshot(next, lds, url, og ? decodeEntities(og[1]) : null);
}

async function fetchSnapshot(url) {
  const res = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    cache: 'no-store',
    headers: { Accept: 'text/html,application/xhtml+xml' }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  const snap = parseHtml(html, url);
  if (!snap) throw new Error('لم يتم العثور على بيانات المنتج (قد تكون الصفحة محجوبة أو تغيّر شكلها)');
  return snap;
}

/* ------------------------ delta & velocity engine ------------------------- */

function newProduct(snap, now) {
  return {
    sku: snap.sku,
    title: snap.title || snap.sku,
    url: snap.url || null,
    seller: snap.seller || null,
    rating: snap.rating != null ? snap.rating : null,
    reviews: snap.reviews != null ? snap.reviews : null,
    currency: 'EGP',
    price: snap.price != null ? snap.price : null,
    salePrice: snap.salePrice != null ? snap.salePrice : null,
    regularPrice: snap.regularPrice != null ? snap.regularPrice : null,
    stock: null,
    maxOrder: snap.maxOrder != null ? snap.maxOrder : null,
    stockSource: null,
    totalSold: 0,
    totalRevenue: 0,
    velocityPerHour: 0,
    peak: null,
    history: [],
    events: [],
    radar: false,
    firstSeen: now,
    lastSeen: now,
    lastChecked: now,
    lastStockTs: null,
    lastRestock: null,
    alertedAt: 0,
    lastError: null
  };
}

// Returns true when a low-stock alert should fire.
function applySnapshot(p, snap, now) {
  for (const k of ['title', 'url', 'seller', 'rating', 'reviews', 'maxOrder']) {
    if (snap[k] != null && snap[k] !== '') p[k] = snap[k];
  }
  if (snap.price != null) {
    p.price = snap.price;
    p.salePrice = snap.salePrice;
    p.regularPrice = snap.regularPrice;
  }

  // Effective stock = real quantity when exposed, otherwise the max-order limit.
  const stock = snap.stock != null ? snap.stock : snap.maxOrder != null ? snap.maxOrder : null;
  const source = snap.stock != null ? 'stock' : snap.maxOrder != null ? 'max_order' : null;

  // Never compare readings coming from two different fields.
  if (p.stockSource && source && p.stockSource !== source) {
    p.stock = null;
    p.lastStockTs = null;
  }
  if (source) p.stockSource = source;

  if (stock != null) {
    if (p.stock != null && p.lastStockTs && stock < p.stock) {
      const sold = p.stock - stock;
      const unit = p.price != null ? p.price : 0;
      p.totalSold += sold;
      p.totalRevenue = round2(p.totalRevenue + sold * unit);
      p.events.push({ t0: p.lastStockTs, t1: now, sold: sold, price: unit });
      if (p.events.length > MAX_EVENTS) p.events.splice(0, p.events.length - MAX_EVENTS);
    } else if (p.stock != null && stock > p.stock) {
      p.lastRestock = { t: now, added: stock - p.stock };
    }
    p.stock = stock;
    p.lastStockTs = now;
  }

  const last = p.history[p.history.length - 1];
  const changed = !last || last.stock !== p.stock || last.price !== p.price;
  if (changed || now - last.t >= HISTORY_HEARTBEAT_MS) {
    p.history.push({ t: now, stock: p.stock, price: p.price });
    if (p.history.length > MAX_HISTORY) p.history.splice(0, p.history.length - MAX_HISTORY);
  }

  p.lastSeen = now;
  p.lastChecked = now;

  let alert = false;
  if (p.stock != null && p.stock < LOW_STOCK) {
    if (!p.alertedAt || now - p.alertedAt > ALERT_COOLDOWN_MS) {
      p.alertedAt = now;
      alert = true;
    }
  } else if (p.stock != null) {
    p.alertedAt = 0;
  }
  return alert;
}

function computeVelocity(p, now) {
  const ws = now - VELOCITY_WINDOW_MS;
  let sold = 0;
  for (const e of p.events) {
    if (e.t1 < ws) continue;
    const dt = Math.max(e.t1 - e.t0, 1);
    const overlap = e.t1 - Math.max(e.t0, ws);
    sold += e.sold * Math.min(1, overlap / dt);
  }
  const hours = Math.max((now - Math.max(ws, p.firstSeen || now)) / 3.6e6, 0.25);
  return round2(sold / hours);
}

// Steepest drop: for every event, sum the sales inside the 1h window that ends
// at that event, and keep the window with the highest units/hour.
function computePeak(events) {
  let best = null;
  for (let i = 0; i < events.length; i++) {
    const end = events[i].t1;
    let sold = 0;
    let from = end;
    for (let j = i; j >= 0; j--) {
      const e = events[j];
      if (e.t1 <= end - PEAK_WINDOW_MS) break;
      sold += e.sold;
      if (e.t0 < from) from = e.t0;
    }
    const hours = Math.max((end - from) / 3.6e6, 0.25);
    const rate = sold / hours;
    if (!best || rate > best.rate || (rate === best.rate && sold > best.sold)) {
      best = { from: from, to: end, sold: sold, rate: round2(rate) };
    }
  }
  return best;
}

function computeMetrics(p, now) {
  p.velocityPerHour = computeVelocity(p, now);
  p.peak = computePeak(p.events);
}

/* ------------------------------ persistence ------------------------------ */

function commitSnapshot(snap, opts) {
  opts = opts || {};
  return locked(async () => {
    const db = await getDB();
    const now = Date.now();
    let p = db[snap.sku];
    if (!p) p = db[snap.sku] = newProduct(snap, now);
    const alert = applySnapshot(p, snap, now);
    if (opts.radar != null) p.radar = !!opts.radar;
    p.lastError = null;
    computeMetrics(p, now);
    await saveDB(db);
    return { product: p, alert: alert && p.radar };
  }).then(async (r) => {
    if (r.alert) await notifyLow(r.product);
    if (!opts.skipSupabase) pushSupabase([r.product]);
    return r.product;
  });
}

function markError(sku, err) {
  return locked(async () => {
    const db = await getDB();
    if (!db[sku]) return;
    db[sku].lastError = String((err && err.message) || err);
    db[sku].lastChecked = Date.now();
    await saveDB(db);
  });
}

function slugTitle(u) {
  const segs = u.pathname.split('/').filter(Boolean);
  const i = segs.findIndex((s) => /^[NZ][0-9A-Z]{6,}$/i.test(s));
  let raw = i > 0 ? segs[i - 1] : segs[segs.length - 1] || 'Noon product';
  try {
    raw = decodeURIComponent(raw);
  } catch (e) {
    /* keep raw */
  }
  return raw.replace(/-/g, ' ');
}

async function addUrlToRadar(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch (e) {
    throw new Error('رابط غير صالح');
  }
  if (!isNoonProductUrl(u)) throw new Error('الرابط يجب أن يكون صفحة منتج على noon.com (ينتهي بـ /p/)');
  u.hash = '';
  const url = u.toString();
  try {
    const snap = await fetchSnapshot(url);
    return await commitSnapshot(snap, { radar: true });
  } catch (e) {
    const sku = skuFromUrl(url) || 'URL_' + hashStr(url);
    return await locked(async () => {
      const db = await getDB();
      const now = Date.now();
      let p = db[sku];
      if (!p) {
        p = db[sku] = newProduct({ sku: sku, title: slugTitle(u), url: url }, now);
      }
      p.radar = true;
      p.url = url;
      p.lastError = String((e && e.message) || e);
      p.lastChecked = now;
      await saveDB(db);
      return p;
    });
  }
}

let refreshPromise = null;
function refreshAll(opts) {
  opts = opts || {};
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const db = await getDB();
    const list = Object.values(db)
      .filter((p) => p.url && (opts.sku ? p.sku === opts.sku : p.radar))
      .sort((a, b) => (a.lastChecked || 0) - (b.lastChecked || 0));
    const started = Date.now();
    const out = { checked: 0, failed: 0, total: list.length };
    const updated = [];
    for (const p of list) {
      if (Date.now() - started > RUN_BUDGET_MS) break;
      try {
        const snap = await fetchSnapshot(p.url);
        snap.sku = p.sku; // keep identity stable
        updated.push(await commitSnapshot(snap, { skipSupabase: true }));
        out.checked++;
      } catch (e) {
        out.failed++;
        await markError(p.sku, e);
      }
      await sleep(1000 + Math.random() * 1200);
    }
    await pushSupabase(updated);
    await setMeta({ lastRefresh: Date.now(), lastRefreshResult: out });
    return out;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

/* ------------------------------ notifications ----------------------------- */

let iconPromise = null;
function getIcon() {
  if (!iconPromise) {
    iconPromise = (async () => {
      const c = new OffscreenCanvas(128, 128);
      const g = c.getContext('2d');
      g.fillStyle = '#090d16';
      g.fillRect(0, 0, 128, 128);
      const grad = g.createLinearGradient(0, 0, 128, 128);
      grad.addColorStop(0, '#00f5d4');
      grad.addColorStop(1, '#a855f7');
      g.strokeStyle = grad;
      g.lineWidth = 9;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      [[12, 68], [38, 68], [52, 34], [70, 100], [84, 54], [94, 68], [116, 68]].forEach((pt, i) =>
        i ? g.lineTo(pt[0], pt[1]) : g.moveTo(pt[0], pt[1])
      );
      g.stroke();
      const blob = await c.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return 'data:image/png;base64,' + btoa(bin);
    })();
  }
  return iconPromise;
}

async function notifyLow(p) {
  try {
    const iconUrl = await getIcon();
    const out = p.stock === 0;
    chrome.notifications.create('pulse|' + p.sku + '|' + Date.now(), {
      type: 'basic',
      iconUrl: iconUrl,
      title: out ? '⛔ نفد المخزون | Noon Pulse' : '⚠️ مخزون منخفض | Noon Pulse',
      message: String(p.title || p.sku).slice(0, 90) + '\n' + (out ? 'نفد المخزون' : 'المتبقي: ' + p.stock + ' وحدة'),
      priority: 2
    });
  } catch (e) {
    console.warn('[Noon Pulse] notification failed', e);
  }
}

chrome.notifications.onClicked.addListener(async (id) => {
  const sku = id.split('|')[1];
  const db = await getDB();
  if (db[sku] && db[sku].url) chrome.tabs.create({ url: db[sku].url });
  chrome.notifications.clear(id);
});

/* ------------------------------ Supabase sync ----------------------------- */
/* Table (SQL editor):
   create table if not exists pulse_products (
     sku text primary key, data jsonb not null, updated_at timestamptz default now());
*/
async function pushSupabase(products) {
  try {
    const s = await getSettings();
    if (!s.supabaseEnabled || !s.supabaseUrl || !s.supabaseKey || !products.length) return;
    const base = s.supabaseUrl.replace(/\/+$/, '');
    const rows = products.map((p) => ({ sku: p.sku, data: p, updated_at: new Date().toISOString() }));
    const r = await fetch(
      base + '/rest/v1/' + encodeURIComponent(s.supabaseTable || 'pulse_products') + '?on_conflict=sku',
      {
        method: 'POST',
        headers: {
          apikey: s.supabaseKey,
          Authorization: 'Bearer ' + s.supabaseKey,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(rows)
      }
    );
    await setMeta({ lastSupabase: { ok: r.ok, status: r.status, at: Date.now() } });
  } catch (e) {
    await setMeta({ lastSupabase: { ok: false, error: String((e && e.message) || e), at: Date.now() } });
  }
}

/* -------------------------------- commands -------------------------------- */

async function runCommand(command, args) {
  args = args || {};
  switch (command) {
    case 'ADD_URL_TO_RADAR':
      return { product: await addUrlToRadar(args.url) };

    case 'DELETE_PRODUCT':
      await locked(async () => {
        const db = await getDB();
        delete db[args.sku];
        await saveDB(db);
      });
      return {};

    case 'CLEAR_DATA':
      await locked(() => saveDB({}));
      return {};

    case 'FORCE_REFRESH':
      return { refresh: await refreshAll({ sku: args.sku || null }) };

    case 'TOGGLE_RADAR':
      return {
        product: await locked(async () => {
          const db = await getDB();
          if (!db[args.sku]) throw new Error('المنتج غير موجود');
          db[args.sku].radar = !!args.on;
          await saveDB(db);
          return db[args.sku];
        })
      };

    case 'GET_SETTINGS':
      return { settings: await getSettings() };

    case 'SET_SETTINGS': {
      const incoming = args.settings || {};
      const cur = await getSettings();
      const next = { ...cur };
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (incoming[k] === undefined) continue;
        next[k] = typeof DEFAULT_SETTINGS[k] === 'boolean' ? !!incoming[k] : String(incoming[k]).trim();
      }
      if (next.supabaseEnabled && !/^https:\/\//i.test(next.supabaseUrl)) {
        throw new Error('رابط Supabase يجب أن يبدأ بـ https://');
      }
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      return { settings: next };
    }

    default:
      throw new Error('أمر غير معروف: ' + command);
  }
}

async function handleMessage(msg) {
  switch (msg && msg.type) {
    case 'PULSE_PAGE_SNAPSHOT': {
      const snap = parseHtml(msg.html, msg.url);
      if (!snap) return { product: null, reason: 'no-data' };
      return { product: await commitSnapshot(snap) };
    }
    case 'PULSE_TOGGLE_RADAR':
      return await runCommand('TOGGLE_RADAR', { sku: msg.sku, on: msg.on });
    case 'PULSE_GET_ALL':
      return { payload: await getAll() };
    case 'PULSE_COMMAND':
      return { result: await runCommand(msg.command, msg.args) };
    default:
      throw new Error('رسالة غير معروفة');
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // async response
});

/* --------------------------------- alarms --------------------------------- */

function ensureAlarm() {
  chrome.alarms.get(ALARM_NAME, (a) => {
    if (!a) chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 30 });
  });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM_NAME) refreshAll().catch((e) => console.warn('[Noon Pulse] refresh failed', e));
});

chrome.action.onClicked.addListener(async () => {
  const s = await getSettings();
  chrome.tabs.create({ url: s.dashboardUrl || 'https://www.noon.com/egypt-ar/' });
});
