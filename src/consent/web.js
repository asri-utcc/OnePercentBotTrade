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
const { EventEmitter } = require('events');

const config = require('./config');
const adminConfig = require('../admin-monitor/config');
const storage = require('./storage');
const api = require('./api');
const { pageHtml } = require('./html');
const buildSections = require('./text');
const { getMachineId } = require('../admin-monitor/machineId');
const rootLogger = require('../utils/logger');

const logger = rootLogger.child ? rootLogger.child({ module: 'consent-web' }) : rootLogger;

class ConsentServer extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.bound = null; // { host, port }
    this.decidedAt = null; // when decision was made (to stop server)
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
    const html = pageHtml({ sections: ctx.sections, currentDecision: ctx.currentDecision });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  serveStatus(req, res, ctx) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      currentDecision: ctx.currentDecision,
      consentVersion: config.version,
      web: this.bound,
      adminMonitorEnabled: !!(adminConfig.enabled && adminConfig.licenseKey),
    }));
  }

  async handleDecision(req, res, ctx, decision) {
    const previousDecision = storage.currentDecision();
    const source = previousDecision ? 'settings_change' : 'first_run';

    // 1. Persist locally first (atomic)
    storage.write({ decision, source, previousDecision });

    // 2. Push to admin (best-effort; doesn't block)
    api.pushDecision({
      machineId: ctx.machineId,
      decision,
      consentVersion: config.version,
      source,
    }).catch((err) => logger.warn({ err: err.message }, 'consent: push failed'));

    // 3. Emit event for main flow to react
    this.emit('decision', { decision, source, previousDecision });
    this.decidedAt = new Date();

    // 4. Redirect back to GET (so refresh works)
    const banner = decision === 'accepted'
      ? { kind: 'success', en: 'Consent accepted. Reloading…', th: 'ยอมรับแล้ว กำลังโหลดใหม่…' }
      : { kind: 'error', en: 'Consent declined. Bot will suspend — no new positions.', th: 'ไม่ยอมรับ บอทจะระงับ — จะไม่เปิด position ใหม่' };
    const html = pageHtml({ sections: ctx.sections, currentDecision: decision, decisionBanner: banner });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}

module.exports = new ConsentServer();