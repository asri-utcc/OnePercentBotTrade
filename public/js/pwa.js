'use strict';

// ── Service Worker Registration ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        // Check for updates
        reg.onupdatefound = () => {
          const installingWorker = reg.installing;
          if (installingWorker) {
            installingWorker.onstatechange = () => {
              if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                console.log('[PWA] New version available.');
              }
            };
          }
        };
      })
      .catch((err) => {
        console.warn('[PWA] Service Worker registration failed:', err);
      });
  });
}

// ── PWA Install Prompt Management ───────────────────────────────────────────
let deferredPrompt = null;

function wireInstallButtons() {
  const btns = document.querySelectorAll('#btn-pwa-install, .pwa-install-btn');
  if (!btns.length || !deferredPrompt) return;

  btns.forEach((btn) => {
    btn.style.display = 'inline-flex';
    btn.onclick = async (e) => {
      e.preventDefault();
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice && choice.outcome === 'accepted') {
        btns.forEach((b) => (b.style.display = 'none'));
      }
      deferredPrompt = null;
      window.deferredPrompt = null;
    };
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  window.deferredPrompt = e;
  window.dispatchEvent(new CustomEvent('pwa:installable', { detail: { prompt: e } }));
  wireInstallButtons();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  window.deferredPrompt = null;
  const btns = document.querySelectorAll('#btn-pwa-install, .pwa-install-btn');
  btns.forEach((b) => (b.style.display = 'none'));
});

// Re-check buttons when DOM or Nav partial loads
document.addEventListener('DOMContentLoaded', wireInstallButtons);
window.addEventListener('pwa:check-buttons', wireInstallButtons);
