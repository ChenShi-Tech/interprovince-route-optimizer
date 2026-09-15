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
import crypto from 'node:crypto';
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
    // 专项工程送受端固定、潮流方向固定（1490号附件4第二条），只按核定方向通行；
    // 不经区域共用交流网络，不计区域电网电量电价（1227号第五条的购电价格构成中没有该项）
    bidir: false, regional: false, tRev: null,
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
    t: exportOf(a) * 1000,      // 省间交流联络线未单独核价，其自身即按送出省输电价格计（存储方向 a→b，取 a 的价格）
    tRaw: exportOf(a) * 1000,
    tRev: exportOf(b) * 1000,   // 反向行进 b→a 时送端省是 b，取 b 的送出省输电价格
    bidir: true,                // 交流联络线可双向通行
    regional: true,             // 经区域共用交流网络输送，按到达省所在区域计区域电网电量电价（1490号附件3第十一条）
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
    note: '省间交流联络线未单独核定输电价格，此处按第四监管周期送端省「送出省输电价格」口径取值（反向行进取对侧省的价格）；该段经区域共用交流网络输送，另按到达省所在区域的电量电价计区域电网输电费。',
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

// ---------- 4. 输出：Web 内联版 + 端云共用的独立数据文件 ----------
const payload = {
  ST: extra.stations,
  CH: channels,
  SEC: extra.sections,
  PV: provinceOut,
  RG: prices.区域电网输电价格,
  RGOF: prices.区域电网分区,
};

const builtAt = new Date().toISOString();
const BUILD_TIME = builtAt.slice(0, 16).replace('T', ' ');
const json = (o) => JSON.stringify(o);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// 价格数据的版本指纹：只要 fixed-prices.json 变了，这个值就变。
// 哈希前归一化换行（CRLF→LF），指纹只随数据内容变化；与部署版（96078954f87aff52，
// LF 口径）在任何机器的 autocrlf 设置下都一致，见 test-data-share.mjs 同口径校验。
const priceVersion = sha(fs.readFileSync(path.join(root, 'data/fixed-prices.json'), 'utf8').replace(/\r\n?/g, '\n')).slice(0, 16);

// (a) Web：自包含单文件，离线可用
// 内联顺序：常量 → 格式化 → 数据 → 状态 → 算法 → 界面 → 启动（boot 有顶层执行语句，必须最后）
const APP_FILES = [
  'src/app/config.js',
  'src/app/format.js',
  'src/app/data.js',
  'src/app/state.js',
  'src/app/algo/network.js',
  'src/app/algo/cost.js',
  'src/app/algo/paths.js',
  'src/app/algo/solve.js',
  'src/app/ui/calc.js',
  'src/app/ui/lib.js',
  'src/app/ui/map.js',
  'src/app/boot.js',
];
const appSource = APP_FILES.map((f) => {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) throw new Error('缺少模块：' + f);
  return `/* ===== ${f} ===== */\n` + fs.readFileSync(p, 'utf8').trim();
}).join('\n\n');

const tpl = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8');
const out = tpl
  .replace('/*__DATA__*/', 'const DATA=' + json(payload) + ';')
  .replace('/*__APP__*/', appSource)
  .replace('__BUILD_TIME__', BUILD_TIME)
  .replace('__PRICE_VERSION__', priceVersion);
fs.writeFileSync(path.join(root, 'index.html'), out);

// (b) 手机端与其它消费方：同一份数据的独立 JSON（输出到 shared/，不用 dist/ 以免被发布工具排除）。
//     与 Web 版同源、同一次构建产出，保证两端数据结构与数值完全一致。
const appData = {
  schema: 'iproute-app-data/v2',   // v2：CH 新增 bidir / regional / tRev 三个字段
  builtAt,
  priceVersion,                                   // 价格数据指纹，用于两端比对
  dataHash: sha(json(payload)),                   // 载荷指纹，用于校验完整性
  counts: {
    stations: Object.keys(payload.ST).length,
    channels: payload.CH.length,
    sections: payload.SEC.length,
    provinces: Object.keys(payload.PV).length,
  },
  units: {
    价格: '元/兆瓦时',
    线损率: '百分数 %',
    容量: '兆瓦 MW',
    长度: '公里 km',
    送出省输电价格: '元/千瓦时（与官方文件原文一致，使用时 ×1000 转为 元/兆瓦时）',
    区域电网输电价格: '元/千瓦时（同上）',
  },
  readme: [
    '本文件由 tools/build.mjs 生成，与 index.html 同源同版本。',
    '修改价格请改 data/fixed-prices.json 后重新构建，不要直接改本文件。',
    'CH[].tier 为数据可信度：gov=发改委核定 / grid=国网披露 / region=区域或送出省口径。',
    'CH[].cap 为用于容量校验的容量，已优先取「实际输送能力」，缺失时回退额定；capBasis 标明口径。',
    'CH[].priceType 为 energy（电量制）或 capacity（容量制，t 为折算的等效度电成本）。',
    'CH[].sendFee 为送端省内段费用（送出省输电价格），AC 联络线为 0（其价格已含在该段 t 中）。',
    'CH[].bidir：专项工程为 false，只按 from→to 方向通行；AC 联络线为 true，可双向通行，反向时输电价取 tRev（对侧省的送出省输电价格）。',
    'CH[].regional：仅 AC 联络线为 true，表示经区域共用交流网络输送，该段按到达省所在区域计区域电网电量电价；专项工程段不计区域电网费。',
    'CH[].incLoss 为 true 的专项工程价已含输电环节线损，输电费按该段落地端（段后）电量计；其余按段前电量计。',
    'PV[].fund 可能为 null（西藏未获取），消费方需按缺失处理而非当作 0 静默使用。',
    'LOADING：路径规划算法不在本文件内，需由消费方实现。算法约定与回归基线见 docs/01-安卓开发框架.md 与 docs/regression-baseline-v2.json。',
  ],
  ...payload,
};

const distDir = path.join(root, 'shared')   // 不要用 dist/：发布工具会把它当构建产物排除;
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, 'app-data.json'), JSON.stringify(appData, null, 2) + '\n');
// 另存一份仅含数据的紧凑版，减小手机端体积
fs.writeFileSync(path.join(distDir, 'app-data.min.json'), json(appData) + '\n');

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
console.log('价格数据源: data/fixed-prices.json');
console.log('应用模块:', APP_FILES.length, '个（' + (appSource.length / 1024).toFixed(1) + ' KB）');
console.log('价格数据指纹 priceVersion:', priceVersion);
console.log('index.html 已生成:', (fs.statSync(path.join(root, 'index.html')).size / 1024).toFixed(1), 'KB');
console.log('shared/app-data.json 已生成:', (fs.statSync(path.join(distDir, 'app-data.json')).size / 1024).toFixed(1), 'KB（端云共用数据）');
