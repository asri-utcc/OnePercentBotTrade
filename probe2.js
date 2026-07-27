require('dotenv').config();
const mongoose = require('mongoose');
const Signal = require('./src/db/models/Signal');
const Bot = require('./src/db/models/Bot');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade');
  const bot = await Bot.findOne({ symbol: 'SOLUSDT' }).lean();
  const botId = bot._id;
  // Use ±5 min window
  const targets = ['2026-07-15T07:15:00Z','2026-07-15T07:21:00Z','2026-07-15T08:06:00Z','2026-07-15T08:21:00Z'];
  for (const t of targets) {
    const start = new Date(new Date(t).getTime() - 300_000);
    const end = new Date(new Date(t).getTime() + 300_000);
    const sigs = await Signal.find({ botId, candleCloseTime: { $gte: start, $lte: end } }).lean();
    console.log(t, '=>', sigs.length);
    for (const s of sigs) {
      console.log('  ', s.candleCloseTime.toISOString(), 'outcome=', s.outcome, 'note=', s.note);
    }
  }
  // Also count total signals today (all hours)
  console.log('--- all 15/Jul signals in any ±2h near these ---');
  const sigs = await Signal.find({
    botId,
    candleCloseTime: { $gte: new Date('2026-07-15T05:00:00Z'), $lte: new Date('2026-07-15T10:00:00Z') }
  }).sort({ candleCloseTime: 1 }).lean();
  console.log('count=', sigs.length);
  for (const s of sigs) {
    console.log('  ', s.candleCloseTime.toISOString(), 'outcome=', s.outcome, 'note=', s.note||'(none)');
  }
  // And check last 50 signals regardless of date to see if there are any with outcome=skipped
  const last = await Signal.find({ botId }).sort({ createdAt: -1 }).limit(30).lean();
  console.log('--- last 30 signals ---');
  for (const s of last) {
    console.log('  ', s.candleCloseTime && s.candleCloseTime.toISOString(), 'outcome=', s.outcome, 'note=', s.note||'(none)');
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
