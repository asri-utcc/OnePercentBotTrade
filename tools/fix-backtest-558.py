#!/usr/bin/env python3
"""FIX-2026-08-28 UX: replace backtest.js:558 native confirm with modal helper."""
import re

with open('public/js/pages/backtest.js', 'rb') as f:
    data = f.read()

# Find exact block
start = data.find(b'    const confirm = window.confirm(')
end = data.find(b'    if (!confirm) return;', start) + len(b'    if (!confirm) return;')
find = data[start:end]

# Build replacement (CRLF line endings). Use literal UTF-8 characters.
repl = (
    '    const ok = await AdminModalAlert.confirm({\r\n'
    '      title: \'⚠️ ทุนรวมไม่พอ\',\r\n'
    '      message: `ทุนรวม ($${totalCapital}) น้อยกว่าที่ควรใช้ ($${needed})\\n'
    '(ผลรวม Max ไม้ × ทุน/ไม้ ของทุกบอท)\\n\\n'
    'จะมี skip เยอะเพราะทุนเต็ม — ดำเนินการต่อหรือไม่?`,\r\n'
    '      level: \'warn\', okLabel: \'ดำเนินการต่อ\',\r\n'
    '    });\r\n'
    '    if (!ok) return;'
)
repl_bytes = repl.encode('utf-8')

if find in data:
    new = data.replace(find, repl_bytes, 1)
    with open('public/js/pages/backtest.js', 'wb') as f:
        f.write(new)
    print('OK: backtest.js:558 replaced,', len(find), '→', len(repl_bytes), 'bytes')
else:
    print('STILL NOT FOUND')
    print(f'Find bytes: {find!r}')
