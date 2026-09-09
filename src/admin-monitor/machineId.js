'use strict';

/**
 * FIX-2026-08-26: Machine fingerprint for admin license binding
 *
 * Generates a stable, unique machine fingerprint from:
 *  - hostname
 *  - OS platform + arch
 *  - CPU model
 *  - MAC address of first non-internal network interface
 *
 * Hash is SHA-256 (truncated to 32 chars for readability).
 * Stable across restarts but unique per machine.
 *
 * If a fingerprint has been persisted to data/admin-machine-id.txt, that one is used
 * (allows migration/reinstall without losing license binding).
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// FIX-2026-09-09: Multi-instance support — allow per-instance machineId file
//   via env `MACHINE_ID_FILE`. Default (single-instance path) is unchanged so
//   existing deployments keep working. To run 2+ instances on one host,
//   set MACHINE_ID_FILE=./data/<name>-machine-id.txt per instance AND
//   pre-seed the file with a unique value before first start.
const FINGERPRINT_FILE = process.env.MACHINE_ID_FILE
  ? path.resolve(process.env.MACHINE_ID_FILE)
  : path.join(__dirname, '..', '..', 'data', 'admin-machine-id.txt');

function _gatherComponents() {
  const hostname = os.hostname();
  const platform = `${os.platform()}-${os.arch()}`;
  const cpuModel = (os.cpus()[0]?.model || 'unknown').trim();

  // Find first non-internal MAC
  const nets = os.networkInterfaces();
  let mac = '';
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') {
        mac = ni.mac;
        break;
      }
    }
    if (mac) break;
  }

  return { hostname, platform, cpuModel, mac };
}

function _computeHash(components) {
  const data = `${components.hostname}|${components.platform}|${components.cpuModel}|${components.mac}`;
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 32);
}

/**
 * Get the stable machine fingerprint for this host.
 * Persists to disk on first call so reinstalls don't break binding (unless disk wiped).
 */
function getMachineId() {
  // Try persisted ID first
  try {
    if (fs.existsSync(FINGERPRINT_FILE)) {
      const persisted = fs.readFileSync(FINGERPRINT_FILE, 'utf8').trim();
      if (persisted && persisted.length >= 16) return persisted;
    }
  } catch (_) { /* ignore read errors */ }

  // Compute new fingerprint
  const components = _gatherComponents();
  const id = _computeHash(components);

  // Persist for stability across reboots
  try {
    const dir = path.dirname(FINGERPRINT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FINGERPRINT_FILE, id, 'utf8');
  } catch (_) { /* non-fatal */ }

  return id;
}

/**
 * Get human-readable host info (for heartbeat payload).
 */
function getHostInfo() {
  const c = _gatherComponents();
  return {
    hostname: c.hostname,
    platform: c.platform,
    mac: c.mac,
    cpuModel: c.cpuModel,
  };
}

module.exports = { getMachineId, getHostInfo };
