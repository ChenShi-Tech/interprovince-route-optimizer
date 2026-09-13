#!/usr/bin/env node
/**
 * 构建脚本：把真实费率数据（docs/tariff.json）与网架辅助数据（src/extra.json）
 * 合并注入 src/template.html，生成自包含的 index.html。
 *
 * 数据可信度分档（tier）：
 *   gov    = 国家发改委核定价，有文号
 *   grid   = 国家电网/交易中心披露价（含报备价）
 *   region = 区域电网输电价格 / 送出省输电价格口径
 *   est    = 估算或待补
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const tariff = rd('docs/tariff.json');
const extra = rd('src/extra.json');

const PROVNAMES = Object.entries(extra.provinces);
function toProv(s) {
  if (!s) return null;
  const norm = s.replace(/[（）()]/g, ' ').replace(/\//g, ' ');
  const hits = [];
  for (const [code, v] of PROVNAMES) {
    if (norm.includes(v.n)) hits.push({ code, idx: norm.indexOf(v.n) });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.idx - b.idx);
  return hits[0].code;
}

function stationPair(name) {
  for (const [k, v] of Object.entries(extra.channelStations)) {
    if (name.includes(k)) return v;
  }
  return [null, null];
}

// ---------- 1. 专项工程（发改委核定 / 国网披露） ----------
const channels = [];
const seen = new Set();
let skip = 0;

for (const r of tariff) {
  const from = toProv(r.from_province);
  const to = toProv(r.to_province);
  if (!from || !to || from === to) { skip++; continue; }
  const key = r.name.slice(0, 8) + from + to;
  if (seen.has(key)) continue;
  seen.add(key);

  const [stFrom, stTo] = stationPair(r.name);
  const tier = r.source.doc_number && /发改/.test(r.source.doc_number) ? 'gov' : 'grid';
  let cap = r.capacity_mw || null;
  let lenKm = null;
  for (const [k, v] of Object.entries(extra.capacities || {})) {
    if (k.startsWith('_')) continue;
    if (cap == null && r.name.includes(k)) cap = v;
  }
  for (const [k, v] of Object.entries(extra.lengths || {})) {
    if (k.startsWith('_')) continue;
    if (lenKm == null && r.name.includes(k)) lenKm = v;
  }

  channels.push({
    id: 'g' + channels.length,
    n: r.name.replace(/（.*?）/g, '').trim(),
    fn: (r.alias || []).join(' / ') || r.name,
    from, to, stFrom, stTo,
    kv: r.voltage || '', type: r.type,
    cap, lenKm,
    t: r.tariff_cny_per_mwh,
    loss: r.loss_rate_pct,
    tier,
    eff: r.effective_from || '',
    doc: r.source.doc_number || '',
    docTitle: r.source.doc_title || '',
    issuer: r.source.issuer || '',
    pubDate: r.source.publish_date || '',
    url: r.source.url || '',
    excerpt: r.source.excerpt || '',
    hist: r.tariff_history || [],
    tax: r.tax_included,
    incLoss: !!r.includes_transmission_loss,
    bill: r.billing_basis || '未明确',
    status: r.status || '',
    note: r.note || '',
  });
}

// ---------- 2. 省间交流联络线（区域电网 / 送出省输电价格口径） ----------
const EXPORT_DEFAULT = 30.0;   // 元/MWh，多数省第四监管周期送出省输电价格 0.03 元/kWh
const AC_LINKS = [
  ['SC', 'CQ', '川渝联络线', 500, 3000, 0.8],
  ['SC', 'SN', '川陕联络线', 500, 2000, 1.4],
  ['CQ', 'HB', '渝鄂联络线', 500, 2500, 1.6],
  ['YN', 'GZ', '云贵联络线', 500, 2500, 1.2],
  ['GX', 'GD', '两广联络线', 500, 3000, 0.9],
  ['HB', 'HN', '鄂湘联络线', 500, 3000, 1.1],
  ['HN', 'JX', '湘赣联络线', 500, 2500, 1.0],
  ['AH', 'JS', '皖苏联络线', 500, 3000, 0.9],
  ['HB', 'HA', '鄂豫联络线', 500, 2500, 1.0],
  ['SX', 'SN', '晋陕联络线', 500, 1500, 1.5],
  ['SX', 'HE', '晋冀联络线', 500, 2000, 1.2],
  ['SX', 'NM', '蒙晋联络线', 500, 1500, 1.8],
  ['SD', 'HE', '鲁冀联络线', 500, 2000, 1.0],
  ['JS', 'SH', '苏沪联络线', 500, 3000, 0.5],
  ['JS', 'ZJ', '苏浙联络线', 500, 2500, 0.6],
  ['TJ', 'HE', '津冀联络线', 500, 2000, 0.7],
  ['LN', 'HE', '高岭联络线', 500, 2000, 1.6],
  ['LN', 'JL', '辽吉联络线', 500, 1800, 0.9],
  ['JL', 'HL', '吉黑联络线', 500, 1500, 0.9],
  ['SC', 'XZ', '川藏联络线', 500, 1000, 2.5],
  ['QH', 'XZ', '青藏交流', 500, 1000, 3.0],
  ['NM', 'BJ', '蒙京联络线', 500, 1500, 1.0],
  ['ZJ', 'FJ', '浙闽联络线', 500, 2000, 1.2],
  ['YN', 'GX', '云桂联络线', 500, 2000, 1.5],
];

for (const [a, b, n, kv, cap, loss] of AC_LINKS) {
  channels.push({
    id: 'a' + channels.length,
    n, fn: n, from: a, to: b, stFrom: null, stTo: null,
    kv: kv + 'kV', type: 'AC', cap, lenKm: null,
    t: EXPORT_DEFAULT, loss, tier: 'region',
    doc: '送出省输电价格（第四监管周期）', docTitle: '各省第四监管周期输配电价通知',
    eff: '2026-08-01',
    issuer: '省级发展改革委', pubDate: '2026-07/08', url: '',
    excerpt: '因省间互济等因素临时送省外电量，送出省输电价格按每千瓦时 0.03 元（含税）执行，不计线损。',
    hist: [], tax: true, incLoss: false,
    bill: '送出省输电价格', status: '口径待确认',
    note: '省间交流联络线未单独核定输电价格，此处按第四监管周期各省统一的送出省输电价格口径取 30 元/MWh；跨区交易另需按到达区电量电价加收区域电网输电费。',
  });
}

// ---------- 3. 输出 ----------
const payload = {
  ST: extra.stations,
  CH: channels,
  SEC: extra.sections,
  PV: extra.provinces,
  RG: extra.regionGrid,
};

const tpl = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8');
const out = tpl
  .replace('/*__DATA__*/', 'const DATA=' + JSON.stringify(payload) + ';')
  .replace('__BUILD_TIME__', new Date().toISOString().slice(0, 16).replace('T', ' '));

fs.writeFileSync(path.join(root, 'index.html'), out);

const byTier = channels.reduce((a, c) => (a[c.tier] = (a[c.tier] || 0) + 1, a), {});
console.log('通道总数:', channels.length);
console.log('  发改委核定 gov   :', byTier.gov || 0);
console.log('  国网/交易中心 grid:', byTier.grid || 0);
console.log('  区域电网/送出省   :', byTier.region || 0);
console.log('跳过（同名或同省）:', skip);
console.log('站点:', Object.keys(extra.stations).length, '| 断面:', extra.sections.length, '| 省级参数:', Object.keys(extra.provinces).length);
console.log('index.html 已生成:', (fs.statSync(path.join(root, 'index.html')).size / 1024).toFixed(1), 'KB');
