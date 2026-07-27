require('dotenv').config();
const mongoose = require('mongoose');
const Signal = require('./src/db/models/Signal');
const Trade = require('./src/db/models/Trade');
const Bot = require('./src/db/models/Bot');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/onepercentbottrade');
  const bot = await Bot.findOne({ symbol: 'SOLUSDT' }).lean();
  console.log('SOL bot:', bot && bot._id.toString(), 'maxTrades=', bot && bot.maxTrades);
  // 07:15 UTC 14/Jul == 14:15 Thai on 14/07? user said today's signals but date changed to 15/07.
  // Probe both 14/Jul (07:15,07:21,08:06,08:21 UTC) and 15/Jul
  const ts = ['2026-07-14T07:15:00Z','2026-07-14T07:21:00Z','2026-07-14T08:06:00Z','2026-07-14T08:21:00Z'];
  for (const t of ts) {
    const d = new Date(t);
    const start = new Date(d.getTime() - 60_000);
    const end = new Date(d.getTime() + 60_000);
    const sigs = await Signal.find({ botId: bot._id, candleCloseTime: { $gte: start, $lte: end } }).lean();
    console.log(t, '=>', sigs.length, 'signals:');
    for (const s of sigs) {
      console.log('  outcome=', s.outcome, 'note=', s.note, 'candleCloseTime=', s.candleCloseTime, 'closePrice=', s.closePrice);
    }
  }
  // Also check 15/Jul
  console.log('--- 15/Jul signals (UTC 00:00-24:00) ---');
  const sigs15 = await Signal.find({ botId: bot._id, candleCloseTime: { $gte: new Date('2026-07-15T00:00:00Z'), $lt: new Date('2026-07-15T23:59:59Z') } }).sort({ candleCloseTime: 1 }).lean();
  console.log('count=', sigs15.length);
  for (const s of sigs15) {
    console.log(' ', s.candleCloseTime.toISOString(), 'outcome=', s.outcome, 'note=', s.note);
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
