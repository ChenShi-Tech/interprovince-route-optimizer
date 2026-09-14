#!/usr/bin/env node
/**
 * 费率数据核实后的一次性整合补丁。
 *
 * 依据：
 *  1. 发改价格〔2026〕1077号 附件1《省级电网输配电价表》（发改委官方 PDF，34 张省表）
 *  2. 各省发改委第四监管周期落实通知中的「政府性基金及附加」分项
 *  3. 独立复核：49 条专项工程数值全部与发改委/国网原文吻合
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extraPath = path.join(root, 'src/extra.json');
const tariffPath = path.join(root, 'docs/tariff.json');
const extra = JSON.parse(fs.readFileSync(extraPath, 'utf8'));
const tariff = JSON.parse(fs.readFileSync(tariffPath, 'utf8'));

// ── 1. 省级参数：真实核定价（发改价格〔2026〕1077号，2026-08-01 起执行） ──
// [省代码, 220kV+ 两部制 元/MWh, 基金及附加 元/MWh, 送受端口径备注]
const PROV = [
  ['BJ', 150.0, 27.16875, '北京电网输配电价表（35~110kV 合并档）'],
  ['TJ', 105.2, 27.16875, '津发改价管〔2026〕245号'],
  ['HE', 72.6, 24.06875, '河北电网（冀北电网为 70.5，另有独立表）'],
  ['SX', 29.0, 43.36875, '山西电网（含两部制 4 档）'],
  ['NM', 42.9, 22.425, '蒙西电网（内蒙古电力集团单独核价；蒙东电网为 60.1）'],
  ['LN', 57.1, 26.825, '辽宁电网'],
  ['JL', 111.3, 45.025, '吉林电网'],
  ['HL', 76.3, 24.825, '黑龙江电网'],
  ['SH', 85.1, 29.115, '上海电网'],
  ['JS', 51.8, 29.4, '江苏电网'],
  ['ZJ', 66.3, 29.23875, '浙江电网'],
  ['AH', 54.8, 28.87, '安徽电网'],
  ['FJ', 46.2, 27.66875, '福建电网'],
  ['JX', 93.5, 26.7525, '江西电网（此前误用单一制 116.6，已改正为两部制）'],
  ['SD', 89.0, 27.16875, '山东电网（鲁发改价格〔2026〕556号）'],
  ['HA', 98.0, 28.889375, '河南电网'],
  ['HB', 69.4, 45.2, '湖北电网'],
  ['HN', 85.2, 46.25, '湖南电网（湘发改价调〔2026〕460号）'],
  ['GD', 44.9, 27.66875, '广东电网全省均值，实际执行需叠加价区交叉补贴（珠三角 +23.7、东西两翼 −58.0、粤北 −89.6 元/MWh）'],
  ['GX', 29.3, 41.825, '广西电网（基金按两部制口径 41.825；单一制为 51.825）'],
  ['GZ', 46.8, 25.325, '贵州电网'],
  ['YN', 47.5, 63.875, '云南电网（含地方水利建设基金 0.02 元/kWh，为全国最高）'],
  ['SC', 46.6, 47.16875, '四川电网'],
  ['CQ', 86.8, 47.69375, '重庆电网'],
  ['SN', 73.1, 26.325, '陕西电网（不含榆林地区；榆林地区为 54.3）。第四监管周期起已取消农网还贷资金 0.02 元/kWh'],
  ['GS', 69.3, 22.925, '甘肃电网（甘发改价格〔2026〕432号）'],
  ['QH', 60.0, 21.525, '青海电网'],
  ['NX', 49.1, 21.325, '宁夏电网'],
  ['XJ', 48.5, 4.1, '新疆电网（基金仅 4.1 元/MWh，为全国最低）'],
  ['XZ', 282.4, null, '西藏电网（由国家发改委核定，2026-10-01 起执行）。⚠️ 政府性基金及附加未获取'],
];

const oldNet = {};
Object.entries(extra.provinces).forEach(([k, v]) => { oldNet[k] = v.net; });

let changed = 0, unchanged = 0;
for (const [code, net, fund, note] of PROV) {
  const p = extra.provinces[code];
  if (!p) { console.log(`  ⚠ 未找到省份 ${code}`); continue; }
  const wasEst = /^估/.test(p.netSrc || '') || /待补/.test(p.netSrc || '');
  const delta = (net - p.net).toFixed(1);
  if (Math.abs(net - p.net) > 0.05 || p.fund !== fund) {
    changed++;
    console.log(`  ✏ ${p.n.padEnd(4)} 输配电价 ${String(p.net).padStart(6)} → ${String(net).padStart(6)} (${delta >= 0 ? '+' : ''}${delta})　基金 ${String(p.fund).padStart(8)} → ${String(fund).padStart(9)}${wasEst ? '  ← 原为估算' : ''}`);
  } else unchanged++;
  p.net = net;
  p.fund = fund;
  p.netSrc = '发改价格〔2026〕1077号 附件1 省级电网输配电价表 · 220kV及以上两部制电量电价。' + note;
}
console.log(`\n  省级参数：修正 ${changed} 条，未变 ${unchanged} 条`);

// ── 2. 送出省输电价格：改用逐省核定值（元/千瓦时） ──
extra.exportTariff = {
  _note: '第四监管周期各省「因省间互济等因素临时送省外电量」的送出省输电价格（元/千瓦时，含税，不计线损）。无专属值的省份适用通用条款 0.03 元/千瓦时。',
  BJ: 0.030, TJ: 0.030, HE: 0.030, JX: 0.030, JS: 0.030, SH: 0.030, ZJ: 0.030, AH: 0.030, SD: 0.030, GD: 0.030,
  SX: 0.0217, NM: 0.0300, NME: 0.0268, HE_B: 0.0238,
  LN: 0.0259, JL: 0.0251, HL: 0.0235,
  FJ: 0.0220, HA: 0.0255, HB: 0.0328, HN: 0.0240,
  GX: 0.0180, CQ: 0.0216, SC: 0.0350, GZ: 0.0302, YN: 0.0478,
  SN: 0.0348, GS: 0.0280, QH: 0.0339, NX: 0.0250, XJ: 0.0343, XZ: 0.0495,
};

// ── 3. 费率库：修正计费口径的条号引用 ──
let fixedBilling = 0;
for (const r of tariff) {
  if (r.billing_basis && r.billing_basis.includes('1455号第十八条')) {
    r.billing_basis = r.billing_basis.replace('1455号第十八条', '1455号第十九条');
    fixedBilling++;
  }
}
console.log(`  计费口径条号修正：${fixedBilling} 条`);

// ── 4. 费率库：标注出处版本问题（5 条报备价的 URL 指向 2025 年表） ──
const URL_ISSUE = ['金永', '中衡', '坤渝', '庆东', '宝合'];
const VER_ISSUE = ['青豫', '吉泉', '昭沂'];
let flagged = 0;
for (const r of tariff) {
  const hit5 = URL_ISSUE.some((k) => r.name.includes(k));
  const hitV = VER_ISSUE.some((k) => r.name.includes(k));
  if (!hit5 && !hitV) continue;
  r.source.doc_version = '国家电网《2026年跨省跨区交易各环节输电价格》（2026-07-22，40 条）';
  r.source_issue = hit5
    ? '⚠️ 原引用 URL 指向《2025年国家电网跨省跨区交易各环节输电价格》（36 条，落款 2024-10-31），该表中不存在本工程。数值已由独立复核对照 2026 年表原文确认正确，但 2026 年表的稳定公开地址待补，可核性受限。'
    : '引用的 PDF 实为 2025 年表（落款 2024-10-31），两版数值恰好一致，故数值可用；但版本标注需更正。';
  if (hit5) r.confidence = 'medium';
  flagged++;
}
console.log(`  出处版本标注：${flagged} 条`);

// ── 5. 辛洹线线损率补注 ──
const xh = tariff.find((r) => r.name.includes('辛洹'));
if (xh) {
  xh.note = (xh.note || '') + ' 原文列线损率 0.00%，因属单一容量电价工程、输送电量不单独计费，库中置 null 作口径处理。';
  console.log('  辛洹线线损率已补注');
}

fs.writeFileSync(extraPath, JSON.stringify(extra, null, 2) + '\n');
fs.writeFileSync(tariffPath, JSON.stringify(tariff, null, 2) + '\n');
console.log('\n✅ 数据文件已更新');
