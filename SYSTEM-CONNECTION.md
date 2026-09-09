# CONNECTION — Connecting to a Remote Bot

How to connect your admin to someone else's bot (or vice versa). The system uses **phone-home** (bot → admin), not the other way around, so the bot must be able to reach the admin's URL.

## Topology

```
┌──────────────┐                          ┌──────────────┐
│ Friend's Bot │ ───── heartbeat ──────►  │  Your Admin  │
│   :6015      │   every 5 min            │    :6016     │
└──────────────┘                          └──────────────┘
```

**Two connection models:**

| Model | Who hosts admin | Friend's bot phones home to | License scope |
|-------|-----------------|-----------------------------|---------------|
| **Centralized** (you host admin) | You (your server) | `http://<your-public-IP>:6016` | You issue 1 license per friend |
| **Distributed** (friend hosts admin) | Each friend (their own) | `http://<friend-public-IP>:6016` | Each friend self-issues |

For a **demo / trial**, the simplest is: **each friend runs their own admin + their own bot** on their machine, and they all phone-home to a central admin (yours).

## Friend Setup (Distributed — each friend runs their own admin + bot)

Each friend needs to run BOTH OnePercentBotTrade (port 6015) and OnePercentBot-Admin (port 6016) on their machine.

### Step 1: Friend installs

See [INSTALL.md](INSTALL.md) — full instructions. TL;DR:

```bash
cd OnePercentBot-System/OnePercentBotTrade && npm install && cp .env.example .env
cd ../OnePercentBot-Admin && npm install && cp .env.example .env
```

### Step 2: Friend opens port 6015 + 6016 to the internet (optional, only if you want remote access)

Two options:

**A. Direct public IP (if friend has static IP)**
- Router: port-forward 6015 → friend's local IP:6015
- Router: port-forward 6016 → friend's local IP:6016
- Set `HOST=0.0.0.0` in both .env files

**B. Dynamic DNS (e.g., DuckDNS / No-IP)**
- Friend signs up for free DDNS (e.g., `yourfriend.duckdns.org`)
- Router: dynamic-DNS client
- Set `HOST=0.0.0.0`
- Friend's URL becomes `http://yourfriend.duckdns.org:6015`

### Step 3: Friend starts both services

```bash
# In each project:
npm run pm2:start

# Verify:
pm2 status
```

### Step 4: Friend generates their own license

```bash
cd OnePercentBot-Admin
node tools/generate-license.js --owner="<friend-name>" --max-bots=10 --max-machines=2 --tier=basic
# Output: License Key: AAAA-BBBB-CCCC-DDDD
```

Friend pastes this key into `OnePercentBotTrade/.env` as `ADMIN_LICENSE_KEY`, then reloads:
```bash
cd ../OnePercentBotTrade
npm run pm2:delete && npm run pm2:start
```

### Step 5: Friend verifies

Open `http://localhost:6016` → should see "1 machine online" → click → confirm bot's port/version/uptime.

## Connection Test (Curl)

From your machine (admin side), test friend's bot:

```bash
# Should return 200 + JSON (login required for most endpoints)
curl -i http://<friend-public-ip>:6016/api/machines

# Public endpoint (no auth)
curl http://<friend-public-ip>:6015/api/consent/status
```

If `connection refused`: port-forward not set up, or firewall blocking.
If `timeout`: friend is offline, or wrong IP/hostname.

## Demo Scenario: Centralized Admin

You run admin on your machine. Friend runs ONLY bot. Friend's bot phones-home to your admin.

### Friend's bot .env:
```bash
ADMIN_ENABLED=true
ADMIN_URL=http://<your-public-ip>:6016
ADMIN_LICENSE_KEY=<key you issued>
HOST=0.0.0.0
PORT=6015
```

### You (admin) .env:
```bash
JWT_SECRET=...
MONGODB_URI=mongodb://127.0.0.1:27017/onepercentbot_admin
PORT=6016
HOST=0.0.0.0
```

### Issue a license to friend:
```bash
cd OnePercentBot-Admin
node tools/generate-license.js --owner="friend-name" --max-bots=5 --tier=basic
# Send the AAAA-BBBB-CCCC-DDDD key to friend
```

### Friend configures + starts:
```bash
cd OnePercentBotTrade
# paste ADMIN_LICENSE_KEY
npm run pm2:delete && npm run pm2:start
```

### You verify:
Open `http://localhost:6016` → Machines → friend should appear within 5 min.

## Security Notes

⚠️ **Phone-home is HMAC-signed** — the bot signs every heartbeat with `ADMIN_LICENSE_KEY`. The admin verifies the signature before accepting. So even if someone knows your admin URL, they can't impersonate without the key.

⚠️ **API keys stay on the bot's machine.** Admin NEVER sees Binance API keys. Admin only sees: port, version, uptime, public IP, license-allowed bot count, error counts.

⚠️ **If you don't trust the admin URL** (e.g., shared hosting), set `ADMIN_ENABLED=false` and run standalone. The bot works fully without admin.

## Troubleshooting

### Friend's bot shows "offline" on your admin
- Wait 5 min (heartbeat interval)
- Check friend's bot logs: `cd OnePercentBotTrade && npm run pm2:logs | grep -i "phone-home"`
- Test friend's URL from your machine: `curl http://<friend-ip>:6015/api/consent/status`
- If curl times out: friend firewall / port-forward issue

### "401 Unauthorized" on heartbeat
- License key mismatch. Friend's `ADMIN_LICENSE_KEY` doesn't match what admin has.
- Verify in admin dashboard: Machines → friend → click "Validate License"

### "HMAC signature invalid"
- Bot's local time is more than 5 min off from admin's time.
- Run `w32tm /resync` (Windows) or `sudo ntpdate pool.ntp.org` (Linux) on BOTH machines.

## See Also

- [INSTALL.md](INSTALL.md) — full install
- [README.md](README.md) — system overview
- [OnePercentBotTrade/src/admin-monitor/heartbeat.js](OnePercentBotTrade/src/admin-monitor/heartbeat.js) — phone-home source
- [OnePercentBot-Admin/README.md](OnePercentBot-Admin/README.md) — admin docs
