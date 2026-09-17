#!/usr/bin/env python3
"""
FIX-2026-09-17: getOrder criticality bug

Root cause: binanceRest.getOrder() hardcoded { critical: false } and IGNORED the
second options argument that callers pass. FIX-2026-09-12 added
{ critical: true } calls in botManager.reconcilePendingTrades but the option
silently dropped → reconcile sweep blocked by circuit breaker whenever CB opens.

Effect: orphan SELLs (FILLED on Binance) stuck in DB state='selling' indefinitely.
Confirmed: 36+ orphan SELLs + 1 orphan BUY (1000CATUSDT) stuck.

Fix:
  1. binanceRest.getOrder() — accept opts, forward opts.critical
  2. botManager.js — add { critical: true } to remaining reconcile getOrder calls
     (lines 537, 557, 664) — also safety-net paths, also blocked by CB

Run:  python tools/fix-getOrder-criticality.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ────────────────────────────────────────────────────────────────────────────
# Fix 1: binanceRest.getOrder() — accept opts, forward critical
# ────────────────────────────────────────────────────────────────────────────
f1 = ROOT / "src/binance/binanceRest.js"
src1 = f1.read_text(encoding="utf-8")
old1 = """async function getOrder({ symbol, orderId = null, origClientOrderId = null }) {
  const params = { symbol };
  if (orderId) params.orderId = orderId;
  if (origClientOrderId) params.origClientOrderId = origClientOrderId;
  return signedRequest('GET', '/api/v3/order', params, 4, { critical: false });
}"""
new1 = """async function getOrder({ symbol, orderId = null, origClientOrderId = null }, opts = {}) {
  const params = { symbol };
  if (orderId) params.orderId = orderId;
  if (origClientOrderId) params.origClientOrderId = origClientOrderId;
  // FIX-2026-09-17: forward opts.critical to signedRequest
  //   - default false (preserves P0-audit behavior — non-reconcile callers respect CB)
  //   - reconcile safety-net callers (botManager.reconcilePendingTrades) pass
  //     { critical: true } to bypass CB (FIX-2026-09-12 intent)
  //   - bug: pre-fix signature was `(args)` only — second arg silently dropped,
  //     every reconcile sweep was treated as critical:false → blocked by CB
  //     → orphan SELLs stuck for hours/days (36 confirmed stuck at fix time)
  return signedRequest('GET', '/api/v3/order', params, 4, { critical: opts.critical === true });
}"""
if old1 not in src1:
    print(f"❌ FAILED: getOrder block not found in {f1}", file=sys.stderr)
    sys.exit(1)
src1 = src1.replace(old1, new1)
f1.write_text(src1, encoding="utf-8")
print(f"✅ Patched {f1.relative_to(ROOT)}: getOrder accepts/ forwards opts.critical")

# ────────────────────────────────────────────────────────────────────────────
# Fix 2: botManager.js — add { critical: true } to orphan-BUY detection paths
#   Lines 537 (BUY order check), 557 (live SELL pre-check), 664 (pre-recover backstop)
#   All are inside reconcilePendingTrades — safety net — must bypass CB
# ────────────────────────────────────────────────────────────────────────────
f2 = ROOT / "src/core/botManager.js"
src2 = f2.read_text(encoding="utf-8")

# Each call has a unique signature; surgical replace
patterns = [
    (
        # Line 537 (BUY order check in orphan BUY detection)
        """          const order = await binanceRest.getOrder({
            symbol: trade.symbol,
            orderId: trade.buyOrderId,
          }).catch(() => null);""",
        """          // FIX-2026-09-17: critical=true to bypass CB (safety-net reconcile)
          //   - reconcile sweep = 36+ trades × 2 calls each every 5min
          //   - without critical=true, CB opens frequently on rate-spike and EVERY
          //     orphan BUY detection is silently skipped → orphan BUY accumulates
          //     (e.g. 1000CATUSDT stuck 265h with no SELL on book)
          const order = await binanceRest.getOrder({
            symbol: trade.symbol,
            orderId: trade.buyOrderId,
          }, { critical: true }).catch(() => null);""",
    ),
    (
        # Line 557 (live SELL pre-check before placing new SELL)
        """                  const liveSell = await binanceRest.getOrder({
                    symbol: trade.symbol,
                    orderId: trade.sellOrderId,
                  }).catch(() => null);""",
        """                  // FIX-2026-09-17: critical=true (safety-net reconcile path)
                  const liveSell = await binanceRest.getOrder({
                    symbol: trade.symbol,
                    orderId: trade.sellOrderId,
                  }, { critical: true }).catch(() => null);""",
    ),
    (
        # Line 664 (pre-recovery backstop — check existing SELL before placing new)
        """                    const preRecoverSell = await binanceRest.getOrder({
                      symbol: trade.symbol,
                      orderId: trade.sellOrderId,
                    }).catch(() => null);""",
        """                    // FIX-2026-09-17: critical=true (safety-net reconcile path)
                    const preRecoverSell = await binanceRest.getOrder({
                      symbol: trade.symbol,
                      orderId: trade.sellOrderId,
                    }, { critical: true }).catch(() => null);""",
    ),
]

for old, new in patterns:
    if old not in src2:
        print(f"❌ FAILED: pattern not found in {f2}\n---pattern---\n{old}", file=sys.stderr)
        sys.exit(1)
    src2 = src2.replace(old, new)

f2.write_text(src2, encoding="utf-8")
print(f"✅ Patched {f2.relative_to(ROOT)}: 3 reconcile getOrder calls now critical:true")

print("\n✅ All patches applied successfully")
print("Next: node -c src/binance/binanceRest.js && node -c src/core/botManager.js")
print("Then: npm run pm2:reload")
