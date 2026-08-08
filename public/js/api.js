'use strict';

async function throwApiError(r) {
  const body = await r.json().catch(() => ({ error: r.statusText }));
  const err = new Error(body.error || `HTTP ${r.status}`);
  err.status = r.status;
  err.body = body;
  throw err;
}

const API = {
  async get(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) await throwApiError(r);
    return r.json();
  },
  async post(url, body, opts) {
    // FIX-2026-08-07: รองรับ opts (เช่น custom headers) — ก่อนหน้านี้ argument ที่ 3 ถูก ignore เงียบ ๆ
    //   - merge headers กับ default Content-Type
    //   - ดู unlock-cbv2 incident: เคยส่ง header แต่ API ไม่ได้ apply → backend 403
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      (opts && opts.headers) || {}
    );
    const r = await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) await throwApiError(r);
    return r.json();
  },
  async put(url, body, opts) {
    // FIX-2026-08-07: รองรับ opts (เช่น custom headers) — symmetric กับ post()
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      (opts && opts.headers) || {}
    );
    const r = await fetch(url, {
      method: 'PUT',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) await throwApiError(r);
    return r.json();
  },
  async del(url, body, opts) {
    const headers = Object.assign(
      {},
      (opts && opts.headers) || {}
    );
    const init = { method: 'DELETE', credentials: 'same-origin', headers };
    if (body) {
      if (!headers['Content-Type'] && !headers['content-type']) {
        init.headers['Content-Type'] = 'application/json';
      }
      init.body = JSON.stringify(body);
    }
    const r = await fetch(url, init);
    if (!r.ok) await throwApiError(r);
    return r.json();
  },
};

window.API = API;