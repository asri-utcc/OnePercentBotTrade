'use strict';

/**
 * Shared confirm/alert/password helper used by bots.html and bot-detail.html.
 *
 * Requires the page to have the #confirmActionModal markup (see bots.html for
 * the canonical block) BEFORE this script runs. The page's own script can then
 * use `window.LUX_CONFIRM.luxConfirm(opts)` etc.
 *
 * Variants: gold | success | warning | danger | info
 *
 * luxConfirm(opts) → Promise<string|null>
 *   returns the trimmed password ('' if user didn't type), or null on cancel.
 *
 * luxAlert(opts)    → Promise<null>   (same modal, no password, "รับทราบ" label)
 *
 * callBotWithPassword(method, url, data, actionLabel)
 *   tries the call first; on 403/503 it pops luxConfirm for the password and
 *   retries once. other errors are rethrown.
 *
 * bindPasswordToggles(root)   — wires the 👁/🙈 show-hide buttons for any
 *   .lux-pw-toggle elements within root.
 */

(function () {
  // ─── LuxConfirm — themed modal replacing native confirm()/prompt() ────
  function luxConfirm(opts) {
    return new Promise((resolve) => {
      const {
        variant = 'gold',
        icon = '⚠️',
        title = 'ยืนยันการทำรายการ',
        sub = 'กรุณาตรวจสอบรายละเอียดก่อนดำเนินการ',
        message = '',
        target = null,        // { name, symbol, timeframe } | null
        requirePassword = true,
        dangerNote = null,    // string | null — shows the danger callout
        confirmGlyph = '✓',
        confirmLabel = 'ยืนยัน',
      } = opts || {};

      const modalEl = document.getElementById('confirmActionModal');
      if (!modalEl) {
        // Fallback if markup missing — degrade gracefully to native confirm.
        // eslint-disable-next-line no-alert
        const ok = window.confirm((message || sub) + (requirePassword ? ' (กรุณาตอบ OK แล้วใส่รหัสที่ป้อนอัตโนมัติ)' : ''));
        return resolve(ok ? '' : null);
      }

      const header = document.getElementById('cam-header');
      header.classList.remove('is-gold', 'is-success', 'is-warning', 'is-danger');
      header.classList.add(`is-${variant}`);

      document.getElementById('cam-icon').textContent = icon;
      document.getElementById('cam-title').textContent = title;
      document.getElementById('cam-sub').textContent = sub;
      document.getElementById('cam-message').textContent = message || sub;

      const targetEl = document.getElementById('cam-target');
      if (target) {
        targetEl.hidden = false;
        document.getElementById('cam-target-name').textContent = target.name || '—';
        document.getElementById('cam-target-symbol').textContent = target.symbol || '—';
        document.getElementById('cam-target-tf').textContent = target.timeframe || '—';
      } else {
        targetEl.hidden = true;
      }

      const dangerEl = document.getElementById('cam-danger-note');
      if (dangerNote) {
        dangerEl.hidden = false;
        document.getElementById('cam-danger-text').textContent = dangerNote;
      } else {
        dangerEl.hidden = true;
      }

      const pwBlock = document.getElementById('cam-pw-block');
      const pwInput = document.getElementById('cam-password');
      pwBlock.style.display = requirePassword ? '' : 'none';
      pwInput.value = '';

      const errorEl = document.getElementById('cam-error');
      errorEl.hidden = true;
      errorEl.textContent = '';

      const confirmBtn = document.getElementById('cam-confirm');
      confirmBtn.classList.remove('is-gold', 'is-success', 'is-warning', 'is-danger');
      confirmBtn.classList.add(`is-${variant}`);
      confirmBtn.classList.remove('is-loading');
      confirmBtn.disabled = false;
      document.getElementById('cam-confirm-glyph').textContent = confirmGlyph;
      document.getElementById('cam-confirm-label').textContent = confirmLabel;

      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      const cleanup = () => {
        confirmBtn.onclick = null;
        document.getElementById('cam-cancel').onclick = null;
        document.getElementById('cam-close').onclick = null;
        modalEl.removeEventListener('hidden.bs.modal', onHidden);
      };
      const onHidden = () => { cleanup(); resolve(null); };

      const finish = (val) => {
        cleanup();
        modal.hide();
        resolve(val);
      };

      confirmBtn.onclick = () => {
        confirmBtn.classList.add('is-loading');
        confirmBtn.disabled = true;
        const pw = requirePassword ? (pwInput.value || '') : '';
        // small delay so the spinner is visible (UX feedback even on instant resolve)
        setTimeout(() => finish(pw), 120);
      };
      document.getElementById('cam-cancel').onclick = () => finish(null);
      document.getElementById('cam-close').onclick = () => finish(null);
      modalEl.addEventListener('hidden.bs.modal', onHidden);

      modal.show();

      // Focus password field (or confirm button) after animation starts
      setTimeout(() => {
        if (requirePassword) pwInput.focus();
        else confirmBtn.focus();
      }, 250);

      // Submit on Enter / Escape inside password field
      pwInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          confirmBtn.click();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          document.getElementById('cam-cancel').click();
        }
      };

      // Expose a way to show an error after server reject (used by callBotWithPassword)
      confirmBtn._showError = (msg) => {
        errorEl.hidden = false;
        errorEl.textContent = msg;
        confirmBtn.classList.remove('is-loading');
        confirmBtn.disabled = false;
        pwInput.focus();
        pwInput.select();
      };
    });
  }

  // Helper: show a quick alert inside the modal (when the action result is a synchronous error)
  function luxAlert(opts) {
    return luxConfirm({
      variant: opts.variant || 'warning',
      icon: opts.icon || '⚠️',
      title: opts.title || 'แจ้งเตือน',
      sub: opts.sub || '',
      message: opts.message || '',
      requirePassword: false,
      confirmLabel: 'รับทราบ',
      confirmGlyph: '✓',
      dangerNote: opts.dangerNote || null,
    });
  }

  // Password show/hide eye — bound for any field with [data-target]
  function bindPasswordToggles(root = document) {
    root.querySelectorAll('.lux-pw-toggle').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        if (!input) return;
        const isPw = input.type === 'password';
        input.type = isPw ? 'text' : 'password';
        btn.textContent = isPw ? '🙈' : '👁';
        btn.setAttribute('aria-label', isPw ? 'ซ่อนรหัส' : 'แสดงรหัส');
      });
    });
  }

  // ─── callBotWithPassword — tries the action once, then prompts via themed modal on 403/503 ────
  // - First try uses any password already supplied.
  // - On 403/503 it pops the confirm modal so user can re-enter the password, then retries.
  // - `customizePrompt` lets callers override title/icon/variant based on the URL/verb
  //   (e.g. force-close should use variant='danger', icon='🛑').
  async function callBotWithPassword(method, url, data, actionLabel, customizePrompt) {
    const basePayload = { ...(data || {}) };
    const tryOnce = () => (
      method === 'DELETE'
        ? API.del(url, basePayload)
        : method === 'PUT'
          ? API.put(url, basePayload)
          : API.post(url, basePayload)
    );
    try {
      return await tryOnce();
    } catch (err) {
      if (!err || (err.status !== 403 && err.status !== 503)) throw err;

      const lower = url.toLowerCase();
      let variant = 'warning';
      let icon = '🔒';
      let title = 'ต้องใส่รหัสยืนยัน';
      let sub = `เซิร์ฟเวอร์ขอรหัสยืนยันการทำรายการ${actionLabel || ''}`;
      if (lower.includes('/enable'))      { variant = 'success'; icon = '▶️'; title = 'ยืนยันการเปิดบอท'; }
      else if (lower.includes('/disable')){ variant = 'warning'; icon = '⏸';  title = 'ยืนยันการหยุดบอท'; }
      else if (/\/force-close(\/|\?|$)/.test(lower)) {
        variant = 'danger'; icon = '🛑'; title = 'ยืนยันการบังคับปิด';
        sub = actionLabel ? `เซิร์ฟเวอร์ขอรหัสยืนยัน — ${actionLabel}` : 'เซิร์ฟเวอร์ขอรหัสยืนยัน — บังคับปิด position';
      }
      else if (lower.endsWith('/api/bots'))        { variant = 'gold';    icon = '✨'; title = 'ยืนยันการสร้างบอท'; }
      else if (/\/api\/bots\/[^/]+$/.test(lower) && method === 'DELETE') { /* handled in deleteBot */ }

      const promptOpts = { variant, icon, title, sub, message: 'กรุณาใส่รหัส BOT_ACTION_PASSWORD เพื่อดำเนินการต่อ', requirePassword: true, confirmLabel: 'ยืนยันอีกครั้ง', confirmGlyph: '✓' };
      if (typeof customizePrompt === 'function') customizePrompt(promptOpts);

      const pw = await luxConfirm(promptOpts);
      if (pw === null) throw new Error('ยกเลิก (ไม่ได้ใส่รหัส)');
      const retryPayload = { ...basePayload, password: pw };
      const tryAgain = () => (
        method === 'DELETE'
          ? API.del(url, retryPayload)
          : method === 'PUT'
            ? API.put(url, retryPayload)
            : API.post(url, retryPayload)
      );
      return await tryAgain();
    }
  }

  window.LUX_CONFIRM = {
    luxConfirm,
    luxAlert,
    bindPasswordToggles,
    callBotWithPassword,
  };

  // Backwards-compat aliases (legacy bots.js still references bare names).
  // New code should call window.LUX_CONFIRM.* explicitly.
  window.luxConfirm = luxConfirm;
  window.luxAlert = luxAlert;
  window.bindPasswordToggles = bindPasswordToggles;
  window.callBotWithPassword = callBotWithPassword;
})();
