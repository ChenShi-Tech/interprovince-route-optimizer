#!/usr/bin/env node
/**
 * 构建脚本：把数据文件合并注入 src/template.html，生成自包含的 index.html。
 *
 * 三个输入文件，职责分离：
 *   data/fixed-prices.json  ← 所有价格数值（改价只改这个文件）
 *   src/extra.json          ← 非价格数据：站点、断面、经纬度、容量、线路长度
 *   src/template.html       ← 界面与算法
 *
 * docs/tariff.json 保留为采集档案，不再参与构建。
 *
 * 数据可信度分档（tier）：
 *   gov    = 国家发改委核定价，有文号
 *   grid   = 国家电网/交易中心披露价（含报备价）
 *   region = 区域电网输电价格 / 送出省输电价格口径
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const prices = rd('data/fixed-prices.json');
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
  for (const [k, v] of Object.entries(extra.channelStations || {})) {
    if (name.includes(k)) return v;
  }
  return [null, null];
}

// ---------- 0. 送出省输电价格与容量制折算（下面两段共用，须先声明） ----------
const EXPORT_DEFAULT = 0.03;   // 元/千瓦时，无专属值的省份适用通用互济条款
const EX = prices.送出省输电价格 || {};
const exportOf = (code) => (typeof EX[code] === 'number' ? EX[code] : EXPORT_DEFAULT);
// 送出省输电价格：元/千瓦时 → 元/兆瓦时
const EXPORT_YUAN_PER_MWH = (code) => exportOf(code) * 1000;
// 容量制工程的等效度电成本：容量电价 × 1000 ÷ 折算利用小时
const CAP_HOURS = prices.容量制折算利用小时 || 4500;
const capEq = (r) => (r.容量电价 ? r.容量电价.容量电价 * 1000 / CAP_HOURS : null);

// ---------- 1. 专项工程 ----------
const channels = [];
const seen = new Set();
let skip = 0;

for (const r of prices.专项工程) {
  const from = toProv(r.送端);
  const to = toProv(r.受端);
  if (!from || !to || from === to) { skip++; continue; }
  const key = r.名称.slice(0, 8) + from + to;
  if (seen.has(key)) continue;
  seen.add(key);

  const [stFrom, stTo] = stationPair(r.名称);
  const tier = r.文号 && /发改/.test(r.文号) ? 'gov' : 'grid';
  const capRated = r.额定容量 ?? null;
  const capActual = r.实际输送能力 ?? null;
  const cap = capActual ?? capRated;          // 容量校验优先用实际输送能力
  const lenKm = r.线路长度 ?? null;

  const sendFee = EXPORT_YUAN_PER_MWH(from);   // 送端省「送出省输电价格」，发改价格〔2018〕1227号第五条
  const eq = capEq(r);
  channels.push({
    id: 'g' + channels.length,
    n: r.名称.replace(/（.*?）/g, '').trim(),
    fn: (r.别名 || []).join(' / ') || r.名称,
    from, to, stFrom, stTo,
    kv: r.电压等级 || '', type: r.类型,
    cap, lenKm,
    capRated, capActual,
    capBasis: r.容量口径 || 'unknown',
    capSrc: r.容量来源 || '',
    priceType: r.计价方式 || 'energy',
    capPrice: r.容量电价 || null,
    t: r.输电价 != null ? r.输电价 : eq,   // 容量制工程用折算的等效度电成本参与比选
    tRaw: r.输电价,
    capEq: eq,
    sendFee,                                // 送端省内段：送出省输电价格
    loss: r.线损率,
    tier,
    doc: r.文号 || '', docTitle: r.文件标题 || '', issuer: r.颁发机构 || '',
    pubDate: r.发布日期 || '', url: r.地址 || '',
    eff: r.生效日期 || '',
    excerpt: r.原文摘录 || '',
    hist: r.调价历史 || [],
    tax: r.含税, incLoss: !!r.含线损,
    bill: r.计费口径 || '未明确',
    status: r.状态 || '', note: r.备注 || '',
    docVersion: r.文档版本 || '', sourceIssue: r.出处问题 || '',
    tradable: true,
  });
}

// ---------- 2. 省间交流联络线（区域电网 / 送出省输电价格口径） ----------
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
    t: exportOf(a) * 1000,      // 省间交流联络线未单独核价，其自身即按送出省输电价格计
    tRaw: exportOf(a) * 1000,
    capEq: null,
    sendFee: 0,                 // 上行的送出省价已含在 t 中，不重复计
    loss, tier: 'region',
    doc: '送出省输电价格（第四监管周期）',
    docTitle: '各省第四监管周期输配电价通知',
    issuer: '省级发展改革委', pubDate: '2026-07/08', url: '',
    eff: '2026-08-01',
    excerpt: `因省间互济等因素临时送省外电量，送出省输电价格按每千瓦时 ${exportOf(a)} 元（含税）执行，不计线损。`,
    hist: [], tax: true, incLoss: false,
    bill: '送出省输电价格', status: '口径待确认',
    priceType: 'energy', capRated: cap, capActual: cap, capBasis: 'rated', capSrc: '设计容量',
    tradable: false,   // 省间交流联络线未单独核定输电价格，是否属于省间现货交易网络待确认
    note: '省间交流联络线未单独核定输电价格，此处按第四监管周期该省「送出省输电价格」口径取值；跨区交易另需按到达区电量电价加收区域电网输电费。',
    docVersion: '', sourceIssue: '',
  });
}

// ---------- 3. 省级参数（价格取自 fixed-prices，经纬度与名称取自 extra） ----------
const provinceOut = {};
for (const [code, geo] of Object.entries(extra.provinces)) {
  const pr = prices.省级参数[code] || {};
  provinceOut[code] = {
    n: geo.n, lng: geo.lng, lat: geo.lat,
    clear: pr.出清价 ?? null,
    net: pr.受端省网输配电价 ?? null,
    fund: pr.政府性基金及附加 === undefined ? null : pr.政府性基金及附加,
    netSrc: pr.来源 || '（未记录来源）',
  };
}

// ---------- 4. 输出 ----------
const payload = {
  ST: extra.stations,
  CH: channels,
  SEC: extra.sections,
  PV: provinceOut,
  RG: prices.区域电网输电价格,
  RGOF: prices.区域电网分区,
};

const tpl = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8');
const out = tpl
  .replace('/*__DATA__*/', 'const DATA=' + JSON.stringify(payload) + ';')
  .replace('__BUILD_TIME__', new Date().toISOString().slice(0, 16).replace('T', ' '));

fs.writeFileSync(path.join(root, 'index.html'), out);

const byTier = channels.reduce((a, c) => (a[c.tier] = (a[c.tier] || 0) + 1, a), {});
const est = Object.values(provinceOut).filter((p) => p.net == null).length;
console.log('通道总数:', channels.length, `（专项工程 ${channels.length - AC_LINKS.length} + 省间联络线 ${AC_LINKS.length}）`);
console.log('  发改委核定 gov   :', byTier.gov || 0);
console.log('  国网/交易中心 grid:', byTier.grid || 0);
console.log('  区域电网/送出省   :', byTier.region || 0);
console.log('跳过（同名或同省）:', skip);
console.log('站点:', Object.keys(extra.stations).length,
  '| 断面:', extra.sections.length,
  '| 省级参数:', Object.keys(provinceOut).length,
  est ? `（其中 ${est} 个缺输配电价）` : '（全部有值）');
console.log('价格数据源: data/fixed-prices.json（' + prices.专项工程.length + ' 条专项工程）');
console.log('index.html 已生成:', (fs.statSync(path.join(root, 'index.html')).size / 1024).toFixed(1), 'KB');
