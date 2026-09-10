# OnePercentBot System

บอทเทรด Binance Spot แบบ maker-only พร้อมระบบ Admin กลางสำหรับ monitor + คุม license
ประกอบด้วย 2 โปรเจกต์ที่ใช้ MongoDB ตัวเดียวกัน (คนละฐานข้อมูล)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          OnePercentBot System                            │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   OnePercentBotTrade :6015              OnePercentBot-Admin :6016        │
│   ┌────────────────────────┐            ┌────────────────────────┐       │
│   │ S1 signal engine       │  heartbeat │ Monitor เครื่องทั้งหมด   │       │
│   │ Dashboard + จัดการบอท   │ ─────────► │ ออก/ยกเลิก license      │       │
│   │ ตัวส่งคำสั่งซื้อขาย       │ ◄───────── │ สั่งงานบอทระยะไกล        │       │
│   │ Backtest               │  คำสั่ง     │ Audit log              │       │
│   └───────────┬────────────┘            └───────────┬────────────┘       │
│               │                                     │                    │
│               └──────────► MongoDB :27017 ◄─────────┘                    │
│                    onepercentbottrade / onepercentbot_admin              │
└──────────────────────────────────────────────────────────────────────────┘
```

> การเชื่อมต่อเป็นแบบ **phone-home** — บอทโทรออกไปหา Admin ฝ่ายเดียว
> Admin ไม่เคยวิ่งเข้ามาหาบอท ดังนั้นเครื่องผู้ใช้ไม่ต้องเปิดพอร์ตใดๆ

## โปรเจกต์

| โปรเจกต์ | พอร์ต | เวอร์ชัน | หน้าที่ |
|---|---|---|---|
| [OnePercentBotTrade](OnePercentBotTrade/) | **6015** | 2.5.1 | ตัวบอทเทรด — signal engine + dashboard + ตัวส่งออเดอร์ |
| [OnePercentBot-Admin](OnePercentBot-Admin/) | **6016** | 1.3.0 | ศูนย์กลาง monitor, ออก license, audit log |

## เริ่มต้นที่นี่

| ถ้าคุณ... | อ่าน |
|---|---|
| 📥 ได้รับบอทมาใช้งาน | [INSTALL.md → แทร็ก A](INSTALL.md#แทร็ก-a--ผู้ใช้งานบอท) — ใช้เวลา ~10 นาที |
| 🛠 เป็นเจ้าของระบบ / ออก license | [INSTALL.md → แทร็ก B](INSTALL.md#แทร็ก-b--เจ้าของระบบผู้ดูแล) |
| 🔌 ต่อ Admin ไม่ติด | [CONNECTION.md](CONNECTION.md) |
| ⚙️ อยากรู้ว่าตัวแปรแต่ละตัวคืออะไร | `OnePercentBotTrade/.env.example` |

## ภาพรวมการทำงาน

**การเทรด:** S1 signal (Keltner Channel + bg zones) → `LIMIT_MAKER` BUY → SELL ที่ราคา TP

**การควบคุม:** บอทแต่ละเครื่องส่ง heartbeat ทุก 5 นาที (พอร์ต, เวอร์ชัน, uptime, public IP, จำนวนบอท/ไม้)
Admin สั่ง pause / resume / kill / force-close กลับมาได้ และใช้ license key เป็นตัวคุมสิทธิ์

**ฟีเจอร์หลัก:**
- 🎯 ตรวจจับ S1 signal (แปลงจาก Pine Script v5)
- 💎 Maker-only (`LIMIT_MAKER`) — ไม่เสีย taker fee
- 🔄 Smart retry — bid ขยับแล้ว cancel + วางใหม่
- 📊 Dashboard: บอท / กราฟ / backtest / ประวัติ
- 🛡️ DCA + BEP stack mode (เปิดรายบอท)
- 🎲 Martingale sizing (เปิดรายบอท เฉพาะโหมด DCA)
- 🤖 Auto-pause ปรับ KC/vol อัตโนมัติ
- ⏱ Auto-Timing เลือกช่วงเวลาเทรดที่ดีที่สุดรายบอท
- 🔐 เข้ารหัส API key ด้วย AES-256-GCM + phone-home เซ็นด้วย HMAC
- 📜 License แบ่ง tier (basic / pro / enterprise) พร้อมเปิด-ปิดฟีเจอร์ตาม tier

## ความต้องการของระบบ

Node.js **>= 18** · MongoDB **>= 6** · PM2 (สำหรับใช้งานจริง)

## License

ใช้งานส่วนตัวเท่านั้น — ระบบ license ดูที่ [OnePercentBot-Admin/README.md](OnePercentBot-Admin/README.md)
