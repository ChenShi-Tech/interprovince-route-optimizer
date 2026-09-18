#!/usr/bin/env node
/**
 * 模块结构守卫。
 *
 * 断言两件事：
 *   ① 算法层（src/app/algo/*）是纯函数模块 —— 不引用任何界面全局（state / PV / CH /
 *      DATA / DOM 等）。这是「安卓端可原样复用同一份算法」的前提，一旦被破坏，
 *      复用时会静默出错。
 *   ② 构建产物确实按 APP_FILES 顺序内联了全部模块，且 boot.js 在最后
 *      （它是唯一有顶层执行语句的模块）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log('  ✅ ' + l); } else { fail++; console.log('  ❌ ' + l + (d ? '　' + d : '')); } };

const APP_FILES = [
  'src/app/config.js', 'src/app/format.js', 'src/app/data.js', 'src/app/state.js',
  'src/app/algo/network.js', 'src/app/algo/cost.js', 'src/app/algo/paths.js', 'src/app/algo/solve.js',
  'src/app/ui/calc.js', 'src/app/ui/lib.js', 'src/app/ui/map.js', 'src/app/ui/ai.js', 'src/app/boot.js',
];

console.log('══ 一、模块齐全 ══');
for (const f of APP_FILES) {
  const p = path.join(root, f);
  const has = fs.existsSync(p);
  ok(has, `${f}${has ? '  ' + (fs.statSync(p).size / 1024).toFixed(1) + ' KB' : ''}`);
}
if (fail) { console.log('\n模块缺失，先补全再谈其它。'); process.exit(1); }

console.log('\n══ 二、算法层是纯函数（安卓端可复用）══');
// 只禁止「裸引用」界面全局。两种合法情形要排除：
//   ① 经参数访问：env.SEC / data.PV（前面有点号）
//   ② 对象字面量的键名：{ REGION_OF: data.REGION_OF }（后面跟冒号）
const bare = (name) => new RegExp('(?<![.\\w$])' + name + '(?![\\w$])(?!\\s*:)');
const FORBIDDEN = [
  [bare('state'), 'state（界面状态）'],
  [bare('DATA'), 'DATA（构建期注入的数据）'],
  [bare('PV'), 'PV（省份表）'],
  [bare('CH'), 'CH（通道表）'],
  [bare('ST'), 'ST（站点表）'],
  [bare('SEC'), 'SEC（断面表）'],
  [bare('REGION_OF'), 'REGION_OF（应由 env 传入）'],
  [bare('RG'), 'RG（应由 env 传入）'],
  [/\bdocument\b|\bwindow\b|\blocalStorage\b/, '浏览器 API'],
  [/(?<![.\w$])(fmt|esc|num|tierTag)\(/, '界面格式化函数'],
];
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
for (const f of APP_FILES.filter((x) => x.includes('/algo/'))) {
  const body = strip(fs.readFileSync(path.join(root, f), 'utf8'));
  const hits = FORBIDDEN.filter(([re]) => re.test(body)).map(([, name]) => name);
  ok(hits.length === 0, `${path.basename(f)} 不引用界面全局`, hits.join('、'));
}

console.log('\n══ 三、构建产物正确内联 ══');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
ok(!html.includes('/*__APP__*/'), '占位符 __APP__ 已被替换');
ok(!html.includes('/*__DATA__*/'), '占位符 __DATA__ 已被替换');
const marks = APP_FILES.map((f) => ({ f, at: html.indexOf(`/* ===== ${f} ===== */`) }));
ok(marks.every((m) => m.at >= 0), `全部 ${APP_FILES.length} 个模块都已内联`,
  marks.filter((m) => m.at < 0).map((m) => m.f).join('、'));
const order = marks.filter((m) => m.at >= 0);
ok(order.every((m, i) => i === 0 || m.at > order[i - 1].at), '内联顺序与 APP_FILES 一致');
const bootAt = html.indexOf('/* ===== src/app/boot.js ===== */');
ok(bootAt > 0 && order.every((m) => m.f === 'src/app/boot.js' || m.at < bootAt),
  'boot.js 排在最后（它含顶层执行语句，必须先定义后执行）');

console.log('\n══ 四、算法入口签名稳定 ══');
const solveSrc = strip(fs.readFileSync(path.join(root, 'src/app/algo/solve.js'), 'utf8'));
ok(/function solve\(input,\s*data\)/.test(solveSrc), 'solve(input, data) 签名保持不变');
ok(/function enumPaths\(adj,\s*src,\s*dst,\s*maxHops,\s*cap,\s*weightOf\)/.test(solveSrc) ||
   /function enumPaths\(adj,\s*src,\s*dst,\s*maxHops,\s*cap,\s*weightOf\)/.test(strip(fs.readFileSync(path.join(root, 'src/app/algo/paths.js'), 'utf8'))),
  'enumPaths 接收显式的权重函数');
const costSrc = strip(fs.readFileSync(path.join(root, 'src/app/algo/cost.js'), 'utf8'));
const netSrc = strip(fs.readFileSync(path.join(root, 'src/app/algo/network.js'), 'utf8'));
// 区域归集及折算行为由 test-model-audit / test-regional-billing 独立数值核验。
ok(/function tariffOf\(e,\s*fromCode\)/.test(costSrc) && /tRev/.test(costSrc), 'tariffOf(e, from) 按行进方向取联络线的输电价（反向取 tRev）');
ok(/function sendFeeOf\(e,\s*fromCode\)/.test(costSrc) && /sendFeeRev/.test(costSrc), 'sendFeeOf(e, from) 双向专项工程反向时送端省内段取 sendFeeRev');
ok(/const fee\s*=\s*t\s*\*\s*qOut/.test(costSrc), '所有段的输电费按段后电量计（规则 4.3.1）');
ok(/LOSS_OF/.test(costSrc) && /inLoss/.test(costSrc) && /exportLoss/.test(costSrc), '受端上网环节线损进买方落地价，送端省内线损进口径三');
ok(/if\s*\(\s*e\.bidir\s*\)/.test(netSrc), 'buildAdj 只对 bidir 边挂反向（方向由数据逐条给定）');
ok(/sideOf\(edges\[0\],\s*nodes\[0\]/.test(netSrc), 'detourOf 按实际行进方向取起点');

console.log('\n══ 五、地图标注清单纯函数（format.js routeLabelList，spec: grid-map）══');
const fmtSrc = fs.readFileSync(path.join(root, 'src/app/format.js'), 'utf8');
const ctx5 = {};
new Function('exports', fmtSrc + '\n;exports.routeLabelList=routeLabelList;')(ctx5);
const ST5 = { S1: { n: '锦屏换流站' }, S2: { n: '苏州换流站' } };
const row5 = { segs: [
  { e: { id: 'g1', n: '锦苏直流', stFrom: 'S1', stTo: 'S2' } },
  { e: { id: 'g2', n: '建苏直流', stFrom: 'S2', stTo: 'S9' } },
]};
const ls5 = ctx5.routeLabelList(row5, ST5);
ok(ls5.length === 4, '两段方案标注数=段2+去重站2', JSON.stringify(ls5));
ok(ls5[0].kind === 'seg' && ls5[0].no === 1 && ls5[0].name === '锦苏直流', '段标注含序号与线路名');
ok(ls5.filter((x) => x.kind === 'station').map((x) => x.st).join(',') === 'S1,S2', '共有站点去重（S2 只出现一次）');
ok(ctx5.routeLabelList(null, ST5).length === 0, '空方案返回空清单');

console.log('\n══ 六、FR-1 数值钳制与缩略显示（format.js sanNum/fmtCompact，PRD-体验问题修复）══');
const ctx6 = {};
new Function('exports', fmtSrc + '\n;exports.sanNum=sanNum;exports.NUM_LIMITS=NUM_LIMITS;exports.fmtCompact=fmtCompact;exports.TIER_STYLE=TIER_STYLE;exports.tierStyle=tierStyle;exports.mapSearchHits=mapSearchHits;exports.regionPalette=regionPalette;')(ctx6);
const { sanNum, NUM_LIMITS, fmtCompact, TIER_STYLE, tierStyle, mapSearchHits, regionPalette } = ctx6;
// 钳制：合法值透传 / 超上限取边界 / 非法取 fallback（决策 D-3 上限表；0/负回落为旧口径，由 e2e B-02/B-03 锁定）
ok(sanNum('320', NUM_LIMITS.quote) === 320, '合法报价原样通过');
ok(sanNum(' 1234.5 ', NUM_LIMITS.quote) === 1234.5, '首尾空白的数值照常解析');
ok(sanNum('999999999', NUM_LIMITS.quote) === 10000, '报价超限钳到 10,000');
ok(sanNum('-8', NUM_LIMITS.quote) === -8, '负值维持旧口径（PRD 只定义上限钳制）');
ok(sanNum('abc', NUM_LIMITS.quote) === 0, '非法输入取 fallback 0');
ok(sanNum('', NUM_LIMITS.qty) === 1000, '电量空输入回退默认 1000');
ok(sanNum('2e12', NUM_LIMITS.qty) === 10000000, '电量科学计数超限钳到 1e7');
ok(sanNum('99999', NUM_LIMITS.hours) === 8760, '时长钳到 8,760');
ok(sanNum('5e9', NUM_LIMITS.capacity) === 1000000, '容量/需量钳到 1e6');
ok(sanNum('5e9', NUM_LIMITS.annualQty) === 10000000, '年用电量钳到 1e7');
ok(sanNum('120', NUM_LIMITS.pct) === 99.999, '百分比钳到 99.999');
// 缩略：常规量级与现状逐字符一致（hero toFixed / 展示位千分位），超大才切万/亿
ok(fmtCompact(436.26, 2) === '436.26', '常规落地价 toFixed 透传（显示不变）');
ok(fmtCompact(9999, 2) === '9999.00', '万以下 toFixed 透传');
ok(fmtCompact(123456) === '12.3万', '≥1e4 缩略为万（396000→39.6万 口径）');
ok(fmtCompact(150000000) === '1.5亿', '≥1e8 缩略为亿');
ok(fmtCompact(320) === '320', '千分位整数口径与 num() 一致');
ok(fmtCompact(null) === '—' && fmtCompact(NaN) === '—', '空值/NaN 显示 —');
ok(fmtCompact(Infinity, 2) === '—' && fmtCompact(-Infinity, 2) === '—', '±Infinity 显示 —（不渲染 Infinity亿）');
ok(sanNum('', NUM_LIMITS.quote) === 0, '报价空输入按 0 计（原口径 +v||0 等价）');

console.log('\n══ 七、批次 B：tier 线型与地图搜索（format.js，change: grid-map-p1-and-ux-fixes）══');
// tier 线型：gov/grid 实线（grid 细）、region 长虚线、est 短虚线（design D5）
ok(tierStyle('gov').dash === '' && tierStyle('gov').w === 1, 'gov=实线原宽');
ok(tierStyle('grid').dash === '' && tierStyle('grid').w < 1, 'grid=实线细化（宽度系数<1）');
ok(tierStyle('region').dash === '8 5', 'region=长虚线');
ok(tierStyle('est').dash === '2 4', 'est=短虚线');
ok(tierStyle('unknown') === TIER_STYLE.gov, '未知档别回退 gov 样式');
ok(Object.keys(TIER_STYLE).join(',') === 'gov,grid,region,est', '档别集合与数据 tier 枚举一致');
// 地图搜索：名称子串匹配站点+通道，空/无命中语义
const ST7 = { S1: { n: '锦屏换流站', a: '四川凉山' }, S2: { n: '苏州换流站', a: '江苏苏州' } };
const CH7 = [ { id: 'g1', n: '锦苏直流', fn: '' }, { id: 'g2', n: '复奉直流', fn: '复奉线' } ];
ok(mapSearchHits('', ST7, CH7).stations.length === 0, '空词返回空命中');
const h7 = mapSearchHits('锦屏', ST7, CH7);
ok(h7.stations.join(',') === 'S1' && h7.channels.length === 0, '站名命中');
ok(mapSearchHits('苏州', ST7, CH7).stations.join(',') === 'S2', '站址文本参与匹配');
ok(mapSearchHits('直流', ST7, CH7).channels.join(',') === 'g1,g2', '通道名子串命中两条');
ok(mapSearchHits('复奉线', ST7, CH7).channels.join(',') === 'g2', '通道别名参与匹配');
ok(mapSearchHits('不存在', ST7, CH7).stations.length + mapSearchHits('不存在', ST7, CH7).channels.length === 0, '无命中返回空');
// 区域归属调色板（批次 B 增补）：跳过元数据键、同名区域合并、颜色固定分配
const p7 = regionPalette({ _note: '说明文本', BJ: '华北', SH: '华东', JS: '华东', GD: '南方' });
ok(Object.keys(p7).length === 3, `元数据键跳过、同名区域合并（${Object.keys(p7).join(',')}）`);
ok(Object.values(p7).every(c => /^#[0-9A-F]{6}$/i.test(c)), '颜色均为合法十六进制');
ok(regionPalette({ A: 'x', B: 'x' }).x === regionPalette({ C: 'x' }).x, '同名区域跨名单颜色稳定（返回值以区域名为键）');

console.log(`\n${fail ? '❌' : '✅'} 结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
