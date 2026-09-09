#!/usr/bin/env python3
"""Batch 5: bots.html New Bot modal + bots.js create payload — sync to RECOMMENDED_DEFAULTS."""
import re
import sys

# ─── 1. bots.html: hardcoded defaults in New Bot modal ────────────────────
html_path = r'd:/NodeJs/OnePercentBot-System/OnePercentBotTrade/public/bots.html'
with open(html_path, 'r', encoding='utf-8') as f:
    html = f.read()
html_orig = html

# Timeframes: currently 9 options, expand to 15
old_tf = """                  <label class="lux-form-label" for="nb-timeframe">กรอบเวลา (Timeframe)</label>
                  <select class="form-select" id="nb-timeframe">
                    <option value="1m">1m</option>
                    <option value="3m">3m</option>
                    <option value="5m">5m</option>
                    <option value="15m">15m</option>
                    <option value="30m">30m</option>
                    <option value="1h">1h</option>
                    <option value="2h">2h</option>
                    <option value="4h">4h</option>
                    <option value="1d">1d</option>
                  </select>"""

new_tf = """                  <label class="lux-form-label" for="nb-timeframe">กรอบเวลา (Timeframe)</label>
                  <select class="form-select" id="nb-timeframe">
                    <option value="1m">1m</option>
                    <option value="3m" selected>3m</option>
                    <option value="5m">5m</option>
                    <option value="15m">15m</option>
                    <option value="30m">30m</option>
                    <option value="1h">1h</option>
                    <option value="2h">2h</option>
                    <option value="4h">4h</option>
                    <option value="6h">6h</option>
                    <option value="8h">8h</option>
                    <option value="12h">12h</option>
                    <option value="1d">1d</option>
                    <option value="3d">3d</option>
                    <option value="1w">1w</option>
                    <option value="1M">1M</option>
                  </select>"""

if old_tf in html:
    html = html.replace(old_tf, new_tf)
    print("  OK: TIMEFRAMES expanded 9 → 15 (default 3m)", file=sys.stderr)
else:
    print("  NO MATCH: TIMEFRAMES select", file=sys.stderr)

# Capital: 9 → 8
html = html.replace(
    'id="nb-capital" value="9" step="0.01" min="1"',
    'id="nb-capital" value="8" step="0.01" min="1"',
)
print("  OK: nb-capital 9 → 8", file=sys.stderr)

# cbAutoUnlockThreshold: 1 → 2
html = html.replace(
    'id="nb-cb-auto-unlock-threshold" min="0.5" max="5" step="0.1" value="1"',
    'id="nb-cb-auto-unlock-threshold" min="0.5" max="5" step="0.1" value="2"',
)
print("  OK: nb-cb-auto-unlock-threshold 1 → 2", file=sys.stderr)

# autoArmLossPct: 6.3 → 10
html = html.replace(
    'id="nb-auto-arm-loss-pct" step="0.5" min="1" max="90" value="6.3"',
    'id="nb-auto-arm-loss-pct" step="0.5" min="1" max="90" value="10"',
)
print("  OK: nb-auto-arm-loss-pct 6.3 → 10", file=sys.stderr)

# autoArmAgeHours: 4 → 828, also bump max from 168 to 999 (matches bot-edit)
html = html.replace(
    'id="nb-auto-arm-age-hours" step="0.5" min="0.5" max="168" value="4"',
    'id="nb-auto-arm-age-hours" step="0.5" min="0.5" max="999" value="828"',
)
print("  OK: nb-auto-arm-age-hours 4 → 828 (max 168 → 999)", file=sys.stderr)

# autoPauseMinKcPct: 2 → 1.2
html = html.replace(
    'id="nb-auto-pause-min-kc" value="2" step="0.1"',
    'id="nb-auto-pause-min-kc" value="1.2" step="0.1"',
)
print("  OK: nb-auto-pause-min-kc 2 → 1.2", file=sys.stderr)

# autoPauseMin24hVolUsdt: 1000000 → 400000
html = html.replace(
    'id="nb-auto-pause-min-24h-vol" value="1000000" step="1000"',
    'id="nb-auto-pause-min-24h-vol" value="400000" step="1000"',
)
print("  OK: nb-auto-pause-min-24h-vol 1M → 400000", file=sys.stderr)

# DLC default: was unchecked, RECOMMENDED=true → should be checked
html = html.replace(
    '<input class="form-check-input" type="checkbox" id="nb-dlc-enabled" />',
    '<input class="form-check-input" type="checkbox" id="nb-dlc-enabled" checked />',
)
print("  OK: nb-dlc-enabled default → checked (RECOMMENDED=true)", file=sys.stderr)

# CB Auto-Unlock: was unchecked, RECOMMENDED=true → should be checked
html = html.replace(
    '<input class="form-check-input" type="checkbox" id="nb-cb-auto-unlock-enabled" />',
    '<input class="form-check-input" type="checkbox" id="nb-cb-auto-unlock-enabled" checked />',
)
print("  OK: nb-cb-auto-unlock-enabled default → checked", file=sys.stderr)

# Round-down Capital: was unchecked, RECOMMENDED=true → should be checked
html = html.replace(
    '<input class="form-check-input" type="checkbox" id="nb-round-down-capital-enabled" />',
    '<input class="form-check-input" type="checkbox" id="nb-round-down-capital-enabled" checked />',
)
print("  OK: nb-round-down-capital-enabled default → checked", file=sys.stderr)

# XS1: was checked, RECOMMENDED=false → uncheck
html = html.replace(
    '<input class="form-check-input" type="checkbox" id="nb-xs1-enabled" checked />',
    '<input class="form-check-input" type="checkbox" id="nb-xs1-enabled" />',
)
print("  OK: nb-xs1-enabled default → unchecked (RECOMMENDED=false)", file=sys.stderr)

# s1OnlyDown: was checked, RECOMMENDED=false → uncheck
html = html.replace(
    '<input class="form-check-input" type="checkbox" id="nb-s1-only-down" checked />',
    '<input class="form-check-input" type="checkbox" id="nb-s1-only-down" />',
)
print("  OK: nb-s1-only-down default → unchecked", file=sys.stderr)

# Safe trade: was unchecked (no change), trendline/no-trade were checked → uncheck
html = html.replace(
    '<input class="form-check-input" type="checkbox" id="nb-safe-trade-trendline-enabled" checked />',
    '<input class="form-check-input" type="checkbox" id="nb-safe-trade-trendline-enabled" />',
)
print("  OK: nb-safe-trade-trendline-enabled default → unchecked", file=sys.stderr)
html = html.replace(
    '<input class="form-check-input" type="checkbox" id="nb-safe-trade-no-trade-enabled" checked />',
    '<input class="form-check-input" type="checkbox" id="nb-safe-trade-no-trade-enabled" />',
)
print("  OK: nb-safe-trade-no-trade-enabled default → unchecked", file=sys.stderr)

# roundDownCapitalMin: stays 5.5 (matches RECOMMENDED)

# Write HTML
if html != html_orig:
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"  HTML written: {len(html) - len(html_orig):+d} bytes", file=sys.stderr)

# ─── 2. bots.js createBot payload: replace || X defaults with rec() ──────
js_path = r'd:/NodeJs/OnePercentBot-System/OnePercentBotTrade/public/js/pages/bots.js'
with open(js_path, 'r', encoding='utf-8') as f:
    js = f.read()
js_orig = js

js_replacements = [
    (r"(autoPauseMinKcPct:\s*parseFloat\(document\.getElementById\('nb-auto-pause-min-kc'\)\.value\)\s*\|\|\s*)2",
     r"\1rec('autoPauseMinKcPct')"),
    (r"(autoPauseMin24hVolUsdt:\s*parseFloat\(document\.getElementById\('nb-auto-pause-min-24h-vol'\)\.value\)\s*\|\|\s*)1000000",
     r"\1rec('autoPauseMin24hVolUsdt')"),
    (r"(autoArmLossPct:\s*parseFloat\(document\.getElementById\('nb-auto-arm-loss-pct'\)\.value\)\s*\|\|\s*)10",
     r"\1rec('autoArmLossPct')"),
    (r"(autoArmAgeHours:\s*parseFloat\(document\.getElementById\('nb-auto-arm-age-hours'\)\.value\)\s*\|\|\s*)4",
     r"\1rec('autoArmAgeHours')"),
    (r"(roundDownCapitalMin:\s*parseFloat\(document\.getElementById\('nb-round-down-capital-min'\)\?\.value\)\s*\|\|\s*)5\.5",
     r"\1rec('roundDownCapitalMin')"),
    (r"(tpTrendMultiplier:\s*parseFloat\(document\.getElementById\('nb-tp-trend-multiplier'\)\.value\)\s*\|\|\s*)2",
     r"\1rec('tpTrendMultiplier')"),
]
for pattern, repl in js_replacements:
    new_js, n = re.subn(pattern, repl, js)
    if n > 0:
        js = new_js
        print(f"  OK js ({n}x): {pattern[:60]}", file=sys.stderr)
    else:
        print(f"  NO MATCH js: {pattern[:60]}", file=sys.stderr)

if js != js_orig:
    with open(js_path, 'w', encoding='utf-8') as f:
        f.write(js)
    print(f"  JS written: {len(js) - len(js_orig):+d} bytes", file=sys.stderr)
