#!/usr/bin/env python3
"""Batch 2: Replace inline defaults in bot-edit.js with rec(key) helpers."""
import re
import sys

path = r'd:/NodeJs/OnePercentBot-System/OnePercentBotTrade/public/js/pages/bot-edit.js'
with open(path, 'r', encoding='utf-8') as f:
    src = f.read()

original = src

# === RENDER() inline ?? <default> and != null ? ... : <default> replacements ===
render_replacements = [
    # roundDownCapitalMin 5.5
    (r'(\$\{bot\.roundDownCapitalMin\s*\?\?\s*)5\.5(\s*\})', r"\1rec('roundDownCapitalMin')\2"),
    # retryMax 1
    (r'(\$\{bot\.retryMax\s*\?\?\s*)1(\s*\})', r"\1rec('retryMax')\2"),
    # kcMult 1.5
    (r'(\$\{bot\.kcMult\s*\?\?\s*)1\.5(\s*\})', r"\1rec('kcMult')\2"),
    # suggestTpWindow 500
    (r'(\$\{bot\.suggestTpWindow\s*\?\?\s*)500(\s*\})', r"\1rec('suggestTpWindow')\2"),
    # tpTrendMultiplier 2
    (r'(\$\{bot\.tpTrendMultiplier\s*\?\?\s*)2(\s*\})', r"\1rec('tpTrendMultiplier')\2"),
    # dlcBaseLossPct -10
    (r'(\$\{bot\.dlcBaseLossPct\s*\?\?\s*)-10(\s*\})', r"\1rec('dlcBaseLossPct')\2"),
    # autoPauseMinKcPct 2
    (r'(\$\{bot\.autoPauseMinKcPct\s*\?\?\s*)2(\s*\})', r"\1rec('autoPauseMinKcPct')\2"),
    # autoPauseMin24hVolUsdt 1000000
    (r'(\$\{bot\.autoPauseMin24hVolUsdt\s*\?\?\s*)1000000(\s*\})', r"\1rec('autoPauseMin24hVolUsdt')\2"),
    # autoArmLossPct 10
    (r'(\$\{bot\.autoArmLossPct\s*\?\?\s*)10(\s*\})', r"\1rec('autoArmLossPct')\2"),
    # autoArmAgeHours 4
    (r'(\$\{bot\.autoArmAgeHours\s*\?\?\s*)4(\s*\})', r"\1rec('autoArmAgeHours')\2"),
    # auv2MinAgeHours 24
    (r'(\$\{bot\.auv2MinAgeHours\s*\?\?\s*)24(\s*\})', r"\1rec('auv2MinAgeHours')\2"),
    # auv2LossMode 'pct'
    (r"""(\$\{bot\.auv2LossMode\s*\?\?\s*)'pct'(\s*\})""", r"\1rec('auv2LossMode')\2"),
    # auv2MaxLossPct 5
    (r'(\$\{bot\.auv2MaxLossPct\s*\?\?\s*)5(\s*\})', r"\1rec('auv2MaxLossPct')\2"),
    # auv2MaxLossThb 200
    (r'(\$\{bot\.auv2MaxLossThb\s*\?\?\s*)200(\s*\})', r"\1rec('auv2MaxLossThb')\2"),
    # auv2MaxWaitDays 7
    (r'(\$\{bot\.auv2MaxWaitDays\s*\?\?\s*)7(\s*\})', r"\1rec('auv2MaxWaitDays')\2"),
    # cbv2LockHours 8
    (r'(\$\{bot\.cbv2LockHours\s*!=\s*null\s*\?\s*bot\.cbv2LockHours\s*:\s*)8(\s*\})', r"\1rec('cbv2LockHours')\2"),
    # cbv3LockHours 8
    (r'(\$\{bot\.cbv3LockHours\s*!=\s*null\s*\?\s*bot\.cbv3LockHours\s*:\s*)8(\s*\})', r"\1rec('cbv3LockHours')\2"),
    # cbv5LockHours 4
    (r'(\$\{bot\.cbv5LockHours\s*!=\s*null\s*\?\s*bot\.cbv5LockHours\s*:\s*)4(\s*\})', r"\1rec('cbv5LockHours')\2"),
    # cbv5KcLen 20
    (r'(\$\{bot\.cbv5KcLen\s*!=\s*null\s*\?\s*bot\.cbv5KcLen\s*:\s*)20(\s*\})', r"\1rec('cbv5KcLen')\2"),
    # cbv5KcMult 1.2
    (r'(\$\{bot\.cbv5KcMult\s*!=\s*null\s*\?\s*bot\.cbv5KcMult\s*:\s*)1\.2(\s*\})', r"\1rec('cbv5KcMult')\2"),
    # cbv5PivotLookback 3
    (r'(\$\{bot\.cbv5PivotLookback\s*!=\s*null\s*\?\s*bot\.cbv5PivotLookback\s*:\s*)3(\s*\})', r"\1rec('cbv5PivotLookback')\2"),
    # cbv5PivotLeftLen 5
    (r'(\$\{bot\.cbv5PivotLeftLen\s*!=\s*null\s*\?\s*bot\.cbv5PivotLeftLen\s*:\s*)5(\s*\})', r"\1rec('cbv5PivotLeftLen')\2"),
    # cbv5PivotRightLen 5
    (r'(\$\{bot\.cbv5PivotRightLen\s*!=\s*null\s*\?\s*bot\.cbv5PivotRightLen\s*:\s*)5(\s*\})', r"\1rec('cbv5PivotRightLen')\2"),
    # cbv5VolMaLen 20
    (r'(\$\{bot\.cbv5VolMaLen\s*!=\s*null\s*\?\s*bot\.cbv5VolMaLen\s*:\s*)20(\s*\})', r"\1rec('cbv5VolMaLen')\2"),
    # cbv5VolMultiplier 1.5
    (r'(\$\{bot\.cbv5VolMultiplier\s*!=\s*null\s*\?\s*bot\.cbv5VolMultiplier\s*:\s*)1\.5(\s*\})', r"\1rec('cbv5VolMultiplier')\2"),
    # cbv5DebounceCandles 5
    (r'(\$\{bot\.cbv5DebounceCandles\s*!=\s*null\s*\?\s*bot\.cbv5DebounceCandles\s*:\s*)5(\s*\})', r"\1rec('cbv5DebounceCandles')\2"),
    # cbAutoUnlockThresholdPct 1.0
    (r'(\$\{bot\.cbAutoUnlockThresholdPct\s*!=\s*null\s*\?\s*bot\.cbAutoUnlockThresholdPct\s*:\s*)1\.0(\s*\})', r"\1rec('cbAutoUnlockThresholdPct')\2"),
]

# === Strict-default flips (RECOMMENDED now false → lenient !== false rendered wrong for new bots) ===
strict_flips = [
    ('id="f-cb-enabled" ${bot.cbEnabled !== false ? \'checked\' : \'\'}',
     'id="f-cb-enabled" ${bot.cbEnabled === true ? \'checked\' : \'\'}'),
    ('id="f-cbv2-enabled" ${bot.cbv2Enabled !== false ? \'checked\' : \'\'}',
     'id="f-cbv2-enabled" ${bot.cbv2Enabled === true ? \'checked\' : \'\'}'),
    ('id="f-cbv3-enabled" ${bot.cbv3Enabled !== false ? \'checked\' : \'\'}',
     'id="f-cbv3-enabled" ${bot.cbv3Enabled === true ? \'checked\' : \'\'}'),
    ('id="f-safe-trade-enabled" ${bot.safeTradeEnabled !== false ? \'checked\' : \'\'}',
     'id="f-safe-trade-enabled" ${bot.safeTradeEnabled === true ? \'checked\' : \'\'}'),
    ('id="f-xs1-enabled" ${bot.xs1Enabled !== false ? \'checked\' : \'\'}',
     'id="f-xs1-enabled" ${bot.xs1Enabled === true ? \'checked\' : \'\'}'),
]

for old, new in strict_flips:
    if old in src:
        src = src.replace(old, new)
        print(f"  STRICT FLIP OK: {old[:60]}", file=sys.stderr)
    else:
        print(f"  STRICT FLIP NO MATCH: {old[:60]}", file=sys.stderr)

count_changed = 0
for pattern, repl in render_replacements:
    new_src, n = re.subn(pattern, repl, src)
    if n > 0:
        src = new_src
        count_changed += n
        print(f"  OK ({n}x): {pattern[:60]}", file=sys.stderr)
    else:
        print(f"  NO MATCH: {pattern[:60]}", file=sys.stderr)

# === SAVE() inline `|| X` defaults ===
save_replacements = [
    (r'(autoPauseMinKcPct:\s*parseFloat\(document\.getElementById\(\'f-auto-pause-min-kc\'\)\.value\)\s*\|\|\s*)2', r"\1rec('autoPauseMinKcPct')"),
    (r'(autoPauseMin24hVolUsdt:\s*parseFloat\(document\.getElementById\(\'f-auto-pause-min-24h-vol\'\)\.value\)\s*\|\|\s*)1000000', r"\1rec('autoPauseMin24hVolUsdt')"),
    (r'(autoArmLossPct:\s*parseFloat\(document\.getElementById\(\'f-auto-arm-loss-pct\'\)\.value\)\s*\|\|\s*)10', r"\1rec('autoArmLossPct')"),
    (r'(autoArmAgeHours:\s*parseFloat\(document\.getElementById\(\'f-auto-arm-age-hours\'\)\.value\)\s*\|\|\s*)4', r"\1rec('autoArmAgeHours')"),
    (r'(auv2MinAgeHours:\s*parseFloat\(document\.getElementById\(\'f-auv2-min-age-hours\'\)\.value\)\s*\|\|\s*)24', r"\1rec('auv2MinAgeHours')"),
    (r'(auv2MaxLossPct:\s*parseFloat\(document\.getElementById\(\'f-auv2-max-loss-pct\'\)\.value\)\s*\|\|\s*)5', r"\1rec('auv2MaxLossPct')"),
    (r'(auv2MaxLossThb:\s*parseFloat\(document\.getElementById\(\'f-auv2-max-loss-thb\'\)\.value\)\s*\|\|\s*)200', r"\1rec('auv2MaxLossThb')"),
    # auv2MaxWaitDays: parseFloat → keep parseInt? actually let me check — original is parseInt with || 7
    (r"auv2MaxWaitDays:\s*Math\.max\(0,\s*Math\.min\(90,\s*parseInt\(document\.getElementById\('f-auv2-max-wait-days'\)\.value,\s*10\)\s*\|\|\s*7\)\)",
     r"auv2MaxWaitDays: Math.max(0, Math.min(90, parseInt(document.getElementById('f-auv2-max-wait-days').value, 10) || rec('auv2MaxWaitDays')))"),
    (r'(dcaMaxLayers:\s*parseInt\(document\.getElementById\(\'f-dca-max-layers\'\)\.value,\s*10\)\s*\|\|\s*)3', r"\1rec('dcaMaxLayers')"),
    (r'(martingaleMultiplier:\s*parseFloat\(document\.getElementById\(\'f-martingale-multiplier\'\)\.value\)\s*\|\|\s*)1\.5', r"\1rec('martingaleMultiplier')"),
    (r'(martingaleMaxLayerNotional:\s*parseFloat\(document\.getElementById\(\'f-martingale-max-notional\'\)\.value\)\s*\|\|\s*)100', r"\1rec('martingaleMaxLayerNotional')"),
    (r'(roundDownCapitalMin:\s*parseFloat\(document\.getElementById\(\'f-round-down-capital-min\'\)\.value\)\s*\|\|\s*)5\.5', r"\1rec('roundDownCapitalMin')"),
    (r'(cbv5LockHours:\s*parseFloat\(document\.getElementById\(\'f-cbv5-lock-hours\'\)\.value\)\s*\|\|\s*)4', r"\1rec('cbv5LockHours')"),
    (r'(cbv5KcLen:\s*parseInt\(document\.getElementById\(\'f-cbv5-kc-len\'\)\.value,\s*10\)\s*\|\|\s*)20', r"\1rec('cbv5KcLen')"),
    (r'(cbv5KcMult:\s*parseFloat\(document\.getElementById\(\'f-cbv5-kc-mult\'\)\.value\)\s*\|\|\s*)1\.2', r"\1rec('cbv5KcMult')"),
    (r'(cbv5PivotLookback:\s*parseInt\(document\.getElementById\(\'f-cbv5-pivot-lookback\'\)\.value,\s*10\)\s*\|\|\s*)3', r"\1rec('cbv5PivotLookback')"),
    (r'(cbv5PivotLeftLen:\s*parseInt\(document\.getElementById\(\'f-cbv5-pivot-left\'\)\.value,\s*10\)\s*\|\|\s*)5', r"\1rec('cbv5PivotLeftLen')"),
    (r'(cbv5PivotRightLen:\s*parseInt\(document\.getElementById\(\'f-cbv5-pivot-right\'\)\.value,\s*10\)\s*\|\|\s*)5', r"\1rec('cbv5PivotRightLen')"),
    (r'(cbv5VolMaLen:\s*parseInt\(document\.getElementById\(\'f-cbv5-vol-ma-len\'\)\.value,\s*10\)\s*\|\|\s*)20', r"\1rec('cbv5VolMaLen')"),
    (r'(cbv5VolMultiplier:\s*parseFloat\(document\.getElementById\(\'f-cbv5-vol-mult\'\)\.value\)\s*\|\|\s*)1\.5', r"\1rec('cbv5VolMultiplier')"),
    (r'(cbv5DebounceCandles:\s*parseInt\(document\.getElementById\(\'f-cbv5-debounce\'\)\.value,\s*10\)\s*\|\|\s*)5', r"\1rec('cbv5DebounceCandles')"),
]

for pattern, repl in save_replacements:
    new_src, n = re.subn(pattern, repl, src)
    if n > 0:
        src = new_src
        count_changed += n
        print(f"  OK save ({n}x): {pattern[:80]}", file=sys.stderr)
    else:
        print(f"  NO MATCH save: {pattern[:80]}", file=sys.stderr)

print(f"\nTotal changes: {count_changed}", file=sys.stderr)
print(f"Bytes changed: {len(src) - len(original)}", file=sys.stderr)

if src != original:
    with open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print("FILE WRITTEN", file=sys.stderr)
