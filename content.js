/* ==========================================================================
   Noon Pulse | رادار نون  —  content.js
   by Ayman Stack
   One script, two roles (decided by hostname):
     A) *.noon.com            -> collector + floating glass badge
     B) localhost / file:///  -> postMessage bridge to dashboard.html
   ========================================================================== */
(() => {
  'use strict';
  if (window.__noonPulseLoaded) return;
  window.__noonPulseLoaded = true;

  const IS_NOON = /(^|\.)noon\.com$/i.test(location.hostname);

  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          const le = chrome.runtime.lastError;
          if (le) return reject(new Error(le.message));
          if (!r || r.ok === false) return reject(new Error((r && r.error) || 'no response'));
          resolve(r);
        });
      } catch (e) {
        reject(e); // e.g. "Extension context invalidated" after a reload
      }
    });
  }

  if (IS_NOON) initCollector();
  else initBridge();

  /* ======================================================================
     A) Collector + badge
     ====================================================================== */
  function initCollector() {
    const initialPath = location.pathname;
    const POLL_MS = 5 * 60e3;
    let lastHref = location.href;
    let lastCaptureAt = 0;
    let host = null;
    let ui = {};
    const state = { product: null, collapsed: false, busy: false, error: null };

    const isProductPage = () => /\/p\/?$/.test(location.pathname);

    function h(tag, attrs, ...kids) {
      const el = document.createElement(tag);
      for (const k in attrs || {}) {
        if (k === 'class') el.className = attrs[k];
        else el.setAttribute(k, attrs[k]);
      }
      kids.forEach((c) => el.append(c));
      return el;
    }

    /* ---------- reading the page ---------- */
    function domPayload() {
      const parts = [];
      const nd = document.getElementById('__NEXT_DATA__');
      if (nd) parts.push(nd.outerHTML);
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => parts.push(s.outerHTML));
      const og = document.querySelector('meta[property="og:title"]');
      if (og) parts.push(og.outerHTML);
      return parts.join('\n');
    }

    async function fetchPageHtml() {
      const r = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }

    async function capture(forceFetch) {
      if (!isProductPage() || state.busy) return;
      state.busy = true;
      render();
      try {
        // The DOM copy of __NEXT_DATA__ is only valid for the first (hard) page load.
        // After SPA navigation or for fresh stock readings we re-fetch the HTML.
        let html;
        const domValid = !forceFetch && location.pathname === initialPath && document.getElementById('__NEXT_DATA__');
        html = domValid ? domPayload() : await fetchPageHtml();
        let res = await send({ type: 'PULSE_PAGE_SNAPSHOT', url: location.href, html: html });
        if (!res.product && domValid) {
          res = await send({ type: 'PULSE_PAGE_SNAPSHOT', url: location.href, html: await fetchPageHtml() });
        }
        state.product = res.product || null;
        state.error = res.product ? null : 'تعذّر قراءة بيانات المنتج من هذه الصفحة';
        lastCaptureAt = Date.now();
      } catch (e) {
        state.error = 'تعذّر الاتصال: ' + (e && e.message ? e.message : e);
      } finally {
        state.busy = false;
        render();
      }
    }

    /* ---------- badge ---------- */
    const CSS = `
      :host{all:initial}
      *{box-sizing:border-box;font-family:'Cairo','Segoe UI',Tahoma,sans-serif}
      .card{width:272px;direction:rtl;color:#e2e8f0;border-radius:18px;overflow:hidden;
        background:linear-gradient(160deg,rgba(18,24,40,.78),rgba(9,13,22,.82));
        border:1px solid rgba(255,255,255,.14);
        backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
        box-shadow:0 12px 40px rgba(0,0,0,.45),0 0 0 1px rgba(0,245,212,.12),0 0 28px rgba(168,85,247,.18)}
      .head{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;
        background:linear-gradient(90deg,rgba(0,245,212,.14),rgba(168,85,247,.16))}
      .dot{width:8px;height:8px;border-radius:50%;background:#00f5d4;box-shadow:0 0 10px #00f5d4}
      .dot.busy{animation:p 1s infinite}
      @keyframes p{50%{opacity:.25}}
      .brand{font-weight:800;font-size:13px;letter-spacing:.2px}
      .sub{font-size:11px;color:#94a3b8;margin-inline-start:auto}
      .tg{color:#94a3b8;font-size:16px;line-height:1}
      .body{padding:12px;display:flex;flex-direction:column;gap:10px}
      .collapsed .body{display:none}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .cell{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:8px 10px}
      .lbl{display:block;font-size:10.5px;color:#94a3b8;margin-bottom:2px}
      .val{font-size:20px;font-weight:800;color:#00f5d4}
      .val.low{color:#ff4d6d;text-shadow:0 0 12px rgba(255,77,109,.55)}
      .val.sold{color:#a855f7}
      .row{display:flex;justify-content:space-between;gap:8px;font-size:12px;align-items:center}
      .seller{color:#e2e8f0;font-weight:700;text-align:left;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .meta{font-size:11px;color:#94a3b8}
      .btn{all:unset;box-sizing:border-box;text-align:center;cursor:pointer;font-weight:800;font-size:12.5px;
        padding:9px 12px;border-radius:12px;color:#06121a;background:linear-gradient(90deg,#00f5d4,#a855f7);
        transition:transform .12s,filter .12s}
      .btn:hover{filter:brightness(1.1);transform:translateY(-1px)}
      .btn.on{background:rgba(0,245,212,.12);color:#00f5d4;border:1px solid rgba(0,245,212,.4)}
      .btn[aria-disabled=true]{opacity:.5;cursor:not-allowed;transform:none}
      .err{font-size:11px;color:#fbbf24;line-height:1.5}
    `;

    function buildBadge() {
      host = h('div', { id: 'noon-pulse-badge' });
      host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';
      const root = host.attachShadow({ mode: 'open' });
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
      } catch (e) {
        const st = document.createElement('style');
        st.textContent = CSS;
        root.append(st);
      }

      ui.card = h('div', { class: 'card', dir: 'rtl' });
      ui.dot = h('span', { class: 'dot' });
      ui.tg = h('span', { class: 'tg' }, '–');
      const head = h('div', { class: 'head' }, ui.dot, h('span', { class: 'brand' }, 'Noon Pulse'),
        h('span', { class: 'sub' }, 'رادار نون'), ui.tg);
      head.addEventListener('click', () => {
        state.collapsed = !state.collapsed;
        render();
      });

      ui.stock = h('span', { class: 'val' }, '—');
      ui.sold = h('span', { class: 'val sold' }, '0');
      const grid = h('div', { class: 'grid' },
        h('div', { class: 'cell' }, h('span', { class: 'lbl' }, 'المخزون الحالي'), ui.stock),
        h('div', { class: 'cell' }, h('span', { class: 'lbl' }, 'المبيعات المرصودة'), ui.sold));

      ui.seller = h('span', { class: 'seller' }, '—');
      const sellerRow = h('div', { class: 'row' }, h('span', { class: 'meta' }, 'البائع'), ui.seller);

      ui.vel = h('span', {}, '');
      ui.upd = h('span', {}, '');
      const metaRow = h('div', { class: 'row meta' }, ui.vel, ui.upd);

      ui.btn = h('button', { class: 'btn' }, 'Add to Auto-Radar');
      ui.btn.addEventListener('click', onRadarClick);
      ui.err = h('div', { class: 'err' });

      ui.card.append(head, h('div', { class: 'body' }, grid, sellerRow, metaRow, ui.btn, ui.err));
      root.append(ui.card);
      document.documentElement.append(host);
    }

    async function onRadarClick() {
      const p = state.product;
      if (!p || state.busy) return;
      try {
        const res = await send({ type: 'PULSE_TOGGLE_RADAR', sku: p.sku, on: !p.radar });
        if (res.result && res.result.product) state.product = res.result.product;
        else if (res.product) state.product = res.product;
        state.error = null;
      } catch (e) {
        state.error = 'تعذّر تحديث الرادار: ' + (e && e.message ? e.message : e);
      }
      render();
    }

    function ago(t) {
      if (!t) return '';
      const m = Math.round((Date.now() - t) / 60000);
      if (m < 1) return 'الآن';
      if (m < 60) return 'منذ ' + m + ' د';
      return 'منذ ' + Math.round(m / 60) + ' س';
    }

    function render() {
      if (!host || !document.documentElement.contains(host)) {
        if (host) host.remove();
        buildBadge();
      }
      host.style.display = isProductPage() ? 'block' : 'none';
      const p = state.product;
      ui.card.classList.toggle('collapsed', state.collapsed);
      ui.tg.textContent = state.collapsed ? '+' : '–';
      ui.dot.classList.toggle('busy', state.busy);

      if (p) {
        ui.stock.textContent = p.stock != null ? String(p.stock) : 'غير متاح';
        ui.stock.classList.toggle('low', p.stock != null && p.stock < 5);
        ui.sold.textContent = String(p.totalSold || 0);
        ui.seller.textContent = p.seller || '—';
        ui.seller.title = p.seller || '';
        ui.vel.textContent = '⚡ ' + (p.velocityPerHour || 0) + ' وحدة/ساعة';
        ui.upd.textContent = ago(p.lastSeen);
        ui.btn.textContent = p.radar ? '✓ في الرادار (إزالة)' : 'Add to Auto-Radar';
        ui.btn.classList.toggle('on', !!p.radar);
        ui.btn.setAttribute('aria-disabled', 'false');
      } else {
        ui.stock.textContent = '—';
        ui.stock.classList.remove('low');
        ui.sold.textContent = '0';
        ui.seller.textContent = '—';
        ui.vel.textContent = state.busy ? 'جارٍ القراءة…' : '';
        ui.upd.textContent = '';
        ui.btn.textContent = 'Add to Auto-Radar';
        ui.btn.classList.remove('on');
        ui.btn.setAttribute('aria-disabled', 'true');
      }
      ui.err.textContent = state.error || '';
    }

    /* ---------- lifecycle ---------- */
    render();
    if (isProductPage()) capture(false);

    // Noon is a SPA: detect URL changes without a reload.
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        state.product = null;
        state.error = null;
        render();
        if (isProductPage()) setTimeout(() => capture(true), 900);
      } else if (host && !document.documentElement.contains(host)) {
        render();
      }
    }, 1000);

    // Fresh stock readings while the tab stays open.
    setInterval(() => {
      if (document.visibilityState === 'visible' && isProductPage()) capture(true);
    }, POLL_MS);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && isProductPage() && Date.now() - lastCaptureAt > 2 * 60e3) {
        capture(true);
      }
    });
  }

  /* ======================================================================
     B) Dashboard bridge
     Only answers pages that opt in with
       <meta name="noon-pulse-dashboard" content="1">
     so random localhost pages cannot read or wipe your data.
     ====================================================================== */
  function initBridge() {
    const isDashboard = () => !!document.querySelector('meta[name="noon-pulse-dashboard"]');
    const targetOrigin = () => (location.protocol === 'file:' || location.origin === 'null' ? '*' : location.origin);
    const reply = (m) => window.postMessage(m, targetOrigin());
    const version = () => {
      try {
        return chrome.runtime.getManifest().version;
      } catch (e) {
        return null;
      }
    };

    window.addEventListener('message', async (ev) => {
      if (ev.source !== window) return;
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.type !== 'PULSE_PING' && m.type !== 'PULSE_SYNC_REQUEST' && m.type !== 'PULSE_COMMAND') return;
      if (!isDashboard()) return;

      try {
        if (m.type === 'PULSE_PING') {
          reply({ type: 'PULSE_PONG', version: version() });
        } else if (m.type === 'PULSE_SYNC_REQUEST') {
          const r = await send({ type: 'PULSE_GET_ALL' });
          reply({ type: 'PULSE_SYNC_RESPONSE', payload: r.payload, reqId: m.reqId });
        } else {
          const r = await send({ type: 'PULSE_COMMAND', command: m.command, args: m.args || {} });
          reply({ type: 'PULSE_COMMAND_RESULT', reqId: m.reqId, ok: true, result: r.result });
        }
      } catch (e) {
        const error = String((e && e.message) || e);
        if (m.type === 'PULSE_COMMAND') reply({ type: 'PULSE_COMMAND_RESULT', reqId: m.reqId, ok: false, error: error });
        else if (m.type === 'PULSE_SYNC_REQUEST') reply({ type: 'PULSE_SYNC_RESPONSE', reqId: m.reqId, error: error });
      }
    });

    // Announce ourselves once the page exists (the dashboard also pings).
    document.addEventListener('DOMContentLoaded', () => {
      if (isDashboard()) reply({ type: 'PULSE_PONG', version: version() });
    });

    // Push live updates whenever the extension writes new data.
    let timer = null;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.pulse_db || !isDashboard()) return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            const r = await send({ type: 'PULSE_GET_ALL' });
            reply({ type: 'PULSE_SYNC_RESPONSE', payload: r.payload, push: true });
          } catch (e) {
            /* extension reloaded; ignore */
          }
        }, 400);
      });
    } catch (e) {
      /* ignore */
    }
  }
})();
