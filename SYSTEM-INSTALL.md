# INSTALL — คู่มือติดตั้ง OnePercentBot System

> เลือกอ่านเฉพาะแทร็กของคุณ — **ไม่ต้องอ่านทั้งไฟล์**
>
> | คุณคือใคร | อ่านหัวข้อ | ต้องลงอะไร |
> |---|---|---|
> | **ได้รับบอทมาใช้งาน** (ส่วนใหญ่อยู่กลุ่มนี้) | [แทร็ก A](#แทร็ก-a--ผู้ใช้งานบอท) | บอทอย่างเดียว (พอร์ต 6015) |
> | **เจ้าของระบบ / คนออก license** | [แทร็ก B](#แทร็ก-b--เจ้าของระบบผู้ดูแล) | บอท + Admin (6015 + 6016) |

---

## 0. สิ่งที่ต้องมีก่อน (ทั้ง 2 แทร็ก)

| เครื่องมือ | เวอร์ชัน | ใช้ทำอะไร |
|---|---|---|
| Node.js | **>= 18** | รันตัวโปรแกรม |
| MongoDB | **>= 6** | ฐานข้อมูลบนเครื่อง (พอร์ต 27017) |
| PM2 | latest | ตัวจัดการโปรเซสตอนใช้งานจริง |

```bash
# Windows: ติดตั้ง Node.js 18+ จาก https://nodejs.org/
# Windows: ติดตั้ง MongoDB Community จาก https://www.mongodb.com/try/download/community
#          หรือใช้ Docker แทน:
docker run -d --name mongodb -p 27017:27017 mongo:7

# PM2
npm install -g pm2

# ให้ PM2 กลับมาทำงานเองหลังรีสตาร์ทเครื่อง (Windows)
npm install -g pm2-windows-startup
pm2-startup install
```

เช็คว่า MongoDB ขึ้นแล้ว:
```bash
mongosh --eval "db.runCommand({ ping: 1 })"
```

---

# แทร็ก A — ผู้ใช้งานบอท

ใช้เวลาประมาณ 10 นาที คุณ**ไม่ต้อง**ติดตั้งโปรเจกต์ Admin และ**ไม่ต้อง**เปิดพอร์ตอะไรที่เราเตอร์เลย

### A1. ติดตั้ง

```bash
cd OnePercentBotTrade
npm install
cp .env.example .env
```

### A2. สร้าง secret 2 ตัว

```bash
# ตัวที่ 1 → SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# ตัวที่ 2 → ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> ⚠️ `ENCRYPTION_KEY` ต้องเป็น **hex 64 ตัว** (`randomBytes(32)`) — จะถูกใช้เป็นกุญแจ AES-256 ตรงๆ
> ⚠️ ตั้งแล้ว **ห้ามเปลี่ยน** หลังบันทึก Binance API key ลงระบบ ไม่งั้นถอดรหัสของเก่าไม่ออก

### A3. แก้ไฟล์ `.env`

เปิด `.env` แล้วกรอก 4 ช่องนี้ (ที่เหลือใช้ค่าที่ให้มาได้เลย):

```bash
SESSION_SECRET=<วางจาก A2 ตัวที่ 1>
ENCRYPTION_KEY=<วางจาก A2 ตัวที่ 2>
ADMIN_LICENSE_KEY=<คีย์ที่ผู้ดูแลระบบออกให้ รูปแบบ AAAA-BBBB-CCCC-DDDD>
ADMIN_CUSTOMER_TAG=<ชื่อเล่นของคุณ เช่น FAIZ-FRIEND>
```

Binance API key จะใส่ตรงนี้ หรือใส่ทีหลังผ่านหน้าเว็บ Settings ก็ได้:
```bash
BINANCE_API_KEY=
BINANCE_API_SECRET=
```

> 🔑 **ยังไม่มี license key?** ต้องขอจากผู้ดูแลระบบเท่านั้น — สร้างเองไม่ได้ และมั่วไม่ได้
> ระบบ Admin จะตอบ `401 invalid_license` ถ้าคีย์ไม่มีอยู่จริงในฐานข้อมูลของเขา

> ⚠️ **ห้ามแก้ `ADMIN_URL`** — ตั้งค่าไว้ให้ถูกแล้ว (`http://gigi.thaiddns.com:6016`)
> เปลี่ยนเป็น `127.0.0.1` เมื่อไหร่ = บอทจะโทรกลับหาเครื่องตัวเอง แล้วต่อ Admin ไม่ติดทันที

### A4. ตั้งค่า Binance API key

สร้างที่ https://www.binance.com/en/my/settings/api-management

- ✅ เปิด **Enable Spot & Margin Trading**
- ❌ **ปิด Enable Withdrawals** (ห้ามเปิดเด็ดขาด)
- 🔒 แนะนำให้ล็อก IP whitelist เป็น IP ของเครื่องที่รันบอท

### A5. เริ่มใช้งาน

```bash
npm run pm2:start
pm2 status          # ต้องเห็น onepercentbot = online
```

เปิดเบราว์เซอร์ → **http://localhost:6015**

ครั้งแรกจะเจอ 3 ขั้น: ตั้งรหัสผ่าน dashboard → หน้ายินยอม (กด **Accept**) → เริ่มสร้างบอทได้

> ⚠️ ถ้ากด **Decline** ในหน้ายินยอม บอทจะไม่เทรดและไม่ส่งข้อมูลไป Admin เลย
> แก้ได้โดยเปิด `http://localhost:6015/consent` แล้วกด Accept ใหม่ (หรือ `npm run consent:reset`)

### A6. เช็คว่าต่อ Admin ติดแล้ว

```bash
npm run pm2:logs | grep -E "admin-monitor|license-gate"
```

ต่อสำเร็จจะเห็นประมาณนี้ (heartbeat ตัวแรกออกภายใน 5 นาที):
```
admin-monitor: heartbeat sent
admin-monitor: command listener started
license-gate: validated
```

ถ้าไม่ขึ้นแบบนี้ → ดู [แก้ปัญหาต่อ Admin ไม่ติด](#แก้ปัญหาต่อ-admin-ไม่ติด) ท้ายไฟล์

### A7. ทดสอบก่อนลงเงินจริง

1. เมนู **Backtest** → BNBUSDT 5m ย้อนหลัง 30 วัน → ดู winRate / PnL / maxDrawdown
2. สร้างบอทด้วยทุนน้อยก่อน เช่น `$10 × 10 ไม้ = $100`
3. เช็คใน Binance ว่า order ที่ออกเป็น `LIMIT_MAKER` จริง

---

# แทร็ก B — เจ้าของระบบ/ผู้ดูแล

รันทั้งบอทและ Admin คุณเป็นคนออก license key ให้คนอื่น

### B1. ติดตั้งทั้ง 2 โปรเจกต์

```bash
cd OnePercentBotTrade  && npm install && cd ..
cd OnePercentBot-Admin && npm install && cd ..
```

### B2. ตั้งค่า Admin (พอร์ต 6016)

```bash
cd OnePercentBot-Admin
cp .env.example .env
```

กรอกใน `.env`:

```bash
NODE_ENV=production
PORT=6016
MONGODB_URI=mongodb://127.0.0.1:27017/onepercentbot_admin

# สร้างด้วย: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=<ค่าสุ่ม — ห้ามเว้นค่า CHANGE_ME ไว้>

ADMIN_USERNAME=admin
ADMIN_PASSWORD=<รหัสผ่านที่แข็งแรง — ห้ามใช้ changeme>

# Telegram 2FA — บังคับเมื่อ NODE_ENV=production (ดูคำเตือนข้างล่าง)
ADMIN_TG_BOT_TOKEN=<token จาก @BotFather>
ADMIN_TG_CHAT_ID=<chat id ของคุณ>
```

> 🚨 **กับดักที่ทำให้ล็อกอินไม่ได้เลย:** ถ้า `NODE_ENV=production` แต่ไม่ได้ตั้ง `ADMIN_TG_BOT_TOKEN` + `ADMIN_TG_CHAT_ID` ทั้งคู่ → หน้า login จะตอบ **HTTP 503** ตลอด เข้าระบบไม่ได้
> เลือกอย่างใดอย่างหนึ่ง: ตั้ง Telegram 2FA ให้ครบ **หรือ** ใช้ `NODE_ENV=development` (ปลอดภัยน้อยกว่า — เหมาะกับเครื่องทดสอบเท่านั้น)

> 🚨 ถ้า `NODE_ENV=production` แล้วปล่อย `JWT_SECRET`/`ADMIN_PASSWORD` เป็นค่า `CHANGE_ME` หรือ `changeme`
> เซิร์ฟเวอร์จะดับพร้อมข้อความ `FATAL: <ชื่อตัวแปร> must be changed for production` (ตั้งใจให้ดับ)

**วิธีหา Telegram chat id:** สร้างบอทใหม่กับ @BotFather (แยกจากบอทแจ้งเตือนเทรด) → ทักหาบอทนั้น 1 ข้อความ → เปิด `https://api.telegram.org/bot<TOKEN>/getUpdates` → อ่านค่า `result[0].message.chat.id`

### B3. เริ่ม Admin

```bash
npm run pm2:start
```

> ℹ️ **ผู้ใช้ admin ถูกสร้างอัตโนมัติตอนเซิร์ฟเวอร์บูต** จากค่า `ADMIN_USERNAME` / `ADMIN_PASSWORD` ใน `.env`
> **ไม่ต้อง**รันคำสั่งสร้าง user ใดๆ (คู่มือเวอร์ชันเก่าเขียนว่าให้ใช้ `generate-license.js` สร้าง admin — **ผิด** เครื่องมือนั้นออกได้แค่ license เท่านั้น)

เปิด **http://localhost:6016** → ล็อกอินด้วย `ADMIN_USERNAME` / `ADMIN_PASSWORD` → ใส่ OTP 6 หลักที่ส่งเข้า Telegram

ตรวจว่าเซิร์ฟเวอร์ขึ้นจริง:
```bash
curl http://127.0.0.1:6016/health
# {"ok":true,"service":"onepercentbot-admin","version":"1.3.0",...}
```

### B4. ออก license key ให้ผู้ใช้

```bash
cd OnePercentBot-Admin
node tools/generate-license.js \
  --owner="ชื่อลูกค้า" \
  --tier=basic \
  --max-bots=10 \
  --max-machines=2 \
  --expires-days=365 \
  --notes="หมายเหตุ"
```

ผลลัพธ์:
```
=== License Generated ===
  License Key: AAAA-BBBB-CCCC-DDDD
  Owner:       ชื่อลูกค้า
  Tier:        basic
  ...
Save this key — it cannot be retrieved later.
```

| ตัวเลือก | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `--owner` | **บังคับ** | ชื่อเจ้าของคีย์ |
| `--tier` | `basic` | `basic` / `pro` / `enterprise` |
| `--max-bots` | `10` | จำนวนบอทสูงสุดที่สร้างได้ |
| `--max-machines` | `1` | **จำนวนเครื่องสูงสุด** — เกินแล้ว heartbeat จะโดน `403 machine_limit_exceeded` |
| `--expires-days` | `365` | อายุคีย์ |
| `--notes` | – | หมายเหตุอิสระ |

> ⚠️ คีย์ดูย้อนหลังไม่ได้ — ก๊อปเก็บทันทีตอนสร้าง
> ⚠️ `--max-machines=1` (ค่าเริ่มต้น) พอสำหรับ 1 เครื่อง ถ้าลูกค้าจะรัน 2 เครื่องต้องระบุ `--max-machines=2`

ส่งให้ผู้ใช้ 2 อย่าง: **license key** + บอกให้ตั้ง `ADMIN_CUSTOMER_TAG` เป็นชื่อของเขา

### B5. เปิดพอร์ต 6016 ให้ผู้ใช้ภายนอกเข้าถึงได้

บอทของผู้ใช้เป็นฝ่ายโทรเข้ามาหา Admin ดังนั้น**เฉพาะเครื่อง Admin** ที่ต้องเปิดพอร์ต

- เราเตอร์: forward พอร์ต `6016` → IP เครื่อง Admin
- ไฟร์วอลล์ Windows: อนุญาต inbound TCP 6016
- ใน `OnePercentBot-Admin/.env`: `HOST` ไม่ต้องตั้ง (Admin ฟังทุก interface อยู่แล้ว)
- ใช้ Dynamic DNS ถ้า IP ไม่นิ่ง (เช่น `gigi.thaiddns.com`)

ทดสอบจากเน็ตข้างนอก (มือถือปิด WiFi):
```bash
curl -i http://gigi.thaiddns.com:6016/health
```

### B6. (ทางเลือก) เปิด anti-tamper — ผูก license กับ hash ของโค้ด

ป้องกันคนแก้ซอร์สโค้ดบอทแล้วเอาไปใช้ต่อ

```bash
# 1. คำนวณ hash ของ src/ ฝั่งบอท
node tools/hash-bot-src.js

# 2. ผูก hash เข้ากับ license
node tools/set-license-code-hash.js AAAA-BBBB-CCCC-DDDD <hash-ที่ได้>

# หรือคำนวณ+ผูกในคำสั่งเดียว
node tools/set-license-code-hash.js --owner="ชื่อลูกค้า" --compute
```

ถ้าโค้ดถูกแก้ บอทยังทำงานต่อได้ (ไม่ดับ) แต่ heartbeat จะติดธง `tamper` และขึ้นแบดจ์แดงในหน้า Admin

### B7. เชื่อมบอทของตัวเองเข้ากับ Admin ของตัวเอง

ใน `OnePercentBotTrade/.env`:
```bash
ADMIN_ENABLED=true
ADMIN_URL=http://127.0.0.1:6016      # Admin อยู่เครื่องเดียวกัน จึงใช้ 127.0.0.1 ได้
ADMIN_LICENSE_KEY=<คีย์ที่ออกให้ตัวเอง>
ADMIN_CUSTOMER_TAG=OWNER-SELF
```

> ⚠️ **แก้ `.env` แล้วต้อง `delete` + `start` เท่านั้น** — `pm2 reload` ไม่โหลดค่า env ใหม่
> ```bash
> npm run pm2:delete && npm run pm2:start
> ```

---

## รันบอท 2 ตัวขึ้นไปบนเครื่องเดียวกัน

ต้องแยก **ทุกบรรทัด**ในตารางนี้ ไม่งั้นจะชนกันเงียบๆ

| ตัวแปร | ตัวที่ 1 | ตัวที่ 2 | ถ้าไม่แยกจะเกิดอะไร |
|---|---|---|---|
| `PORT` | 6015 | 2026 | `EADDRINUSE` เปิดไม่ขึ้น |
| `MONGODB_URI` | `.../onepercentbottrade` | `.../onepercentbottrade_faiz` | ข้อมูลเทรดปนกัน |
| `MACHINE_ID_FILE` | `./data/admin-machine-id.txt` | `./data/faiz-machine-id.txt` | **Admin เห็นเป็นเครื่องเดียว** |
| `SESSION_COOKIE_NAME` | `connect.sid` | `connect.sid.faiz` | ล็อกอินตัวหนึ่งเตะอีกตัวหลุด |
| `CONSENT_WEB_PORT` | 6017 | 2028 | พอร์ตชน |
| `CONSENT_FILE_PATH` | (ค่าเริ่มต้น) | `./data/faiz-consent.json` | ตัวที่ 2 อ่านผลยินยอมของตัวที่ 1 |
| `ADMIN_BOT_URL` | `http://127.0.0.1:6015` | `http://127.0.0.1:2026` | snapshot ว่างเปล่า |
| `ADMIN_LICENSE_KEY` | คีย์ A | คีย์ B | ชน `max-machines` |

วิธีรัน: สร้างไฟล์ `.env.<ชื่อ>` + `ecosystem.<ชื่อ>.config.js` แล้วสั่ง `npm run pm2:start:faiz`
(ดูตัวอย่างจริงที่ `.env.faiz` และ `ecosystem.faiz.config.js`)

> ⚠️ PM2 6.x อ่าน `env_file` ไม่เสถียร — ต้อง spread ค่าเข้าไปในบล็อก `env` ของ ecosystem โดยตรง
> ⚠️ ต้อง pre-seed ไฟล์ `MACHINE_ID_FILE` ด้วยค่าที่ไม่ซ้ำกันก่อนสตาร์ทครั้งแรก ไม่งั้นทั้ง 2 ตัวจะคำนวณ fingerprint ได้ค่าเดียวกัน (มาจาก hostname + cpu + mac ของเครื่องเดียวกัน)

---

## สรุปพอร์ต

| พอร์ต | บริการ | ต้อง forward ที่เราเตอร์ไหม |
|---|---|---|
| **6015** | บอท — dashboard + API | ไม่ต้อง (ยกเว้นอยากเปิดจากมือถือ/นอกบ้าน) |
| **6016** | Admin — monitor + license | **ต้อง** เฉพาะเครื่องที่รัน Admin |
| **6017** | หน้ายินยอมสำรอง | ไม่ต้อง (127.0.0.1 เท่านั้น) |
| **27017** | MongoDB | ไม่ต้อง (ห้ามเปิดออกเน็ตเด็ดขาด) |

---

## แก้ปัญหาต่อ Admin ไม่ติด

ดู log ก่อนเสมอ:
```bash
cd OnePercentBotTrade && npm run pm2:logs | grep -E "admin-monitor|license-gate|consent"
```

| ข้อความใน log | สาเหตุ | วิธีแก้ |
|---|---|---|
| `admin-monitor: disabled` | `ADMIN_ENABLED` ไม่ใช่ `true` | ตั้ง `ADMIN_ENABLED=true` |
| `ADMIN_LICENSE_KEY not set, heartbeat disabled` | ยังไม่ใส่ license key | ขอคีย์จากผู้ดูแลระบบ |
| `heartbeat failed ... ECONNREFUSED 127.0.0.1:6016` | `ADMIN_URL` ชี้ไปเครื่องตัวเอง | แก้เป็น URL ของ Admin จริง |
| `heartbeat failed ... ETIMEDOUT` | ไฟร์วอลล์บล็อก / Admin ปิดอยู่ | `curl -i http://<admin>:6016/health` แล้วแจ้งผู้ดูแล |
| `heartbeat failed ... status: 401` | คีย์ผิด / ถูกยกเลิก / หมดอายุ | ขอคีย์ใหม่ |
| `heartbeat failed ... status: 403` | ใช้คีย์เดียวเกินจำนวนเครื่อง | ขอเพิ่ม `--max-machines` หรือขอคีย์แยก |
| `consent: declined — botManager.start() SKIPPED` | กด Decline ไว้ | เปิด `/consent` กด Accept |
| `snapshot send failed` | `ADMIN_BOT_URL` พอร์ตไม่ตรง `PORT` | ตั้งให้ตรงกัน |
| `phone-home DOWN — bot will pause new positions` | ติดต่อ Admin ไม่ได้เกิน 48 ชม. | แก้ heartbeat ให้กลับมาก่อน |

**หลักการที่คนเข้าใจผิดบ่อย:** บอทเป็นฝ่ายโทรออกไปหา Admin เสมอ (phone-home) — Admin ไม่เคยวิ่งเข้ามาหาบอท
ดังนั้นเครื่องผู้ใช้**ไม่ต้อง**เปิดพอร์ตอะไรเลย และการแก้ `HOST=0.0.0.0` **ไม่ช่วย**แก้ปัญหาต่อ Admin ไม่ติด

---

## ปัญหาอื่นๆ

**`EADDRINUSE :::6015`** — มีโปรเซสอื่นใช้พอร์ตอยู่
```bash
# Windows
netstat -ano | findstr :6015
taskkill /PID <pid> /F
# Linux/Mac
lsof -i :6015 && kill <pid>
```

**`Missing required env: SESSION_SECRET`** — ยังไม่ได้ `cp .env.example .env` หรือเว้นค่าว่างไว้ (ดู A2)

**`ENCRYPTION_KEY must be at least 32 characters`** — คีย์สั้นไป ใช้ `randomBytes(32).toString('hex')` (ได้ 64 ตัว)

**`FATAL: JWT_SECRET must be changed for production`** (ฝั่ง Admin) — ยังไม่ได้แก้ค่า `CHANGE_ME` ใน `.env`

**ล็อกอิน Admin ได้ 503** — `NODE_ENV=production` แต่ยังไม่ได้ตั้ง Telegram 2FA ครบทั้ง 2 ตัว (ดู B2)

**Binance error `-1021` (outside recvWindow)** — นาฬิกาเครื่องเพี้ยน
```bash
w32tm /resync                    # Windows
sudo ntpdate pool.ntp.org        # Linux
```

---

## ตรวจสอบระบบ

```bash
cd OnePercentBotTrade  && npm test    # ~2,100 tests
cd OnePercentBot-Admin && npm test    # ~300 tests
pm2 status
```

เวอร์ชันปัจจุบัน: บอท **2.5.1** · Admin **1.3.0** · ต้องการ Node.js **>= 18**

---

## อ่านต่อ

- [README.md](README.md) — ภาพรวมระบบ
- [CONNECTION.md](CONNECTION.md) — รายละเอียดการเชื่อมต่อบอท ↔ Admin
- [OnePercentBotTrade/README.md](OnePercentBotTrade/README.md) — คู่มือบอท
- [OnePercentBot-Admin/README.md](OnePercentBot-Admin/README.md) — คู่มือ Admin
- `OnePercentBotTrade/.env.example` — คำอธิบายทุกตัวแปร + ตารางแก้ปัญหา
