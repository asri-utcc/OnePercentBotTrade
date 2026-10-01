'use strict';

/**
 * FIX-2026-10-02: callContext — AsyncLocalStorage-based "current task" tracker
 *
 * Why
 * ---
 * The user wants to drill into WHICH scheduled task is burning Binance API
 * weight. Without attribution, we only know total usedPct from the X-MBX-USED-WEIGHT-1M
 * header — not which call site caused the spike. After a CB trip incident, the
 * question is always "which task called getAccount() 57 times in 30 seconds?"
 *
 * Mechanism
 * ---------
 * - scheduledInterval + _instrumentedInterval wrap each fire in `run({taskName}, async () => {...})`
 * - binanceRest publicGet/publicPost/signedRequest read `get()` to find the current task,
 *   then call `taskRegistry.attributeWeight(taskName, weightDelta)` after the response
 *   lands (delta = new X-MBX-USED-WEIGHT-1M - snapshot before request)
 *
 * Why AsyncLocalStorage not Prop
 *   - Prop-drilling would force every helper to know its caller's task name
 *   - AsyncLocalStorage propagates through await/microtasks/Promise chains automatically
 *   - Zero overhead in hot paths (V8 stores it on the async resource)
 *
 * Edge cases
 * ----------
 * - Outside any tracked task: get() returns { taskName: null }. Weight cost falls
 *   in 'untracked' bucket (visible in /api/health/weight-attribution as untracked row)
 * - Multiple concurrent tasks: each async stack has its own context — no cross-talk
 * - Nested tasks (task A calls function that calls task B): outer task wins via
 *   `enterWith` semantics only when B doesn't explicitly run. Today no nesting exists.
 */

const { AsyncLocalStorage } = require('async_hooks');

const _als = new AsyncLocalStorage();

/**
 * Run a function with a given task context. Returns the function's return value.
 * Use: `await callContext.run({ taskName: 'foo' }, async () => { ... })`
 */
function run(name, fn) {
  return _als.run({ taskName: name }, fn);
}

/**
 * Read current task context. Returns { taskName: string | null } or undefined
 * if outside any tracked call.
 */
function get() {
  return _als.getStore();
}

/**
 * Convenience: returns the current task name or 'untracked' if outside any
 * tracked context. Use in error logs / metric attribution where a sensible
 * default matters.
 */
function currentTaskName() {
  const s = _als.getStore();
  return s && s.taskName ? s.taskName : 'untracked';
}

module.exports = {
  run,
  get,
  currentTaskName,
  // exposed for tests
  _als,
};