#!/usr/bin/env node
// FIX-2026-08-28 UX: replace native alert/confirm/prompt with AdminModalAlert helpers.
// Idempotent.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Each entry: { file, find, replace, label }
const ops = [
  // ── bot-detail.js:331 ──
  {
    label: 'bot-detail.js:331 alert(Bot not found)',
    file: 'public/js/pages/bot-detail.js',
    find: "      alert('Bot not found');",
    replace: "      await AdminModalAlert.alert('Bot not found', 'warn');",
  },
  // ── bot-edit.js:797 ──
  {
    label: 'bot-edit.js:797 window.confirm(Import จะทับ)',
    file: 'public/js/pages/bot-edit.js',
    find: "    if (mode === 'replace' && !window.confirm('Import จะทับฟอร์มทั้งหมด (ยกเว้น symbol ที่ล็อกไว้) — แน่ใจมั้ย?')) return;",
    replace: "    if (mode === 'replace' && !(await AdminModalAlert.confirm({ title: '⚠️ Import (Replace Mode)', message: 'Import จะทับฟอร์มทั้งหมด (ยกเว้น symbol ที่ล็อกไว้) — แน่ใจมั้ย?', level: 'warn', okLabel: 'Import' }))) return;",
  },
  // ── bots.js:2479 ──
  {
    label: 'bots.js:2479 alert(บันทึก API keys)',
    file: 'public/js/pages/bots.js',
    find: "    alert('บันทึก API keys แล้ว — กรุณา restart server เพื่อให้ User Data Stream ทำงาน');",
    replace: "    await AdminModalAlert.alert('บันทึก API keys แล้ว — กรุณา restart server เพื่อให้ User Data Stream ทำงาน', 'success');",
  },
  // ── backtest.js:452 ──
  {
    label: 'backtest.js:452 confirm(ลบ?)',
    file: 'public/js/pages/backtest.js',
    find: "  if (!confirm('ลบ?')) return;",
    replace: "  if (!(await AdminModalAlert.confirm({ title: '🗑️ ลบ Backtest', message: 'ลบ?', level: 'error', okLabel: 'ลบ' }))) return;",
  },
  // ── backtest.js:558 — multi-line, use literal replacement ──
  {
    label: 'backtest.js:558 const confirm = window.confirm(...)',
    file: 'public/js/pages/backtest.js',
    find: "    const confirm = window.confirm(\n      `⚠️ ทุนรวม ($${totalCapital}) น้อยกว่าที่ควรใช้ ($${needed})\\n` +\n      `(ผลรวม Max ไม้ × ทุน/ไม้ ของทุกบอท)\\n\\n` +\n      `จะมี skip เยอะเพราะทุนเต็ม — ดำเนินการต่อหรือไม่?`\n    );\n    if (!confirm) return;",
    replace: "    const ok = await AdminModalAlert.confirm({\n      title: '⚠️ ทุนรวมไม่พอ',\n      message: `ทุนรวม ($${totalCapital}) น้อยกว่าที่ควรใช้ ($${needed})\\n(ผลรวม Max ไม้ × ทุน/ไม้ ของทุกบอท)\\n\\nจะมี skip เยอะเพราะทุนเต็ม — ดำเนินการต่อหรือไม่?`,\n      level: 'warn', okLabel: 'ดำเนินการต่อ',\n    });\n    if (!ok) return;",
  },
  // ── masterConfigModal.js:516 ──
  {
    label: 'masterConfigModal.js:516 forceRunAutoDelete',
    file: 'public/js/partials/masterConfigModal.js',
    find: "    if (!window.confirm('▶ Force run Auto Delete Bot 1 cycle? จะสแกนบอททั้งหมดและ soft-delete ตาม threshold')) return;",
    replace: "    if (!(await AdminModalAlert.confirm({ title: '▶ Force Run Auto Delete Bot', message: 'Force run Auto Delete Bot 1 cycle? จะสแกนบอททั้งหมดและ soft-delete ตาม threshold', level: 'warn', okLabel: '▶ Run' }))) return;",
  },
  // ── masterConfigModal.js:580 ──
  {
    label: 'masterConfigModal.js:580 bulk-update clobber',
    file: 'public/js/partials/masterConfigModal.js',
    find: "    const ok = window.confirm(`⚠️ ยืนยัน: overwrite ${Object.keys(settings).length} fields บน ${selectedBotIds.length} บอท\\n\\nFields ที่จะเปลี่ยน:\\n${Object.keys(settings).join(', ')}`);\n    if (!ok) return;",
    replace: "    const ok = await AdminModalAlert.confirm({\n      title: '⚠️ Bulk Update',\n      message: `ยืนยัน: overwrite ${Object.keys(settings).length} fields บน ${selectedBotIds.length} บอท\\n\\nFields ที่จะเปลี่ยน:\\n${Object.keys(settings).join(', ')}`,\n      level: 'error', okLabel: 'Overwrite',\n    });\n    if (!ok) return;",
  },
  // ── masterConfigModal.js:641 (Stop/Start bots) ──
  {
    label: 'masterConfigModal.js:641 toggle start/stop',
    file: 'public/js/partials/masterConfigModal.js',
    find: "    const ok = window.confirm(`�️ ยืนยัน${verb} ${toggleableBotIds.length} บอท?${skipNote}`);\n    if (!ok) return;",
    replace: "    const ok = await AdminModalAlert.confirm({\n      title: verb === 'เปิด' ? '▶️ Start Bots' : '⏸️ Stop Bots',\n      message: `ยืนยัน${verb} ${toggleableBotIds.length} บอท?${skipNote}`,\n      level: 'warn', okLabel: verb,\n    });\n    if (!ok) return;",
  },
  // ── masterConfigModal.js:702 (Restore) ──
  {
    label: 'masterConfigModal.js:702 bulk-restore',
    file: 'public/js/partials/masterConfigModal.js',
    find: "    const ok = window.confirm(`↩️ ยืนยัน Restore ${restoreIds.length} บอท?${skipNote}\\n\\nบอทที่ restore แล้วจะกลับมา�ำงานตามปกติ (แต่จะยังไม่ถูก Start อัตโนมัติ — ใ�้ปุ่ม \"▶️ Start\" แยกต่างหา�)`);\n    if (!ok) return;",
    replace: "    const ok = await AdminModalAlert.confirm({\n      title: '↩️ Restore Bots',\n      message: `ยืนยัน Restore ${restoreIds.length} บอท?${skipNote}\\n\\nบอทที่ restore แล้วจะกลับมาทำงานตามปกติ (แต่จะยังไม่ถูก Start อัตโนมัติ — ใช้ปุ่ม \"▶️ Start\" แยกต่างหาก)`,\n      level: 'warn', okLabel: '↩️ Restore',\n    });\n    if (!ok) return;",
  },
  // ── masterConfigModal.js:818 (Save as Defaults) ──
  {
    label: 'masterConfigModal.js:818 save as defaults',
    file: 'public/js/partials/masterConfigModal.js',
    find: "    if (!window.confirm(`📋 จะตั้งค่า ${fieldCount} fields เป็นค่าเริ่มต้นของบอทใหม่ (Bot Defaults)?\\n\\nใช้กับ \"+ New Bot\" และ \"Auto Add Bot\" ในครั้งถัดไป`)) return;",
    replace: "    if (!(await AdminModalAlert.confirm({\n      title: '📋 Save as Bot Defaults',\n      message: `จะตั้งค่า ${fieldCount} fields เป็นค่าเริ่มต้นของบอทใหม่ (Bot Defaults)?\\n\\nใช้กับ \"+ New Bot\" และ \"Auto Add Bot\" ในครั้งถัดไป`,\n      level: 'warn', okLabel: 'Save as Defaults',\n    }))) return;",
  },
  // ── masterConfigModal.js:852 (prompt) ──
  {
    label: 'masterConfigModal.js:852 promptForName',
    file: 'public/js/partials/masterConfigModal.js',
    find: "  function promptForName(title, defaultValue) {\n    const v = window.prompt(title, defaultValue || '');\n    if (v == null) return null;\n    return v;\n  }",
    replace: "  async function promptForName(title, defaultValue) {\n    const v = await AdminModalAlert.prompt({\n      title: title || 'กรอกชื่อ',\n      defaultValue: defaultValue || '',\n      placeholder: 'ตั้งชื่อ',\n      level: 'info', okLabel: 'ตกลง',\n    });\n    return v;\n  }",
  },
  // ── masterConfigModal.js:880 (overwrite template) ──
  {
    label: 'masterConfigModal.js:880 overwrite template',
    file: 'public/js/partials/masterConfigModal.js',
    find: "      if (!window.confirm(`⚠️ จะ overwrite settings ของ template \"${existing.name}\" ใ่มั้ย? (ชื่อเดิม)`)) return;",
    replace: "      if (!(await AdminModalAlert.confirm({\n        title: '⚠️ Overwrite Template',\n        message: `จะ overwrite settings ของ template \"${existing.name}\" ใช่มั้ย? (ชื่อเดิม)`,\n        level: 'warn', okLabel: 'Overwrite',\n      }))) return;",
  },
  // ── masterConfigModal.js:907 (load template - form dirty) ──
  {
    label: 'masterConfigModal.js:907 load template dirty',
    file: 'public/js/partials/masterConfigModal.js',
    find: "    if (isFormDirty() && !window.confirm('ท่านมีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก — แน่ใจมั้ยที่จะ Load (จะทับฟอร์ม)?')) return;",
    replace: "    if (isFormDirty() && !(await AdminModalAlert.confirm({\n      title: '⚠️ Load Template',\n      message: 'ท่านมีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก — แน่ใจมั้ยที่จะ Load (จะทับฟอร์ม)?',\n      level: 'warn', okLabel: 'Load ทับ',\n    }))) return;",
  },
  // ── masterConfigModal.js:990 (delete template) ──
  {
    label: 'masterConfigModal.js:990 delete template',
    file: 'public/js/partials/masterConfigModal.js',
    find: "    if (!window.confirm(`🗑️ ลบ template \"${existing.name}\" ใช่มั้ย? การกระทำนี้ไม่สามาร undo ได้`)) return;",
    replace: "    if (!(await AdminModalAlert.confirm({\n      title: '🗑️ Delete Template',\n      message: `ลบ template \"${existing.name}\" ใช่มั้ย? การกระทำนี้ไม่สามาร undo ได้`,\n      level: 'error', okLabel: '🗑️ ลบ',\n    }))) return;",
  },
  // ── masterConfigModal.js:1043 (import - replace mode) ──
  {
    label: 'masterConfigModal.js:1043 import replace dirty',
    file: 'public/js/partials/masterConfigModal.js',
    find: "    if (mode === 'replace' && isFormDirty() && !window.confirm('ท่านมีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก — แน่ใจมั้ยที่จะ Import (จะทับฟอร์ม)?')) return;",
    replace: "    if (mode === 'replace' && isFormDirty() && !(await AdminModalAlert.confirm({\n      title: '⚠️ Import (Replace Mode)',\n      message: 'ท่านมีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก — แน่ใจมั้ยที่จะ Import (จะทับฟอร์ม)?',\n      level: 'warn', okLabel: 'Import ทับ',\n    }))) return;",
  },
];

let okCount = 0, skipCount = 0, errCount = 0;
for (const op of ops) {
  const full = path.join(ROOT, op.file);
  if (!fs.existsSync(full)) { console.error('MISSING:', op.file); errCount++; continue; }
  let src = fs.readFileSync(full, 'utf8');
  if (!src.includes(op.find)) {
    console.error('NOT FOUND:', op.label);
    console.error('  search bytes:', JSON.stringify(op.find.slice(0, 100)));
    errCount++;
    continue;
  }
  if (src.includes(op.replace)) {
    console.log('SKIP (already applied):', op.label);
    skipCount++;
    continue;
  }
  src = src.replace(op.find, op.replace);
  fs.writeFileSync(full, src, 'utf8');
  console.log('OK:', op.label);
  okCount++;
}
console.log(`\n=== ${okCount} applied, ${skipCount} skipped, ${errCount} errors ===`);
process.exit(errCount === 0 ? 0 : 1);
