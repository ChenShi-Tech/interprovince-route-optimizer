#!/usr/bin/env node
/**
 * 校验 Web 与手机端共用数据的一致性。
 * 两端必须来自同一次构建、同一份数据、同一价格版本。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '　' + detail : '')); }
};

console.log('══ 一、产物存在性 ══');
const p = {
  fixed: 'data/fixed-prices.json',
  html: 'index.html',
  full: 'shared/app-data.json',
  min: 'shared/app-data.min.json',
  tpl: 'src/template.html',
};
const exists = {};
for (const [k, v] of Object.entries(p)) {
  exists[k] = fs.existsSync(path.join(root, v));
  ok(exists[k], `${v}${exists[k] ? '  ' + (fs.statSync(path.join(root, v)).size / 1024).toFixed(0) + ' KB' : ''}`);
}
if (fail) { console.log('\n产物缺失，先跑 node tools/build.mjs'); process.exit(1); }

console.log('\n══ 二、手机端数据结构 ══');
const ad = JSON.parse(fs.readFileSync(path.join(root, p.full), 'utf8'));
// v6：新增顶层 LOSS_OF（省级上网环节线损率，与 PV 同源派生）。加字段必须升 schema，
// 消费方据此做兼容判断；缺 LOSS_OF 的端侧实现会静默按 0 计省内网损（H3）。
// v5：NIC 非省间通道台账 + CH.pricePending；v4：CH.bidir/regional/tRev 等。
const SCHEMA = 'iproute-app-data/v6';
ok(ad.schema === SCHEMA, `schema = ${ad.schema}（应为 ${SCHEMA}）`, `字段 schema：期望 ${SCHEMA}，实际 ${ad.schema}`);
ok(typeof ad.priceVersion === 'string' && ad.priceVersion.length === 16, `priceVersion = ${ad.priceVersion}`);
ok(typeof ad.dataHash === 'string' && ad.dataHash.length === 64, 'dataHash 长度正确');
ok(ad.ST && Object.keys(ad.ST).length === ad.counts.stations, `ST 站点 ${ad.counts.stations} 个与 counts 一致`);
ok(Array.isArray(ad.CH) && ad.CH.length === ad.counts.channels, `CH 通道 ${ad.counts.channels} 条与 counts 一致`);
ok(Array.isArray(ad.SEC) && ad.SEC.length === ad.counts.sections, `SEC 断面 ${ad.counts.sections} 个与 counts 一致`);
ok(ad.PV && Object.keys(ad.PV).length === ad.counts.provinces, `PV 省级参数 ${ad.counts.provinces} 个与 counts 一致`);
ok(ad.RG && ad.RGOF, 'RG 区域电网电价与 RGOF 区域归属均存在');
ok(Array.isArray(ad.readme) && ad.readme.length > 0, '自带 readme 说明');
ok(ad.units && ad.units['价格'] === '元/兆瓦时', '单位声明存在且正确');

// LOSS_OF（v6 契约字段）：必须与 PV 同源一致，逐省逐字段比对，失败信息能直接定位到省与字段。
{
  const issues = [];
  const lo = ad.LOSS_OF;
  for (const [code, prov] of Object.entries(ad.PV)) {
    const item = lo && lo[code];
    if (!item || typeof item !== 'object') { issues.push(`LOSS_OF.${code} 缺失`); continue; }
    if ((item.inLoss ?? null) !== (prov.inLoss ?? null)) issues.push(`LOSS_OF.${code}.inLoss=${item.inLoss} ≠ PV.${code}.inLoss=${prov.inLoss}`);
    if ((item.exportLoss ?? null) !== (prov.exportLoss ?? null)) issues.push(`LOSS_OF.${code}.exportLoss=${item.exportLoss} ≠ PV.${code}.exportLoss=${prov.exportLoss}`);
  }
  for (const code of Object.keys(lo || {})) if (!(code in ad.PV)) issues.push(`LOSS_OF 含未知省份 ${code}`);
  ok(issues.length === 0, `LOSS_OF 与 PV 同源一致（${Object.keys(ad.PV).length} 省逐字段比对）`, issues.slice(0, 6).join('；'));
}

console.log('\n══ 三、紧凑版与完整版同内容 ══');
const minAd = JSON.parse(fs.readFileSync(path.join(root, p.min), 'utf8'));
ok(JSON.stringify(minAd) === JSON.stringify(ad), 'app-data.min.json 与 app-data.json 内容完全一致');

console.log('\n══ 四、载荷指纹自校验 ══');
/* LOSS_OF 与构建期同源派生：tools/build.mjs 的 lossOf 与 src/app/data.js 的 LOSS_OF
   都由 PV 逐省取 {exportLoss, inLoss}（缺项写 null）。这里必须用同一派生方式重建，
   不能在测试里另写一份常量——「价格数据只有一处来源」的纪律同样约束测试自身。
   键序也要与 build.mjs 一致（PV 顺序、exportLoss 在前），JSON.stringify 才逐字节可比。 */
const derivedLossOf = (pv) => Object.fromEntries(Object.entries(pv)
  .map(([code, prov]) => [code, { exportLoss: prov.exportLoss ?? null, inLoss: prov.inLoss ?? null }]));
const payload = { ST: ad.ST, CH: ad.CH, SEC: ad.SEC, PV: ad.PV, RG: ad.RG, RGOF: ad.RGOF, RLOSS:ad.RLOSS, VALIDITY:ad.VALIDITY, CAP: ad.CAP, VT: ad.VT, SRCX: ad.SRCX, NIC: ad.NIC, LOSS_OF: derivedLossOf(ad.PV) };
/* 顶层字段级差异提示：哈希对不上时直接指出是哪个字段不一致（键序问题也会被点出）。 */
const payloadDiff = (a, b) => {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const bad = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return bad.length ? '不一致的顶层字段：' + bad.join(', ') : '顶层字段值一致（差异在键序/序列化）';
};
ok(sha(JSON.stringify(payload)) === ad.dataHash, 'dataHash 与载荷内容吻合，数据未被篡改', `字段 dataHash：${payloadDiff(payload, ad)}`);
// 与 build.mjs 同口径：哈希前归一化换行，避免 autocrlf 检出差异造成假性版本不一致
const fixedHash = sha(fs.readFileSync(path.join(root, p.fixed), 'utf8').replace(/\r\n?/g, '\n')).slice(0, 16);
ok(fixedHash === ad.priceVersion, 'priceVersion 与 data/fixed-prices.json 当前内容吻合');

console.log('\n══ 五、Web 端内联数据与手机端一致 ══');
const html = fs.readFileSync(path.join(root, p.html), 'utf8');
const m = html.match(/const DATA=(\{.*?\});\r?\n/s);
ok(!!m, 'index.html 含内联 DATA');
if (m) {
  const web = JSON.parse(m[1]);
  ok(web.CH.length === ad.CH.length, `通道数一致（${web.CH.length}）`);
  ok(Object.keys(web.PV).length === Object.keys(ad.PV).length, `省级参数数一致（${Object.keys(web.PV).length}）`);
  ok(Object.keys(web.ST).length === Object.keys(ad.ST).length, `站点数一致（${Object.keys(web.ST).length}）`);
  ok(JSON.stringify(payload) === JSON.stringify(web), '两端载荷逐字节一致', `字段级差异：${payloadDiff(payload, web)}`);
}
const webPv = (html.match(/const PRICE_VERSION='([^']+)'/) || [])[1];
ok(webPv === ad.priceVersion, `Web 端 priceVersion（${webPv}）与手机端一致`);
ok(!html.includes('__PRICE_VERSION__') && !html.includes('__BUILD_TIME__'), '构建占位符已全部替换');

console.log('\n══ 六、关键字段可用于手机端实现 ══');
const ch = ad.CH;
ok(ch.every((c) => typeof c.sendFee === 'number'), '每条通道都带 sendFee（送端省内段费用）');
ok(ch.every((c) => c.capBasis), '每条通道都带 capBasis（容量口径）');
ok(ch.every((c) => c.priceType), '每条通道都带 priceType（计价方式）');
ok(ch.every((c) => typeof c.tradable === 'boolean'), '每条通道都带 tradable 标记');
ok(ch.every((c) => typeof c.bidir === 'boolean' && typeof c.regional === 'boolean'), '每条通道都带 bidir / regional 标记');
const ties = ch.filter((c) => c.regional), projects = ch.filter((c) => !c.regional);
ok(ties.length === 33 && ties.every((c) => c.bidir && typeof c.tRev === 'number' && !c.tradable && c.tier === 'region'),
  `33 条省间联络线（含特高压交流 11 条、西北 750kV 4 条；跨华北/西北异步边界的两条已删）为双向、带反向输电价 tRev、tier=region（现 ${ties.length} 条）`);
const biProj = projects.filter((c) => c.bidir).map((c) => c.n).sort();
ok(biProj.length === 7 && ['云霄直流', '灵宝直流', '德宝直流', '青藏直流', '辛洹线', '长南荆特高压交流', '高岭直流'].sort().join() === biProj.join(),
  `双向专项工程 7 条：${biProj.join('、')}`);
ok(projects.filter((c) => c.bidir).every((c) => typeof c.sendFeeRev === 'number' && c.dirNote) && projects.filter((c) => !c.bidir).every((c) => c.sendFeeRev === null),
  '双向专项工程带 sendFeeRev 与方向依据，单向工程为 null');
ok(projects.every((c) => c.tRev === null), '专项工程 tRev 为 null（核定价与方向无关）');
ok(!ch.some((c) => ['川陕联络线', '晋陕联络线', '高岭联络线', '青藏交流', '云贵联络线', '云桂联络线'].includes(c.n)), '7 条物理上不存在的交流联络已删除（渝鄂改记为背靠背）');
ok(ch.find((c) => c.n === '渝鄂联络线').type === 'DC', '渝鄂联络线记为背靠背直流');
// D6/H2：省间联络线一律不填估算容量（cap=null、capBasis=unknown），界面显示「容量待补」且不做越限判断。
// 估算值只留在说明列供追溯，不得参与计价或容量校验——旧断言曾要求 5000 MW，与 2026-09-18 口径冲突。
ok(ties.every((c) => c.cap === null && c.capBasis === 'unknown'),
  '33 条省间联络线容量一律 null（capBasis=unknown，不做越限判断，界面「容量待补」）',
  `非空容量的联络线：${ties.filter((c) => c.cap !== null || c.capBasis !== 'unknown').map((c) => `${c.n}(${c.cap}/${c.capBasis})`).join('、') || '无'}`);
ok(ch.find((c) => c.n === '青藏直流').cap === 1200 && ch.find((c) => c.n === '高岭直流').cap === 3000, '青藏直流 1200 MW、高岭直流 3000 MW（扩建后）');
ok(ch.find((c) => c.n === '辛洹线').t === 0 && ch.find((c) => c.n === '云霄直流').t === 25.6, '容量制工程边际输电价：辛洹 0、云霄 25.6');
const pv = Object.values(ad.PV);
{
  // 31 个省级参数全部带两个线损率：海南 2026-09-17 补录、西藏 2026-09-18 回填（10.81 / 3.22）。
  // 失败信息逐省列出缺哪个字段，不写「30 个省」这类会再过期的人数快照。
  const missIn = Object.entries(ad.PV).filter(([, x]) => typeof x.inLoss !== 'number').map(([k]) => k);
  const missOut = Object.entries(ad.PV).filter(([, x]) => typeof x.exportLoss !== 'number').map(([k]) => k);
  ok(missIn.length === 0 && missOut.length === 0,
    `${pv.length} 个省全部带省内 / 送省外上网环节线损率（含海南、西藏）`,
    `字段 inLoss 缺：${missIn.join(',') || '无'}；exportLoss 缺：${missOut.join(',') || '无'}`);
  ok(ad.PV.XZ.inLoss === 10.81 && ad.PV.XZ.exportLoss === 3.22 && ad.LOSS_OF.XZ.inLoss === 10.81 && ad.LOSS_OF.XZ.exportLoss === 3.22,
    '西藏线损率 10.81（注3 省内）/ 3.22（注4 送省外）已进入 PV 与 LOSS_OF（D1 回填）',
    `字段 PV.XZ/LOSS_OF.XZ：PV=${ad.PV.XZ.inLoss}/${ad.PV.XZ.exportLoss}，LOSS_OF=${ad.LOSS_OF.XZ.inLoss}/${ad.LOSS_OF.XZ.exportLoss}`);
}
ok(ad.PV.SC.exportLoss === 0.99 && ad.PV.HB.exportLoss === 0.82 && ad.PV.JS.inLoss === 2.83, '抽查：四川送省外 0.99%、湖北 0.82%、江苏省内 2.83%');
ok(ch.filter((c) => c.priceType === 'capacity').length === 3, '容量制工程 3 条（辛洹线、云霄直流、海南联网）');
ok(ch.filter((c) => c.capActual != null).length > 0, `有实际输送能力的通道 ${ch.filter((c) => c.capActual != null).length} 条`);
const xz = ad.PV.XZ;
ok(xz && xz.fund === null, '西藏基金附加为 null（消费方须按缺失处理）');

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
