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
 * 数据可信度分档（tier，四档计数之和必须等于 CH 长度）：
 *   gov    = 国家发改委核定价，有文号
 *   grid   = 国家电网/交易中心披露价（含报备价）
 *   region = 区域电网输电价格 / 送出省输电价格口径
 *   est    = 待补：价格待核、无文号可依的工程（界面显示「待补」），不得按已核定/已披露价使用
 *
 * 构建期 fail-fast（任一不过即 process.exit(1) 并说明原因）：
 *   ① 模板三个注入占位符（TOKENS / DATA / APP）各出现且仅出现 1 次、各自独占一行；
 *      TOKENS 注入 src/tokens.css（设计令牌 :root 块，全站唯一允许写颜色 / 圆角字面值的地方）；
 *   ② APP_FILES 与 tools/test-modules.mjs 的守卫清单逐项一致；
 *   ③ 注入串不含 String.replace 的替换陷阱（$& / $$ / $` / $'，M23）；
 *   ④ 内联脚本能被 vm 解析（语法检查）；
 *   ⑤ 三份产物同源：index.html 内联数据与 shared/app-data.json 的 dataHash / priceVersion 一致；
 *   ⑥ 数据值域 lint：坐标包络、PV 线损率、区域电价、双向通道成对、CH 端点省码、省间联络线容量
 *      （见文件末尾 lint 段）。
 *
 * ⚠️ 校验顺序（2026-09-18）：以上全部校验都在**写盘之前**基于内存中的产出串执行，
 * 校验通过才写出三份产物；因此任一失败时磁盘上不会留下新增/被改的不一致产物。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
/** 构建期断言：失败即 exit 1，绝不产出半成品（构建产物宁可没有，也不能是错的）。 */
function failFast(msg){
  console.error('\n❌ 构建失败：' + msg);
  process.exit(1);
}

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
const EX = prices.送出省输电价格 || {};
const exportOf = (code) => (typeof EX[code] === 'number' ? EX[code] : null);
// 送出省输电价格：元/千瓦时 → 元/兆瓦时。
// 蒙东特例：库内省份表把内蒙古合并为 NM 并按蒙西口径归华北，而送出省输电价格单列 NME
// （蒙东电网 0.0268 元/千瓦时，S11 第6页蒙东电网表注4）。送端属蒙东电网时必须取 NME，
// 否则会按 NM（蒙西 0.03 元/千瓦时）多计。
// 「送端属蒙东」的判定依据（2026-09-18 修正，D2 补漏）：国网蒙东电力供电区域为呼伦贝尔、兴安、
// 通辽、赤峰四盟市（国网蒙东电力公开简介；蒙东电网在 S11 单列一表）。因此除字面「蒙东」外，
// 送端文本/站点名出现呼伦贝尔、兴安（排除大兴安岭）、通辽、赤峰或境内站点扎鲁特（属通辽）、
// 霍林河（属通辽）、伊敏（属呼伦贝尔）都按蒙东取价。锡盟、鄂尔多斯（上海庙）属蒙西电网，
// 不得纳入——漏判会让同属蒙东的两条直流口径不一致（呼辽按 NME 26.8、扎青按 NM 30）。
const MENGDONG_RE = /蒙东|呼伦贝尔|(?<!大)兴安|通辽|赤峰|扎鲁特|霍林河|伊敏/;
const isMengDongSender = (rawName) => MENGDONG_RE.test(rawName || '');
function exportYuanPerMwh(rawName, code){
  const v = (isMengDongSender(rawName) && typeof EX.NME === 'number') ? EX.NME : exportOf(code);
  return v == null ? null : v * 1000;
}
// 取价分支留痕：蒙东（NME）与蒙西（NM）两个分支都写进产出条目的备注，
// 供界面「通道资料」与审计核对——避免「为什么这条是 26.8 那条是 30」只能靠读代码回答。
// 数值直接取库内值（不写死），价格调整后备注不会失真。
function sendPriceNote(rawName){
  const yuan = (v) => (typeof v === 'number' ? v + ' 元/千瓦时' : '（库内未取到）');
  if (isMengDongSender(rawName)) {
    return '送端属蒙东电网（呼伦贝尔/兴安/通辽/赤峰），送出省输电价格按蒙东（NME）取价：'
      + `${yuan(EX.NME)}（S11 第6页蒙东电网表注4）；蒙东属东北电网，本库 NM 为单节点按华北计费，`
      + '区域归属待子网建模后修正。';
  }
  if (/内蒙古/.test(rawName || '')) {
    return `送端属蒙西电网（锡盟、鄂尔多斯等属蒙西，不适用蒙东 NME），送出省输电价格按蒙西（NM，${yuan(EX.NM)}）取价。`;
  }
  return '';
}
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
  // 价格待核工程没有文号，不能落到 'grid'（界面会显示「国网披露」）——那是事实错误。
  // 用 'est'（界面显示「待补」）如实表示数据可信度待补（2026-09-17 审查意见）。
  const tier = r.价格待核 ? 'est' : (r.文号 && /发改/.test(r.文号) ? 'gov' : 'grid');
  const capRated = r.额定容量 ?? null;
  const capActual = r.实际输送能力 ?? null;
  const cap = capActual ?? capRated;          // 容量校验优先用实际输送能力
  const lenKm = r.线路长度 ?? null;

  // 送端省「送出省输电价格」，发改价格〔2018〕1227号第五条；送端属蒙东的条目按 NME 取价（见 exportYuanPerMwh）
  const sendFee = exportYuanPerMwh(r.送端, from);
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
    // 电量制工程用核定电量电价；容量制工程（辛洹、云霄）用数据文件给出的「边际输电价」：
    // 辛洹 0（容量电费经省级输配电价回收），云霄取输电权报价下限。旧的 4500 小时折算值仅保留在 capEq 供展示
    t: r.输电价 != null ? r.输电价 : (r.边际输电价 != null ? r.边际输电价 : eq),
    tRaw: r.输电价,
    capEq: eq,
    marginalNote: r.边际输电价说明 || '',
    sendFee,                                // 送端省内段：送出省输电价格
    // 通行方向：专项工程默认只按核定送受端方向（1490号附件4第二条「送受端相对明确、潮流方向相对固定」）；
    // 数据文件里标 双向=true 的工程（背靠背、联网型直流与交流联络线）经公开报道证实双向运行，反向时送端省内段费用取对侧省
    bidir: !!r.双向, dirNote: r.方向依据 || '',
    originOnly: !!r.仅限起点,               // 点对网电厂送出：只能作交易路径首段，不能作过境通道
    sendFeeRev: r.双向 ? exportYuanPerMwh(r.受端, to) : null,
    regional: false, tRev: null,            // 专项工程不是区域共用交流网络的组成部分
    loss: r.线损率,
    tier,
    doc: r.文号 || '', docTitle: r.文件标题 || '', issuer: r.颁发机构 || '',
    pubDate: r.发布日期 || '', url: r.地址 || '',
    eff: r.生效日期 || '',
    excerpt: r.原文摘录 || '',
    hist: r.调价历史 || [],
    tax: r.含税, incLoss: !!r.含线损,
    bill: r.计费口径 || '未明确',
    status: r.状态 || '',
    // 送端电价取价分支（蒙东/蒙西）如实写进备注，供界面「通道资料」与审计核对；判定口径见 sendPriceNote。
    note: [r.备注 || '', sendPriceNote(r.送端)].filter(Boolean).join('　'),
    docVersion: r.文档版本 || '', sourceIssue: r.出处问题 || '',
    // 价格待核：南网部分物理直流（云广、普侨、高肇、兴安、禄高肇）未检索到发改委独立核价文件，
    // 其收费并入 842 号的「云南送广东/贵州送广东」等聚合口径。为避免产出免费或虚构价格的路径，
    // 这类通道建边但不参与路径枚举（solve 按 pricePending 过滤），仅在通道资料中登记。
    pricePending: !!r.价格待核,
    tradable: !r.价格待核,
  });
}

// ---------- 2. 省间交流联络线（区域电网 / 送出省输电价格口径） ----------
// 只保留同一同步电网内真实存在的省间交流联络（区域共用交流网络）。
// 2026-09-15 按公开原件核对全国联网格局（S20 国资委《国家电网：电力大动脉纵贯神州》：六大区域电网、区域间异步互联；
// S25 云南自 2016 年经鲁西背靠背与南网主网异步；S26 榆横—潍坊属华北网架；S23 青海—西藏仅青藏直流）后，
// 删除了 6 条物理上不存在交流联络的条目：川陕、晋陕（西北与华北 / 川渝异步）、高岭联络线（东北—华北仅高岭背靠背，已是 g3）、
// 青藏交流（仅青藏直流，已是 g9）、云贵、云桂（云南异步，云南送广西为 g42）；渝鄂改记为渝鄂背靠背直流（S20：华中东四省与川渝藏异步互联）。24 → 18 条。
// 各条的线损率仍为本工具估算值（无核定来源），容量一律 null（原估算值与口径写在说明列里，见上）。
const AC_LINKS = [
  // [送端, 受端, 名称, 电压 kV, 容量 MW, 线损率 %, 类型, 电压等级文字, 说明]
  //
  // 容量（第 5 列）一律留 null —— 2026-09-17 审查意见：公开来源只给到「回数」，
  // 没有逐回输送能力；按「每回 1000MW」折算的估算值会参与越限判断而产生假告警。
  // cap=null 时 build 标 capBasis='unknown'，界面显示「容量待补」，不做容量校验。
  // 2026-09-18（docs/11 D6/H2）补齐：此前遗留的 14 条历史估算容量（渝鄂 5000、两广 3000、
  // 鄂湘 3000、鄂豫 2500、皖苏 3000、晋冀 2000、鲁冀 2000、苏沪 3000、苏浙 2500、津冀 2000、
  // 辽吉 1800、吉黑 1500、浙闽 2000、蒙西—河北 4000 MW）已全部置 null，原值与口径移入各行
  // 说明列（第 9 列）末尾并在产出条目里带出，保持可追溯；文件末尾 lint ⑥ 守住「regional
  // 交流边容量必须为 null」。
  //
  // 区域边界（2026-09-17 审查意见）：不得跨越华北/西北等异步边界建 AC 边。
  // 已按此删除「蒙西—宁夏 750kV」与「榆横—潍坊 1000kV」——前者把蒙西（华北同步电网）
  // 与宁夏（西北）直接连通，后者把陕西（西北）与山东（华北）连通，都制造了物理上不存在的
  // 同步通路。若日后确认区域间存在同步交流互联，须整体重审区域异步约定，而不是只加边。
  //
  // 南方区域（2026-09-17 审查意见）：1077号附件2 区域电网输电价格表**不含南方**，
  // 南方按逐工程/逐交易成分核定，不存在「区域共用交流网络不单独收费」的机制。
  // 故不得把南网交流接口建成 regional 免费边——那会绕开 842 号核定价（如云南→广西
  // 会从 371.05 降到 312.49 元/MWh）。已删除鲁西背靠背、黔粤、黔桂三条，
  // 南网交易仍走 842 号的云南/贵州/天生桥送广东广西等专项工程。
  ['SC', 'CQ', '川渝联络线', 1000, null, 1.0, 'AC', '1000kV（川渝特高压交流）',
    '川渝 1000 千伏特高压交流工程 2024-12-27 投运（甘孜—天府南—成都东—铜梁，1316km，变电 2400 万 kVA），' +
    '川渝断面电力交换能力由 600 万提升至 1000 万千瓦（断面限额见 SEC.SC-CQ）。' +
    '2026-09-17 核对：川渝之间原 500kV 交流联络已并入本工程，故本条目由 500kV 改为 1000kV；川渝与华中之间才是渝鄂背靠背异步互联（S20）。'],
  ['CQ', 'HB', '渝鄂联络线', 500, null, 1.6, 'DC', '背靠背（渝鄂柔直背靠背，南北通道各 2×1250MW）',
    '川渝藏与华中东四省为异步互联（S20），此处为渝鄂柔性直流背靠背（±420kV）；无单独核定输电价格，暂按送出省口径计价。'
    + '容量原记录 5000MW（取自断面资料 SEC.YBE 渝鄂背靠背设计容量，非逐回输送能力、非核定容量/ATC），2026-09-18 按审查意见置 null，不做容量校验。'],
  ['GX', 'GD', '两广联络线', 500, null, 0.9, 'AC', '500kV',
    '容量原记录 3000MW 为初版拓扑估算（无一手来源，非核定容量、非 ATC）；2026-09-18 按审查意见置 null，不做容量校验。'],
  ['HB', 'HN', '鄂湘联络线', 500, null, 1.1, 'AC', '500kV',
    '容量原记录 3000MW 为初版拓扑估算（无一手来源，非核定容量、非 ATC）；2026-09-18 按审查意见置 null，不做容量校验。'],
  ['HB', 'HA', '鄂豫联络线', 500, null, 1.0, 'AC', '500kV',
    '容量原记录 2500MW 为初版拓扑估算（无一手来源，非核定容量、非 ATC）；2026-09-18 按审查意见置 null，不做容量校验。'],
  ['AH', 'JS', '皖苏联络线', 500, null, 0.9, 'AC', '500kV',
    '安徽—江苏 500kV 交流联络（皖电东送 500kV 断面）。与「淮南—南京—上海特高压交流」是不同工程，两者并存。'
    + '容量原记录 3000MW 为初版拓扑估算（无一手来源，非核定容量、非 ATC）；2026-09-18 按审查意见置 null，不做容量校验。'],
  ['SX', 'HE', '晋冀联络线', 500, null, 1.2, 'AC', '500kV',
    '容量原记录 2000MW 为初版拓扑估算（无一手来源，非核定容量、非 ATC）；2026-09-18 按审查意见置 null，不做容量校验。'],
  ['SD', 'HE', '鲁冀联络线', 500, null, 1.0, 'AC', '500kV',
    '容量原记录 2000MW 为初版拓扑估算（无一手来源，非核定容量、非 ATC）；2026-09-18 按审查意见置 null，不做容量校验。'],
  ['JS', 'SH', '苏沪联络线', 500, null, 0.5, 'AC', '500kV',
    '容量原记录 3000MW 为初版拓扑估算（无一手来源，非核定容量、非 ATC）；2026-09-18 按审查意见置 null，不做容量校验。'],
  ['JS', 'ZJ', '苏浙联络线', 500, null, 0.6, 'AC', '500kV',
    '容量原记录 2500MW 为初版拓扑估算（无一手来源，非核定容量、非 ATC）；2026-09-18 按审查意见置 null，不做容量校验。'],
  ['TJ', 'HE', '津冀联络线', 500, null, 0.7, 'AC', '500kV',
    '容量原记录 2000MW 为初版拓扑估算（无一手来源，非核定容量、非 ATC）；2026-09-18 按审查意见置 null，不做容量校验。'],
  ['LN', 'JL', '辽吉联络线', 500, null, 0.9, 'AC', '500kV',
    '容量原记录 1800MW 为初版拓扑估算（无一手来源，非核定容量、非 ATC）；2026-09-18 按审查意见置 null，不做容量校验。'],
  ['JL', 'HL', '吉黑联络线', 500, null, 0.9, 'AC', '500kV',
    '容量原记录 1500MW 为初版拓扑估算（无一手来源，非核定容量、非 ATC）；2026-09-18 按审查意见置 null，不做容量校验。'],
  ['SC', 'XZ', '川藏联络线', 500, null, 2.5, 'AC', '500kV',
    '川藏联网 500kV 交流，塘芒一、二线（2018-08 升压至 500kV）+ 塘澜线（巴塘—澜沧江，2023-04）共 3 回，双向；' +
    '西藏向四川送电 56.4 亿千瓦时、四川向西藏 30.8 亿千瓦时（S24）。'],
  ['HE', 'BJ', '京冀联络线', 500, null, 0.7, 'AC', '500kV',
    '北京电网经 500kV 环网受电于河北，1000kV 落点为北京东、北京西两站。' +
    '2026-09-17 核对：原「蒙京 500kV 联络线」未检索到公开来源（内蒙古—北京无直连 500kV 报道），已按京冀联络替换；回数未检索到逐条公开来源。'],
  ['ZJ', 'FJ', '浙闽联络线', 500, null, 1.2, 'AC', '500kV',
    '宁剑 5906 线、宁川 5916 线共 2 回 500kV；另有浙北—福州 1000kV 特高压交流（单列）。'
    + '容量原记录 2000MW 为初版拓扑估算（无逐回输送能力来源，非核定容量、非 ATC）；2026-09-18 按审查意见置 null，不做容量校验。'],
  // ---- 特高压交流（省间，区域共用网络口径，无独立核定通道价）----
  ['NM', 'SX', '蒙西—晋中特高压交流', 1000, null, 1.2, 'AC', '1000kV',
    '蒙西—晋中 1000 千伏特高压交流，2020-09 投运（2×304km）。' +
    '2026-09-17 核对：原「蒙晋 500kV 联络线」未检索到公开来源，已按本工程替换。'],
  ['NM', 'TJ', '蒙西—天津南特高压交流', 1000, null, 1.2, 'AC', '1000kV',
    '蒙西—天津南 1000 千伏特高压交流，2016-11 投运（蒙西—晋北—北京西—天津南，2×608km，变电 2400 万 kVA）。'],
  ['NM', 'SD', '锡盟—山东特高压交流', 1000, null, 1.2, 'AC', '1000kV',
    '锡盟—山东 1000 千伏特高压交流，2016-07 投运（锡盟—北京东—济南，2×730km，含承德串补站）。'],
  ['AH', 'SH', '皖电东送特高压交流', 1000, null, 1.2, 'AC', '1000kV',
    '淮南—浙北—上海 1000 千伏特高压交流（皖电东送），2013-09 投运（淮南—皖南—浙北—沪西，656km），我国首条同塔双回特高压交流。'],
  ['AH', 'JS', '淮南—南京—上海特高压交流', 1000, null, 1.2, 'AC', '1000kV',
    '淮南—南京—上海 1000 千伏特高压交流，2016-11 投运（2×754km，含苏通 GIL 综合管廊）；与「皖苏联络线」是不同工程，两者并存。'],
  ['SD', 'HE', '山东—河北特高压交流环网', 1000, null, 1.2, 'AC', '1000kV',
    '山东—河北 1000 千伏特高压交流环网，2020-01 投运（潍坊—临沂—枣庄—菏泽—石家庄，2×823.6km，变电 1500 万 kVA）。'],
  ['JX', 'HN', '南昌—长沙特高压交流', 1000, null, 1.2, 'AC', '1000kV',
    '南昌—长沙 1000 千伏特高压交流，2021-12 投运（2×341km，变电 1200 万 kVA）。' +
    '2026-09-17 核对：原「湘赣 500kV 联络线」检索无任何公开来源（湖南对外 500kV 仅鄂湘 3 回、江西对外仅鄂赣 3 回），已按本工程替换。'],
  ['HA', 'HN', '南阳—荆门—长沙特高压交流', 1000, null, 1.2, 'AC', '1000kV',
    '南阳—荆门—长沙 1000 千伏特高压交流，2022-10 投运（625.8km，豫鄂湘三省）。'],
  ['HA', 'HB', '驻马店—武汉特高压交流', 1000, null, 1.2, 'AC', '1000kV',
    '驻马店—武汉 1000 千伏特高压交流，2023-11 投运（豫南—武汉，2×287km）。'],
  ['HB', 'JX', '武汉—黄石—南昌特高压交流', 1000, null, 1.2, 'AC', '1000kV',
    '武汉—黄石—南昌 1000 千伏特高压交流，2024-11 投运（2×456km）；华中「日」字形特高压环网由此建成，覆盖豫鄂湘赣。'],
  ['HB', 'JX', '鄂赣联络线', 500, null, 1.0, 'AC', '500kV',
    '咸梦 I/II 线（咸宁—梦山双回）+ 磁永线（磁湖—永修单回）共 3 回 500kV，江西电网经此与华中主网相连。'],
  // ---- 西北 750kV 省际联络线（西北主网架；公开来源只给回数，未给逐回容量）----
  ['SN', 'GS', '甘陕联络线', 750, null, 1.2, 'AC', '750kV',
    '平凉—乾县双回、麦积山—宝鸡双回、夏州—曲子（庆阳北）双回（2025-06-26 投运），共 6 回 750kV；甘肃 2025-06 官方口径「通过 21 条省际 750 千伏线路与陕、青、宁、新相连」。'],
  ['NX', 'GS', '甘宁联络线', 750, null, 1.2, 'AC', '750kV',
    '平凉—六盘山双回、白银—天都山 3 回（第三回 2025-12-14 投运），共 5 回 750kV；甘宁断面输送能力超 800 万 kW，' +
    '反推每回约 1600MW，与新疆通道「4 回、外送 400 万千瓦」反推的每回约 1000MW 不一致，故不按回数折算容量。'],
  ['QH', 'GS', '甘青联络线', 750, null, 1.2, 'AC', '750kV',
    '兰州东—官亭 I/II 回（2005 官亭—兰州东为我国首个 750kV 示范工程）、武胜—郭隆 3 回、沙洲—鱼卡 2 回，共 7 回 750kV；官亭—兰州东 I/II 回已于 2023 年 π 接入兰临变。'],
  ['XJ', 'GS', '新甘联络线', 750, null, 1.2, 'AC', '750kV',
    '哈密—敦煌双回、烟墩—沙洲双回，共 4 回 750kV，即新疆与西北主网联网第一、第二通道；国网口径「新疆与西北主网联络线 4 回、外送 400 万千瓦」。'],
  // ---- 其他省间交流 ----
  ['NM', 'HE', '蒙西—河北联络线', 500, null, 1.0, 'AC', '500kV',
    '丰泉/汗海（内蒙古乌兰察布）—万泉/沽源（河北张家口）500kV 共 4 回，设计容量 400 万千瓦，为蒙西电网与华北电网网间断面。'
    + '容量原记录 4000MW（按设计容量填写，非逐回输送能力、非核定容量/ATC）；2026-09-18 按审查意见置 null，不做容量校验。'],
  ['ZJ', 'SH', '浙沪联络线', 500, null, 0.6, 'AC', '500kV',
    '安吉—练塘 500kV（上海—浙江通道之一）。来源为上海市电力公司技术资料（二手），回数待核实。'],
];


for (const [a, b, n, kv, cap, loss, type, kvText, extraNote] of AC_LINKS) {
  const tFwd = exportYuanPerMwh('', a);
  channels.push({
    id: 'a' + channels.length,
    n, fn: n, from: a, to: b, stFrom: null, stTo: null,
    kv: kvText || (kv + 'kV'), type: type || 'AC', cap, lenKm: null,
    dirNote: extraNote || '省间交流联络线，潮流双向',
    sendFeeRev: null, marginalNote: '',
    t: tFwd,                    // 送出省参考价，仅路径起点使用；不是接口独立通道费
    tRaw: tFwd,
    tRev: exportYuanPerMwh('', b),   // 反向行进 b→a 时送端省是 b，取 b 的送出省输电价格
    bidir: true,                // 交流联络线可双向通行
    regional: true,             // 共用网络接口：区域费用按整条路径去重归集
    capEq: null,
    sendFee: 0,                 // 起点送出省参考价存于 t/tRev，算法归入 send，不重复计
    loss, lossStatus:'estimate', tariffStatus:type==='DC'?'unknown':'pooled', tier: 'region',
    doc: '送出省输电价格（第四监管周期）',
    docTitle: '各省第四监管周期输配电价通知',
    issuer: '省级发展改革委', pubDate: '2026-07/08', url: '',
    eff: '2026-08-01',
    excerpt: '送出省参考价取自对应省核价表，临时互济与核定外送条件不同；接口容量、损耗为估算，不是核价表的核定参数。',
    hist: [], tax: true, incLoss: false,
    bill: '送出省输电价格', status: '口径待确认',
    priceType: 'energy', capRated: cap, capActual: cap,
    // cap 为 null = 公开来源只给到回数、未给逐回输送能力：不做容量校验，界面显示「容量待补」。
    // 给 null 而不是填估算值，是为了不参与越限判断、不产生假告警（2026-09-17 审查意见；
    // 2026-09-18 起 33 条联络线全部为 null，文件末尾 lint ⑥ 守住这条）。
    capBasis: cap == null ? 'unknown' : 'estimate',
    capSrc: cap == null
      ? '未采集：公开来源只给出回数，未给逐回输送能力；非核定容量、非 ATC'
      : '拓扑模型估算，非核定容量或当期ATC',
    tradable: false,   // 省间交流联络线未单独核定输电价格，是否属于省间现货交易网络待确认
    note: '省间联络接口无单独核定通道价；t/tRev 仅保存正反方向送出省参考价，只有作为交易起点时计入送端省内段，过境时不收。区域共用网络按区域去重计费；区域内交流接口计费损耗为 0，原线损仅作容量估算，背靠背直流保留自身计费损耗。'
      + (extraNote ? '　' + extraNote : ''),
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
    effectiveFrom:pr.价格生效日期 || '', scopeNote:pr.适用主体提醒 || '',
    // 1077号附件1 各省表注3 / 注4（S11）：受端省内上网环节线损率（用户承担）、送省外上网环节线损率（卖方承担）
    inLoss: pr.省内上网环节线损率 ?? null,
    exportLoss: pr.送省外上网环节线损率 ?? null,
    exportKind: pr.送出省输电价格口径 || null,
    lossSrc: pr.线损率来源 || '',
  };
}

// ---------- 3.5 直流走廊几何（waypoints，change: grid-map-p1-and-ux-fixes / design D4）----------
// 仅影响地理呈现，不影响计价与枚举。spec 硬约束：逐条必须带 src 来源（先审后上），
// 坐标非法或缺来源直接 build 失败——未经审核的走廊数据进不了构建产物。
{
  const corridors = extra.corridors || [];
  const byId = new Map(channels.map((c) => [c.id, c]));
  for (const entry of corridors) {
    const ch = byId.get(entry.id);
    if (!ch) throw new Error(`[corridors] 指向不存在的通道 id: ${entry.id}`);
    if (!Array.isArray(entry.wp) || !entry.wp.length)
      throw new Error(`[corridors] ${entry.id} 缺 waypoints（至少 1 个中间点；无数据请整条删除）`);
    for (const p of entry.wp) {
      if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) ||
          Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)
        throw new Error(`[corridors] ${entry.id} 存在非法坐标: ${JSON.stringify(p)}`);
    }
    if (!entry.src || !String(entry.src).trim())
      throw new Error(`[corridors] ${entry.id} 缺 src 来源字段（spec: 先审后上）`);
    ch.waypoints = entry.wp.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
    ch.wpSrc = String(entry.src).trim();
    if (entry.url) ch.wpUrl = String(entry.url);
  }
}

// ---------- 4. 输出：Web 内联版 + 端云共用的独立数据文件 ----------
// LOSS_OF（省级上网环节线损率）：与 PV 同源派生，随载荷下发，算法层只认这一份。
// 为什么必须进契约（H3）：算法层读 data.LOSS_OF 决定受端省内网损（inLoss）与送端省内网损
// （exportLoss）是否计费；端侧按旧契约组装数据会漏掉它，两者被静默按 0 计而基线仍全绿。
// 消费方缺字段时必须显式告警（fail-closed），不得静默按 0——见 docs/03-数据接口说明.md。
const lossOf = {};
for (const [code, p] of Object.entries(provinceOut)) {
  lossOf[code] = { exportLoss: p.exportLoss ?? null, inLoss: p.inLoss ?? null };
}

const payload = {
  ST: extra.stations,
  CH: channels,
  SEC: extra.sections,
  PV: provinceOut,
  RG: prices.区域电网输电价格,
  RGOF: prices.区域电网分区,
  RLOSS: prices.区域网损参数,
  VALIDITY: prices.参数适用期,
  // REQ-401：两部制容（需）量电价（月单价，按电压档多档），数据源 S11-附件1 省级电网输配电价表
  CAP: prices.两部制容量需量电价,
  // 受端分电压等级输配电价（电网主体 × 档别 × 单一制/两部制，含注3 线损率）与送端电站专属送出价（注4），S11-附件1
  VT: prices.受端分电压输配电价 || null,
  SRCX: prices.送端电站专属送出价 || null,
  // 非省间通道台账：物理存在但在省级图模型里无法建跨省边的工程（广东省内分区背靠背、对俄跨境受入），
  // 只登记不参与枚举与计价，见 data/fixed-prices.json 的「非省间通道」。
  NIC: prices.非省间通道 || null,
  // v6 新增：省级上网环节线损率，由上面的 PV 派生（与 PV 同源、同一数据源）。
  // 放在载荷末尾：新增字段只影响 dataHash，不改变既有键序，便于消费方逐字段对照升级。
  LOSS_OF: lossOf,
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
// 内联顺序：常量 → 格式化 → 数据 → 状态 → 算法 → 界面（theme 取令牌工具在最前）→ 启动（boot 有顶层执行语句，必须最后）
const APP_FILES = [
  'src/app/config.js',
  'src/app/format.js',
  'src/app/data.js',
  'src/app/state.js',
  'src/app/algo/network.js',
  'src/app/algo/cost.js',
  'src/app/algo/paths.js',
  'src/app/algo/solve.js',
  'src/app/ui/theme.js',
  'src/app/ui/calc.js',
  'src/app/ui/lib.js',
  'src/app/ui/map.js',
  'src/app/ui/ai.js',
  'src/app/boot.js',
];
// APP_FILES 与 tools/test-modules.mjs 的守卫清单必须逐项一致（两份列表过去靠人工同步，
// 漏改会让新模块不参与纯度守卫，或构建与守卫对不上）。
const testModulesSrc = fs.readFileSync(path.join(root, 'tools/test-modules.mjs'), 'utf8');
const tmMatch = testModulesSrc.match(/const APP_FILES\s*=\s*\[([\s\S]*?)\];/);
if (!tmMatch) failFast('无法从 tools/test-modules.mjs 解析 APP_FILES 列表（格式变了？请同步本断言）');
const testFiles = [...tmMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
if (JSON.stringify(testFiles) !== JSON.stringify(APP_FILES)) {
  const onlyBuild = APP_FILES.filter((f) => !testFiles.includes(f));
  const onlyTest = testFiles.filter((f) => !APP_FILES.includes(f));
  failFast('APP_FILES 与 tools/test-modules.mjs 不一致：'
    + (onlyBuild.length ? `仅 build 有 [${onlyBuild.join(', ')}]；` : '')
    + (onlyTest.length ? `仅 test-modules 有 [${onlyTest.join(', ')}]；` : '')
    + '请同步两份列表');
}

const appSource = APP_FILES.map((f) => {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) failFast('缺少模块：' + f);
  return `/* ===== ${f} ===== */\n` + fs.readFileSync(p, 'utf8').trim();
}).join('\n\n');

// ---- 模板占位符：各出现且仅出现 1 次，且各自独占一行（残留文字会变成悬空代码）----
const tpl = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8');
for (const ph of ['/*__TOKENS__*/', '/*__DATA__*/', '/*__APP__*/']) {
  const n = tpl.split(ph).length - 1;
  if (n !== 1) failFast(`src/template.html 中 ${ph} 出现 ${n} 次（必须且只能出现 1 次）`);
  const onOwnLine = new RegExp('^[ \\t]*' + ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*$', 'm');
  if (!onOwnLine.test(tpl)) failFast(`src/template.html 中 ${ph} 未独占一行（前后有残留文字会变成悬空代码）`);
}

// ---- String.replace 替换陷阱（M23）：$& / $$ / $` / $' 会被当作替换模式解释 ----
// 字符串模式下这四种序列可让替换结果被静默改写，且 rc=0 产出语法错误产物（实测四种均可复现）。
function assertNoReplaceDollar(s, label){
  const m = s.match(/\$(?:&|\$|`|')/);
  if (m) failFast(`注入串 ${label} 含替换模式 ${JSON.stringify(m[0])}（String.replace 会改写它）；` +
    '请在数据/源码中改写该序列或为替换实现转义（$ → $$）后再构建');
}
// 设计令牌（src/tokens.css）：注入模板 <style> 开头的 /*__TOKENS__*/ 占位行。
// 注入前去掉 /* */ 注释与由此留下的空行（源文件保留注释供查阅，产物不带，约省 10 KB）；
// 引号内的字符串（url("data:…") 等）原样保留。tools/test-modules.mjs 用同一规则核对产物。
function stripCssComments(css) {
  let out = '', i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {                       // 字符串：原样拷到配对的引号（含转义）
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
      out += css.slice(i, j + 1); i = j + 1;
    } else if (c === '/' && css[i + 1] === '*') {       // 注释：跳到 */
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
    } else { out += c; i++; }
  }
  return out.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).join('\n');
}
const tokensPath = path.join(root, 'src/tokens.css');
if (!fs.existsSync(tokensPath)) failFast('缺少设计令牌文件 src/tokens.css');
const tokensCss = stripCssComments(fs.readFileSync(tokensPath, 'utf8').replace(/\r\n?/g, '\n')).trim();
if (/\/\*|\*\//.test(tokensCss.replace(/(["'])(?:\\.|(?!\1).)*\1/g, ''))) failFast('src/tokens.css 去注释后仍残留 /* 或 */（注释未闭合？）');
if (!/(^|\n):root\s*\{/.test(tokensCss)) failFast('src/tokens.css 中没有 :root{…} 令牌块');
if (/<\/style/i.test(tokensCss)) failFast('src/tokens.css 含 </style>，注入后会提前闭合样式块');
if (/\/\*__(TOKENS|DATA|APP)__\*\//.test(tokensCss)) failFast('src/tokens.css 含注入占位符字面量，会与模板占位符混淆');
const tokensAt = tpl.indexOf('/*__TOKENS__*/');
if (!(tokensAt > tpl.indexOf('<style>') && tokensAt < tpl.indexOf('</style>'))) failFast('src/template.html 中 /*__TOKENS__*/ 不在 <style> 块内');
assertNoReplaceDollar(tokensCss, 'TOKENS');
const injectedData = 'const DATA=' + json(payload) + ';';
assertNoReplaceDollar(injectedData, 'DATA');
assertNoReplaceDollar(appSource, 'APP');
assertNoReplaceDollar(BUILD_TIME, 'BUILD_TIME');
assertNoReplaceDollar(priceVersion, 'PRICE_VERSION');

const out = tpl
  .replace('/*__TOKENS__*/', tokensCss)
  .replace('/*__DATA__*/', injectedData)
  .replace('/*__APP__*/', appSource)
  .replace('__BUILD_TIME__', BUILD_TIME)
  .replace('__PRICE_VERSION__', priceVersion);

// ---- 注入结果逐字节核对：替换串必须原样出现且只出现 1 次 ----
// 注意链路顺序：appSource 注入后，config.js 里的 BUILD_TIME / PRICE_VERSION 两个 token 还会被
// 后续两次 replace 填值，因此内联脚本的期望值要按同样顺序先算出来，再做逐字节比对。
const appSourceFinal = appSource
  .replace('__BUILD_TIME__', BUILD_TIME)
  .replace('__PRICE_VERSION__', priceVersion);
if (out.includes('/*__TOKENS__*/') || out.includes('/*__DATA__*/') || out.includes('/*__APP__*/')) failFast('index.html 中仍残留注入占位符');
if ((out.split(tokensCss).length - 1) !== 1) failFast('index.html 内联设计令牌与 src/tokens.css 不一致（替换被 $ 模式污染或占位符被改写）');
if ((out.split(injectedData).length - 1) !== 1) failFast('index.html 内联数据与注入串不一致（替换被 $ 模式污染或占位符被改写）');
if ((out.split(appSourceFinal).length - 1) !== 1) failFast('index.html 内联脚本与注入串不一致（替换被 $ 模式污染或占位符被改写）');
if (out.includes('__PRICE_VERSION__') || out.includes('__BUILD_TIME__')) failFast('构建占位符未全部替换（__PRICE_VERSION__ / __BUILD_TIME__）');

// ---- 语法检查：内联后的整个脚本必须能被 vm 解析（不执行）----
const scriptStart = out.lastIndexOf('<script>');
const scriptEnd = out.lastIndexOf('</' + 'script>');
if (scriptStart < 0 || scriptEnd <= scriptStart) failFast('index.html 中未找到内联脚本段');
try {
  new vm.Script(out.slice(scriptStart + '<script>'.length, scriptEnd), { filename: 'index.html#inline-script' });
} catch (e) {
  failFast('内联脚本无法通过语法解析（占位符破坏或替换污染）：' + e.message);
}
// ================= 写盘前校验区（以下全部通过后才写出文件） =================
// index.html 内容（out）到此已定版：占位符、注入串、语法三项均已校验，但**尚未写盘**。
// (b) 手机端与其它消费方：同一份数据的独立 JSON（输出到 shared/，不用 dist/ 以免被发布工具排除）。
//     与 Web 版同源、同一次构建产出，保证两端数据结构与数值完全一致。
const dataHash = sha(json(payload));   // 载荷指纹：Web 内联数据与两份 JSON 必须同源同值
const appData = {
  // v6：新增顶层 LOSS_OF（省级上网环节线损率，与 PV 同源派生）。加字段必须升 schema，
  // 消费方据此做兼容判断；缺 LOSS_OF 的端侧实现会静默按 0 计省内网损（H3）。
  // v5：新增 NIC（非省间通道台账）；v4：CH 新增 pricePending（价格待核通道）；
  // v3：CH 新增 sendFeeRev / dirNote / marginalNote，PV 新增 inLoss / exportLoss / exportKind；
  // v2：CH 新增 bidir / regional / tRev。
  schema: 'iproute-app-data/v6',
  builtAt,
  priceVersion,                                   // 价格数据指纹，用于两端比对
  dataHash,                                       // 载荷指纹，用于校验完整性
  counts: {
    stations: Object.keys(payload.ST).length,
    channels: payload.CH.length,
    channelsPriced: payload.CH.filter((c) => !c.pricePending).length,
    sections: payload.SEC.length,
    provinces: Object.keys(payload.PV).length,
    nonInterprovincial: payload.NIC ? payload.NIC.条目.length : 0,
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
    'RLOSS：currentPct=null 表示本期未核实；historicalPct 仅供历史参考情景。VALIDITY/PV.effectiveFrom 为适用期。',
    '本文件由 tools/build.mjs 生成，与 index.html 同源同版本。',
    '修改价格请改 data/fixed-prices.json 后重新构建，不要直接改本文件。',
    'CH[].tier 为数据可信度：gov=发改委核定 / grid=国网披露 / region=区域或送出省口径 / est=待补（价格待核）。',
    'CH[].cap 为用于容量校验的容量，已优先取「实际输送能力」，缺失时回退额定；capBasis 标明口径（cap/rated/reported/estimate/unknown），estimate 与 unknown 不得用于越限判定。',
    'CH[].priceType 为 energy（电量制）或 capacity（容量制，t 为边际费用情景，非通用核定电量价）。',
    'CH[].sendFee 仅在交易起点计入送端省内段。regional 接口的 t/tRev 为两侧省送出参考价，仅首段归入 send，不作独立通道收费。',
    'CH[].bidir：能否双向通行。专项工程默认 false；数据文件标「双向」的 7 条（德宝、青藏、长南荆、辛洹、灵宝、高岭、云霄）与全部联络线为 true。反向行进时联络线输电价取 tRev，专项工程送端省内段费用取 sendFeeRev；dirNote 为方向依据。',
    'CH[].regional：仅联络接口为 true，中长期区域费按共用网络去重，公告要求时另计受端区域一次。',
    '区域内部共用交流接口的计费线损为 0；CH[].loss 原值仅作物理功率和容量估算。专项工程与背靠背直流按自身计费口径处理。',
    'CH[].incLoss 为 true 的段「输电价格已包含网损」，不再重复收计费网损；独立工程输电费按其出口电量约定折算。',
    'CH[].marginalNote：容量制工程（辛洹、云霄）的 t 为交易方的边际输电价（辛洹 0，云霄取输电权报价下限），说明见此字段。',
    'PV[].inLoss / exportLoss：受端省内上网环节线损率 / 送省外上网环节线损率（%），1077号附件1 注3、注4；exportKind 标明送出省价格是「核定外送」还是「临时互济条款」。',
    'PV[].fund 可能为 null（西藏未获取），消费方需按缺失处理而非当作 0 静默使用。',
    'LOSS_OF[code] = { exportLoss, inLoss }：省级送省外 / 省内上网环节线损率（%，1077号附件1 注3、注4），与 PV 同源派生。',
    '算法层读 data.LOSS_OF 决定省内网损是否计费；该字段缺失或与 PV 不一致时消费方必须显式告警（fail-closed），不得静默按 0 计。',
    'LOADING：路径规划算法不在本文件内，需由消费方实现。算法约定与回归基线见 docs/01-安卓开发框架.md 与 docs/regression-baseline-v2.json。',
  ],
  ...payload,
};

// 两份 JSON 的最终文本（与 index.html 的 out 一样在内存中定版，写盘只写这里校验过的字符串）。
// 紧凑版仅去掉缩进，减小手机端体积；两者内容必须逐字节等价（下面校验）。
const fullText = JSON.stringify(appData, null, 2) + '\n';
const minText = json(appData) + '\n';

// ---- 三份产物同源：index.html 内联数据 / app-data.json / app-data.min.json ----
// 内联数据已在上面逐字节核对；这里对**待写入的字符串**做解析回读，校验指纹与序列化保真
// （防止写入/序列化环节出岔）。校验对象就是随后写出的内容，因此不再需要落盘后再回读。
let inlinePayload;
try {
  inlinePayload = JSON.parse(injectedData.slice('const DATA='.length, -1));
} catch (e) {
  failFast('index.html 内联 DATA 不是合法 JSON：' + e.message);
}
if (sha(json(inlinePayload)) !== dataHash) failFast('index.html 内联数据与 dataHash 不一致（三份产物不同源）');
let fullAd, minAd;
try {
  fullAd = JSON.parse(fullText);
  minAd = JSON.parse(minText);
} catch (e) {
  failFast('app-data 序列化结果读回失败（JSON 不合法）：' + e.message);
}
if (fullAd.dataHash !== dataHash) failFast(`app-data.json 的 dataHash=${fullAd.dataHash} ≠ ${dataHash}`);
if (minAd.dataHash !== dataHash) failFast(`app-data.min.json 的 dataHash=${minAd.dataHash} ≠ ${dataHash}`);
if (fullAd.priceVersion !== priceVersion) failFast('app-data.json 的 priceVersion 与构建值不一致');
if (json(fullAd) !== json(minAd)) failFast('app-data.json 与 app-data.min.json 内容不一致');
if (fullAd.schema !== appData.schema) failFast('app-data.json 的 schema 与构建值不一致');
if (json(inlinePayload) !== json(payload)) failFast('index.html 内联载荷与 app-data.json 载荷不一致');

// ---------- 5. 数据值域 lint（写盘前执行；每条附书面依据，0 违例才通过） ----------
// 只做「能给出确定判据」的检查，不把估算口径当错误；任何一条有违例即 exit 1。
const LINT = [];
const lintAdd = (label, basis, bad) => LINT.push({ label, basis, bad });

// ① 坐标：非空且落在合理包络
{
  const bad = [];
  const B = { lng: [73, 136], lat: [3, 54] };
  const checkLL = (kind, id, lng, lat) => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) bad.push(`${kind} ${id}：坐标缺失`);
    else if (lng < B.lng[0] || lng > B.lng[1] || lat < B.lat[0] || lat > B.lat[1])
      bad.push(`${kind} ${id}：(${lng}, ${lat}) 落在包络外`);
  };
  for (const [id, s] of Object.entries(extra.stations)) checkLL('ST', id, s.lng, s.lat);
  for (const [code, p] of Object.entries(payload.PV)) checkLL('PV', code, p.lng, p.lat);
  lintAdd('坐标非空且落在合理包络', '中国电网设施地理包络（含南海诸岛）：经度 73–136°E、纬度 3–54°N；空值或域外坐标视为录入错误', bad);
}

// ② PV 上网环节线损率 ∈ [0, 100)
{
  const bad = [];
  for (const [code, p] of Object.entries(payload.PV)) {
    for (const f of ['inLoss', 'exportLoss']) {
      const v = p[f];
      if (v == null) continue;   // null = 未获取，属合法缺项（消费方必须告警而非按 0）
      if (!Number.isFinite(v) || v < 0 || v >= 100) bad.push(`PV.${code}.${f}=${v}`);
    }
  }
  lintAdd('PV 上网环节线损率 ∈ [0,100)', '1077号附件1 注3/注4 线损率为百分数，物理上 0≤ρ<100；null=未获取', bad);
}

// ③ 区域电网电量电价为正
{
  const bad = [];
  for (const [k, v] of Object.entries(payload.RG || {})) {
    if (k.startsWith('_')) continue;
    if (!Number.isFinite(v) || v <= 0) bad.push(`RG.${k}=${v}`);
  }
  lintAdd('区域电网输电价格为有限正数', '1077号附件2 区域电网输电价格为核定电量电价（元/千瓦时）；0 或负值说明单位/录入错误', bad);
}

// ④ 双向通道正反向取价成对
{
  const bad = [];
  for (const c of channels) {
    if (!c.bidir) continue;
    if (c.regional) {
      if (c.t == null || c.tRev == null) bad.push(`${c.id} ${c.n}：联络线缺 t/tRev`);
    } else {
      if (c.t == null) bad.push(`${c.id} ${c.n}：双向专项工程缺核定价 t`);
      if ((c.sendFee == null) !== (c.sendFeeRev == null))
        bad.push(`${c.id} ${c.n}：sendFee/sendFeeRev 未成对（${c.sendFee} / ${c.sendFeeRev}）`);
    }
  }
  lintAdd('双向通道正反向取价成对', '反向取价路径：联络线 tariffOf 取 tRev、双向专项工程 sendFeeOf 取 sendFeeRev；缺一侧会让反向路径少计或按 0 计', bad);
}

// ⑤ CH 端点省码必须是 PV 中存在的省级节点
{
  const bad = [];
  const codes = new Set(Object.keys(payload.PV));
  for (const c of channels) {
    if (!codes.has(c.from)) bad.push(`${c.id} ${c.n}：from=${c.from} 不在 PV`);
    if (!codes.has(c.to)) bad.push(`${c.id} ${c.n}：to=${c.to} 不在 PV`);
  }
  lintAdd('CH 端点省码在 PV 中存在', '省级图节点 = PV 键；省码写错会让 buildAdj 挂到不存在的节点、路径静默消失（换流站 ST.p 另有 5 处历史不一致，属独立台账问题，不在本条判据内）', bad);
}

// ⑥ 省间联络线（regional 边）容量一律为 null
// 公开来源只给到回数/断面对应关系，未给逐回输送能力；填估算值会参与越限判断并产生假告警
// （docs/11 D6/H2：14 条历史估算容量曾让辽宁→吉林等常规量级交易被误判「全部越限」）。
{
  const bad = [];
  for (const c of channels) {
    if (!c.regional) continue;
    if (c.cap != null || c.capBasis !== 'unknown')
      bad.push(`${c.id} ${c.n}：cap=${c.cap}、capBasis=${c.capBasis}（须为 null/unknown）`);
  }
  lintAdd('省间联络线容量一律为 null（capBasis=unknown）', '2026-09-17 审查意见与 docs/11 D6：省间联络线不填估算容量，界面显示「容量待补」且不做容量校验；估算值只存放在说明列供追溯', bad);
}

console.log('\n数据值域 lint（每条附书面依据，0 违例才通过）：');
let lintBad = 0;
for (const { label, basis, bad } of LINT) {
  if (bad.length) {
    lintBad += bad.length;
    console.log(`  ❌ ${label}　${bad.length} 违例（依据：${basis}）`);
    bad.slice(0, 5).forEach((b) => console.log('     · ' + b));
  } else console.log(`  ✅ ${label}　0 违例（依据：${basis}）`);
}
if (lintBad) failFast(`数据值域 lint 共 ${lintBad} 处违例`);

// ---- tier 分档计数（写盘前校验）----
const byTier = channels.reduce((a, c) => (a[c.tier] = (a[c.tier] || 0) + 1, a), {});
// tier 四档必须覆盖全部通道（既不能漏统计，也不能有未知档）；合计 ≠ CH 长度说明分档逻辑漏了取值。
const TIER_KEYS = ['gov', 'grid', 'region', 'est'];
const tierSum = TIER_KEYS.reduce((a, k) => a + (byTier[k] || 0), 0);
const unknownTier = channels.filter((c) => !TIER_KEYS.includes(c.tier));
if (tierSum !== channels.length || unknownTier.length)
  failFast(`tier 分档计数 ${tierSum} ≠ 通道总数 ${channels.length}`
    + (unknownTier.length ? `；未知档：${unknownTier.map((c) => c.id + ':' + c.tier).join(',')}` : ''));

// ================= 校验全部通过，写盘 =================
// 写出的正是上面被校验过的字符串：out / fullText / minText。任一校验失败都会在此之前 exit 1，
// 磁盘上不会留下新增或被改写的产物（index.html、shared/app-data*.json 保持上一次构建的状态）。
const distDir = path.join(root, 'shared')   // 不要用 dist/：发布工具会把它当构建产物排除;
fs.mkdirSync(distDir, { recursive: true });
const fullPath = path.join(distDir, 'app-data.json');
const minPath = path.join(distDir, 'app-data.min.json');
fs.writeFileSync(path.join(root, 'index.html'), out);
fs.writeFileSync(fullPath, fullText);
fs.writeFileSync(minPath, minText);

// ---------- 6. 控制台统计 ----------
const est = Object.values(provinceOut).filter((p) => p.net == null).length;
console.log('通道总数:', channels.length, `（专项工程 ${channels.length - AC_LINKS.length} + 省间联络线 ${AC_LINKS.length}）`);
console.log('  发改委核定 gov   :', byTier.gov || 0);
console.log('  国网/交易中心 grid:', byTier.grid || 0);
console.log('  区域电网/送出省   :', byTier.region || 0);
console.log('  待补 est（价格待核）:', byTier.est || 0, `　分档合计 ${tierSum} = 通道总数`);
console.log('跳过（同名或同省）:', skip);
console.log('站点:', Object.keys(extra.stations).length,
  '| 断面:', extra.sections.length,
  '| 省级参数:', Object.keys(provinceOut).length,
  est ? `（其中 ${est} 个缺输配电价）` : '（全部有值）');
console.log('省级线损率 LOSS_OF:', Object.keys(lossOf).length, '省（null = 未获取，消费方须显式告警）');
console.log('价格数据源: data/fixed-prices.json');
console.log('应用模块:', APP_FILES.length, '个（' + (appSource.length / 1024).toFixed(1) + ' KB）');
console.log('价格数据指纹 priceVersion:', priceVersion);
console.log('index.html 已生成:', (fs.statSync(path.join(root, 'index.html')).size / 1024).toFixed(1), 'KB');
console.log('shared/app-data.json 已生成:', (fs.statSync(path.join(distDir, 'app-data.json')).size / 1024).toFixed(1), 'KB（端云共用数据）');
