'use strict';

/**
 * FIX-2026-08-26 Phase 2c: Consent web server.
 *
 *   Tiny HTTP server (built-in http — no extra deps) that serves the consent
 *   page and accepts POST /consent/accept and POST /consent/decline.
 *
 *   Lifecycle:
 *     - start() opens the server; caller decides when to stop() (after decision
 *       or when bot is shutting down)
 *     - on accept: writes local file, pushes to admin, emits 'decision' event
 *       with decision='accepted', then stops the server
 *     - on decline: same but decision='declined'
 *     - the page is also accessible any time via /consent (settings flow)
 *
 *   Events:
 *     emitter emits 'decision' with { decision, source }
 */

const http = require('http');
const url = require('url');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const config = require('./config');
const adminConfig = require('../admin-monitor/config');
const storage = require('./storage');
const handlers = require('./handlers'); // FIX-2026-08-26 Phase 2c-v2: shared decision core
const { pageHtml } = require('./html');
const buildSections = require('./text');
const { getMachineId } = require('../admin-monitor/machineId');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'consent-web' }) : rootLogger;

/**
 * FIX-2026-08-26: auto-open default browser so user actually sees the consent page
 *   (was a silent gap — page was served but never displayed).
 *   Windows: `start "" <url>`; macOS: `open <url>`; Linux: `xdg-open <url>`.
 *   Failures are swallowed (user can navigate manually).
 */
function _autoOpenBrowser(url) {
  try {
    const platform = process.platform;
    let cmd, args;
    if (platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '""', url]; }
    else if (platform === 'darwin') { cmd = 'open'; args = [url]; }
    else { cmd = 'xdg-open'; args = [url]; }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, 'consent-web: auto-open browser failed');
    return false;
  }
}

class ConsentServer extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.bound = null; // { host, port }
    this.decidedAt = null; // when decision was made (to stop server)

    // FIX-2026-08-26 Phase 2c-v2: re-emit decisions from handlers.emitter so existing
    //   `web.once('decision', ...)` consumers (gateStartup, openSettingsPage) keep
    //   working even when the decision is made via the new Express routes on 6015.
    handlers.emitter.on('decision', (payload) => this.emit('decision', payload));
  }

  /**
   * Build and start the HTTP server. Resolves once it's listening.
   * If the user has already decided, the server is opened but auto-stops
   * 60 seconds later — gives the user a chance to change via settings.
   */
  async start() {
    const machineId = getMachineId();
    const adminMonitorEnabled = !!(adminConfig.enabled && adminConfig.licenseKey);
    const sections = buildSections({ adminMonitorEnabled });
    const current = storage.currentDecision();

    this.server = http.createServer((req, res) => this.handle(req, res, {
      machineId, sections, currentDecision: current,
    }));

    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(config.webPort, config.webHost, () => {
        const addr = this.server.address();
        this.bound = { host: addr.address, port: addr.port };
        logger.info({
          host: addr.address, port: addr.port,
          currentDecision: current, adminMonitorEnabled,
        }, 'consent-web: listening');

        // FIX-2026-08-26: auto-open browser so user actually sees the page.
        //   Only fires on first-run (no decision yet) — re-opens via settings page are user-initiated.
        if (!current && config.autoOpen) {
          const url = `http://${addr.address}:${addr.port}/consent`;
          if (_autoOpenBrowser(url)) {
            logger.info({ url }, 'consent-web: auto-opened browser');
          }
        }

        // If user has already decided, keep server open for 60s for settings access,
        // then auto-close to free the port. They can restart bot to re-open.
        if (current) {
          setTimeout(() => {
            logger.info({ currentDecision: current }, 'consent-web: auto-stop (already-decided, 60s window)');
            this.stop().catch(() => {});
          }, 60000);
        }

        resolve(this.bound);
      });
    });
  }

  async stop() {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        logger.info('consent-web: stopped');
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * POST handler — also used by the GET page when posting back via form
   */
  async handle(req, res, ctx) {
    const parsed = url.parse(req.url, true);
    const path = parsed.pathname;

    try {
      if (req.method === 'GET' && (path === '/' || path === '/consent' || path === '/consent/')) {
        return this.servePage(req, res, ctx);
      }
      if (req.method === 'POST' && path === '/consent/accept') {
        return this.handleDecision(req, res, ctx, 'accepted');
      }
      if (req.method === 'POST' && path === '/consent/decline') {
        return this.handleDecision(req, res, ctx, 'declined');
      }
      if (req.method === 'GET' && path === '/consent/status') {
        return this.serveStatus(req, res, ctx);
      }
      // 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      logger.error({ err: err.message }, 'consent-web: handler error');
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }

  servePage(req, res, ctx) {
    // FIX-2026-08-26 Phase 2c-v2: actionBase='/consent' preserves legacy 6017 form posts.
    const html = pageHtml({
      sections: ctx.sections,
      currentDecision: ctx.currentDecision,
      actionBase: '/consent',
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  serveStatus(req, res, ctx) {
    // FIX-2026-08-26 Phase 2c-v2: keep legacy `currentDecision` key so 6017 consumers don't break.
    //   New 6015 endpoint at /api/consent/status uses `decision` instead (different shape).
    const status = handlers.getStatusPayload();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      currentDecision: ctx.currentDecision,
      consentVersion: status.consentVersion,
      web: this.bound,
      adminMonitorEnabled: status.adminMonitorEnabled,
    }));
  }

  async handleDecision(req, res, ctx, decision) {
    // FIX-2026-08-26 Phase 2c-v2: delegate to handlers.recordDecision (shared core).
    //   The constructor re-emits handlers' 'decision' event as our own, so this.emit('decision')
    //   is no longer needed here.
    const result = await handlers.recordDecision({ decision, port: config.webPort });
    this.decidedAt = new Date();

    // Redirect back to GET (so refresh works) — banner reflects the user's decision
    const banner = decision === 'accepted'
      ? { kind: 'success', en: 'Consent accepted. Reloading…', th: 'ยอมรับแล้ว กำลังโหลดใหม่…' }
      : { kind: 'error', en: 'Consent declined. Bot will suspend — no new positions.', th: 'ไม่ยอมรับ บอทจะระงับ — จะไม่เปิด position ใหม่' };
    const html = pageHtml({
      sections: ctx.sections,
      currentDecision: decision,
      decisionBanner: banner,
      actionBase: '/consent',
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return result;
  }
}

module.exports = new ConsentServer();