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
  async post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) await throwApiError(r);
    return r.json();
  },
  async put(url, body) {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) await throwApiError(r);
    return r.json();
  },
  async del(url, body) {
    const opts = { method: 'DELETE', credentials: 'same-origin' };
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    if (!r.ok) await throwApiError(r);
    return r.json();
  },
};

window.API = API;