# OnePercentBotTrade

Node.js Binance Spot Trading Bot ที่ใช้ **S1 signal** จาก Pine Script indicator "BOD Signal Overlay" (Keltner Channel + bg zones) เพื่อ trigger **maker-only BUY → TP SELL** (ไม่มี SL) พร้อม web dashboard

## Features

- 🎯 **S1 Signal Detection**: แปลง Pine Script v5 indicator เป็น JavaScript pure functions (RMA-based ATR, EMA)
- 💎 **Maker-only Trading**: ใช้ `LIMIT_MAKER` order type เพื่อรับ maker fee (0.075% with BNB, 0.1% ไม่มี BNB)
- 🔄 **Smart Order Retry**: เมื่อ bid ขยับ → cancel + re-place ที่ bid ใหม่, ครบ retry → ยกเลิกสัญญาณ
- 🛡️ **Binance Filters Check**: LOT_SIZE, PRICE_FILTER, NOTIONAL ทุกครั้งก่อนส่ง order
- 📊 **Dashboard**: monitor + CRUD bots + chart with S1 markers + backtest + history
- 📈 **Backtest**: โหลด historical klines + simulate trades + ดู winRate/PnL/maxDrawdown
- 🔌 **Local MongoDB**: เก็บ bots/trades/signals/backtest results
- 🔐 **Session Auth**: password-based login พร้อม bcrypt + AES-256-GCM encrypted API keys
- 🔁 **Auto-reconnect**: Binance WebSocket ตัด → reconnect + resubscribe + backfill
- 📚 **DCA + BEP Stack Mode** (opt-in per bot): เปิด DCA → S1 signal ตัวแรกเปิด stack, ตัวถัดไปเพิ่ม layer (สูงสุด `dcaMaxLayers`, default 3) → BEP = weighted avg → aggregate SELL ที่ BEP+TP. **CB panic-sell ปิดใน DCA mode** (no cut loss). Spot only, no leverage. ดู [DCA Stack Mode](#dca--bep-stack-mode)
- 🎲 **DCA + Martingale sizing** (opt-in per bot, DCA-only): เปิด Martingale ใน DCA mode → layer N notional = `capitalPerTrade × multiplier^(N-1)`, capped by per-layer cap (default 100 USDT). ทำให้ BEP recover เร็วขึ้น แต่ max loss สูงขึ้นเมื่อถึง max layers. ดู [DCA Stack Mode](#dca--bep-stack-mode)

## Quick Start

### 1. ติดตั้ง MongoDB (local)
```bash
# Windows: ดาวน์โหลดจาก https://www.mongodb.com/try/download/community
# หรือใช้ Docker
docker run -d --name mongodb -p 27017:27017 mongo:7
```

### 2. ติดตั้ง dependencies
```bash
cd OnePercentBotTrade  # adjust path to where you cloned the repo
npm install
```

### 3. ตั้งค่า environment
```bash
cp .env.example .env
# แก้ไข .env:
#   SESSION_SECRET=<random 64 chars>
#   ENCRYPTION_KEY=<random 32 chars>
#   BINANCE_API_KEY=<your key>
#   BINANCE_API_SECRET=<your secret>
```

### 4. รัน
```bash
npm start
# หรือ dev mode
npm run dev
```

### 5. เปิด Dashboard
```
http://localhost:6015
```

(Port 6015 is the default; override via `PORT=` in `.env`. Admin monitor uses **6016**.)

ครั้งแรกจะให้ตั้ง password + (optional) ใส่ Binance API keys

## ⚠️ Binance API Key Best Practices

1. ตั้ง permission: **"Enable Spot & Margin Trading" เท่านั้น, ปิด Withdraw**
2. ผูก **IP whitelist** กับ IP เครื่องที่รันบอท
3. ทดสอบกับ **ทุนน้อย** ก่อน (เช่น $10/trade 10 ไม้ = $100)
4. ทำ Backtest ก่อนเสมอ

## Architecture

```
src/
├── server.js          # bootstrap
├── app.js             # Express app
├── db/                # Mongoose models + connection
├── binance/           # REST, WS, symbolInfo, fees
├── core/              # signalEngine, trader, botManager, backtester
├── services/          # eventBus, klineCache, crypto, botDefaults
├── api/routes/        # auth, bots, trades, signals, chart, backtest, account
├── admin-monitor/     # phone-home (heartbeat) + command executor
├── realtime/          # dashboardWs (WebSocket server)
└── utils/             # logger, rateLimiter

public/                # Frontend dashboard (plain HTML/JS)
├── login.html, bots.html, bot-edit.html, chart.html, chart-monitor.html, backtest.html
└── js/, css/
```

For system-wide overview (3 sibling projects), see [SYSTEM-README.md](./SYSTEM-README.md).
For install instructions, see [SYSTEM-INSTALL.md](./SYSTEM-INSTALL.md).
For connecting multiple bots/admins, see [SYSTEM-CONNECTION.md](./SYSTEM-CONNECTION.md).

## Verification / Testing

### Backtest ก่อนเสมอ
1. เปิด Dashboard → เมนู "Backtest"
2. เลือก BNBUSDT 5m, ย้อนหลัง 30 วัน
3. คลิก "▶ รัน"
4. ดู winRate / totalPnl / maxDrawdown

### Live Dry-Run
1. สร้าง Bot ด้วย capital $10/trade 10 ไม้ = $100
2. กด ▶ เริ่ม
3. ดูสถานะในหน้า Bots
4. ตรวจสอบใน Binance ว่า order เป็น LIMIT_MAKER (post-only)

### ตรวจสอบ Signal ในกราฟ
1. เมนู "Chart" → เลือก BNBUSDT 5m, 200 แท่ง
2. ดู S1 markers (ลูกศรเขียวใต้แท่งเทียน)
3. เทียบกับ Binance จริง

## Important Notes

- **ATR ใช้ Wilder RMA** (ไม่ใช่ SMA) — ตรงกับ Pine Script `ta.atr`
- **ตรวจเฉพาะ closed candle** (`k.x === true`)
- **Maker-only**: ใช้ `LIMIT_MAKER` order type — ถ้าจะ match ทันทีจะถูก reject
- **Fee buffer**: sell price = buy × (1 + TP% + 2×makerFee) — เพื่อให้กำไรสุทธิ ≥ TP%
- **Race conditions**: ใช้ clientOrderId deterministic + state guard กัน double-place

## DCA + BEP Stack Mode

**Opt-in alternative** to the 1 BUY → 1 SELL model. Default off (`dcaEnabled: false`) → existing bots 100% unchanged.

### Design (locked-in choices)

- **Single Stack Mode** — 1 bot = 1 open DCA stack at a time (each S1 adds a layer, not a new trade)
- **Per-bot configurable**: `dcaMaxLayers` (default **3**, range 1-100), reuses `capitalPerTrade` per layer
- **BEP** = `totalSpent / totalQty` (weighted average), recomputed on every layer fill
- **SL-UKC on stack BEP** (gated by `autoArmStopLossOnUKC`)
- **CB panic-sell DISABLED** in DCA mode (matches "no cut loss" philosophy)
- **Spot only** — no leverage, no liquidation risk
- **Telegram**: full notifications on every layer BUY + target hit + max-layers hit

### Quick start

1. **Migrate** (one-time, idempotent):
   ```bash
   pm2 stop onepercentbot
   node scripts/migrate-dca-fields.js
   pm2 start onepercentbot
   ```
2. **Edit bot** → enable "📚 DCA + BEP Stack Mode" → set `dcaMaxLayers` (default 3, max 100)
3. **Run** as usual — first S1 opens stack, subsequent S1s add layers until `dcaMaxLayers`
4. **Backtest**: tick "DCA mode" in backtest form → runs `runDcaBacktest` (single-stack simulator)

### Backtest stats (DCA mode)

- `stacksCount` = total stacks opened (NOT layers)
- `dcaTargetHitCount` = TP fills closing whole stack
- `dcaStackStopLossCount` = SL-UKC force-closes
- `dcaMaxLayersHitCount` = signals skipped due to layer cap
- `avgLayersPerStack` = average fill efficiency

### Where to look

- **Bot card** → 📚 DCA/N badge next to bot name
- **Bot detail** → DCA Stack card (BEP, total qty, per-layer table, ❄️ Frozen pill if SELL partial-fill)
- **History** → 📚 L{n} badge on Symbol column + BEP hint under Price
- **PnL modal** → DCA stack rows with layer count + BEP as Entry
- **API**: `GET /api/trades/:id/stack` — resolves layer OR stack _id, returns full stack view
- **Telegram**: `dcaLayerAdded` (every BUY), `dcaTargetHit` (close), `dcaMaxLayersHit` (warning)

### Files involved

| Layer | Files |
|---|---|
| Schema | `src/db/models/Bot.js`, `src/db/models/Trade.js`, `scripts/migrate-dca-fields.js` |
| Trader core | `src/core/trader.js` (helpers: `_isDcaMode`, `_computeStackBEP`, `_computeDcaTp`, `_cancelAndReplaceSell`) |
| Force-close | `src/core/forceClose.js` |
| Backtester | `src/core/backtester.js` (`runDcaBacktest` + DCA pass in `runMultiBacktest`) |
| API | `src/api/routes/bot.routes.js`, `src/api/routes/backtest.routes.js`, `src/api/routes/trade.routes.js` (`/:id/stack`) |
| Telegram | `src/services/telegramNotifier.js` (3 new events) |
| UI | `public/js/pages/bot-edit.js`, `public/js/pages/bots.js`, `public/js/pages/bot-detail.js`, `public/js/pages/history.js`, `public/js/pages/pnl.js`, `public/js/partials/stackCard.js`, `public/js/utils/sellReasons.js`, `public/css/app.css` |

### Race conditions handled

1. 2 BUYs in flight → atomic claim via `dcaLayerIndex` + state='selling'
2. BUY in flight when SELL fills → recheck state in `_handleDcaBuyFilled`
3. Cancel SELL while new BUY placing → `dcaAdding: true` transient lock
4. Bot restart mid-stack → `_reconcileDcaStackOnStart` verifies with Binance
5. SELL partial-fill in DCA → FREEZE policy (no cancel, no MARKET replace)
6. Duplicate WS events → all transitions guarded by atomic-claim with `modifiedCount === 1`

### Backward compatibility

- All new fields have safe defaults (`dcaEnabled: false`, `isDcaStack: false`, `dcaLayerCount: 0`)
- Default `dcaEnabled: false` keeps existing code 100% unchanged
- Migration is idempotent (re-running shows 0 modified)
- Existing CB / SL-UKC / partial-fill / force-close code paths work for non-DCA trades

## License

Private use only.