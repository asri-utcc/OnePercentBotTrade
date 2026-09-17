#!/usr/bin/env python3
"""FIX-2026-09-17: TDZ bug — 'recovered' used before initialization."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
f = ROOT / "src/core/botManager.js"
src = f.read_text(encoding="utf-8")

# Move `let recovered = false;` (line 690) to BEFORE the if (trade.sellOrderId) block (line 669).
# Delete it from its current location and insert before the backstop comment.

# Step 1: remove the late declaration
old1 = """                  const canRecover = !recovered && bot.enabled === false
                    && !bot.deletedAt
                    && ORPHAN_RECOVERABLE_PAUSE_REASONS.includes(bot.autoPauseReason)
                    && recoveryCount < MAX_ORPHAN_RECOVERY_ATTEMPTS
                    && !this.traders.has(bot._id.toString());
                  let recovered = false;
                  let recoveryError = null;"""

new1 = """                  const canRecover = !recovered && bot.enabled === false
                    && !bot.deletedAt
                    && ORPHAN_RECOVERABLE_PAUSE_REASONS.includes(bot.autoPauseReason)
                    && recoveryCount < MAX_ORPHAN_RECOVERY_ATTEMPTS
                    && !this.traders.has(bot._id.toString());
                  let recoveryError = null;"""

if old1 not in src:
    print("FAILED: late-declaration pattern not found", file=sys.stderr)
    sys.exit(1)
src = src.replace(old1, new1)

# Step 2: insert declaration BEFORE the backstop comment (and the if (trade.sellOrderId))
old2 = """                  const recoveryCount = trade.orphanBuyRecoveryCount || 0;
                  // FIX-2026-09-09 (ETCUSDT orphan bug): backstop ก่อน auto-recovery"""

new2 = """                  const recoveryCount = trade.orphanBuyRecoveryCount || 0;
                  // FIX-2026-09-17 (TDZ bug): declare `recovered` BEFORE first use
                  //   - bug: old code declared `let recovered = false` AFTER the
                  //     if (trade.sellOrderId) block that may set recovered=true.
                  //     When sellOrderId is undefined (orphan BUY w/ no SELL yet, e.g.
                  //     1000CATUSDT) `!recovered` at canRecover hit TDZ → ReferenceError
                  //     → outer try/catch caught it → recovery NEVER fired for this
                  //     trade class. Hidden because previous CB-block prevented
                  //     reconcile from reaching this code at all.
                  let recovered = false;
                  // FIX-2026-09-09 (ETCUSDT orphan bug): backstop ก่อน auto-recovery"""

if old2 not in src:
    print("FAILED: insertion-point pattern not found", file=sys.stderr)
    sys.exit(1)
src = src.replace(old2, new2)

f.write_text(src, encoding="utf-8")
print("OK: TDZ fix applied — let recovered moved to line ~664 (before first use)")
