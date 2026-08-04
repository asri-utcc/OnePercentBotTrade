'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const backtester = require('../../core/backtester');
const BacktestResult = require('../../db/models/BacktestResult');
const config = require('../../../config');
const logger = require('../../utils/logger');

const router = express.Router();

router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      symbol,
      timeframe,
      from,
      to,
      tpPercent = 0.1,
      capitalPerTrade = 10,
      useBnbForFees = false,
      maxConcurrentTrades = 10,
      // FIX-2026-08-02: DCA mode — opt-in via dcaEnabled. Dispatch to runDcaBacktest when true.
      dcaEnabled = false,
      dcaMaxLayers = 3,
      kcMult = 1.5,
      xs1Enabled = true,
      stopLossOnUpperKC = false,
      autoArmStopLossOnUKC = false,
      // FIX-2026-08-03: F1 thresholds + SL-UKC profit toggle (Option B parity)
      autoArmLossPct = 10,
      autoArmAgeHours = 4,
      slUkcTriggerOnProfit = false,
      // FIX-2026-08-03: DCA + Martingale sizing (opt-in, default off — backward compat 100%)
      //   - martingaleEnabled requires dcaEnabled=true (validated below)
      //   - layer N notional = capitalPerTrade × mult^(N-1), capped by martingaleMaxLayerNotional
      martingaleEnabled = false,
      martingaleMultiplier = 1.5,
      martingaleMaxLayerNotional = 100,
      // FIX-2026-08-03: Safe-trade filter #2 (LuxAlgo red pivot-low trendline) — opt-in, default OFF
      //   - when true: backtester pre-fetches upper-TF (TREND_TF_MAP) klines + computes trendline;
      //     signal skipped if lastClose <= trendline value at signal time
      //   - when false (default): no trendline pre-fetch — backward compatible
      safeTradeTrendlineEnabled = false,
    } = req.body || {};

    if (!symbol || !timeframe || !from || !to) {
      return res.status(400).json({ error: 'symbol, timeframe, from, to required' });
    }
    if (!config.binanceIntervals.includes(timeframe)) {
      return res.status(400).json({ error: 'invalid timeframe' });
    }

    logger.info({
      symbol, timeframe, from, to, dcaEnabled: !!dcaEnabled, dcaMaxLayers,
    }, 'backtest requested');

    // FIX-2026-08-02: dispatch to DCA simulator when dcaEnabled=true.
    // DCA mode is single-stack (1 bot = 1 open stack) so maxConcurrentTrades is irrelevant.
    if (dcaEnabled) {
      // FIX-2026-08-03: Martingale requires DCA — reject if user toggles Martingale without DCA
      if (martingaleEnabled) {
        return res.status(400).json({
          error: 'martingaleEnabled requires dcaEnabled=true (Martingale is DCA-only)',
        });
      }
      const result = await backtester.runDcaBacktest({
        symbol: symbol.toUpperCase(),
        timeframe,
        from,
        to,
        tpPercent: parseFloat(tpPercent),
        capitalPerTrade: parseFloat(capitalPerTrade),
        dcaMaxLayers: parseInt(dcaMaxLayers, 10),
        useBnbForFees: !!useBnbForFees,
        kcMult: parseFloat(kcMult),
        xs1Enabled: xs1Enabled !== false,
        stopLossOnUpperKC: stopLossOnUpperKC === true,
        autoArmStopLossOnUKC: autoArmStopLossOnUKC === true,
        // FIX-2026-08-03: F1 thresholds + SL-UKC profit toggle (Option B parity)
        autoArmLossPct: parseFloat(autoArmLossPct) || 10,
        autoArmAgeHours: parseFloat(autoArmAgeHours) || 4,
        slUkcTriggerOnProfit: slUkcTriggerOnProfit === true,
        // FIX-2026-08-03: pass-through Martingale params (parity with trader._computeDcaLayerNotional)
        martingaleEnabled: martingaleEnabled === true,
        martingaleMultiplier: parseFloat(martingaleMultiplier) || 1.5,
        martingaleMaxLayerNotional: parseFloat(martingaleMaxLayerNotional) || 100,
        // FIX-2026-08-03: Safe-trade filter #2 (trendline) — forward flag to DCA backtest
        safeTradeTrendlineEnabled: safeTradeTrendlineEnabled === true,
      });
      return res.json({
        id: result.id,
        executionModel: result.executionModel,
        stats: result.stats,
        signalsCount: result.signalsCount,
        stacksCount: result.stacksCount,
        truncated: result.truncated,
        candlesFetched: result.candlesFetched,
        requestedDays: result.requestedDays,
        actualDays: result.actualDays,
        stacks: result.stacks,
        signalTrades: result.signalTrades,
        stillHoldingPositions: result.stillHoldingPositions,
      });
    }

    const result = await backtester.runBacktest({
      symbol: symbol.toUpperCase(),
      timeframe,
      from,
      to,
      tpPercent: parseFloat(tpPercent),
      capitalPerTrade: parseFloat(capitalPerTrade),
      useBnbForFees: !!useBnbForFees,
      maxConcurrentTrades: parseInt(maxConcurrentTrades, 10),
      // FIX-2026-08-03: F1 thresholds + SL-UKC profit toggle (Option B parity)
      kcMult: parseFloat(kcMult),
      xs1Enabled: xs1Enabled !== false,
      stopLossOnUpperKC: stopLossOnUpperKC === true,
      autoArmStopLossOnUKC: autoArmStopLossOnUKC === true,
      autoArmLossPct: parseFloat(autoArmLossPct) || 10,
      autoArmAgeHours: parseFloat(autoArmAgeHours) || 4,
      slUkcTriggerOnProfit: slUkcTriggerOnProfit === true,
      // FIX-2026-08-03: Safe-trade filter #2 (trendline) — forward flag to non-DCA backtest
      safeTradeTrendlineEnabled: safeTradeTrendlineEnabled === true,
    });

    res.json({
      id: result.result._id,
      executionModel: result.result.executionModel,
      stats: result.stats,
      signalsCount: result.signals.length,
      tradesCount: result.trades.length,
      // FIX 2026-07-13: แจ้ง UI ว่าข้อมูลถูกตัดจาก SAFETY_LIMIT (ใช้กรณีขอช่วงยาวเกิน cap)
      truncated: result.truncated,
      candlesFetched: result.candlesFetched,
      requestedDays: result.requestedDays,
      actualDays: result.actualDays,
      // ส่ง trades ทั้งหมดที่เก็บไว้ (ถ้า > 500 trades จะถูกตัดเป็น head+tail 250+250 ฝั่ง server)
      // ฝั่ง client จะแบ่งหน้าเอง 20/page
      trades: result.trades,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'backtest failed');
    res.status(500).json({ error: err.message });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const results = await BacktestResult.find().sort({ createdAt: -1 }).limit(50).lean();
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await BacktestResult.findById(req.params.id).lean();
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FIX-2026-07-30: Multi-bot backtest — shared capital pool + per-bot stats
router.post('/multi', requireAuth, async (req, res) => {
  try {
    const { totalCapital, from, to, bots = [] } = req.body || {};

    if (!totalCapital || totalCapital <= 0) {
      return res.status(400).json({ error: 'totalCapital required (> 0)' });
    }
    if (!bots.length) {
      return res.status(400).json({ error: 'bots[] required (>= 1)' });
    }
    if (!from || !to) {
      return res.status(400).json({ error: 'from, to required (YYYY-MM-DD)' });
    }
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      if (!b.symbol || !b.timeframe) {
        return res.status(400).json({ error: `bots[${i}]: symbol + timeframe required` });
      }
      if (!config.binanceIntervals.includes(b.timeframe)) {
        return res.status(400).json({ error: `bots[${i}]: invalid timeframe "${b.timeframe}"` });
      }
    }

    logger.info({ totalCapital, botCount: bots.length, from, to }, 'multi-bot backtest requested');

    const result = await backtester.runMultiBacktest({
      totalCapital: parseFloat(totalCapital),
      from,
      to,
      bots: bots.map((b) => ({
        symbol: b.symbol,
        timeframe: b.timeframe,
        tpPercent: parseFloat(b.tpPercent != null ? b.tpPercent : 0.1),
        capitalPerTrade: parseFloat(b.capitalPerTrade != null ? b.capitalPerTrade : 10),
        maxConcurrentTrades: parseInt(b.maxConcurrentTrades != null ? b.maxConcurrentTrades : 10, 10),
        maxBuyWait: parseInt(b.maxBuyWait != null ? b.maxBuyWait : 6, 10),
        useBnbForFees: !!b.useBnbForFees,
        kcMult: b.kcMult != null ? parseFloat(b.kcMult) : 1.5,
        xs1Enabled: b.xs1Enabled !== false,
        // FIX-2026-08-01: forward CB + Upper-KC stop-loss toggles per bot — เดิมชื่อ sls1Enabled
        cbEnabled: b.cbEnabled !== false,             // default true (parity กับ live)
        stopLossOnUpperKC: b.stopLossOnUpperKC === true, // default false
        // FIX-2026-08-02: DCA mode (per bot) — when true, single-stack simulator runs instead of per-trade
        dcaEnabled: b.dcaEnabled === true,
        dcaMaxLayers: parseInt(b.dcaMaxLayers != null ? b.dcaMaxLayers : 3, 10),
        autoArmStopLossOnUKC: b.autoArmStopLossOnUKC === true,
        // FIX-2026-08-03: F1 thresholds + SL-UKC profit toggle (Option B parity)
        autoArmLossPct: b.autoArmLossPct != null ? parseFloat(b.autoArmLossPct) : 10,
        autoArmAgeHours: b.autoArmAgeHours != null ? parseFloat(b.autoArmAgeHours) : 4,
        slUkcTriggerOnProfit: b.slUkcTriggerOnProfit === true,
        // FIX-2026-08-03: Safe-trade filter #2 (trendline) — forward per-bot flag
        safeTradeTrendlineEnabled: b.safeTradeTrendlineEnabled === true,
      })),
    });

    res.json(result);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'multi-bot backtest failed');
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await BacktestResult.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;