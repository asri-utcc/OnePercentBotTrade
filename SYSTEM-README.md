# OnePercentBot System

Binance Spot maker-only trading bot with central admin monitor + license control. Three sibling projects, one shared MongoDB.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     OnePercentBot System                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   OnePercentBotTrade (port 6015)      OnePercentBot-Admin (port 6016)│
│   ┌───────────────────────────┐       ┌───────────────────────────┐ │
│   │ S1 signal engine          │       │ Central monitor           │ │
│   │ Web dashboard + bots      │  <--> │ License issuance/revoke   │ │
│   │ Trade executor            │ HTTP  │ Audit log                 │ │
│   │ Backtest                  │       │ Machine detail            │ │
│   └────────────┬──────────────┘       └──────────────┬────────────┘ │
│                │                                     │              │
│                └──────────► MongoDB ◄────────────────┘              │
│                              27017                                  │
│                                                                     │
│   OnePercentBotPentest                                                 │
│   ┌───────────────────────────┐                                       │
│   │ Security audit tooling    │                                       │
│   │ Brute-force testing       │                                       │
│   └───────────────────────────┘                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Projects

| Project | Port | Purpose | README |
|---------|------|---------|--------|
| [OnePercentBotTrade](OnePercentBotTrade/) | **6015** | The trading bot itself (signal engine + dashboard + executor) | [README](OnePercentBotTrade/README.md) |
| [OnePercentBot-Admin](OnePercentBot-Admin/) | **6016** | Central monitor, license control, audit log | [README](OnePercentBot-Admin/README.md) |
| [OnePercentBotPentest](OnePercentBotPentest/) | — | Security audit tooling | [README](OnePercentBotPentest/README.md) |

## Quick Links

- 📥 [INSTALL.md](INSTALL.md) — Install all 3 projects from scratch
- 🔌 [CONNECTION.md](CONNECTION.md) — How to connect to a friend's remote bot

## System Overview

**Trading flow:** S1 signal (Keltner Channel + bg zones) → LIMIT_MAKER BUY → TP SELL (no SL).

**Architecture:** Each bot instance phone-homes every 5 min to the admin server with heartbeat (port, version, uptime, public IP). Admin can queue commands (pause/resume/kill/force-close). License keys gate bot usage.

**Key features:**
- 🎯 S1 signal detection (Pine Script v5 → JS)
- 💎 Maker-only (`LIMIT_MAKER`) — no taker fees
- 🔄 Smart order retry (cancel + re-place on bid move)
- 📊 Web dashboard: bots / chart / backtest / history
- 🛡️ DCA + BEP stack mode (opt-in per bot)
- 🎲 Martingale sizing (opt-in per bot, DCA only)
- 🤖 Auto-pause (auto-tightens KC/vol to keep [15,25] running)
- ⏱ Auto-Timing (per-bot time-band optimization, heatmap)
- 🔐 AES-256-GCM encrypted API keys + HMAC phone-home
- 📜 License tiers (basic/pro/enterprise) with feature gating

## License

See [OnePercentBotTrade/package.json](OnePercentBotTrade/package.json) for current version. License system: see [OnePercentBot-Admin/README.md](OnePercentBot-Admin/README.md#cli-tool-generate-license).
