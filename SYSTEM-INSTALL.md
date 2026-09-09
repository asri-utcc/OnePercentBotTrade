# INSTALL — OnePercentBot System

Consolidated install for all 3 sibling projects.

## 0. Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| Node.js | **>= 18** | All 3 services |
| MongoDB | **>= 6** | Local DB on port 27017 |
| PM2 | latest | Production process manager |
| Git | any | Pull updates |

```bash
# Windows: install Node.js 18+ from https://nodejs.org/
# Windows: install MongoDB Community from https://www.mongodb.com/try/download/community
#          OR use Docker:
docker run -d --name mongodb -p 27017:27017 mongo:7

# PM2
npm install -g pm2

# Make pm2 survive Windows reboot
npm install -g pm2-windows-startup
pm2-startup install
```

## 1. Clone + Install Dependencies

```bash
# From d:\NodeJs\ (Windows) or ~/projects/ (Linux)
git clone <your-repo-url> OnePercentBot-System
cd OnePercentBot-System

# Or if you already have the folder, just:
cd OnePercentBot-System

# Install each project
cd OnePercentBotTrade && npm install && cd ..
cd OnePercentBot-Admin && npm install && cd ..
cd OnePercentBotPentest && npm install && cd ..
```

## 2. Generate Secrets

```bash
# 64-char session secret (paste into .env as SESSION_SECRET)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 32-char AES-256 key (paste into .env as ENCRYPTION_KEY)
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

## 3. Configure OnePercentBotTrade (port **6015**)

```bash
cd OnePercentBotTrade
cp .env.example .env
notepad .env  # or your editor
```

Fill in:
- `SESSION_SECRET` — paste from step 2
- `ENCRYPTION_KEY` — paste from step 2
- `BINANCE_API_KEY` / `BINANCE_API_SECRET` — from https://www.binance.com/en/my/settings/api-management
  - ⚠️ **Enable Spot Trading only**, **disable Withdraw**, **whitelist your IP**
- `PORT=6015` (already set in .env.example)
- `HOST=0.0.0.0` if you want LAN/external access; `127.0.0.1` for localhost-only
- `USE_BNB_FOR_FEES=true` (recommended — 0.075% vs 0.1% maker)

Leave `ADMIN_ENABLED=false` for now. Enable after admin is up.

## 4. Configure OnePercentBot-Admin (port **6016**)

```bash
cd ../OnePercentBot-Admin
cp .env.example .env
notepad .env
```

Fill in:
- `JWT_SECRET` — separate secret, paste from step 2 (use a different one than SESSION_SECRET if you want)
- `MONGODB_URI` — usually `mongodb://127.0.0.1:27017/onepercentbot_admin`
- `PORT=6016`

## 5. Start MongoDB

```bash
# If installed as service: it should be running already
# Verify:
mongosh --eval "db.runCommand({ ping: 1 })"
```

## 6. Start OnePercentBotTrade

```bash
cd OnePercentBotTrade

# Dev mode (auto-restart on code change)
npm run dev

# OR production with PM2:
npm run pm2:start      # uses --env production
npm run pm2:dev        # uses --env development (bypasses 2FA on /admin)
```

Open browser: **http://localhost:6015**

First run: set dashboard password → consent screen → start trading.

## 7. Start OnePercentBot-Admin

```bash
cd ../OnePercentBot-Admin

# Create the first admin user
node tools/generate-license.js --owner=admin
# This creates an admin login + an "admin-tier" license

# Start dev mode
npm run dev

# OR production:
npm run pm2:start
```

Open browser: **http://localhost:6016**

Login with the credentials shown by `generate-license.js`.

## 8. Wire bot → admin (phone-home)

In `OnePercentBotTrade/.env`:
```bash
ADMIN_ENABLED=true
ADMIN_URL=http://127.0.0.1:6016
ADMIN_LICENSE_KEY=<paste from generate-license.js>
```

Reload bot (env vars need full restart, not reload):
```bash
cd OnePercentBotTrade
npm run pm2:delete
npm run pm2:start
```

Verify: admin dashboard should show your bot as online within 5 min.

## 9. (Optional) Make Admin 2FA-required

Default: admin login requires Telegram 2FA in production. See [OnePercentBot-Admin/README.md](OnePercentBot-Admin/README.md).

## 10. Verify All 3

```bash
# Bot tests (2176+ tests)
cd OnePercentBotTrade && npm test

# Admin tests
cd ../OnePercentBot-Admin && npm test

# Status of all PM2 processes
pm2 status
```

Expected output:
```
┌────┬──────────────────────┬─────────┬──────┬────────┬──────────┐
│ id │ name                 │ mode    │ ↺    │ status │ ↻        │
├────┼──────────────────────┼─────────┼──────┼────────┼──────────┤
│ 0  │ onepercentbot-admin  │ fork    │ 0    │ online │ 0        │
│ 1  │ onepercentbot        │ fork    │ 0    │ online │ 0        │
└────┴──────────────────────┴─────────┴──────┴────────┴──────────┘
```

## Ports Summary

| Port | Service | Notes |
|------|---------|-------|
| **6015** | Bot (OnePercentBotTrade) | Dashboard + API |
| **6016** | Admin (OnePercentBot-Admin) | Monitor + license |
| **6017** | Consent fallback (legacy) | Auto-started if you don't engage 6015 /consent within 60s |
| **27017** | MongoDB | Both databases (onepercentbottrade, onepercentbot_admin) |

## Troubleshooting

### "EADDRINUSE :::6015"
Another process is using port 6015. Find it:
```bash
# Windows
netstat -ano | findstr :6015
taskkill /PID <pid> /F

# Linux/Mac
lsof -i :6015
kill <pid>
```

### "Missing required env: SESSION_SECRET"
You didn't copy `.env.example` to `.env`, or `SESSION_SECRET` is blank.

### Bot can't connect to admin
- Check `ADMIN_URL` is reachable from bot: `curl http://127.0.0.1:6016/api/health`
- Verify `ADMIN_LICENSE_KEY` is valid in admin dashboard
- Check admin logs: `npm run pm2:logs` in OnePercentBot-Admin

### Bot trades but admin shows offline
- Heartbeat interval is 5 min — wait
- Check bot logs for `phone-home` errors: `cd OnePercentBotTrade && npm run pm2:logs`

## See Also

- [README.md](README.md) — system overview
- [CONNECTION.md](CONNECTION.md) — connecting to a friend's remote bot
- [OnePercentBotTrade/README.md](OnePercentBotTrade/README.md) — bot-specific docs
- [OnePercentBot-Admin/README.md](OnePercentBot-Admin/README.md) — admin-specific docs
