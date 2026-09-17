#!/usr/bin/env python3
"""Add { critical: true } to remaining reconcile getOrder calls in botManager.js."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
f = ROOT / "src/core/botManager.js"
src = f.read_text(encoding="utf-8")

patches = [
    # Line 537: BUY order check (orphan BUY detection)
    (
        """          const order = await binanceRest.getOrder({
            symbol: trade.symbol,
            orderId: trade.buyOrderId,
          }).catch(() => null);""",
        """          // FIX-2026-09-17: critical=true to bypass CB (safety-net reconcile path)
          //   - reconcile sweep = 36+ trades x 2 calls each every 5min
          //   - without critical=true, CB opens frequently on rate-spike and EVERY
          //     orphan BUY detection silently skipped -> orphan BUY accumulates
          //     (e.g. 1000CATUSDT stuck 265h with no SELL on book)
          const order = await binanceRest.getOrder({
            symbol: trade.symbol,
            orderId: trade.buyOrderId,
          }, { critical: true }).catch(() => null);""",
    ),
    # Line 557: live SELL pre-check
    (
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
    # Line 664: pre-recovery backstop
    (
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

for i, (old, new) in enumerate(patches, 1):
    if old not in src:
        print(f"FAILED: pattern {i} not found", file=sys.stderr)
        sys.exit(1)
    src = src.replace(old, new)
    print(f"Patched pattern {i}")

f.write_text(src, encoding="utf-8")
print("OK: botManager.js patched (3 reconcile getOrder calls)")
