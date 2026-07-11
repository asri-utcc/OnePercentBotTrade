'use strict';

const config = require('../../config');
const binanceRest = require('./binanceRest');

let accountCache = { data: null, ts: 0 };
const ACCOUNT_TTL_MS = 5 * 60 * 1000;

async function getAccount() {
  const now = Date.now();
  if (accountCache.data && now - accountCache.ts < ACCOUNT_TTL_MS) {
    return accountCache.data;
  }
  const acc = await binanceRest.getAccount();
  accountCache = { data: acc, ts: now };
  return acc;
}

function clearCache() {
  accountCache = { data: null, ts: 0 };
}

/**
 * คืน maker fee rate (decimal เช่น 0.00075 = 0.075%)
 * Binance ในบัญชีส่วนใหญ่จะคืนค่า makerCommission เป็น 0.075 (หมายถึง 7.5%) จริงๆ
 * แต่ค่าตรงๆ มักเป็น "0.00075" → ต้องดูจาก doc จริง
 * สำหรับการใช้งานของเรา จะ return ค่า config-driven เป็นหลัก
 */
function getMakerRate({ useBnbForFees = null } = {}) {
  const useBnb = useBnbForFees !== null ? useBnbForFees : config.binance.useBnbForFees;
  return useBnb ? config.fees.bnbMaker : config.fees.normalMaker;
}

/**
 * คำนวณราคาขายเพื่อให้ได้กำไรสุทธิ >= tpPercent (เปอร์เซ็นต์ของ notional)
 * @param buyPrice ราคาซื้อ
 * @param tpPercent เป้าหมายกำไร เช่น 0.1 หมายถึง 0.1%
 * @param feeRate 0.00075 หรือ 0.001
 */
function calcSellPrice({ buyPrice, tpPercent, feeRate }) {
  const p = parseFloat(buyPrice);
  const tp = parseFloat(tpPercent);
  const f = parseFloat(feeRate);
  // sellPrice = buyPrice * (1 + tp% + 2*feeRate)
  // tp% 0.1 = 0.001
  const multiplier = 1 + tp / 100 + 2 * f;
  return p * multiplier;
}

/**
 * คำนวณ P&L สุทธิ (USDT) ของรอบเทรดหนึ่งๆ
 * @param buyPrice ราคาซื้อ
 * @param sellPrice ราคาขาย
 * @param qty จำนวน base asset
 * @param feeRate (เป็นเศษส่วน เช่น 0.00075)
 */
function calcPnl({ buyPrice, sellPrice, qty, feeRate }) {
  const gross = (parseFloat(sellPrice) - parseFloat(buyPrice)) * parseFloat(qty);
  // fee จ่าย 2 ขา: ขาแรกจ่าย buyPrice * qty * feeRate (USDT), ขาสองจ่าย sellPrice * qty * feeRate (USDT)
  // แต่กรณีจ่ายด้วย BNB มันคือ notional * feeRate
  const fees = (parseFloat(buyPrice) + parseFloat(sellPrice)) * parseFloat(qty) * parseFloat(feeRate);
  const net = gross - fees;
  const notional = parseFloat(buyPrice) * parseFloat(qty);
  const pnlPercent = notional > 0 ? (net / notional) * 100 : 0;
  return { gross, fees, net, pnlPercent, notional };
}

module.exports = {
  getAccount,
  clearCache,
  getMakerRate,
  calcSellPrice,
  calcPnl,
};