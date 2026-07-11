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

## Quick Start

### 1. ติดตั้ง MongoDB (local)
```bash
# Windows: ดาวน์โหลดจาก https://www.mongodb.com/try/download/community
# หรือใช้ Docker
docker run -d --name mongodb -p 27017:27017 mongo:7
```

### 2. ติดตั้ง dependencies
```bash
cd e:\NodeJS\OnePercentBotTrade
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
http://localhost:3000
```

ครั้งแรกจะให้ตั้ง password + (optional) ใส่ Binance API keys

## ⚠️ Binance API Key Best Practices

1. ตั้ง permission: **"Enable Spot & Margin Trading" เท่านั้น, ปิด Withdraw**
2. ผูก **IP whitelist** กับ IP เครื่องที่รันบอท
3. ทดสอบกับ **ทุนน้อย** ก่อน (เช่น $10/trade 10 ไม้ = $100)
4. ทำ Backtest ก่อนเสมอ

## Architecture

ดูรายละเอียดใน [C:\Users\asriu\.claude\plans\curious-humming-thacker.md](../../.claude/plans/curious-humming-thacker.md) (plan file)

```
src/
├── server.js          # bootstrap
├── app.js             # Express app
├── db/                # Mongoose models + connection
├── binance/           # REST, WS, symbolInfo, fees
├── core/              # signalEngine, trader, botManager, backtester
├── services/          # eventBus, klineCache, crypto
├── api/routes/        # auth, bots, trades, signals, chart, backtest, account
├── realtime/          # dashboardWs (WebSocket server)
└── utils/             # logger, rateLimiter

public/                # Frontend dashboard (plain HTML/JS)
├── login.html, bots.html, bot-edit.html, chart.html, backtest.html
└── js/, css/
```

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

## License

Private use only.