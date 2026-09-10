# CONNECTION — การเชื่อมต่อบอท ↔ Admin

อธิบายว่าบอทคุยกับ Admin ยังไง ต้องเปิดพอร์ตตรงไหนบ้าง และเวลาต่อไม่ติดต้องดูอะไร

## หลักการสำคัญ: บอทเป็นฝ่ายโทรออก (phone-home)

```
   เครื่องผู้ใช้                                      เครื่อง Admin
┌──────────────────┐                              ┌──────────────────┐
│  บอท :6015       │ ──── heartbeat / 5 นาที ───► │   Admin :6016    │
│                  │ ──── ถามคำสั่ง / 1 นาที ────► │                  │
│                  │ ──── snapshot / 5 นาที ────► │                  │
└──────────────────┘                              └──────────────────┘
      โทรออกอย่างเดียว                             เปิดพอร์ตรอรับ
      ไม่ต้องเปิดพอร์ต                              ต้อง forward 6016
```

**Admin ไม่เคยวิ่งเข้าไปหาบอท** — บอทเป็นคนเปิดการเชื่อมต่อออกไปเองทุกครั้ง

ผลที่ตามมา:

| คำถามที่เจอบ่อย | คำตอบ |
|---|---|
| ผู้ใช้ต้อง forward พอร์ตที่เราเตอร์ไหม | **ไม่ต้อง** เลย |
| ผู้ใช้ต้องมี public IP / DDNS ไหม | **ไม่ต้อง** |
| ต่อ Admin ไม่ติด แก้ `HOST=0.0.0.0` ช่วยไหม | **ไม่ช่วย** — `HOST` คุมแค่ว่าใครเปิดหน้าเว็บบอทได้ ไม่เกี่ยวกับ phone-home |
| ผู้ใช้อยู่หลัง NAT / มือถือ / VPN ใช้ได้ไหม | **ได้** ขอแค่ออกเน็ตไปพอร์ต 6016 ของ Admin ได้ |
| Admin ล่ม บอทจะหยุดเทรดไหม | ไม่หยุดทันที — แต่ถ้าติดต่อไม่ได้เกิน **48 ชม.** บอทจะหยุดเปิดไม้ใหม่ |

## รูปแบบการใช้งาน 2 แบบ

| แบบ | ใครรัน Admin | `ADMIN_URL` ของบอท | ใครออก license |
|---|---|---|---|
| **รวมศูนย์** (ใช้จริงตอนนี้) | เจ้าของระบบคนเดียว | `http://gigi.thaiddns.com:6016` | เจ้าของระบบออกให้ทุกคน |
| **ต่างคนต่างรัน** | ทุกคนรันของตัวเอง | `http://127.0.0.1:6016` | แต่ละคนออกเอง |

ค่าเริ่มต้นใน `.env.example` ตั้งไว้เป็นแบบ **รวมศูนย์** แล้ว — ผู้ใช้ทั่วไปไม่ต้องแก้ `ADMIN_URL`

---

## ฝั่งผู้ใช้ต้องตั้งอะไรบ้าง

ใน `OnePercentBotTrade/.env` แค่ 4 บรรทัดนี้:

```bash
ADMIN_ENABLED=true
ADMIN_URL=http://gigi.thaiddns.com:6016   # ตั้งมาให้แล้ว ห้ามแก้
ADMIN_LICENSE_KEY=AAAA-BBBB-CCCC-DDDD     # ขอจากผู้ดูแลระบบ
ADMIN_CUSTOMER_TAG=ชื่อของคุณ
```

แก้เสร็จต้อง **delete + start** (แค่ `reload` ไม่โหลด env ใหม่):
```bash
npm run pm2:delete && npm run pm2:start
```

รายละเอียดครบทุกตัวแปรอยู่ใน `OnePercentBotTrade/.env.example`

---

## ฝั่ง Admin ต้องเตรียมอะไร

1. เปิดพอร์ต 6016 ออกอินเทอร์เน็ต (forward ที่เราเตอร์ + อนุญาตใน firewall)
2. ใช้ Dynamic DNS ถ้า IP ไม่นิ่ง
3. ออก license key ให้ผู้ใช้แต่ละคน:

```bash
cd OnePercentBot-Admin
node tools/generate-license.js --owner="ชื่อผู้ใช้" --max-bots=10 --max-machines=2 --tier=basic
```

> ⚠️ `--max-machines` ค่าเริ่มต้นคือ **1** — ถ้าผู้ใช้จะรัน 2 เครื่องต้องระบุเอง ไม่งั้นเครื่องที่ 2 จะโดน `403 machine_limit_exceeded`
> ⚠️ ระบบ**ไม่**ออก license อัตโนมัติให้คีย์ที่ไม่รู้จัก (`LICENSE_AUTO_TRIAL_ENABLED` ปิดอยู่) — คีย์มั่วจะได้ `401` เสมอ

---

## บอทเรียก API อะไรบ้าง

ทุกเส้นส่ง header `X-License-Key` และวิ่งไปที่ `ADMIN_URL`

| ทำอะไร | เมธอด + path | ทุกกี่นาที |
|---|---|---|
| heartbeat (แจ้งว่ายังอยู่) | `POST /api/instances/heartbeat` | 5 |
| ถามคำสั่งจาก Admin | `GET /api/instances/{machineId}/commands` | 1 |
| ส่งผลการทำคำสั่ง | `POST /api/instances/command-result` | เมื่อมีคำสั่ง |
| ตรวจสอบ license ซ้ำ | `POST /api/instances/validate` | 60 |
| ส่ง snapshot (บอท/ไม้ที่ถือ) | `POST /api/instances/snapshot` | 5 |
| ส่งสถานะการยินยอม | `POST /api/instances/consent` | ตอนบูต + ตอนเปลี่ยนคำตอบ |
| แชทกับผู้ดูแล | `POST /api/instances/{machineId}/chat/send`<br>`GET /api/instances/{machineId}/chat/inbox` | ทุก 3-5 วินาที |

ข้อมูลใน heartbeat: `machineId`, hostname, platform, เวอร์ชัน Node, เวอร์ชันบอท, จำนวนบอท/ไม้ที่เปิด, พอร์ต, public IP, `customerTag`, สถานะ anti-tamper

**ไม่มี** Binance API key หรือรหัสผ่านใดๆ ส่งไปที่ Admin — คีย์ถูกเข้ารหัส AES-256-GCM เก็บอยู่ในเครื่องผู้ใช้เท่านั้น

---

## ลำดับการเชื่อมต่อครั้งแรก

```
1. บอทบูต → ตรวจ license (POST /api/instances/validate)
              └─ ยังไม่เคยส่ง heartbeat → ได้ 404 machine_not_registered (ปกติ)
2. ผ่านหน้ายินยอม → กด Accept
3. ส่งสถานะยินยอมไป Admin (POST /api/instances/consent, source=boot_resync)
4. heartbeat ตัวแรกออก → Admin สร้าง Machine record → ขึ้นในหน้า Machines
5. หลังจากนั้น validate จะผ่าน + คำสั่งจาก Admin เริ่มทำงาน
```

เครื่องจะโผล่ในหน้า Admin หลัง **heartbeat ตัวแรก** ซึ่งอาจใช้เวลาถึง 5 นาที — รอก่อนอย่าเพิ่งตกใจ

---

## ตรวจสอบว่าต่อติดไหม

### ฝั่งผู้ใช้
```bash
cd OnePercentBotTrade
npm run pm2:logs | grep -E "admin-monitor|license-gate|consent"
```

ต่อสำเร็จ:
```
admin-monitor: heartbeat sent
admin-monitor: command listener started
license-gate: validated
```

### ทดสอบว่าคุยกับ Admin ได้ไหม
```bash
curl -i http://gigi.thaiddns.com:6016/health
```
- ได้ `200` + JSON → เน็ตถึง Admin ปกติ ปัญหาอยู่ที่ license key หรือ config
- `Connection refused` → พอร์ตไม่ได้ forward หรือ Admin ไม่ได้รัน
- `timeout` → firewall บล็อก หรือ hostname/IP ผิด

### ฝั่ง Admin
เปิด `http://localhost:6016` → เมนู **Machines** → ดูคอลัมน์ `lastHeartbeatAt`
(นับว่าออนไลน์ถ้า heartbeat ล่าสุดอยู่ในช่วง 15 นาที)

---

## ตารางแก้ปัญหา

| อาการ / ข้อความใน log | สาเหตุ | วิธีแก้ |
|---|---|---|
| ไม่มี log `admin-monitor` เลย | `ADMIN_ENABLED` ไม่ใช่ `true` | ตั้ง `ADMIN_ENABLED=true` แล้ว delete+start |
| `ADMIN_LICENSE_KEY not set, heartbeat disabled` | ไม่ได้ใส่คีย์ | ขอคีย์จากผู้ดูแลระบบ |
| `heartbeat failed ... ECONNREFUSED 127.0.0.1:6016` | `ADMIN_URL` ชี้เครื่องตัวเอง | แก้เป็น URL ของ Admin จริง |
| `heartbeat failed ... ETIMEDOUT` | firewall / Admin ปิด | `curl http://<admin>:6016/health` |
| `heartbeat failed ... status: 401` | คีย์ผิด / ถูกยกเลิก / หมดอายุ | ขอคีย์ใหม่ |
| `heartbeat failed ... status: 403` | เกิน `max-machines` | ขอเพิ่มโควตาเครื่อง |
| `consent: declined — botManager.start() SKIPPED` | กด Decline | เปิด `/consent` กด Accept |
| ขึ้นออนไลน์แต่ไม่มีข้อมูลบอท | `ADMIN_BOT_URL` ไม่ตรง `PORT` | ตั้งให้ตรงกัน แล้ว delete+start |
| รัน 2 ตัว แต่เห็นเครื่องเดียว | `MACHINE_ID_FILE` ชนกัน | แยกไฟล์ + pre-seed ค่าที่ไม่ซ้ำ |
| `command signature verification failed` | HMAC ไม่ตรง | ลบ `ADMIN_COMMAND_HMAC_SECRET` ออก ให้ระบบคำนวณเองจาก license key |
| `anti-tamper: MISMATCH` | โค้ด `src/` ต่างจาก hash ที่ผูกไว้ | ไม่ทำให้บอทดับ แต่ขึ้นธงแดงที่ Admin — แจ้งผู้ดูแล |
| `phone-home DOWN — bot will pause new positions` | ติดต่อ Admin ไม่ได้เกิน 48 ชม. | แก้ heartbeat ให้กลับมาก่อน |

---

## ความปลอดภัย

- 🔐 คำสั่งจาก Admin ถูกเซ็นด้วย HMAC-SHA256 — ปลอมคำสั่งไม่ได้ถ้าไม่มี license key
- 🔐 Binance API key ไม่เคยออกจากเครื่องผู้ใช้ Admin เห็นแค่: พอร์ต, เวอร์ชัน, uptime, public IP, จำนวนบอท/ไม้, สถานะ tamper
- 🔐 ไม่ไว้ใจ Admin? ตั้ง `ADMIN_ENABLED=false` — บอทยังเทรดได้ครบทุกฟีเจอร์ แต่จะไม่ขึ้นในหน้า Admin
- ⚠️ อย่าเปิดพอร์ต 27017 (MongoDB) ออกอินเทอร์เน็ตเด็ดขาด

---

## อ่านต่อ

- [INSTALL.md](INSTALL.md) — คู่มือติดตั้งแบบเต็ม
- [README.md](README.md) — ภาพรวมระบบ
- `OnePercentBotTrade/.env.example` — คำอธิบายทุกตัวแปร
- `OnePercentBotTrade/src/admin-monitor/` — ซอร์สโค้ดฝั่ง phone-home
