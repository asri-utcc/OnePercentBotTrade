'use strict';

/**
 * FIX-2026-08-26 Phase 2c: Consent page content.
 *
 *   User design (2026-08-26):
 *     - 3 sections, English first then Thai (legal → accessible)
 *     - Section 1: investment risk — legal-style language
 *     - Section 2: data collection — plain language
 *     - Section 3: phone-home requirement
 *     - user must tick each box before Accept/Decline buttons unlock
 *
 *   `adminMonitorEnabled` controls whether sections 2-3 are shown
 *   (no admin = no data collection, no phone-home).
 */

module.exports = function buildSections({ adminMonitorEnabled }) {
  const sections = [];

  // ===== Section 1: Investment risk — always shown =====
  sections.push({
    id: 'risk',
    title: { en: 'Investment Risk Acknowledgement', th: 'การยอมรับความเสี่ยงในการลงทุน' },
    body: {
      en: [
        'This software ("the bot") is an automated cryptocurrency trading system that places real buy and sell orders on your Binance account using funds you have authorised.',
        'Trading cryptocurrencies — including but not limited to spot trading, algorithmic trading, and any strategy implemented by the bot — involves substantial risk of loss. You may lose part or all of the capital you allocate to the bot.',
        'Past performance of the bot, any backtest results, or any sample trades shown in documentation are NOT a guarantee of future results. Market conditions, liquidity, exchange outages, regulatory action, software bugs, network failures, and other factors may cause the bot to underperform or lose money.',
        'The author / developer of the bot is NOT a licensed financial advisor. The bot is provided "AS IS", without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, and non-infringement.',
        'You are solely responsible for your trading decisions and for any losses incurred while using the bot. By continuing, you confirm that you understand and voluntarily accept these risks.',
      ],
      th: [
        'ซอฟต์แวร์นี้ ("บอท") เป็นระบบเทรดคริปโตอัตโนมัติ ที่ส่งคำสั่งซื้อ-ขายจริงบนบัญชี Binance ของคุณ โดยใช้เงินทุนที่คุณอนุญาต',
        'การเทรดคริปโต รวมถึง spot trading, algorithmic trading และกลยุทธ์ใดๆ ที่บอทใช้ มีความเสี่ยงสูงที่จะขาดทุน คุณอาจเสียเงินลงทุนทั้งหมดหรือบางส่วน',
        'ผลการเทรดในอดีต, ผล backtest หรือตัวอย่างที่แสดงในเอกสาร ไม่ใช่การรับประกันผลในอนาคต สภาวะตลาด, สภาพคล่อง, exchange ล่ม, กฎระเบียบ, bug, ปัญหาเครือข่าย และปัจจัยอื่นๆ อาจทำให้บอทขาดทุนได้',
        'ผู้พัฒนาบอท ไม่ใช่ที่ปรึกษาทางการเงินที่มีใบอนุญาต บอทมีให้ "ตามสภาพ" (AS IS) โดยไม่มีการรับประกันใดๆ ทั้งสิ้น',
        'คุณเป็นผู้รับผิดชอบการตัดสินใจเทรดและขาดทุนที่อาจเกิดขึ้นทั้งหมดแต่เพียงผู้เดียว การกดยอมรับแสดงว่าคุณเข้าใจและยอมรับความเสี่ยงเหล่านี้ด้วยความสมัครใจ',
      ],
    },
  });

  // ===== Section 2: Data collection — only when admin monitor enabled =====
  if (adminMonitorEnabled) {
    sections.push({
      id: 'data',
      title: { en: 'Data Collection Notice', th: 'แจ้งเตือนการเก็บข้อมูล' },
      body: {
        en: [
          'When you enable phone-home (admin monitor), the bot will periodically send the following information to the author\'s admin server:',
          '  • machineId (a random per-installation identifier, generated locally; NOT tied to your hardware serial, IP, or personal identity)',
          '  • hostname, OS platform, Node.js version, bot version',
          '  • your public IP address (as seen by the admin server)',
          '  • aggregated trading metrics: number of running bots, active positions, daily/monthly/all-time trade counts and PnL',
          '  • an aggregated snapshot of your bot configurations (safe keys only — Binance API keys, passwords, and Telegram tokens are NEVER sent)',
          'The data is used solely for: (a) verifying your license is active, (b) showing you a dashboard of your bots, (c) sending remote commands you explicitly request, and (d) detecting outdated software versions.',
          'The data is NOT sold, NOT shared with third parties, and is auto-deleted 90 days after your last contact.',
        ],
        th: [
          'เมื่อคุณเปิด phone-home (admin monitor) บอทจะส่งข้อมูลต่อไปนี้ไปยัง admin server ของผู้พัฒนาเป็นระยะ:',
          '  • machineId (ค่า random ต่อการติดตั้ง สร้างในเครื่อง ไม่ผูกกับ serial hardware, IP หรือตัวตนของคุณ)',
          '  • hostname, OS platform, Node.js version, bot version',
          '  • public IP ของคุณ (ตามที่ admin server เห็น)',
          '  • trading metrics รวม: จำนวนบอทที่รัน, position ที่เปิด, จำนวนเทรด+กำไรขาดทุน รายวัน/เดือน/ทั้งหมด',
          '  • snapshot การตั้งค่าบอท (เฉพาะ key ที่ปลอดภัย — Binance API key, password, Telegram token จะไม่ถูกส่งเด็ดขาด)',
          'ข้อมูลถูกใช้เพื่อ: (ก) ตรวจสอบ license, (ข) แสดง dashboard บอทของคุณ, (ค) รับคำสั่งที่คุณสั่งเอง และ (ง) ตรวจจับเวอร์ชั่นที่ล้าสมัย',
          'ข้อมูลจะไม่ถูกขาย ไม่แชร์กับบุคคลที่สาม และจะถูกลบอัตโนมัติหลังไม่มีการติดต่อ 90 วัน',
        ],
      },
    });
  }

  // ===== Section 3: Phone-home requirement — only when admin monitor enabled =====
  if (adminMonitorEnabled) {
    sections.push({
      id: 'phonehome',
      title: { en: 'Phone-Home Requirement (48-Hour Grace)', th: 'ข้อกำหนด Phone-Home (ผ่อนผัน 48 ชั่วโมง)' },
      body: {
        en: [
          'The bot must contact the admin server at least once every 48 hours to keep your license verified.',
          'If the admin server has not heard from this machine for more than 48 hours:',
          '  • the bot will PAUSE itself automatically — it will STOP opening any new positions',
          '  • any positions currently held will REMAIN OPEN and continue to be managed by their existing take-profit / stop-loss rules',
          '  • you will be notified (via Telegram, if configured) so you can investigate the connection issue',
          'This policy protects your money: the bot does NOT force-close existing positions when phone-home fails. You retain full control of any open trades.',
          'If you actively choose not to phone-home, you may decline this consent now — the bot will then refuse to open any new positions from the moment you decline.',
        ],
        th: [
          'บอทต้องติดต่อ admin server อย่างน้อยทุก 48 ชั่วโมง เพื่อให้ license ยังถูกต้อง',
          'ถ้า admin server ไม่ได้รับการติดต่อจากเครื่องนี้นานเกิน 48 ชั่วโมง:',
          '  • บอทจะหยุดตัวเองอัตโนมัติ — จะไม่เปิด position ใหม่',
          '  • position ที่เปิดอยู่จะยังคงเปิดต่อ และ take-profit / stop-loss เดิมยังทำงานตามปกติ',
          '  • คุณจะได้รับแจ้งเตือน (ผ่าน Telegram ถ้าตั้งค่าไว้) เพื่อตรวจสอบปัญหาการเชื่อมต่อ',
          'นโยบายนี้ปกป้องเงินของคุณ: บอทจะ ไม่ บังคับปิด position เดิมเมื่อ phone-home ล้ม คุณยังควบคุมการเทรดที่เปิดอยู่ได้เต็มที่',
          'ถ้าคุณเลือกที่จะไม่ phone-home สามารถกด "ไม่ยอมรับ" ได้เลย — บอทจะปฏิเสธการเปิด position ใหม่ทันทีหลังกด',
        ],
      },
    });
  }

  return sections;
};