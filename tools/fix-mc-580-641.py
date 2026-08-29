#!/usr/bin/env python3
"""FIX-2026-08-28 UX: replace masterConfigModal.js:580 and :641 native dialogs."""
with open('public/js/partials/masterConfigModal.js', 'rb') as f:
    data = f.read()

# === Line 580 ===
find580 = b'    const ok = window.confirm(`\xe2\x9a\xa0\xef\xb8\x8f \xe0\xb8\xa2\xe0\xb8\xb7\xe0\xb8\x99\xe0\xb8\xa2\xe0\xb8\xb1\xe0\xb8\x99: overwrite ${Object.keys(settings).length} fields \xe0\xb8\x9a\xe0\xb8\x99 ${selectedBotIds.length} \xe0\xb8\x9a\xe0\xb8\xad\xe0\xb8\x97\\n\\nFields \xe0\xb8\x97\xe0\xb8\xb5\xe0\xb9\x88\xe0\xb8\x88\xe0\xb8\xb0\xe0\xb9\x80\xe0\xb8\x9b\xe0\xb8\xa5\xe0\xb8\xb5\xe0\xb9\x88\xe0\xb8\xa2\xe0\xb8\x99:\\n${Object.keys(settings).join(\', \')}`);\r\n'
print(f'Line 580 find: {len(find580)} bytes, ends with: {find580[-20:]!r}')
if find580 in data:
    repl580 = (
        '    const ok = await AdminModalAlert.confirm({\r\n'
        '      title: \'⚠️ Bulk Update\',\r\n'
        '      message: `ยืนยัน: overwrite ${Object.keys(settings).length} fields บน ${selectedBotIds.length} บอท\\n\\n'
        'Fields ที่จะเปลี่ยน:\\n${Object.keys(settings).join(\', \')}`,\r\n'
        '      level: \'error\', okLabel: \'Overwrite\',\r\n'
        '    });\r\n'
        '    if (!ok) return;\r\n'
    ).encode('utf-8')
    data = data.replace(find580, repl580, 1)
    print('OK: masterConfigModal.js:580')
else:
    print('NOT FOUND: masterConfigModal.js:580')

# === Line 641 ===
find641 = b'    const ok = window.confirm(`\xef\xbf\xbd\xef\xb8\x8f \xe0\xb8\xa2\xe0\xb8\xb7\xe0\xb8\x99\xe0\xb8\xa2\xe0\xb8\xb1\xe0\xb8\x99${verb} ${toggleableBotIds.length} \xe0\xb8\x9a\xe0\xb8\xad\xe0\xb8\x97?${skipNote}`);\r\n'
print(f'Line 641 find: {len(find641)} bytes, ends with: {find641[-20:]!r}')
if find641 in data:
    repl641 = (
        '    const ok = await AdminModalAlert.confirm({\r\n'
        '      title: verb === \'เปิด\' ? \'▶️ Start Bots\' : \'⏸️ Stop Bots\',\r\n'
        '      message: `ยืนยัน${verb} ${toggleableBotIds.length} บอท?${skipNote}`,\r\n'
        '      level: \'warn\', okLabel: verb,\r\n'
        '    });\r\n'
        '    if (!ok) return;\r\n'
    ).encode('utf-8')
    data = data.replace(find641, repl641, 1)
    print('OK: masterConfigModal.js:641')
else:
    print('NOT FOUND: masterConfigModal.js:641')

# Save
with open('public/js/partials/masterConfigModal.js', 'wb') as f:
    f.write(data)

# Final verify
print('=== final grep ===')
import re
matches = re.findall(rb'(^|[^a-zA-Z.])(window\.)?(alert|confirm|prompt)\(', data)
print(f'Remaining native: {len(matches)}')
