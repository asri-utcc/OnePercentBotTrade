'use strict';
// FIX-2026-08-09: Backfill sellReason for trades that were filled before 2026-08-01
//   - 444/1032 trades (43%) had sellReason=null because the field was added later
//   - Also migrate 1 stale 'sls1_panic' → 'cb_panic' (renamed during schema cleanup)
//
// Strategy:
//   - sls1_panic → cb_panic (rename, preserve detail/source)
//   - sellReason=null OR undefined → derive from prior-state signals:
//     - sellReasonSource hint (best signal — most precise):
//       - 'positionWatchdog.cbv3' → cbv3_panic
//       - 'positionWatchdog.cbv2' → cbv2_panic
//       - 'positionWatchdog.slUkc' → sl_ukc_f1_armed
//       - '_emergencyMarketSell' (default reason 'stop_loss_upper_kc' detail) → re-derive from signals
//       - 'forceClose.forceCloseTrade*' → manual_api_* family
//     - error field hints:
//       - contains "stop_loss_upper_kc" or "SL-UKC" → sl_ukc_f1_armed (if useStopLossOnUKC+autoArmedAt) else sl_ukc_manual
//       - contains "cb_panic" / "CB" → cb_panic
//       - contains "partial_sell" / "PART" → partial_sell_finalized
//       - contains "market" / "MARKET" + close at loss → market_fallback
//     - useStopLossOnUKC + autoArmedAt → sl_ukc_f1_armed (the F1-armed signal)
//     - bot.stopLossOnUpperKC=true → sl_ukc_manual (admin-enabled SL on UKC)
//     - buyPrice+sellPrice signals:
//       - pnlPercent > +0.5% → tp_hit (or tp_trend_boosted if recent)
//       - pnlPercent < -5% → likely market_fallback or sl_ukc_*
//     - Fallback → manual_api_market (most common legacy path)
//
// Usage:
//   node scripts/backfill-sell-reasons.js --dry-run    # preview only
//   node scripts/backfill-sell-reasons.js              # actually run

require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/db/models/Trade');
const Bot = require('../src/db/models/Bot');

const BACKFILL_SOURCE = 'backfill-2026-08-09';

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`🔧 Backfill sellReason (${dryRun ? 'DRY-RUN' : 'LIVE'})`);

  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade');

    // ─── Step 1: migrate stale 'sls1_panic' → 'cb_panic' ─────────────────────
    const staleSls1 = await Trade.countDocuments({ sellReason: 'sls1_panic' });
    console.log(`\n📌 Step 1: Migrate sls1_panic → cb_panic`);
    console.log(`   Found ${staleSls1} trades with stale 'sls1_panic'`);

    if (staleSls1 > 0 && !dryRun) {
      const r = await Trade.updateMany(
        { sellReason: 'sls1_panic' },
        { $set: { sellReason: 'cb_panic', sellReasonSource: 'migrate-sls1-to-cb' } },
      );
      console.log(`   ✅ Migrated: matched=${r.matchedCount} modified=${r.modifiedCount}`);
    } else if (staleSls1 > 0) {
      console.log(`   🔍 DRY-RUN: would rename ${staleSls1} to cb_panic`);
    }

    // ─── Step 2: backfill null/undefined sellReason ──────────────────────────
    // Match: state='sold' AND (sellReason=null OR sellReason doesn't exist)
    const missingQuery = {
      state: 'sold',
      $or: [
        { sellReason: null },
        { sellReason: { $exists: false } },
      ],
    };
    const missingCount = await Trade.countDocuments(missingQuery);
    console.log(`\n📌 Step 2: Backfill missing sellReason`);
    console.log(`   Found ${missingCount} sold trades with null/missing sellReason`);

    if (missingCount === 0) {
      console.log('✅ All trades already have sellReason — nothing to backfill');
      await mongoose.disconnect();
      return;
    }

    // Build bot lookup map for stopLossOnUpperKC check
    const missingTrades = await Trade.find(missingQuery)
      .select('_id botId symbol sellReasonSource error useStopLossOnUKC autoArmedAt buyPrice sellPrice pnlPercent realizedPnl sellFilledAt')
      .lean();

    const botIds = [...new Set(missingTrades.map((t) => String(t.botId)))];
    const bots = await Bot.find({ _id: { $in: botIds } }, 'name stopLossOnUpperKC').lean();
    const botMap = Object.fromEntries(bots.map((b) => [String(b._id), b]));

    // Classify each trade
    const buckets = {
      sl_ukc_f1_armed: [],
      sl_ukc_manual: [],
      cbv3_panic: [],
      cbv2_panic: [],
      cb_panic: [],
      tp_hit: [],
      tp_trend_boosted: [],
      dca_target_hit: [],
      dca_stack_stop_loss: [],
      dca_stack_force_close: [],
      market_fallback: [],
      partial_sell_finalized: [],
      race_recovery_filled: [],
      manual_api_force_close_trade: [],
      manual_api_force_close_bot: [],
      manual_api_watchdog: [],
      manual_api_cleanup_script: [],
      manual_api_market: [],
      manual_api_synthetic: [],
      bot_disabled: [],
      unknown: [],
    };

    for (const t of missingTrades) {
      const source = t.sellReasonSource || '';
      const error = t.error || '';
      const bot = botMap[String(t.botId)];
      const pnl = parseFloat(t.pnlPercent || 0);
      const profit = pnl > 0.5;

      let derived = null;

      // 1. sellReasonSource signal — most precise
      if (source.includes('positionWatchdog.cbv3')) derived = 'cbv3_panic';
      else if (source.includes('positionWatchdog.cbv2')) derived = 'cbv2_panic';
      else if (source.includes('positionWatchdog.slUkc')) derived = 'sl_ukc_f1_armed';
      else if (source.includes('forceClose.forceCloseTrade_dca')) derived = 'dca_stack_force_close';
      else if (source.includes('forceClose.forceCloseTrade_watchdog')) derived = 'manual_api_watchdog';
      else if (source.includes('forceClose.forceCloseTrade_cleanup')) derived = 'manual_api_cleanup_script';
      else if (source.includes('forceClose.forceCloseTrade_synthetic')) derived = 'manual_api_synthetic';
      else if (source.includes('forceClose.forceCloseTrade')) derived = 'manual_api_force_close_trade';
      else if (source.includes('_stopLossForceClose_dca')) derived = 'dca_stack_stop_loss';
      else if (source.includes('_stopLossForceClose')) derived = 'sl_ukc_f1_armed'; // trader path is auto-armed
      else if (source.includes('_emergencyMarketSell')) derived = null; // need more context

      // 2. error field hints
      if (!derived) {
        if (error.includes('stop_loss_upper_kc') || error.includes('SL-UKC')) {
          // trader.js _stopLossForceClose path → F1-armed (F1 is the only arm path in trader)
          derived = t.useStopLossOnUKC === true && t.autoArmedAt ? 'sl_ukc_f1_armed' : 'sl_ukc_manual';
        } else if (error.includes('cb_panic') || error.includes('CB panic')) {
          derived = 'cb_panic';
        } else if (error.includes('partial_sell') || error.includes('PART')) {
          derived = 'partial_sell_finalized';
        } else if (error.includes('market_fallback') || (error.includes('MARKET') && pnl < -5)) {
          derived = 'market_fallback';
        } else if (error.includes('dca_stack_stop_loss')) {
          derived = 'dca_stack_stop_loss';
        } else if (error.includes('dca_target_hit') || error.includes('DCA target')) {
          derived = 'dca_target_hit';
        } else if (error.includes('holding_retry_exhausted')) {
          derived = 'holding_retry_exhausted';
        } else if (error.includes('holding_retry_recovered')) {
          derived = 'holding_retry_recovered';
        } else if (error.includes('race_recovery') || error.includes('race lost')) {
          derived = 'race_recovery_filled';
        }
      }

      // 3. SL-UKC arm signals (useStopLossOnUKC+autoArmedAt)
      if (!derived && t.useStopLossOnUKC === true && t.autoArmedAt) {
        derived = 'sl_ukc_f1_armed';
      }
      if (!derived && bot && bot.stopLossOnUpperKC === true) {
        derived = 'sl_ukc_manual';
      }

      // 4. Profit-based heuristic — likely TP if profit (LIMIT_MAKER filled)
      if (!derived && profit) {
        // Recent + tpTrendMultiplier hint? We don't have it on Trade.
        // Default: tp_hit (most common profitable sell)
        derived = 'tp_hit';
      }

      // 5. Fallback
      if (!derived) {
        derived = 'manual_api_market'; // most common legacy path
      }

      if (!buckets[derived]) buckets.unknown.push(t);
      else buckets[derived].push(t);
    }

    // Print classification summary
    console.log(`\n   Classification:`);
    let totalBuckets = 0;
    for (const [reason, list] of Object.entries(buckets)) {
      if (list.length > 0) {
        console.log(`     ${reason}: ${list.length}`);
        totalBuckets += list.length;
      }
    }
    console.log(`   Total to update: ${totalBuckets}`);

    if (dryRun) {
      console.log(`\n🔍 DRY-RUN — sample of trades that would be updated:`);
      for (const [reason, list] of Object.entries(buckets)) {
        if (list.length > 0 && list[0]) {
          const t = list[0];
          const bot = botMap[String(t.botId)];
          console.log(`   [${reason}] ${t._id} bot=${bot?.name || '?'} pnl=${t.pnlPercent}% src=${t.sellReasonSource || 'null'}`);
        }
      }
      await mongoose.disconnect();
      return;
    }

    // ─── Step 3: write back ──────────────────────────────────────────────────
    console.log(`\n📌 Step 3: Write back`);
    let updatedCount = 0;
    for (const [reason, list] of Object.entries(buckets)) {
      if (list.length === 0) continue;
      const ids = list.map((t) => t._id);
      const r = await Trade.updateMany(
        { _id: { $in: ids }, state: 'sold' },
        {
          $set: {
            sellReason: reason,
            sellReasonDetail: `${BACKFILL_SOURCE} — derived from sellReasonSource='${list[0].sellReasonSource || 'null'}' + error hints + price signals`,
            sellReasonAt: list[0].sellFilledAt || new Date(),
            sellReasonSource: BACKFILL_SOURCE,
          },
        },
      );
      updatedCount += r.modifiedCount;
      console.log(`   ✅ ${reason}: matched=${r.matchedCount} modified=${r.modifiedCount}`);
    }

    // Verify
    const stillMissing = await Trade.countDocuments(missingQuery);
    console.log(`\n📌 Post-backfill:`);
    console.log(`   Updated: ${updatedCount} trades`);
    console.log(`   Still missing sellReason: ${stillMissing}`);

    await mongoose.disconnect();
    console.log(`\n✅ Backfill complete`);
  } catch (err) {
    console.error('Fatal:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();