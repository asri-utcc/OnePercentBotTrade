# OnePercentBotTrade — System Architecture & Internals

เอกสารนี้อธิบายการทำงานภายในของระบบทั้งหมด — ตั้งแต่โครงสร้างไฟล์, data flow, signal engine, trading logic, REST/WebSocket API, การคำนวณ, จนถึง security model

อ่าน [README.md](README.md) ก่อนสำหรับ quick start — เอกสารนี้สำหรับผู้ที่ต้องการ **เข้าใจ/แก้ไข/ขยาย** ระบบ

---

## 📑 สารบัญ

1. [ภาพรวมสถาปัตยกรรม](#1-ภาพรวมสถาปัตยกรรม)
2. [โครงสร้างไฟล์](#2-โครงสร้างไฟล์)
3. [Data Flow ตอนเทรดจริง](#3-data-flow-ตอนเทรดจริง)
4. [Signal Engine (Pine Script v5 → JavaScript)](#4-signal-engine-pine-script-v5--javascript)
5. [Trading Logic — Trader State Machine](#5-trading-logic--trader-state-machine)
6. [Binance REST API Layer](#6-binance-rest-api-layer)
7. [Binance WebSocket Layer](#7-binance-websocket-layer)
8. [การคำนวณ (Math & Fees)](#8-การคำนวณ-math--fees)
9. [Order Precision & Filters](#9-order-precision--filters)
10. [Database Models](#10-database-models)
11. [Authentication & Security](#11-authentication--security)
12. [HTTP API Endpoints](#12-http-api-endpoints)
13. [Dashboard WebSocket](#13-dashboard-websocket)
14. [Backtester Engine](#14-backtester-engine)
15. [Crash Recovery & Reconciliation](#15-crash-recovery--reconciliation)
16. [Health Monitoring](#16-health-monitoring)
17. [Event Bus (Pub/Sub)](#17-event-bus-pubsub)
18. [Process Lifecycle & PM2](#18-process-lifecycle--pm2)
19. [Pitfalls & Design Decisions](#19-pitfalls--design-decisions)

---

## 1. ภาพรวมสถาปัตยกรรม

```
                    ┌──────────────────────────────────────────┐
                    │           Dashboard (Browser)            │
                    │   HTML + Bootstrap + Chart.js (CDN)     │
                    └──┬───────────────────────────┬──────────┘
                       │ HTTP (REST)               │ WebSocket
                       │                           │ /ws/dashboard
                       ▼                           ▼
   ┌────────────────────────────────────────────────────────────┐
   │  Node.js Process (PM2 fork mode)                          │
   │                                                            │
   │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │
   │  │ Express App │  │ Dashboard WS │  │ Health Monitor   │  │
   │  │ (app.js)    │  │ (realtime/)  │  │ (services/)      │  │
   │  └──────┬──────┘  └──────┬───────┘  └──────────────────┘  │
   │         │                │                                 │
   │         ▼                ▼                                 │
   │  ┌──────────────────────────────────────┐                  │
   │  │           Event Bus (Singleton)       │ ← pub/sub       │
   │  └──────────────────────────────────────┘                  │
   │         ▲                ▲                                 │
   │         │                │                                 │
   │  ┌──────┴───────┐ ┌─────┴─────────┐  ┌─────────────────┐   │
   │  │ BotManager   │ │ Binance WS    │  │ Binance REST    │   │
   │  │ (per bot)    │ │ (market +     │  │ (signed/unsigned│   │
   │  │ Trader.js    │ │  user data)   │  │  with rate lim) │   │
   │  └──────┬───────┘ └───────────────┘  └────────┬────────┘   │
   │         │                                       │            │
   │         ▼                                       ▼            │
   │  ┌─────────────────────────────────────────────────────┐    │
   │  │    MongoDB (Local)                                  │    │
   │  │  bots, trades, signals, backtest_results, appconfig │    │
   │  └─────────────────────────────────────────────────────┘    │
   └────────────────────────────────────────────────────────────┘
                            │
                            ▼
                ┌────────────────────────┐
                │   Binance Spot API     │
                │  (api.binance.com)     │
                │  + WebSocket streams   │
                └────────────────────────┘
```

### หลักการสำคัญ

- **Single Node.js process** (PM2 fork mode) — ทุกอย่างอยู่ใน memory เดียวกัน ใช้ in-memory cache ได้
- **Event-driven** — ทุกการเปลี่ยนแปลง (signal, trade update, order fill) ผ่าน `eventBus` แล้วกระจายไปหลาย consumer (Trader, Dashboard WS, HealthMonitor)
- **MongoDB เป็น source of truth** — restart แล้ว reconcile state จาก DB + Binance order status
- **Binance เป็น source of truth สำหรับ fills** — ทุกครั้งที่นับ trade เสร็จ ต้อง verify กับ User Data Stream หรือ poll `/api/v3/order`

---

## 2. โครงสร้างไฟล์

```
OnePercentBotTrade/
├── package.json                    # dependencies + npm scripts
├── ecosystem.config.js             # PM2 config (fork mode, port 6015)
├── .env / .env.example             # secrets (gitignored)
├── README.md                       # quick start
├── system.md                       # ← (ไฟล์นี้)
│
├── config/
│   └── index.js                    # env loader + constants (port, host, fees, intervals)
│
├── src/
│   ├── server.js                   # bootstrap (HTTP + WS + DB + botManager + healthMonitor)
│   ├── app.js                      # Express app (middleware + routes + static + error handler)
│   │
│   ├── db/
│   │   ├── connection.js           # mongoose infinite retry
│   │   └── models/
│   │       ├── AppConfig.js        # singleton: password hash + encrypted API keys
│   │       ├── Bot.js              # bot config (symbol, tf, capital, tp, retry, status)
│   │       ├── Trade.js            # BUY/SELL lifecycle (placed→filled→selling→sold)
│   │       ├── Signal.js           # S1 events log
│   │       └── BacktestResult.js   # backtest simulation outcomes
│   │
│   ├── binance/
│   │   ├── binanceRest.js          # signed/unsigned HTTP + token bucket rate limiter
│   │   ├── binanceWs.js            # combined market WS + user data stream
│   │   ├── symbolInfo.js           # cached exchangeInfo + LOT_SIZE/PRICE_FILTER/NOTIONAL helpers
│   │   └── fees.js                 # fee rate + calcSellPrice + calcPnl
│   │
│   ├── core/
│   │   ├── indicators.js           # EMA, TrueRange, Wilder RMA, ATR
│   │   ├── signalEngine.js         # Keltner Channel + bg_state + S1 detector
│   │   ├── trader.js               # per-bot state machine (maker-only BUY → TP SELL)
│   │   ├── botManager.js           # spawn/stop traders + WS subscription ref-counting
│   │   └── backtester.js           # historical klines → simulate trades
│   │
│   ├── services/
│   │   ├── eventBus.js             # singleton EventEmitter (maxListeners = 100)
│   │   ├── klineCache.js           # rolling 500-candle window per symbol/tf
│   │   ├── crypto.js               # AES-256-GCM encrypt/decrypt for API keys
│   │   └── healthMonitor.js        # 5s heartbeat + 60s Binance ping
│   │
│   ├── api/
│   │   ├── middleware/auth.js      # requireAuth (session.authenticated)
│   │   └── routes/
│   │       ├── auth.routes.js      # /api/auth/{setup,login,logout,me,change-password,api-keys}
│   │       ├── bot.routes.js       # /api/bots CRUD + enable/disable + /symbols
│   │       ├── trade.routes.js     # /api/trades (list + detail)
│   │       ├── signal.routes.js    # /api/signals
│   │       ├── chart.routes.js     # /api/chart/klines (with KC + S1 markers)
│   │       ├── backtest.routes.js  # /api/backtest run + list + detail + delete
│   │       ├── account.routes.js   # /api/account/balance + open-orders
│   │       └── health.routes.js    # /api/health (no auth)
│   │
│   ├── realtime/
│   │   └── dashboardWs.js          # /ws/dashboard — push eventBus events to clients
│   │
│   └── utils/
│       ├── logger.js               # pino + pino-pretty (dev)
│       ├── rateLimiter.js          # Binance weight token bucket (capacity=1200)
│       ├── errorRateLimiter.js     # sliding window (กัน ECONNREFUSED spam)
│       └── loginGuard.js           # brute-force protection สำหรับ /api/auth/login
│
├── public/                         # Frontend dashboard
│   ├── login.html, bots.html, bot-edit.html, chart.html, backtest.html
│   ├── css/app.css
│   └── js/
│       ├── api.js                  # fetch wrapper with cookie credentials
│       ├── ws-client.js            # dashboard WS client
│       └── pages/{bots,bot-edit,chart,backtest}.js
│
├── scripts/
│   └── run-backtest.js             # CLI backtest runner (ไม่ต้องผ่าน HTTP)
│
├── tests/
│   └── signalEngine.test.js        # unit test เทียบ Pine Script
│
└── logs/                           # PM2 stdout/stderr (gitignored)
    ├── pm2-error.log
    └── pm2-out.log
```

---

## 3. Data Flow ตอนเทรดจริง

ลำดับเหตุการณ์ทั้งหมดตั้งแต่ Binance ส่ง kline มาจนบอทได้กำไร:

```
[Binance WS] ──kline:closed──▶ [klineCache.update] ──emit 'kline:closed'──▶ [Trader.onCandleClosed]
                                                                                   │
                                                                                   ▼
                                                                        [signalEngine.checkS1OnLatestCandle]
                                                                                   │
                                                              ┌────────────────────┴────────────────────┐
                                                              ▼                                         ▼
                                                        (S1 detected)                            (no signal)
                                                              │                                         │
                                                              ▼                                         │ return
                                            [บันทึก Signal doc + emit 'signal:new']                    │
                                                              │                                         │
                                                              ▼                                         │
                                              [เช็ค activeTrade + maxTrades]                          │
                                                              │                                         │
                                                              ▼                                         │
                                              [Trader.placeBuy(signal, candle)]                       │
                                                              │                                         │
                                                              ▼                                         │
                                              [symbolInfo.calcQtyFromCapital]                         │
                                              [roundPrice(bid, tickSize)]                             │
                                              [validateOrder]                                         │
                                                              │                                         │
                                                              ▼                                         │
                                              [binanceRest.newOrder(BUY, LIMIT_MAKER)]                │
                                                              │                                         │
                                                              ▼                                         │
                                              [Trade.create(state='placed')]                          │
                                                              │                                         │
                                                              ▼                                         │
                                              [Binance: order pending, sitting in book]                │
                                                              │                                         │
                                            ┌─────────────────────┴─────────────────────┐               │
                                            ▼                                           ▼               │
                              [User Data Stream: FILLED]                  [retryTimeMin minutes]        │
                                            │                                           │               │
                                            ▼                                           ▼               │
                              [handleBuyFilled]                         [checkBuyOrder]                │
                                            │                                           │               │
                                            ▼                                           ▼               │
                              [คำนวณ sellPrice = buy * (1+tp+2f)]         [bestBid ขยับ?]              │
                              [binanceRest.newOrder(SELL)]                  yes → cancel + re-place     │
                                            │                                no → schedule next check    │
                                            ▼                                                            │
                              [Trade.update(state='selling')]                                         │
                                            │                                                            │
                                            ▼                                                            │
                              [Binance: SELL fill]                                                     │
                                            │                                                            │
                                            ▼                                                            │
                              [User Data Stream: FILLED]                                                │
                                            │                                                            │
                                            ▼                                                            │
                              [handleSellFilled]                                                        │
                              [fees.calcPnl]                                                            │
                              [Trade.update(state='sold', realizedPnl, pnlPercent)]                     │
                              [Bot.update(totalPnl, totalTrades, winTrades, status='idle')]              │
                                            │                                                            │
                                            ▼                                                            │
                              [emit 'bot:status' + 'trade:update']                                     │
                                            │                                                            │
                                            ▼                                                            │
                              [dashboardWs กระจาย event ไปยัง browser ผ่าน WS]                          │
```

**จุดสำคัญ**: ทุก async action มี **idempotency guard** ผ่าน `clientOrderId` deterministic — ถ้า reconnect/restart จะไม่ place order ซ้ำ

---

## 4. Signal Engine (Pine Script v5 → JavaScript)

ไฟล์: [src/core/indicators.js](src/core/indicators.js), [src/core/signalEngine.js](src/core/signalEngine.js)

### 4.1 Indicator Functions

#### EMA — Exponential Moving Average

```javascript
// Pine: ta.ema(source, length)
function ema(values, length) {
  const k = 2 / (length + 1);
  // init = SMA of first `length` values
  let prev = sum(values[0..length-1]) / length;
  for (let i = length; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
}
```

#### TrueRange

```javascript
// Pine: ta.tr — true range ของแท่งเดียว
function trueRange(high, low, prevClose) {
  const hl = high - low;
  if (!prevClose) return hl;            // แท่งแรก: tr = high - low
  return Math.max(hl, |high - prevClose|, |low - prevClose|);
}
```

#### RMA — Wilder's Smoothing (สำคัญมาก!)

```javascript
// Pine: ta.rma(source, length) — เหมือน ta.atr เมื่อ source = tr
// ต่างจาก SMA และ EMA ตรงนี้:
//   - first value = SMA of first N
//   - subsequent = (prev * (N-1) + current) / N
// ถ้าใช้สูตรผิด (เช่นคิดว่าเป็น SMA) → สัญญาณเพี้ยนทั้งระบบ
function rma(values, length) {
  let prev = sum(values[0..length-1]) / length;
  for (let i = length; i < values.length; i++) {
    prev = (prev * (length - 1) + values[i]) / length;
  }
}
```

#### ATR = Wilder RMA ของ TrueRange

```javascript
function atr(highs, lows, closes, length) {
  const tr = trueRangeSeries(highs, lows, closes);
  return rma(tr, length);
}
```

### 4.2 Keltner Channel

```javascript
const KC_LEN = 20;    // EMA period + ATR period
const KC_MULT = 1.5;  // multiplier

basisKC = ema(close, KC_LEN)
rngKC   = atr(20)                     // Wilder RMA-based
upperKC = basisKC + KC_MULT * rngKC
lowerKC = basisKC - KC_MULT * rngKC
```

### 4.3 bg_state (Background Color)

แต่ละแท่งจะถูกจัดเป็น zone:

| bg_state | เงื่อนไข                          | สี (Pine)  |
|---------:|----------------------------------|------------|
| **1**    | `close > upperKC`                | 🟢 Strong Up (green)  |
| **2**    | `lowerKC < close < basisKC`      | 🟣 Weak Down (purple) |
| **3**    | `close < lowerKC`                | 🔴 Strong Down (red)  |
| **0**    | `close == basisKC` หรือ edge case| ไม่ระบายสี |

⚠️ **Pine Script ที่มาของโค้ดนี้** อาจนับเงื่อนไขเป็น `close < basisKC and close > lowerKC` เท่านั้น — ถ้า close ≥ basisKC แต่ ≤ upperKC จะได้ `bg_state = 0` (ไม่จัดอยู่ใน zone ใดเลย — เป็น "neutral zone")

### 4.4 S1 Signal

**S1 คือ transition จาก Weak Down (bg=2) → ย้ายออกไป Strong Up (bg=1) หรือ Strong Down (bg=3)**

```
S1 = (bg_prev == 2) AND (bg_curr == 1 OR bg_curr == 3)
```

ในทางปฏิบัติ:
- ราคาเคยอ่อน (อยู่ใต้ EMA แต่เหนือ lower band)
- → แล้วกระโดดขึ้นเหนือ upper band (bg=1, breakout) หรือ ทะลุ lower band ลงล่าง (bg=3, breakdown)
- → ตำแหน่งนี้คือ **S1 entry signal**

**ทำไมไม่ใช้ S2**: ตามแผนเดิม S2 เป็นอีก pattern ที่ Pine author นิยามไว้ แต่ user เลือกใช้แค่ S1 (เพราะ backtest แล้วให้ผลดีกว่า)

### 4.5 การเรียกใช้

```javascript
// ทั้ง backtest และ live ใช้ฟังก์ชันเดียวกัน → ผลต้องตรงกัน
const { signals, basis, upper, lower, bg } = signalEngine.detectS1Signals(klines);

// สำหรับ live: ตรวจแค่แท่งล่าสุด (เร็วกว่า, กัน backfill ยิงย้อนหลัง)
const latestSignal = signalEngine.checkS1OnLatestCandle(klines);

// Warm-up check (ต้องมีอย่างน้อย 2*KC_LEN = 40 แท่ง)
const ready = signalEngine.isWarmedUp(klineCache.size(symbol, timeframe));
```

### 4.6 Pitfall: ตรวจเฉพาะ closed candle

`Trader.onCandleClosed()` รับ event เฉพาะเมื่อ `k.x === true` (candle ปิดแล้ว) — ห้าม trigger ตอนแท่งยังวิ่ง เพราะ:
1. close price ยังไม่ final → bg_state คำนวณผิด
2. signal จะ re-trigger ทุกครั้งที่ price update (TPS flood)

ดู [src/binance/binanceWs.js:134-153](src/binance/binanceWs.js#L134) — `isFinal = k.x === true`

---

## 5. Trading Logic — Trader State Machine

ไฟล์: [src/core/trader.js](src/core/trader.js)

### 5.1 States

```
       ┌─────────────────────────────────────────────────────────────┐
       │                                                             │
       ▼                                                             │
    ┌──────┐  S1 detected + slot ว่าง    ┌──────────────────┐        │
    │ idle │ ────────────────────────▶ │   waiting_fill   │        │
    └──────┘                             │  (BUY pending)    │        │
       ▲                                 └──────┬───────────┘        │
       │                                        │                    │
       │                  ┌─────────────────────┴────────────┐       │
       │                  │                                  │       │
       │                  ▼                                  ▼       │
       │  bestBid ไม่ขยับ                          FILLED          │
       │  (ทุก retryTimeMin)                          │             │
       │                  │                            ▼             │
       │                  ▼                ┌──────────────────┐     │
       │      ┌──────────────────┐         │     selling      │     │
       │      │   retrying       │         │  (SELL pending)  │     │
       │      │  (cancel+replace)│         └────────┬─────────┘     │
       │      └────────┬─────────┘                  │               │
       │               │                            ▼               │
       │               │                  ┌──────────────────┐     │
       │               │                  │      sold        │ ────┘
       │               ▼                  │ (realizedPnl OK) │
       │         bestBid ขยับ             └──────────────────┘
       │         เกิน threshold
       │
       │
       │      partial fill / cancel fail / SELL rejected
       ▼
    ┌──────────┐
    │  failed  │ → บันทึก error + reset currentTrade
    └──────────┘
```

### 5.2 BUY Logic — Maker-Only Post-Only

```javascript
// 1. ใช้ราคา bid ล่าสุด (จาก @bookTicker stream) เป็น buyPrice
const bid = currentBookTicker ? currentBookTicker.bid : candle.close;

// 2. คำนวณ qty จาก capitalPerTrade / bid แล้ว floor ตาม stepSize
const { qty } = symbolInfo.calcQtyFromCapital({ symbol, capitalUSDT: 10, price: bid });

// 3. round price ตาม tickSize
const buyPrice = symbolInfo.roundPrice(bid, tickSize).toString();

// 4. validate (LOT_SIZE, PRICE_FILTER, NOTIONAL)
const validation = symbolInfo.validateOrder({ symbol, price: buyPrice, qty });
if (!validation.ok) throw new Error(validation.reason);

// 5. สร้าง deterministic clientOrderId (idempotency กัน double-place ตอน reconnect)
const clientOrderId = makeClientOrderId('buy', candle.closeTime, 0);  // → "bXXXXX-1700000000000-0-buy"

// 6. วาง LIMIT_MAKER BUY (post-only) — ถ้าราคาจะ match ทันที Binance จะ reject
const orderResp = await binanceRest.newOrder({
  symbol, side: 'BUY', type: 'LIMIT_MAKER',
  quantity: qty, price: buyPrice, newClientOrderId: clientOrderId,
  recvWindow: 5000,
});

// 7. บันทึก Trade doc, schedule retry check ตาม retryTimeMin
await scheduleRetryCheck(candle, signalDoc);
```

**ทำไมใช้ LIMIT_MAKER (post-only)**:
- ถ้า price จะ match ทันทีกับ order ฝั่งตรงข้าม → Binance จะ reject แทนที่จะ fill
- บอทจะได้ **maker fee** (0.075% ถ้าจ่าย BNB, 0.1% ถ้าไม่) ตลอด — ต่างจาก market order ที่จ่าย taker fee

### 5.3 Retry Logic (ทุก retryTimeMin นาที)

```javascript
// scheduleRetryCheck ตั้ง setTimeout(retryTimeMin * 60_000) → เรียก checkBuyOrder
async checkBuyOrder(signalDoc, candle) {
  const order = await binanceRest.getOrder({ symbol, orderId: trade.buyOrderId });

  // Status A: FILLED → handleBuyFilled (ไป step ขาย)
  // Status B: PARTIALLY_FILLED → handlePartialBuyFill (เอาส่วนที่ได้ไปขายเลย)
  // Status C: NEW/PENDING → เช็คว่า best bid ขยับไหม + retryMax เหลือไหม

  const newBid = currentBookTicker?.bid;
  const priceDiff = Math.abs(newBid - originalPrice) / originalPrice;
  const retryMax = this.bot.retryMax ?? 1;
  const remaining = retryMax - (trade.retryCount || 0);

  if (newBid && priceDiff > 0.000001 && remaining > 0) {  // 0.0001% threshold + retry เหลือ
    // bid ขยับ + retry เหลือ → cancel + re-place @ newBid
    await binanceRest.cancelOrder({ symbol, orderId: trade.buyOrderId });
    // re-query order อีกครั้ง กัน race (อาจ fill พอดีระหว่าง cancel)
    const reCheck = await binanceRest.getOrder({ symbol, orderId });
    if (reCheck.status === 'FILLED') return handleBuyFilled(reCheck);
    // สร้าง Trade doc ใหม่ (retryCount++)
    await rePlaceBuy(prevTrade, signalDoc, candle, newBid);
  } else if (newBid && priceDiff > 0.000001 && remaining <= 0) {
    // bid ขยับ แต่ retryMax หมดแล้ว → cancel + signal expired (จบรอบ)
    await binanceRest.cancelOrder({ symbol, orderId: trade.buyOrderId });
    await Trade.updateOne({ _id: trade._id }, { state: 'cancelled', error: `retryMax ${retryMax} reached` });
    await Signal.updateOne({ _id: signalDoc._id }, { outcome: 'expired', note: `retryMax ${retryMax} reached, bid moved` });
    this.currentTrade = null;
  } else {
    // bid ยังอยู่ที่เดิม (order ยังเป็น best bid) → schedule retry รอบถัดไป
    scheduleRetryCheck(candle, signalDoc);
  }
}
```

**retryMax** (ค่า default = 1) ควบคุมจำนวนครั้งที่อนุญาตให้วาง BUY ใหม่:
- `retryMax=0` → วางครั้งเดียว ไม่ retry
- `retryMax=1` → วางได้อีก 1 ครั้งถ้า bid ขยับ (ค่า default)
- `retryMax=N` → วางใหม่ได้สูงสุด N ครั้ง
- ถ้า bid ขยับเกิน retryMax → cancel order + signal `expired` (ไม่วาง SELL)

### 5.3.1 Pre-flight USDT Balance Check

ก่อน place BUY ทุกครั้ง จะตรวจ USDT balance:

```javascript
const requiredNotional = parseFloat(buyPrice) * parseFloat(qty);
const requiredWithBuffer = requiredNotional * (1 + feeRate);  // fee buffer 1 ขา

const account = await binanceRest.getAccount();
const usdtBal = (account.balances || []).find((b) => b.asset === 'USDT');
const freeUsdt = usdtBal ? parseFloat(usdtBal.free) : 0;

if (freeUsdt < requiredWithBuffer) {
  // skip signal, log lastError, ไม่ place order
  return;
}
```

ถ้า fetch balance fail (เช่น API key ไม่มี "Enable Reading") → log warning แต่ไม่ block (ไปต่อ)

### 5.4 SELL Logic — TP Calculation

```javascript
// ทันทีที่ BUY fill → คำนวณ sellPrice แล้ววาง SELL ทันที
async handleBuyFilled(trade, order, signalDoc) {
  const avgPrice = order.price || order.cummulativeQuoteQty / order.executedQty;
  const feeRate = fees.getMakerRate();      // 0.00075 (BNB) หรือ 0.001

  // ─── สูตร sellPrice ─────────────────────────────────────────────
  // sellPrice = buyPrice * (1 + tpPercent/100 + 2*feeRate)
  //
  // เหตุผล: เราจ่าย fee 2 ขา (ตอนซื้อ + ตอนขาย)
  // ถ้าตั้ง TP 0.1% เฉยๆ → หลังหัก fee 2 ขา = 0.1% - 0.15% = -0.05% (ขาดทุน)
  // ดังนั้นต้องบวก fee buffer เข้าไปในราคาเป้าหมายด้วย
  const sellPrice = fees.calcSellPrice({ buyPrice: avgPrice, tpPercent: 0.1, feeRate });

  // ปัดราคาตาม tickSize (Binance requirement)
  const sellPriceFinal = symbolInfo.roundPrice(sellPrice, tickSize);

  // วาง LIMIT_MAKER SELL (post-only เหมือนกัน — ต้องการ maker fee)
  await binanceRest.newOrder({ side: 'SELL', type: 'LIMIT_MAKER', price: sellPriceFinal });
}
```

**ตัวอย่างตัวเลขจริง** (BNBUSDT, TP 0.1%, BNB fee 0.075%):
- Buy at 701.39
- sellPriceRaw = 701.39 × (1 + 0.001 + 2 × 0.00075) = 701.39 × 1.0025 = **703.14248**
- หลังปัด tickSize: 703.49417 (ปัดขึ้นเพื่อความปลอดภัย)
- เมื่อ fill ที่ 703.49417:
  - gross = (703.49417 - 701.39) × 0.014 = **0.02946**
  - fees = (701.39 + 703.49417) × 0.014 × 0.00075 = **0.01967**
  - net (realizedPnl) = 0.02946 - 0.01967 = **0.00979 USDT**
  - pnlPercent = 0.00979 / (701.39 × 0.014) × 100 = **0.0997%**

### 5.5 SELL Filled Handler

```javascript
// onSellOrderUpdate (จาก User Data Stream) → handleSellFilled
async handleSellFilled(update) {
  const pnl = fees.calcPnl({
    buyPrice: trade.buyPrice,
    sellPrice: update.avgPrice,
    qty: update.executedQty,
    feeRate: fees.getMakerRate(),
  });

  await Trade.updateOne({ _id: trade._id }, {
    state: 'sold',
    sellStatus: 'FILLED',
    sellPrice, sellQty, sellQuoteQty,
    sellFilledAt: new Date(update.ts),
    realizedPnl: pnl.net,
    pnlPercent: pnl.pnlPercent,
  });

  // อัปเดต bot stats สะสม
  await Bot.updateOne({ _id: trade.botId }, {
    $inc: { totalPnl: pnl.net, totalTrades: 1, winTrades: pnl.net > 0 ? 1 : 0 },
    status: 'idle',
  });

  this.currentTrade = null;   // พร้อมรับ signal ใหม่
}
```

### 5.6 SELL Failed / Validation Failed → "Holding" State

ถ้า SELL rejected (เช่น balance ไม่พอ หรือ price validation fail):
```javascript
await Trade.updateOne({ _id: trade._id }, {
  state: 'holding',                 // ไม่ใช่ failed — แค่รอ
  targetSellPrice: parseFloat(sellPrice),
  error: '...',
});
// ไม่ reset currentTrade → บอทจะพยายามวาง SELL ใหม่ใน retry รอบถัดไป
```

---

## 6. Binance REST API Layer

ไฟล์: [src/binance/binanceRest.js](src/binance/binanceRest.js)

### 6.1 Rate Limiter (Token Bucket)

```javascript
class RateLimiter {
  constructor({ capacity = 1200, refillPerMs = 1200/60000 }) {
    // capacity = 1200 tokens (Binance weight limit per minute)
    // refill = 1200/60000 = 0.02 tokens/ms = 20 tokens/sec
  }

  async take(weight = 1) {
    // ถ้า tokens < weight → รอ refill จนพอ
    // ทุก response จะอ่าน X-MBX-USED-WEIGHT-1M header → tokens = capacity - used
  }
}
```

**ทุก Binance call** ต้องเรียก `limiter.take(weight)` ก่อน โดย weight ขึ้นกับ endpoint:
- `/api/v3/order` (POST): weight=1
- `/api/v3/order` (DELETE): weight=1
- `/api/v3/order` (GET): weight=4
- `/api/v3/klines`: weight=2
- `/api/v3/exchangeInfo` (1 symbol): weight=20
- `/api/v3/account`: weight=20

ถ้าใช้ weight เกิน 80% → log warning

### 6.2 Signed Request

```javascript
async function signedRequest(method, path, params, weight) {
  await limiter.take(weight);
  const q = { ...params, recvWindow: 5000, timestamp: Date.now() };

  // HMAC-SHA256 signature
  const qs = new URLSearchParams(q).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
  const url = `${path}?${qs}&signature=${signature}`;

  // method ใช้ query string ทั้งหมด (Binance ต้องการแบบนี้)
  const resp = method === 'GET'
    ? await http.get(url)
    : await http.post(url, '');
  return resp.data;
}
```

**Pitfall**: Binance ต้อง signature ครอบคลุม **ทั้ง recvWindow และ timestamp** ที่เพิ่มเข้าไป ไม่ใช่แค่ params เดิม

### 6.3 Endpoints ที่ใช้

| Method | Path | Auth | ใช้ที่ไหน |
|--------|------|------|----------|
| GET | `/api/v3/ping` | - | healthMonitor (ทุก 60s) |
| GET | `/api/v3/time` | - | (ไม่ได้ใช้ในปัจจุบัน) |
| GET | `/api/v3/exchangeInfo` | - | symbolInfo.loadSymbol + listSymbols |
| GET | `/api/v3/klines` | - | chart + backtest + botManager.seedKlines |
| GET | `/api/v3/account` | signed | /api/account/balance |
| POST | `/api/v3/order` | signed | trader.placeBuy + handleBuyFilled |
| DELETE | `/api/v3/order` | signed | trader.cancelOrder |
| GET | `/api/v3/order` | signed | trader.checkBuyOrder + reconcilePendingTrades |
| GET | `/api/v3/openOrders` | signed | /api/account/open-orders |
| DELETE | `/api/v3/openOrders` | signed | /api/account/open-orders (cancel all) |
| POST | `/api/v3/userDataStream` | - | binanceWs.userDataWs.start |
| PUT | `/api/v3/userDataStream?listenKey=X` | - | keepalive ทุก 30 นาที |
| DELETE | `/api/v3/userDataStream?listenKey=X` | - | closeListenKey ตอน shutdown |

### 6.4 Error Mapping

```javascript
function formatBinanceError(err) {
  // axios err.response.data จะเป็น { code: -2011, msg: "Unknown order" }
  return {
    status: err.response?.status,
    code: err.response?.data?.code,
    msg: err.response?.data?.msg || err.message,
    raw: err.response?.data,
  };
}
```

Error codes ที่ต้องจัดการพิเศษ:
- `-1021` timestamp out of sync → แก้ด้วย server time sync
- `-1013` filter failure → เช็ค qty/price validation
- `-2010` new order rejected → ดู msg (อาจเป็น insufficient balance)
- `-2011` unknown order → อาจถูก fill/cancel ไปแล้ว
- `-1003` too many requests → rate limit โดนตรง

---

## 7. Binance WebSocket Layer

ไฟล์: [src/binance/binanceWs.js](src/binance/binanceWs.js)

### 7.1 Market WebSocket (Combined Stream)

URL: `wss://stream.binance.com:9443/stream`

ใช้ **JSON-RPC** (`SUBSCRIBE`/`UNSUBSCRIBE`) — ไม่ใช่ static URL subscription เพราะ:
- เพิ่ม/ลด subscription แบบ dynamic ได้
- รองรับ multiple streams ใน connection เดียว

**Streams ที่ใช้ต่อ symbol/tf**:
- `<symbol>@kline_<interval>` — สำหรับ signal detection
- `<symbol>@bookTicker` — สำหรับ bid price (real-time best bid)

### 7.2 Reference Counting

ป้องกันการ subscribe/unsubscribe ซ้ำเมื่อมีหลาย bot ใช้ symbol/tf เดียวกัน:

```javascript
subscribeMarket('BNBUSDT', '5m') {
  // increment refCount ของทั้ง kline stream และ bookTicker stream
  // ถ้า refCount 0 → 1 → ส่ง SUBSCRIBE message
  // ถ้า refCount > 0 → แค่ increment
}

unsubscribeMarket('BNBUSDT', '5m') {
  // decrement
  // ถ้า refCount กลับเป็น 0 → ส่ง UNSUBSCRIBE
}
```

**ตัวอย่าง**: 2 bots ใช้ BNBUSDT 5m → WS subscribe 1 ครั้ง (refCount=2) ปิด bot แรก → refCount=1 (ไม่ unsubscribe) ปิด bot ที่ 2 → refCount=0 (unsubscribe)

### 7.3 Auto-Reconnect

```javascript
scheduleReconnect() {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
  const wait = Math.min(1000 * 2 ** (reconnectAttempts - 1), 30000);
  setTimeout(() => connect(), wait);
}
```

เมื่อ reconnect สำเร็จ → re-subscribe streams ทั้งหมดที่ค้างอยู่ (`subscriptions.keys()`) + flush pending messages

### 7.4 Ping/Pong

Binance ส่ง ping frame ทุก 10 นาที ถ้าไม่ตอบ pong → ตัด connection

```javascript
ws.on('ping', (data) => {
  ws.pong(data);  // ตอบทันที
});
```

### 7.5 User Data Stream (ListenKey)

URL: `wss://stream.binance.com:9443/ws/<listenKey>`

ใช้สำหรับรับ order fill/update events แบบ real-time (ไม่ต้อง poll):

```javascript
async start() {
  this.listenKey = await binanceRest.createListenKey();
  this.connect();
  this.keepaliveTimer = setInterval(() => this.keepalive(), 30 * 60 * 1000);
}

handleMessage(msg) {
  if (msg.e === 'executionReport') {
    eventBus.emit('order:update', {
      symbol: msg.s,
      clientOrderId: msg.c,
      orderId: msg.i,
      side: msg.S,
      status: msg.X,                    // NEW/PARTIALLY_FILLED/FILLED/CANCELED
      executedQty: parseFloat(msg.z),
      cumulativeQuoteQty: parseFloat(msg.Z),
      avgPrice: parseFloat(msg.ap),
      ts: msg.T,
    });
  }
}
```

**ListenKey expire 60 นาที** — keepalive ทุก 30 นาที ถ้า keepalive fail → reconnect ด้วย listenKey ใหม่

### 7.6 KlineCache

ไฟล์: [src/services/klineCache.js](src/services/klineCache.js)

เก็บ **rolling window 500 candles** ต่อ symbol/tf (Map keyed by `${symbol}:${tf}`)

```javascript
update(kline, { isFinal }) {
  // ถ้าเป็นแท่งใหม่ (openTime ต่างจากแท่งสุดท้าย) → push
  // ถ้าเป็นแท่งเดิม → อัปเดต (close, high, low เปลี่ยน)
  // ถ้า isFinal (x === true) → emit 'kline:closed'
}
```

ทำไมต้องมี cache: เวลา signal detection ต้องใช้ข้อมูลย้อนหลัง ≥ 40 แท่ง (warm-up) แต่ Binance WS ส่งทีละแท่ง — เลยต้อง cache

---

## 8. การคำนวณ (Math & Fees)

ไฟล์: [src/binance/fees.js](src/binance/fees.js)

### 8.1 Fee Rate

```javascript
function getMakerRate({ useBnbForFees = null } = {}) {
  const useBnb = useBnbForFees ?? config.binance.useBnbForFees;
  return useBnb ? 0.00075 : 0.0010;
  // BNB rate: 0.075% maker
  // Normal:  0.1%   maker
}
```

ค่า config ใน `config/index.js`:
```javascript
fees: {
  bnbMaker:    0.00075,
  bnbTaker:    0.00075,
  normalMaker: 0.001,
  normalTaker: 0.001,
}
```

### 8.2 calcSellPrice — คำนวณราคาขายเพื่อกำไรสุทธิ ≥ TP

```javascript
function calcSellPrice({ buyPrice, tpPercent, feeRate }) {
  // sellPrice = buyPrice × (1 + tpPercent/100 + 2 × feeRate)
  //
  // ตัวอย่าง: buyPrice=100, tpPercent=0.1, feeRate=0.00075 (BNB)
  // sellPrice = 100 × (1 + 0.001 + 0.0015) = 100.25
  //
  // เมื่อ fill ที่ 100.25:
  //   gross = (100.25 - 100) × qty = 0.25 × qty
  //   fees  = (100 + 100.25) × qty × 0.00075 = 0.1502 × qty
  //   net   = 0.25 - 0.1502 = 0.0998 × qty  ← ได้กำไรสุทธิ 0.0998%
  //   target = 0.1% (เกือบเป๊ะ ส่วนต่างคือ rounding error จาก tickSize)
  return buyPrice * (1 + tpPercent / 100 + 2 * feeRate);
}
```

**เหตุผลต้องบวก fee buffer**:
- ถ้าตั้ง TP = 0.1% แต่ไม่บวก fee → หลังหัก fee 2 ขา (0.15%) จะ **ขาดทุนสุทธิ 0.05%**
- ดังนั้น sellPrice ต้องสูงกว่า buyPrice อย่างน้อย tp% + 2×fee เพื่อให้ net = tp%

### 8.3 calcPnl — คำนวณกำไร/ขาดทุนสุทธิ

```javascript
function calcPnl({ buyPrice, sellPrice, qty, feeRate }) {
  const gross     = (sellPrice - buyPrice) * qty;                              // กำไรดิบ (USDT)
  const fees      = (buyPrice + sellPrice) * qty * feeRate;                   // รวม fee 2 ขา
  const net       = gross - fees;                                              // กำไรสุทธิ
  const notional  = buyPrice * qty;
  const pnlPercent = notional > 0 ? (net / notional) * 100 : 0;               // % เทียบ notional
  return { gross, fees, net, pnlPercent, notional };
}
```

**Decimal.js**: ใช้ `decimal.js` สำหรับ qty/price calculation ทั้งหมด เพื่อหลีกเลี่ยง float error (เช่น `0.1 + 0.2 !== 0.3`)

---

## 9. Order Precision & Filters

ไฟล์: [src/binance/symbolInfo.js](src/binance/symbolInfo.js)

### 9.1 การโหลด Symbol Info

เรียก `/api/v3/exchangeInfo?symbol=XXX` (weight=20) แล้ว cache ไว้ใน Map

```javascript
async function loadSymbol(symbol, { force = false } = {}) {
  // 1. เรียก getExchangeInfo
  // 2. pick filter LOT_SIZE, PRICE_FILTER, NOTIONAL
  // 3. parse เป็น Decimal
  // 4. cache
}
```

ใช้ `loadingPromises` Map กัน race condition ถ้ามีการโหลด symbol เดียวกันพร้อมกัน

### 9.2 Filter Types

**LOT_SIZE** (qty):
- `minQty` — ขั้นต่ำ เช่น BNBUSDT = 0.000001
- `maxQty` — สูงสุด เช่น BNBUSDT = 9000
- `stepSize` — granularity เช่น BNBUSDT = 0.001 (precision 3)

**PRICE_FILTER** (price):
- `minPrice`, `maxPrice`
- `tickSize` — granularity เช่น BNBUSDT = 0.01 (precision 2)

**NOTIONAL** (qty × price):
- `minNotional` — ขั้นต่ำ เช่น BNBUSDT = 10 USDT

### 9.3 Round Helpers

```javascript
// qty — floor (ปัดลงเสมอ) เพื่อไม่ให้เกิน balance
function roundQty(qty, stepSize) {
  return new Decimal(qty).div(stepSize).floor().mul(stepSize);
}

// price — round (ปัดใกล้สุด)
function roundPrice(price, tickSize) {
  return new Decimal(price).div(tickSize).round().mul(tickSize);
}
```

**เหตุผล**: Binance จะ reject ถ้า qty/price ไม่ใช่ multiple ของ stepSize/tickSize — เราต้อง round ก่อนส่ง

### 9.4 validateOrder

เช็คทุกครั้งก่อน place order:

```javascript
function validateOrder({ symbol, price, qty }) {
  const info = getCached(symbol);
  const errors = [];

  // 1. LOT_SIZE
  if (qty < minQty) errors.push(...);
  if (qty > maxQty) errors.push(...);
  if (!isInteger(qty / stepSize)) errors.push(...);

  // 2. PRICE_FILTER
  if (price < minPrice) errors.push(...);
  if (price > maxPrice) errors.push(...);
  if (!isInteger(price / tickSize)) errors.push(...);

  // 3. NOTIONAL
  const notional = qty * price;
  if (notional < minNotional) errors.push(...);

  return errors.length === 0 ? { ok: true } : { ok: false, reason: errors.join('; ') };
}
```

### 9.5 calcQtyFromCapital

```javascript
function calcQtyFromCapital({ symbol, capitalUSDT, price }) {
  const rawQty = new Decimal(capitalUSDT).div(new Decimal(price));
  const qty = roundQty(rawQty, stepSize);    // floor ตาม stepSize
  return { qty: qty.toString(), precision: getPrecision(stepSize) };
}
```

ตัวอย่าง BNBUSDT @ $700, capital $10:
- rawQty = 10 / 700 = 0.0142857...
- stepSize = 0.001 → qty = floor(14.2857) × 0.001 = 14 × 0.001 = **0.014**
- notional = 0.014 × 700 = $9.80 (≥ minNotional $10? → ถ้าไม่ถึง skip)

---

## 10. Database Models

### 10.1 AppConfig (Singleton)

เก็บ: `passwordHash` (bcrypt), encrypted API keys, `useBnbForFees`, `setupCompleted`

Encryption: AES-256-GCM — เก็บ `ciphertext`, `iv`, `authTag` แยกกัน 3 fields ต่อ key

```javascript
// src/services/crypto.js
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: ..., iv: ..., authTag: ... };
}
```

**Key derivation**:
- ถ้า ENCRYPTION_KEY เป็น hex 64 chars → ใช้ตรงๆ (32 bytes)
- ถ้าเป็น string ทั่วไป → SHA-256 hash ให้ได้ 32 bytes

### 10.2 Bot

Fields สำคัญ:
- `symbol`, `timeframe` — คู่เทรด
- `capitalPerTrade` (default 10 USDT), `maxTrades` (default 10), `tpPercent` (default 0.1%), `retryTimeMin` (default 1)
- `enabled` (boolean) — สั่ง enable แล้ว spawn trader
- `status` (idle / waiting_fill / holding / selling / error / disabled)
- `totalPnl`, `totalTrades`, `winTrades` — สถิติสะสม
- Virtual `totalCapital = capitalPerTrade × maxTrades`

### 10.3 Trade

State machine ของ 1 trade (1 BUY → 1 SELL):

```
placed → filled → selling → sold
   │        │         │
   ▼        ▼         ▼
retrying  holding   holding (ถ้า SELL reject)
   │
   ▼
cancelled

failed — error ร้ายแรง
```

### 10.4 Signal

Log ทุก S1 ที่เจอ — `outcome` enum:
- `detected` → `order_placed` → `filled` (ถ้า BUY fill สำเร็จ)
- `detected` → `expired` (ถ้า retry หมด)
- `detected` → `failed` (ถ้า error)
- `detected` → `skipped` (ถ้า slot เต็ม / active trade)

### 10.5 BacktestResult

เก็บทั้ง summary stats + array ของ trades (cap 500: เก็บ 250 แรก + 250 หลัง ถ้าเกิน)

---

## 11. Authentication & Security

### 11.1 Session-based Auth

ใช้ `express-session` + `connect-mongo` (เก็บ session ใน MongoDB)

```javascript
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,                    // JS อ่านไม่ได้ (กัน XSS)
    maxAge: 7 * 24 * 60 * 60 * 1000,   // 7 วัน
    sameSite: 'lax',                   // กัน CSRF บางส่วน
    secure: false,                     // TODO: ตั้ง 'auto' ถ้าใช้ HTTPS
  },
  store: MongoStore.create({
    mongoUrl: config.mongoUri,
    collectionName: 'sessions',
    ttl: 7 * 24 * 60 * 60,
  }),
}));
```

### 11.2 Password Hashing

bcrypt cost factor 10 (default):

```javascript
configDoc.passwordHash = await bcrypt.hash(password, 10);
const ok = await bcrypt.compare(password, configDoc.passwordHash);
```

### 11.3 Login Brute-Force Protection

ไฟล์: [src/utils/loginGuard.js](src/utils/loginGuard.js)

In-memory sliding window:
- **10 failed attempts / 15 minutes** → IP ถูก lock **15 นาที**
- IP ตรวจจาก `req.ip` หรือ `X-Forwarded-For` header (กรณี reverse proxy)
- ตอน locked → return 429 พร้อม `Retry-After` header

```javascript
const lockStatus = loginGuard.check(ip);
if (lockStatus.locked) {
  res.set('Retry-After', String(lockStatus.retryAfterSec));
  return res.status(429).json({ error: `...` });
}
// ... bcrypt.compare ...
if (!ok) {
  loginGuard.recordFail(ip);
  // ... check again, return 429 if newly locked
}
loginGuard.recordSuccess(ip);  // reset counter
```

**ข้อจำกัด**: ใช้ in-memory (ไม่ใช่ Redis) — ถ้าใช้ PM2 cluster mode ต้องเปลี่ยนเป็น Redis

### 11.4 Setup Endpoint Guard

[src/api/routes/auth.routes.js](src/api/routes/auth.routes.js) — `/api/auth/setup` ตรวจก่อนทำงาน:
- ถ้า `setupCompleted = true` แล้ว → return **404** (ไม่เปิดเผยว่ามี endpoint)
- ป้องกันไม่ให้คน reset password ผ่าน setup อีกครั้ง

### 11.5 Security Headers (inline)

ไม่ใช้ helmet lib — เขียน middleware เล็กๆ ใน [src/app.js](src/app.js):

```javascript
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');  // OWASP แนะนำปิด — buggy
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max=31536000; includeSubDomains');
  }
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});
```

### 11.6 Host Binding

Server bind ตาม `HOST` env (default `127.0.0.1` = localhost only ปลอดภัย):

```javascript
// src/server.js
server.listen(config.port, config.host, () => { ... });
```

ถ้าจะ forward port ผ่าน router → ตั้ง `HOST=0.0.0.0` ใน `.env` (พร้อมตั้ง rate limit + fail2ban)

---

## 12. HTTP API Endpoints

ทุก route (ยกเว้น `/api/auth/*` และ `/api/health`) ต้องผ่าน `requireAuth` middleware

### 12.1 Auth Routes (`/api/auth`)

| Method | Path | Auth | คำอธิบาย |
|--------|------|------|---------|
| GET | `/status` | - | เช็คว่า setup แล้ว + login แล้ว |
| POST | `/setup` | - | ตั้ง password + API keys (ครั้งแรก) — return 404 หลังเสร็จ |
| POST | `/login` | - | login → set session — มี brute-force protection |
| POST | `/logout` | - | destroy session |
| GET | `/me` | - | เช็ค login status |
| POST | `/change-password` | ✓ | เปลี่ยน password |
| PUT | `/api-keys` | ✓ | อัปเดต Binance API keys (encrypt) |
| GET | `/api-keys/status` | ✓ | เช็คว่าตั้ง keys แล้ว |

### 12.2 Bot Routes (`/api/bots`)

| Method | Path | คำอธิบาย |
|--------|------|---------|
| GET | `/symbols` | list symbols USDT ที่ trade ได้ (cache 5 นาที) |
| GET | `/` | list ทุก bot + totalCapital |
| GET | `/:id` | bot detail |
| POST | `/` | สร้าง bot — validate symbol + minNotional |
| PUT | `/:id` | แก้ไข — restart trader ถ้า enabled |
| DELETE | `/:id` | ลบ — stop trader ก่อน |
| POST | `/:id/enable` | enable → spawnTrader |
| POST | `/:id/disable` | disable → stopTrader |

### 12.3 Trade Routes (`/api/trades`)

| Method | Path | คำอธิบาย |
|--------|------|---------|
| GET | `/?botId=&symbol=&state=&limit=` | filter trades |
| GET | `/:id` | trade detail |

### 12.4 Signal Routes (`/api/signals`)

| Method | Path | คำอธิบาย |
|--------|------|---------|
| GET | `/?symbol=&timeframe=&botId=&limit=` | filter signals (default limit 100) |

### 12.5 Chart Routes (`/api/chart`)

| Method | Path | คำอธิบาย |
|--------|------|---------|
| GET | `/klines?symbol=&timeframe=&limit=` | klines + KC bands + bg_states + S1 signals |

### 12.6 Backtest Routes (`/api/backtest`)

| Method | Path | คำอธิบาย |
|--------|------|---------|
| POST | `/` | รัน backtest — body: `{symbol, timeframe, from, to, tpPercent, capitalPerTrade, maxConcurrentTrades, useBnbForFees}` |
| GET | `/` | list backtest results (50 อันล่าสุด) |
| GET | `/:id` | detail + trades array |
| DELETE | `/:id` | ลบ |

### 12.7 Account Routes (`/api/account`)

| Method | Path | คำอธิบาย |
|--------|------|---------|
| GET | `/balance` | Binance balances (free/locked) |
| GET | `/open-orders?symbol=` | list open orders |
| DELETE | `/open-orders` | cancel all open orders ของ symbol |

### 12.8 Health Route (`/api/health`)

ไม่ต้อง auth — ใช้สำหรับ dashboard heartbeat:

```json
{
  "ts": 1720000000000,
  "uptimeSec": 3600,
  "overall": "ok",          // ok | warning | degraded | critical
  "components": {
    "mongodb": { "ok": true, "state": "connected", "host": "mongodb://***@127.0.0.1:27017/..." },
    "binanceRest": { "ok": true, "latencyMs": 120, "lastPingAt": 1720000000000, "errorCount": 0, "hasApiKeys": true },
    "marketWs": { "ok": true, "connected": true, "subscribedStreams": 4, "reconnectAttempts": 0 },
    "userDataWs": { "ok": true, "connected": true, "hasListenKey": true },
    "botManager": { "ok": true, "running": true, "activeTraders": 2 }
  }
}
```

---

## 13. Dashboard WebSocket

ไฟล์: [src/realtime/dashboardWs.js](src/realtime/dashboardWs.js)

### 13.1 Connection Flow

URL: `/ws/dashboard` (upgrade จาก HTTP)

1. Client ส่ง WebSocket upgrade request พร้อม `Cookie: connect.sid=...`
2. Server ตรวจ session โดย parse cookie → ดึง sid → query MongoDB session store → verify `session.authenticated === true`
3. ถ้าไม่ authenticated → `401 Unauthorized` + close socket
4. ถ้า authenticated → upgrade สำเร็จ → ส่ง `{type: 'hello', ts}`

### 13.2 Event Forwarding

ทุก event จาก `eventBus` ที่อยู่ใน `EVENTS_TO_FORWARD` จะถูกกระจายไปยังทุก connected client:

```javascript
const EVENTS_TO_FORWARD = [
  'bot:status', 'bot:updated',
  'signal:new', 'trade:update', 'order:update',
  'kline:update', 'account:update',
  'health:update',
];

for (const evt of EVENTS_TO_FORWARD) {
  eventBus.on(evt, (payload) => {
    const msg = JSON.stringify({ type: evt, payload, ts: Date.now() });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  });
}
```

### 13.3 Client-side (Browser)

ไฟล์: [public/js/ws-client.js](public/js/ws-client.js)

- Auto-reconnect ทุก 3s ถ้า disconnect
- Handle incoming events:
  - `kline:update` → update chart real-time
  - `bot:status` → update bot card color
  - `trade:update` → update trade row
  - `health:update` → update heartbeat pills
  - `signal:new` → add marker on chart

---

## 14. Backtester Engine

ไฟล์: [src/core/backtester.js](src/core/backtester.js)

### 14.1 Pipeline

```
1. fetchKlines(symbol, interval, from, to)  →  array of {openTime, open, high, low, close, volume, closeTime}
2. signalEngine.detectS1Signals(klines)   →  array of S1 signals
3. loadSymbol(symbol)                      →  stepSize, minNotional
4. simulateTrades(klines, signals, opts)   →  array of trade outcomes
5. summarize(trades)                        →  stats (winRate, totalPnl, etc.)
6. BacktestResult.create(...)              →  persist
```

### 14.2 fetchKlines Loop

Binance `/api/v3/klines` จำกัด 1000 แท่งต่อ request — ต้อง loop:

```javascript
while (cursor < toMs && all.length < SAFETY_LIMIT) {
  const resp = await binanceRest.getKlines({
    symbol, interval,
    startTime: cursor,
    endTime: toMs,
    limit: Math.min(1000, 5000 - all.length),
  });
  // append
  cursor = lastOpenTime + stepMs;  // เลื่อน cursor
  if (resp.length < limit) break;  // หมดข้อมูล
}
```

`SAFETY_LIMIT = 5000` — กัน loop ไม่สิ้นสุด (ถ้า user เลือกช่วง 5 ปี × 5m = 525,600 แท่ง → cap ที่ 5000)

### 14.3 Realistic v3 Simulation Model

```javascript
function simulateTrades({ klines, signals, opts }) {
  const { tpPercent, capitalPerTrade, feeRate, maxBuyWait, maxConcurrentTrades, stepSize, minNotional } = opts;

  const trades = [];
  const activeExits = [];   // FIFO tracking ของ positions ที่ยังเปิด

  for (const sig of signals) {
    const idx = sig.index;
    const buyPrice = sig.close;
    const target = buyPrice * (1 + tpPercent/100 + 2*feeRate);

    // 1. Calculate qty
    const rawQty = capitalPerTrade / buyPrice;
    const qty = floorQtyToStep(rawQty, stepSize);
    const notional = qty * buyPrice;

    // 2. Clean up activeExits ที่ปิดก่อน candle idx
    while (activeExits[0]?.exitIdx < idx) activeExits.shift();

    // 3. Check concurrent slot
    if (activeExits.length >= maxConcurrentTrades) {
      trades.push({ ..., exitReason: 'max_concurrent_skip', realizedPnl: 0 });
      continue;
    }

    // 4. Check minNotional
    if (notional < minNotional) {
      trades.push({ ..., exitReason: 'below_min_notional', realizedPnl: 0 });
      continue;
    }

    // 5. Phase 1: BUY fill check
    let buyFilled = false;
    let buyCandleIdx = null;
    for (let j = idx + 1; j < idx + 1 + maxBuyWait; j++) {
      if (klines[j].low <= buyPrice) {
        buyFilled = true;
        buyCandleIdx = j;
        break;
      }
    }
    if (!buyFilled) {
      trades.push({ ..., exitReason: 'no_buy_fill', realizedPnl: 0 });
      continue;
    }

    // 6. Phase 2: SELL fill check (ไม่มี stop loss)
    let sellFilled = false;
    for (let j = buyCandleIdx + 1; j < klines.length; j++) {
      if (klines[j].high >= target) {
        sellFilled = true;
        sellCandleIdx = j;
        break;
      }
    }

    if (sellFilled) {
      // TP hit
      activeExits.push({ buyCandleIdx, exitIdx: sellCandleIdx });
      trades.push({ ..., exitReason: 'tp_hit', realizedPnl: pnl });
    } else {
      // ยังถืออยู่ (unrealized)
      activeExits.push({ buyCandleIdx, exitIdx: klines.length });
      trades.push({ ..., exitReason: 'still_holding', realizedPnl: 0, unrealizedPnl });
    }
  }
}
```

**สูตรการคำนวณ**:
- `qty` floor ตาม `stepSize` (เช่น BNBUSDT stepSize = 0.001 → 14.2857 กลายเป็น 14)
- `buyFilled` = future candle's `low ≤ buyPrice` ภายใน `maxBuyWait` แท่ง
- `sellFilled` = future candle's `high ≥ target` ตลอดจนจบข้อมูล (ไม่มี stop loss)
- `pnl` = `(sellPrice - buyPrice) × qty - fees`

### 14.4 Stats Summary

```javascript
function summarize(trades) {
  const signals = trades.length;
  const tpHit = trades.filter(t => t.exitReason === 'tp_hit').length;
  const stillHolding = trades.filter(t => t.exitReason === 'still_holding').length;
  const noBuyFill = trades.filter(t => t.exitReason === 'no_buy_fill').length;
  const maxConcurrentSkip = trades.filter(t => t.exitReason === 'max_concurrent_skip').length;
  const belowMinNotional = trades.filter(t => t.exitReason === 'below_min_notional').length;

  const wins = trades.filter(t => t.realizedPnl > 0).length;
  const losses = trades.filter(t => t.realizedPnl < 0).length;
  const realized = wins + losses;
  const winRate = realized > 0 ? (wins / realized) * 100 : 0;

  const totalPnl = trades.reduce((s, t) => s + t.realizedPnl, 0);
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const totalUnrealizedPnl = trades.reduce((s, t) => s + t.unrealizedPnl, 0);

  // Max drawdown (running equity curve)
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.realizedPnl;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  return { signalsCount, tpHit, stillHolding, ..., winRate, totalPnl, maxDD, ... };
}
```

**Win Rate interpretation** (โหมด no-stop-loss):
- `winRate = wins / (wins + losses)` — สะท้อนคุณภาพเมื่อเข้าไม้จริง
- `signalSuccessRate = tpHit / signals` — สะท้อนคุณภาพของสัญญาณ
- ในโหมดนี้ winRate จะเป็น 100% เสมอ (ถ้า TP ถึง → realizedPnl > 0 เสมอ เพราะเราบวก fee buffer ไว้แล้ว)

---

## 15. Crash Recovery & Reconciliation

ไฟล์: [src/core/botManager.js:147-205](src/core/botManager.js#L147)

### 15.1 ปัญหา

ถ้าบอท crash ตอน:
- BUY order pending
- BUY filled แต่ SELL ยังไม่ได้วาง
- SELL pending
- SELL filled แต่ยังไม่ได้บันทึก

### 15.2 Reconciliation Algorithm

ตอน `botManager.start()`:

```javascript
async reconcilePendingTrades() {
  const pending = await Trade.find({
    state: { $in: ['placed', 'filled', 'selling'] }
  });

  for (const trade of pending) {
    // 1. ดึงสถานะ order จาก Binance (ground truth)
    const order = await binanceRest.getOrder({ symbol, orderId: trade.buyOrderId });

    // 2. BUY filled but not recorded → trigger handleBuyFilled
    if (order.status === 'FILLED') {
      trader.currentTrade = trade;
      await trader.handleBuyFilled(trade, order, signal);
    }
    // 3. BUY canceled/expired → mark cancelled
    else if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
      await Trade.updateOne({ _id: trade._id }, { state: 'cancelled', buyStatus: order.status });
    }

    // 4. SELL filled but not recorded → handleSellFilled
    if (trade.sellOrderId) {
      const sellOrder = await binanceRest.getOrder({ symbol, orderId: trade.sellOrderId });
      if (sellOrder.status === 'FILLED') {
        await trader.handleSellFilled({
          executedQty: sellOrder.executedQty,
          avgPrice: sellOrder.price,
          cumulativeQuoteQty: sellOrder.cummulativeQuoteQty,
          ts: sellOrder.updateTime,
        });
      }
    }
  }
}
```

**กุญแจสำคัญ**: `clientOrderId` deterministic ทำให้ reconcile ได้แม่นยำ (ไม่มี race กับ order ใหม่)

---

## 16. Health Monitoring

ไฟล์: [src/services/healthMonitor.js](src/services/healthMonitor.js)

### 16.1 Components

| Component | เช็คจาก | Interval |
|-----------|--------|----------|
| MongoDB | `mongoose.connection.readyState` (1=connected) | event-driven |
| Binance REST | `binanceRest.ping()` | 60s |
| Market WS | `marketWs.connected` + subscribed streams | event-driven |
| User Data WS | `userDataWs.ws.readyState === OPEN` | event-driven |
| Bot Manager | `traders.size` | event-driven |

### 16.2 Tick Loop

ทุก 5 วินาที:
```javascript
setInterval(() => {
  const status = getStatus();
  eventBus.emit('health:update', status);
}, 5000);
```

### 16.3 Overall Status Logic

```javascript
let overall = 'ok';
if (!mongoConnected) overall = 'critical';
else if (!marketWsOk) overall = 'degraded';
else if (!lastBinancePingOk && Date.now() - lastBinancePingAt > 120000) overall = 'warning';
```

Dashboard แสดง heartbeat pills:
- 🟢 **ok** — ทุกอย่างปกติ
- 🟡 **warning** — Binance ping fail > 2 นาที (อาจ network issue)
- 🟠 **degraded** — Market WS ตัด (บอทจะหยุดเทรดชั่วคราว)
- 🔴 **critical** — MongoDB ตัด (ข้อมูลไม่ persist)

---

## 17. Event Bus (Pub/Sub)

ไฟล์: [src/services/eventBus.js](src/services/eventBus.js)

Singleton `EventEmitter` ที่ `setMaxListeners(100)`:

### Events ที่ใช้

| Event | Emit โดย | Payload |
|-------|----------|---------|
| `kline:update` | binanceWs.handleKline | `{ symbol, interval, kline }` (ทุก tick) |
| `kline:closed` | klineCache.update (isFinal=true) | `{ symbol, timeframe, candle }` |
| `bookTicker` | binanceWs.handleBookTicker | `{ symbol, bid, ask, ... }` |
| `order:update` | binanceWs.userDataWs.handleMessage | `{ clientOrderId, status, executedQty, avgPrice, ... }` |
| `account:update` | binanceWs.userDataWs.handleMessage | raw Binance payload |
| `bot:status` | Trader / botManager | `{ botId, status }` |
| `bot:updated` | botManager.enableBot/disableBot | `{ botId }` |
| `signal:new` | Trader.onCandleClosed | `{ signalId, signal }` |
| `trade:update` | Trader.placeBuy / handleBuyFilled / handleSellFilled | `{ tradeId, state }` |
| `health:update` | healthMonitor._tick | full status object |

### Consumers

- **dashboardWs.js** — forward ทุก event ใน `EVENTS_TO_FORWARD` ไปยัง browser
- **Trader** — listen `kline:closed` + `bookTicker` + `order:update` (filtered by clientOrderId)

---

## 18. Process Lifecycle & PM2

ไฟล์: [src/server.js](src/server.js), [ecosystem.config.js](ecosystem.config.js)

### 18.1 Startup Order

```javascript
async function main() {
  // 1. สร้าง Express app
  const app = createApp();
  const server = http.createServer(app);

  // 2. Attach WebSocket (ต้องก่อน listen เพื่อ register upgrade handler)
  dashboardWs.attach(server);

  // 3. Start listening ทันที (แม้ MongoDB ยังไม่พร้อม)
  server.listen(config.port, config.host, () => { ... });

  // 4. Connect MongoDB ใน background (retry infinite)
  db.connect().then(async () => {
    // 5. Start bot manager (load enabled bots + reconcile)
    await botManager.start();
  });

  // 6. Start health monitor (ทำงานทันที ไม่ต้องรอ MongoDB)
  healthMonitor.start();
}
```

**ทำไม listen ก่อน DB connect**: ถ้า DB ล่มนานๆ → bot ยัง respond `/api/health` ได้ → ดูสถานะได้

### 18.2 Graceful Shutdown

```javascript
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  healthMonitor.stop();
  await botManager.stop();     // unsubscribe WS, stop traders
  server.close(() => {
    db.disconnect().finally(() => process.exit(0));
  });

  // Force exit หลัง 10 วินาที (กัน hang)
  setTimeout(() => process.exit(1), 10000);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

### 18.3 PM2 Config

```javascript
{
  name: 'onepercentbot',
  script: 'src/server.js',
  instances: 1,
  exec_mode: 'fork',           // ← ต้อง fork ไม่ใช่ cluster (LoginGuard in-memory)
  autorestart: true,
  max_memory_restart: '512M',
  error_file: './logs/pm2-error.log',
  out_file: './logs/pm2-out.log',
}
```

**ทำไมไม่ cluster**: `LoginGuard` + `ErrorRateLimiter` เก็บ state ใน memory — ถ้า cluster mode จะแชร์ state ไม่ได้ ทำให้ lockout ข้าม process

### 18.4 Logs

- PM2 เขียน logs ที่ `logs/pm2-out.log` + `logs/pm2-error.log`
- `pino` logger ใช้ `pino-pretty` ใน dev (สีสวย) — production เป็น JSON
- `*.log` ใน `.gitignore`

---

## 19. Pitfalls & Design Decisions

### 19.1 ATR ต้องใช้ Wilder RMA (ไม่ใช่ SMA/EMA)

**ผิด** → สัญญาณเพี้ยนทั้งระบบ

```javascript
// ❌ ผิด — ใช้ SMA
rngKC = ta.sma(high - low, 20)

// ✅ ถูก — ใช้ Wilder RMA
rngKC = ta.rma(ta.tr, 20)
```

[src/core/indicators.js:63-79](src/core/indicators.js#L63) — `rma()` ที่เขียนตรงกับ Pine Script `ta.rma`

### 19.2 Signal ต้องเป็น Closed Candle เท่านั้น

`Trader.onCandleClosed` รับ event เฉพาะเมื่อ `k.x === true` — ถ้า trigger ตอนแท่งยังวิ่ง → close price ยังไม่ final → bg_state ผิด → signal จะยิงซ้ำทุก tick

### 19.3 clientOrderId Deterministic

ทุก order มี `clientOrderId = "bXXXXX-{candleCloseTime}-{retryCount}-{side}"` (สูงสุด 36 chars)

**ประโยชน์**:
1. **Idempotency**: ถ้า network glitch แล้ว retry → Binance จะรู้ว่าเป็น order เดิม (return เดิม)
2. **Crash recovery**: reconcile จับคู่ trade ↔ order ได้แม่นยำ
3. **Race condition guard**: ถ้า 2 event มาพร้อมกัน (WS fill + REST poll) → currentTrade ถูก check ก่อนเสมอ

### 19.4 Sell Price ต้องบวก Fee Buffer

ถ้าตั้ง TP = 0.1% อย่างเดียว → หลังหัก fee 2 ขา = **ขาดทุน 0.05%**

ดังนั้นต้องใช้ `sellPrice = buy × (1 + tp% + 2×feeRate)` เสมอ — ดู [src/binance/fees.js:40-48](src/binance/fees.js#L40)

### 19.5 Cancel Race Condition

ตอน bestBid ขยับ → cancel order เดิม → re-place:

```javascript
await binanceRest.cancelOrder({ symbol, orderId });
// race! ระหว่างนี้ order อาจ fill พอดี
const reCheck = await binanceRest.getOrder({ symbol, orderId });
if (reCheck.status === 'FILLED') return handleBuyFilled(reCheck);  // ปลอดภัย
```

[src/core/trader.js:323-333](src/core/trader.js#L323)

### 19.6 retryCount ไม่มีเพดาน (อาจเป็นปัญหาได้)

ปัจจุบันไม่ cap retryCount → ถ้า bid ผันผวนมาก อาจมี retry 100+ ครั้ง (ทำให้ fee + slippage กินกำไร)

**แนะนำ**: cap retryCount ≤ 5 แล้ว mark signal = expired ถ้าเกิน (TODO — ยังไม่ได้ทำ)

### 19.7 maker-only อาจไม่ fill เลย

LIMIT_MAKER = post-only → ถ้าราคาจะ match ทันที Binance จะ reject ทันที

ในสภาวะ low liquidity หรือราคาวิ่งเร็ว → order อาจไม่ fill เลย (retry ไม่จบ) → signal expired

**Workaround**: ตอนนี้ไม่มี — ถ้าต้องการ fill แน่นวาง limit ตาม ask/bid ธรรมดา (จะเสีย taker fee)

### 19.8 In-memory Rate Limiter ไม่เหมาะกับ Cluster

`RateLimiter` (Binance) + `LoginGuard` + `ErrorRateLimiter` เก็บ state ใน memory → cluster mode จะมี state แยกกัน

**แก้**: ใช้ Redis ถ้าต้อง cluster (ตอนนี้ใช้ fork mode อยู่)

### 19.9 PORT_FORWARD ผ่าน Router มีความเสี่ยง

- **ไม่มี HTTPS** → password + API key วิ่ง plaintext
- **Dynamic IP** → ต้องใช้ DuckDNS หรือ Cloudflare Tunnel
- **Brute force** → มี LoginGuard แล้ว แต่ไม่มี fail2ban สำหรับ /api/auth ทั้งหมด

**ทางที่ปลอดภัยกว่า** (ถ้าต้องเข้าจากเน็ตบ้าน): Tailscale / Cloudflare Tunnel (ดู [README.md](README.md))

### 19.10 Decimal.js ใช้ทุกที่ที่คำนวณราคา/qty

ห้ามใช้ `parseFloat()` ตรงๆ สำหรับ price/qty — ใช้ `Decimal` แทน

```javascript
// ❌ ผิด
const newPrice = price * (1 + 0.001);

// ✅ ถูก
const newPrice = new Decimal(price).mul(1.001).toNumber();
```

ยกเว้น final display (round แล้วแสดงผล) ใช้ Number ได้

### 19.11 ไม่มี Balance Check ก่อน Place BUY

ปัจจุบันไม่เช็ค USDT balance ก่อน place BUY — ถ้า balance ไม่พอจะโดน Binance reject ที่ order placement

**Workaround**: `Account.routes.balance` แสดง balance ให้ user ดูก่อนเปิด bot

**TODO**: เพิ่ม pre-flight balance check ใน Trader.placeBuy

### 19.12 Slippage ใน Backtest เป็น 0

Backtest assume fill ที่ราคา target เป๊ะ — ในชีวิตจริง:
- LIMIT_MAKER จะ fill เมื่อราคามาถึง (slippage = 0 ใน maker)
- แต่ถ้า cancel + re-place → ราคาใหม่อาจต่างจากของเดิม (slippage > 0)
- และถ้า partial fill → ต้อง cancel + sell เฉพาะส่วนที่ได้ (fee impact)

**ปัจจุบัน**: backtest ไม่ model slippage จาก retry — ผล P&L ใน backtest จะ optimistic กว่าจริงเล็กน้อย

---

## ภาคผนวก A: Environment Variables

| Var | Required | Default | คำอธิบาย |
|-----|----------|---------|----------|
| `PORT` | - | 3000 | HTTP port |
| `HOST` | - | 127.0.0.1 | '127.0.0.1' (localhost) หรือ '0.0.0.0' (all interfaces) |
| `NODE_ENV` | - | development | 'production' ปิด pretty log |
| `LOG_LEVEL` | - | info | debug/info/warn/error |
| `SESSION_SECRET` | ✓ | - | random 64+ chars สำหรับ express-session |
| `DASHBOARD_PASSWORD` | - | (empty) | initial password (hash แล้วเก็บใน DB) |
| `MONGODB_URI` | - | mongodb://127.0.0.1:27017/... | |
| `ENCRYPTION_KEY` | ✓ | - | random 32+ chars (hex 64 หรือ string ใดๆ) |
| `BINANCE_API_KEY` | - | (empty) | mainnet key |
| `BINANCE_API_SECRET` | - | (empty) | mainnet secret |
| `USE_BNB_FOR_FEES` | - | false | true = 0.075%, false = 0.1% |
| `BINANCE_RECV_WINDOW` | - | 5000 | ms |
| `DEFAULT_CAPITAL_PER_TRADE` | - | 10 | USDT |
| `DEFAULT_MAX_TRADES` | - | 10 | concurrent slots |
| `DEFAULT_TP_PERCENT` | - | 0.1 | % |
| `DEFAULT_RETRY_TIME_MIN` | - | 1 | นาที |
| `DEFAULT_SYMBOL` | - | BNBUSDT | |
| `DEFAULT_TIMEFRAME` | - | 5m | |
| `LOGIN_MAX_ATTEMPTS` | - | 10 | login fails ก่อน lock |
| `LOGIN_WINDOW_MS` | - | 900000 | 15 นาที |
| `LOGIN_LOCKOUT_MS` | - | 900000 | 15 นาที |

## ภาคผนวก B: NPM Scripts

| Script | คำสั่ง | คำอธิบาย |
|--------|--------|----------|
| `npm start` | `node src/server.js` | รันปกติ |
| `npm run dev` | `nodemon src/server.js` | auto-restart ตอนแก้ code |
| `npm test` | `jest` | รัน unit tests |
| `npm run backtest` | `node scripts/run-backtest.js` | รัน backtest ผ่าน CLI |
| `npm run pm2:start` | `pm2 start ecosystem.config.js --env production` | รันด้วย PM2 |
| `npm run pm2:dev` | `pm2 start ecosystem.config.js --env development` | รันด้วย PM2 dev |
| `npm run pm2:restart` | `pm2 restart onepercentbot` | restart |
| `npm run pm2:logs` | `pm2 logs onepercentbot` | tail logs |
| `npm run pm2:status` | `pm2 status` | สถานะ PM2 |

## ภาคผนวก C: Troubleshooting

| อาการ | สาเหตุ | วิธีแก้ |
|--------|--------|--------|
| `ECONNREFUSED 127.0.0.1:27017` | MongoDB ไม่ได้รัน | start mongod หรือ `docker start mongodb` |
| `Request failed with status code 410` | User Data Stream listenKey หมดอายุ | restart app (`pm2 restart`) — auto-reconnect จะสร้าง listenKey ใหม่ |
| `LIMIT_MAKER rejected (-2010)` | order จะ match ทันที (ราคาไม่ใช่ฝั่ง maker) | ตรวจ bid/ask — bot ควรวางที่ bid เสมอ |
| `-1021 Invalid timestamp` | นาฬิกาเครื่องเพี้ยน | sync เวลา: `w32tm /resync` |
| Login ไม่ได้ทั้งที่ใส่ password ถูก | IP ถูก lock จาก brute-force | รอ 15 นาที หรือ restart app |
| WS ตัดบ่อย | network ไม่เสถียร | ดู `health:update` → reconnectAttempts — ถ้า > 5 พิจารณาเปลี่ยน network |
| `capitalPerTrade ต่ำกว่า minNotional` | Binance minNotional สูงกว่า capital | เพิ่ม capitalPerTrade หรือเลือก symbol ที่ minNotional ต่ำกว่า |
| Backtest "Win Rate 100%" | โหมด no-stop-loss ทำให้ TP hit = realizedPnl > 0 เสมอ | ดู signalSuccessRate แทน (TP hit / signals) |

---

**เอกสารนี้อัปเดตล่าสุด**: 2026-07-11
**Version**: 1.0.0