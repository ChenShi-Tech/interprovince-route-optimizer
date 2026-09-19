#!/usr/bin/env node
/**
 * 交互行为回归测试。
 *
 * 覆盖用户报过的两类问题：
 *   ① 切换出发地/目的地或其它选项时，固定价格参数应自动核准，不需手动再点一次；
 *   ② 手工改过的值不应被无关操作抹掉，且可一键恢复核定值。
 *
 * 关键：模拟 DOM 不会因 innerHTML 赋值而更新输入框的 value，
 * 而真实浏览器会。因此每次 renderCalc 后用 syncDom() 把渲染结果回写，
 * 否则会得出「参数没更新」的假结论。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const i = html.lastIndexOf('<script>');
const j = html.lastIndexOf('</' + 'script>');

const store = {}, dom = {};
const mk = (id) => (dom[id] ||= { id, innerHTML: '', hidden: false, style: {}, textContent: '', className: '',
  classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, value: '' });
const ctx = { console: { log() {} },
  document: { getElementById: mk, addEventListener() {},
    createElement: () => ({ click() {}, style: {}, setAttribute() {} }),
    head: { appendChild() {} }, body: mk('body'), querySelector: () => null },
  localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  Blob: function () {}, URL: { createObjectURL: () => '' }, confirm: () => false,
  setTimeout: (f) => f(), Math, JSON, Number, Object, Array, String, Date, isNaN, parseInt,
  parseFloat, Error, encodeURIComponent, isFinite, RegExp, Set, Map, location: { hostname: 'x.com' } };
ctx.window = { scrollTo() {}, open() {} };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(html.slice(i + 8, j), ctx);

const PV = vm.runInContext('PV', ctx);
const G = (e) => vm.runInContext(e, ctx);
let pass = 0, fail = 0;
const problems = [];
const ok = (c, l, d) => { if (c) { pass++; } else { fail++; problems.push(l + (d ? '（' + d + '）' : '')); } };

/** 把 renderCalc 的渲染结果回写进模拟 DOM —— 真实浏览器会自动做这件事 */
/** 测算页 + 参数弹出面板正文（参数输入框在面板里） */
const pageHtml = () => G("document.getElementById('v-calc').innerHTML") + G("document.getElementById('sheet-body').innerHTML");
function syncDom() {
  const h = pageHtml();
  for (const m of h.matchAll(/id="(i-[a-z]+)"[^>]*value="([^"]*)"/g)) mk(m[1]).value = m[2];
  for (const m of h.matchAll(/<select id="(i-[a-z]+)"[\s\S]*?<\/select>/g)) {
    const sel = m[0].match(/<option value="([^"]*)" selected/);
    if (sel) mk(m[1]).value = sel[1];
  }
}

/** 模拟浏览器触发 change，走与页面一致的处理分支 */
function change(id, val) {
  mk(id).value = val;
  const branch = id === 'i-to' ? "state.to=e.target.value;readInputs();applyToProv();"
    : id === 'i-from' ? "state.from=e.target.value;readInputs();applyFromProv();"
    : id === 'i-degrade' ? "state.degrade=+e.target.value;readInputs();"
    : "readInputs();";
  G(`(function(){const e={target:{id:${JSON.stringify(id)},value:${JSON.stringify(val)}}};${branch}state._res=solve(state, algoData());renderCalc();})();`);
  syncDom();
}

function boot(from, to) {
  G(`state.from='${from}';state.to='${to}';state.showAll=true;state.maxHops=MAX_HOPS;state.maxDetour=null;state.degrade=0.10;applyBothProv();state._res=solve(state, algoData());renderCalc();`);
  syncDom();
}

console.log('══ 一、切换受端省：自动按核定值核准（不需手动再点）══');
boot('SC', 'JS');
// 受端输配电价 / 基金输入框只在「到户已列费用」口径下渲染
G('state.includeDstCost=true;state._res=solve(state, algoData());renderCalc();'); syncDom();
for (const [code, name] of [['SX', '山西'], ['XJ', '新疆'], ['SH', '上海'], ['GX', '广西']]) {
  change('i-to', code);
  const net = G('state.pNet'), fund = G('state.fund');
  ok(net === PV[code].net && fund === PV[code].fund,
    `受端切换为${name}后自动核准`, `得到 ${net}/${fund}，应为 ${PV[code].net}/${PV[code].fund}`);
  const rendered = pageHtml();
  ok(rendered.includes(`id="i-pnet" type="number" value="${PV[code].net}"`),
    `输入框同步显示${name}的核定值 ${PV[code].net}`);
  ok(rendered.includes(name), `取值依据区显示${name}`);
}
G('state.includeDstCost=false;state._res=solve(state, algoData());renderCalc();'); syncDom();
{
  const h = pageHtml();
  ok(h.includes('id="i-dstcost"') && !h.includes('id="i-pnet"') && !h.includes('id="i-fund"'), '省间交易节点口径下不渲染受端输配电价与基金输入框');
}

console.log('══ 二、切换送端省：只更新送端，不动受端 ══');
boot('SC', 'GD');
const net0 = G('state.pNet'), fund0 = G('state.fund');
change('i-from', 'YN');
ok(G('state.pNet') === net0, '切送端后受端输配电价未被覆盖', `${G('state.pNet')} vs ${net0}`);
ok(G('state.fund') === fund0, '切送端后受端基金附加未被覆盖');
ok(G('state.pGen') === PV.YN.clear, '送端出清价已更新为云南核定值', `${G('state.pGen')} vs ${PV.YN.clear}`);

console.log('══ 三、其它选项变化即时重算 ══');
boot('SC', 'JS');
change('i-hours', '2');
ok(G('state.hours') === 2, '时段改 2h 生效');
change('i-qty', '2000');
ok(G('state.qty') === 2000, '电量改 2000MWh 生效');
const l1 = G('state._res.rows[0].landed');
change('i-bearer', '0.5');
const l2 = G('state._res.rows[0].landed');
ok(l1 !== l2, '网损承担方变化后落地价重算', `${l1} → ${l2}`);
change('i-region', '0');
ok(G('state.includeRegion') === false, '区域电网费开关生效');
change('i-degrade', '0.03');
ok(Math.abs(G('state.degrade') - 0.03) < 1e-9, '成本阈值改 3% 生效', `得到 ${G('state.degrade')}`);
{
  const h = G("document.getElementById('v-calc').innerHTML");
  ok(['i-hops', 'i-detour', 'i-pdst', 'i-date'].every((id) => !h.includes(`id="${id}"`)), '跳数、绕行、受端目标交付价、交付日期输入均已移除');
  ok(!h.includes('setSort('), '排序口径按钮已移除，固定按价格从低到高');
  ok(G('state.maxHops') === G('MAX_HOPS') && G('MAX_HOPS') === 10 && G('state.maxDetour') === null && G('state.sortBy') === 'A', '跳数固定取上限 10、绕行不限、按价格排序');
  const rows = G('state._res.rows');
  ok(rows.every((r, k) => !k || r.feasible !== rows[k - 1].feasible || r.landed >= rows[k - 1].landed - 1e-9), '路线列表按价格从低到高排列');
  // 旧存档里的跳数、绕行、目标交付价、交付日期、排序口径不得覆盖固定口径
  store['iproute.v2.last'] = JSON.stringify({ from: 'SC', to: 'JS', maxHops: 2, maxDetour: 1.5, pDst: 999, pDstManual: true, tradeDate: '2026-08-02', sortBy: 'C', _bt: 'x' });
  G('loadStored();');
  ok(G('state.maxHops') === 10 && G('state.maxDetour') === null && G('state.pDst') === undefined && G('state.sortBy') === 'A' && G('state.tradeDate') !== '2026-08-02',
    '旧存档中已下线的输入不会恢复');
  G('saveLast();');
  ok(!('tradeDate' in JSON.parse(store['iproute.v2.last'])), '交付日期不再持久化');
}

console.log('══ 四、手工覆盖受保护且可恢复 ══');
boot('SC', 'JS');
change('i-to', 'SH');
G('state.pNet=999;state._res=solve(state, algoData());renderCalc();'); syncDom();
change('i-from', 'YN');
ok(G('state.pNet') === 999, '切送端不会抹掉手工改过的受端值', `得到 ${G('state.pNet')}`);
change('i-to', 'SH');
ok(G('state.pNet') === PV.SH.net, '重选受端后回到核定值（视为重新核准）');
G('state.pNet=777;state._res=solve(state, algoData());renderCalc();');
G("resetOne('pNet');");
ok(G('state.pNet') === PV.SH.net, '「恢复核定值」按钮可还原', `得到 ${G('state.pNet')}，应为 ${PV.SH.net}`);
G('state.fund=555;state._res=solve(state, algoData());renderCalc();');
G("resetOne('fund');");
ok(G('state.fund') === PV.SH.fund, '基金附加亦可恢复', `得到 ${G('state.fund')}`);

console.log('══ 五、端点组合无路径时不崩 ══');
boot('YN', 'SX');
ok(G('state._res.err') && typeof G('state._res.err') === 'string', '无连通路径时返回错误提示而非抛异常');
const errHtml = G("document.getElementById('v-calc').innerHTML");
ok(errHtml.includes('连通路径') || errHtml.includes('放宽'), '界面显示可读提示');
ok(!!G("document.getElementById('i-to')"), '参数区仍可操作（可改回有路径的端点）');
change('i-to', 'GD');
ok(!G('state._res.err') && G('state._res.rows.length > 0'), '改回有路径的端点后恢复正常');

console.log('══ 六、受端省内费用口径开关（计入 / 只算到省界）══');
boot('SC', 'JS');
for (const [f, t] of [['SC', 'JS'], ['YN', 'GD'], ['GS', 'SD'], ['SX', 'JS']]) {
  boot(f, t);
  G('state.includeDstCost=true;state._res=solve(state, algoData());');
  const A = G('state._res.rows[0]');
  G('state.includeDstCost=false;state._res=solve(state, algoData());');
  const B = G('state._res.rows[0]');
  const expect = PV[t].net + PV[t].fund + A.comp.inLoss;   // 受端省内三项：输配电价、基金附加、上网环节线损费用
  ok(Math.abs((A.landed - B.landed) - expect) < 1e-6,
    `${PV[f].n}→${PV[t].n}：省界价 = 落地价 − 受端输配电价 − 基金附加 − 受端上网环节线损`,
    `差 ${(A.landed - B.landed).toFixed(2)}，应为 ${expect.toFixed(2)}`);
  ok(B.comp.net === 0 && B.comp.fund === 0 && B.comp.inLoss === 0, '  不计入时受端三项归零');
  ok(A.comp.send === B.comp.send && A.comp.trans === B.comp.trans && A.comp.reg === B.comp.reg,
    '  送端省内段/通道费/区域费不受影响');
  ok(A.channelOnly === B.channelOnly, '  过网费口径不受影响');
  ok(Math.abs((B.yuan.total / B.qty) - B.landed) < 1e-6, '  费用总额与单价自洽');
}
G('state.includeDstCost=false;state._res=solve(state, algoData());renderCalc();');
const hEx = G("document.getElementById('v-calc').innerHTML");
ok(hEx.includes('省界价格'), '界面标签切换为「省界价格」');
ok(hEx.includes('已按口径排除'), '费用表标注受端省内费用已排除');
ok(!hEx.includes('<td>受端省网输配电价</td>'), '费用表不再列出受端输配电价行');
G('state.includeDstCost=true;state._res=solve(state, algoData());renderCalc();');
const hIn = G("document.getElementById('v-calc').innerHTML");
ok(hIn.includes('到户已列费用小计') && hIn.includes('<td>受端省网输配电价</td>'), '切回后恢复完整落地价口径');

console.log('══ 七、行进方向、区域电网费与含线损计费口径 ══');
{
  const RGOF = G('REGION_OF'), RG = G('RG');
  const ENV = "({REGION_OF:DATA.RGOF||{},RG:DATA.RG,includeRegion:true})";
  // 本节手算公式按「区域网损不计入、送端省内网损不另计」口径核对，与界面默认值解耦
  G("state.showBad=true;state.includeRegion=true;state.includeDstCost=true;state.regionChargeMode='buyer';state.regionLossMode='exclude';state.originLossMode='included';");

  // ① 通行方向由数据逐条给定：锦苏为单向送电直流，德宝为双向互济直流
  const jsCh = G("CH.find(c=>c.n==='锦苏直流')"), db = G("CH.find(c=>c.n==='德宝直流')");
  ok(!!jsCh && jsCh.bidir === false && !!db && db.bidir === true && db.sendFeeRev != null, '锦苏直流单向、德宝直流双向且带反向送端省内段费用');
  G("state.from='JS';state.to='SC';state.maxHops=1;state.maxDetour=9;applyBothProv();state._res=solve(state, algoData());");
  const r1 = G('state._res');
  ok(!!r1.err || r1.rows.every((x) => x.edges[0].n !== '锦苏直流'), '江苏→四川 1 段以内没有反向经锦苏直流的路线');
  G("state.from='SN';state.to='SC';state._res=solve(state, algoData());");
  const r2 = G('state._res');
  const dbRow = !r2.err && r2.rows.find((x) => x.edges[0].n === '德宝直流');
  ok(!!dbRow && dbRow.segs[0].sf0 === db.sendFeeRev && db.sendFeeRev !== db.sendFee,
    `陕西→四川 反向经德宝直流，送端省内段取陕西送出省价格 ${dbRow && dbRow.segs[0].sf0}（存储方向四川为 ${db.sendFee}）`);
  // 全网核对：任何路线都不得把单向工程反向走
  let revProj = 0, rowsAll = 0;
  const keys = Object.keys(PV);
  for (const f of keys) for (const t of keys) {
    if (f === t) continue;
    G(`state.from='${f}';state.to='${t}';state.maxHops=3;state.maxDetour=2;applyBothProv();state._res=solve(state, algoData());`);
    const r = G('state._res');
    if (r.err) continue;
    for (const x of r.rows) { rowsAll++; x.edges.forEach((e, i) => { if (!e.bidir && x.nodes[i] !== e.from) revProj++; }); }
  }
  ok(rowsAll > 0 && revProj === 0, `全网 ${rowsAll} 条路线中没有反向行进的单向工程段`, revProj ? `${revProj} 段反向` : '');

  // ② 区域电网费：买方所在区域一律计一次（规则 3.4.2(a)），过境其它区域的联络线段再计一次
  const link = G("CH.find(c=>c.n==='川渝联络线')");
  ok(G(`regionRate(${ENV},'JS')`) === RG['华东'] * 1000 && G(`regionRate(${ENV},'GD')`) === 0, 'regionRate 取省所在区域电量电价，南方无核定价为 0');
  G("state.from='SC';state.to='JS';state.maxHops=1;state.maxDetour=9;applyBothProv();state._res=solve(state, algoData());");
  const r5 = G('state._res');
  const js = !r5.err && r5.rows.find((x) => x.edges[0].n === '锦苏直流');
  ok(!!js && Math.abs(js.comp.reg - RG['华东'] * 1000) < 1e-9 && js.regTransit === 0, `四川→江苏 经锦苏直流计买方区域华东电量电价 ${RG['华东'] * 1000}，无过境区域费`);
  G("state.from='NM';state.to='BJ';state.maxHops=2;applyBothProv();state._res=solve(state, algoData());");
  const r6 = G('state._res');
  const mj = !r6.err && r6.rows.find((x) => x.edges.some((e) => e.n === '京冀联络线'));
  ok(!!mj && Math.abs(mj.comp.reg - RG['华北'] * 1000) < 1e-9, `内蒙古→北京 同区域（蒙西—河北 + 京冀）只计一次华北电量电价 ${RG['华北'] * 1000}`);
  G("state.includeRegion=false;state._res=solve(state, algoData());");
  const r6b = G('state._res');
  ok(!r6b.err && r6b.rows.every((x) => x.comp.reg === 0), '不计入区域电网费时全部为 0');
  G("state.includeRegion=true;");
  // 逐条核对：区域费 = 买方区域电量电价 + Σ(过境其它区域的联络线段 × 该区域电量电价 × 段后系数)
  let bad = 0, checked = 0;
  for (const [f, t] of [['HB', 'JS'], ['SX', 'JS'], ['SC', 'JS'], ['GS', 'SD'], ['HB', 'HE'], ['CQ', 'JS'], ['SN', 'HB'], ['SC', 'HB'], ['NM', 'BJ'], ['CQ', 'SC'], ['LN', 'BJ']]) {
    G(`state.from='${f}';state.to='${t}';state.maxHops=3;state.maxDetour=2;applyBothProv();state._res=solve(state, algoData());`);
    const r = G('state._res');
    if (r.err) continue;
    for (const x of r.rows) {
      const buyer = RGOF[t];
      const exits = new Map();
      for(const s of x.segs) if(s.e.regional && RGOF[s.b] !== buyer) exits.set(RGOF[s.b],s);
      const expect = (RG[buyer] || 0) * 1000 + [...exits.values()].reduce((a,s)=>a+(RG[RGOF[s.b]]||0)*1000*s.qOut,0);
      checked++;
      if (Math.abs(x.comp.reg - expect) > 1e-6) bad++;
    }
  }
  ok(checked > 0 && bad === 0, `${checked} 条路线的区域电网费均等于买方区域 + 过境区域累加值`, bad ? `${bad} 条不符` : '');

  // ③ 联络线反向行进时按实际送端省的送出省输电价格计价
  G("state.from='CQ';state.to='SC';state.maxHops=1;state.maxDetour=9;applyBothProv();state._res=solve(state, algoData());");
  const r3 = G('state._res');
  const cs = !r3.err && r3.rows.find((x) => x.edges[0].n === '川渝联络线');
  ok(!!cs && link.tRev !== link.t && cs.segs[0].sf0 === link.tRev && cs.segs[0].t === 0,
    `重庆→四川 反向经川渝联络线，输电价取重庆送出省价格 ${cs && cs.segs[0].sf0}（存储方向四川为 ${link.t}）`);
  G("state.from='SC';state.to='CQ';state._res=solve(state, algoData());");
  const r3b = G('state._res');
  const sc = !r3b.err && r3b.rows.find((x) => x.edges[0].n === '川渝联络线');
  ok(!!sc && sc.segs[0].sf0 === link.t && sc.segs[0].t === 0, `四川→重庆 正向经川渝联络线，输电价取四川送出省价格 ${link.t}`);

  // ④ 计费口径（规则 4.3.1 / 3.3.2）：所有段输电费 = t × 段后电量；含线损段不再收网损
  G("state.from='NX';state.to='ZJ';state.maxHops=1;applyBothProv();state._res=solve(state, algoData());");
  const r4 = G('state._res');
  const ls = !r4.err && r4.rows.find((x) => x.edges[0].n === '灵绍直流');
  ok(!!ls && ls.edges[0].incLoss === true && ls.D === 1 && ls.comp.loss === 0 && Math.abs(ls.Dphys - (1 - ls.edges[0].loss / 100)) < 1e-12,
    `灵绍直流（含线损）计费线损为 0、网损折价 0，物理线损仍为 ${ls && ls.edges[0].loss}%`);
  ok(!!ls && Math.abs(ls.segs[0].fee - ls.edges[0].t) < 1e-9, '灵绍直流输电费 = t × 1（段后电量）');
  ok(!!js && js.edges[0].incLoss === false && Math.abs(js.segs[0].fee - js.edges[0].t * js.segs[0].qOut) < 1e-9 && js.segs[0].qOut === 1
    && Math.abs(js.comp.loss - js.comp.gen * G('state.lossBearer') * (1 / (1 - js.edges[0].loss / 100) - 1)) < 1e-9,
    `锦苏直流（不含线损）输电费 = t × 段后电量 = ${js && js.segs[0].fee.toFixed(2)}，网损折价按 g × (1/(1−7%)−1) 计`);
  // ⑤ 受端省内上网环节线损进落地价、送端省内线损进口径三
  ok(!!js && js.inLossPct === PV.JS.inLoss && Math.abs(js.comp.inLoss - js.border * (js.inLossPct / 100) / (1 - js.inLossPct / 100)) < 1e-9,
    `受端江苏上网环节线损率 ${PV.JS.inLoss}% 计入落地价 ${js && js.comp.inLoss.toFixed(2)} 元/MWh`);
  ok(!!js && js.exportLossPct === PV.SC.exportLoss && js.cExportLoss > 0, `送端四川送省外线损率 ${PV.SC.exportLoss}% 计入卖方成本 ${js && js.cExportLoss.toFixed(2)} 元/MWh`);
  G("state.from='SC';state.to='JS';state.maxHops=1;applyBothProv();state.includeDstCost=false;state._res=solve(state, algoData());");
  const r7 = G('state._res');
  const js2 = !r7.err && r7.rows.find((x) => x.edges[0].n === '锦苏直流');
  ok(!!js2 && js2.comp.inLoss === 0 && Math.abs(js2.landed - js.border) < 1e-9, '只算到省界时不计受端上网环节线损，落地价 = 省界价');
  G("state.includeDstCost=true;");
  ok(!!js && Math.abs(js.yuan.total / js.consumerQty - js.landed) < 1e-6, '费用总额 ÷ 终端电量 = 到户单价（改口径后仍自洽）');
  // ⑥ 容量制工程：辛洹线边际 0，云霄取输电权报价下限
  const xh = G("CH.find(c=>c.n==='辛洹线')"), yx = G("CH.find(c=>c.n==='云霄直流')");
  ok(!!xh && xh.t === 0 && !!yx && yx.t === 25.6 && xh.bidir && yx.bidir, '辛洹线 t=0、云霄直流 t=25.6（输电权报价下限），均为双向');
}

console.log('══ 八、智能推荐：只在可行路线里选、密钥缺失即提示、结果随测算失效 ══');
{
  G("state.from='SC';state.to='SH';state.maxHops=6;state.maxDetour=9;state.showBad=true;state.sel=0;applyBothProv();state._res=solve(state, algoData());state._ai=null;renderCalc();");
  const h0 = G("document.getElementById('v-calc').innerHTML");
  ok(G('AI_ENABLED') === false && !h0.includes('id="i-ai-prompt"') && !h0.includes('class="col-ai"') && h0.includes('class="layout no-ai"'), '智能推荐卡片暂时隐藏，布局退为两列');
  const card0 = G('renderAI(state._res)');
  ok(card0.includes('智能推荐') && card0.includes('id="i-ai-prompt"') && card0.includes('让模型推荐'), '推荐卡片渲染逻辑保留（改回 AI_ENABLED 即恢复）');
  const res = G('state._res');
  const feasible = res.rows.filter((r) => r.feasible).length;
  const digest = G('aiRouteDigest(state._res)');
  ok(digest.total === feasible && digest.sent === Math.min(feasible, 40) && digest.routes.every((r) => res.rows[r.id - 1].feasible),
    `送给模型的候选只含可行路线（可行 ${feasible} 条，送入 ${digest.sent} 条，id 与列表序号一致）`);
  ok(digest.routes.every((r) => Math.abs(r['落地成本_元每MWh'] - res.rows[r.id - 1].landed) < 0.051), '候选摘要里的落地成本与测算结果一致');
  const msgs = G('aiBuildMessages(state._res)');
  ok(msgs.length === 2 && /JSON/.test(msgs[0].content) && msgs[1].content.includes('"id":1') && msgs[1].content.includes(PV.SC.n) && msgs[1].content.includes(PV.SH.n),
    '提示词含 JSON 输出要求、候选表与送受端');
  // 密钥缺失
  G("aiState.key='';aiState.base='https://api.deepseek.com';aiState.model='deepseek-chat';");
  await G('aiRun()');
  ok(/API Key/.test(G('state._ai.error') || ''), '未填密钥时给出提示而不发请求');
  // 模拟接口：记录请求，返回一条有效 id、一条无效 id、一条越限 id
  const badIdx = res.rows.findIndex((r) => !r.feasible);
  const calls = [];
  ctx.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const body = { recommendations: [{ id: 2, rank: 1, reason: '线损更低' }, { id: 999, rank: 2, reason: '不存在' }, ...(badIdx >= 0 ? [{ id: badIdx + 1, rank: 3, reason: '越限的' }] : [])],
      summary: '总体判断', caveats: '请核实' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '```json\n' + JSON.stringify(body) + '\n```' } }], usage: { total_tokens: 1 } }) };
  };
  G("aiState.key='sk-test';aiState.prompt='优先线损低';");
  await G('aiRun()');
  const ai = G('state._ai');
  ok(calls.length === 1 && calls[0].url === 'https://api.deepseek.com/chat/completions', '请求发到 接口地址 + /chat/completions');
  const req = calls.length ? JSON.parse(calls[0].opts.body) : {};
  ok(calls.length && calls[0].opts.headers.Authorization === 'Bearer sk-test' && req.model === 'deepseek-chat' && req.response_format && req.response_format.type === 'json_object',
    '请求带 Bearer 密钥、模型名与 JSON 输出格式');
  ok(req.messages && req.messages[1].content.includes('优先线损低'), '用户写的考虑因素进入提示词');
  ok(ai && ai.result && ai.result.recs.length === 1 && ai.result.recs[0].idx === 1 && ai.result.recs[0].reason === '线损更低',
    `无效 id 与越限路线被剔除，只保留可行候选（保留 ${ai && ai.result ? ai.result.recs.length : 0} 条）`);
  ok(ai && ai.result && ai.result.summary === '总体判断' && ai.result.caveats === '请核实', '围栏包裹的 JSON 也能解析，summary / caveats 原样保留');
  const h1 = G('renderAI(state._res)');
  ok(h1.includes('推荐 1') && h1.includes('线损更低') && h1.includes('onclick="pick(1)"'), '推荐结果渲染为可点击的路线卡片');
  // 参数变化后旧推荐不再显示
  G("state.to='JS';applyBothProv();state._res=solve(state, algoData());renderCalc();");
  const h2 = G('renderAI(state._res)');
  ok(!h2.includes('推荐 1') && h2.includes('智能推荐'), '重新测算后旧推荐结果失效，卡片仍在');
  // 接口报错
  ctx.fetch = async () => ({ ok: false, status: 401, text: async () => 'invalid key' });
  await G('aiRun()');
  ok(/401/.test(G('state._ai.error') || ''), '接口报错时把状态码显示给用户');
  delete ctx.fetch;
}

console.log('══ 九、通道组件：把直流作为组件来筛方案 ══');
{
  G("state.from='SC';state.to='SH';state.maxHops=6;state.maxDetour=9;state.showBad=true;state.mustHave=[];state.sel=0;applyBothProv();state._res=solve(state, algoData());renderCalc();");
  const base = G('state._res');
  const av = base.availChannels || [];
  ok(av.length > 0, `候选里共 ${av.length} 个通道组件可选`);
  ok(av.every((c) => c.id && c.n && typeof c.count === 'number'), '每个组件都带 id / 名称 / 出现次数');
  const firstAc = av.findIndex((c) => c.type !== 'DC' && c.type !== 'AC/DC');
  ok(av.slice(0, firstAc < 0 ? av.length : firstAc).every((c) => c.type === 'DC' || c.type === 'AC/DC'),
    '直流（专项工程）组件排在交流联络线之前');

  const dc = av.find((c) => c.type === 'DC');
  G(`state.mustHave=['${dc.id}'];state._res=solve(state, algoData());`);
  const r1 = G('state._res');
  ok(r1.rows.length > 0 && r1.rows.every((r) => r.edges.some((e) => e.id === dc.id)),
    `选中「${dc.n}」后 ${r1.rows.length} 条方案全部包含该通道`);
  ok((r1.availChannels || []).length === av.length, '筛选后组件清单仍是完整候选集（其余组件仍可点选、取消）');
  ok(r1.totalAll === base.totalAll && r1.mustHave.length === 1, '区分「筛出条数」与「全量候选条数」');

  const second = av.find((c) => c.id !== dc.id);
  G(`state.mustHave=['${dc.id}','${second.id}'];state._res=solve(state, algoData());`);
  const r2 = G('state._res');
  ok(r2.err ? true : r2.rows.every((r) => [dc.id, second.id].every((id) => r.edges.some((e) => e.id === id))),
    `两个组件同时选中时按「全部包含」筛选（${r2.err ? '无匹配并给出提示' : r2.rows.length + ' 条'}）`);

  // 失效 id（旧存档里的组件在新数据里已不存在）应被忽略，而不是筛成空
  G(`state.mustHave=['__nope__','${dc.id}'];state._res=solve(state, algoData());`);
  const r4 = G('state._res');
  ok(!r4.err && r4.mustHave.length === 1 && r4.rows.every((r) => r.edges.some((e) => e.id === dc.id)),
    '存档里失效的组件 id 被忽略，不影响筛选结果');

  // 全选必然无解：一条路径不可能包含所有通道 —— 检查空结果时是否仍能操作组件
  const allIds = av.map((c) => c.id);
  G(`state.mustHave=${JSON.stringify(allIds)};state._res=solve(state, algoData());renderCalc();`);
  const r3 = G('state._res');
  ok(!!r3.err && r3.availChannels && r3.availChannels.length > 0, '组件组合筛空时给出提示，仍返回组件清单');
  const h3 = G("document.getElementById('v-calc').innerHTML");
  ok(h3.includes('id="i-chan"') && h3.includes('全部通道（不限）'), '筛空时界面仍渲染通道下拉（可选「全部通道」取消），用户不会被困住');

  // 界面为单选下拉：多选存档收敛为一条；换省对后不在候选里的通道自动取消
  G(`state.mustHave=['${dc.id}','${second.id}'];state._res=solveState();`);
  ok(G('state.mustHave.length') === 1 && G('state.mustHave[0]') === dc.id, '界面只保留一条已选通道（单选）');
  G('state.mustHave=[];state._res=solveState();renderCalc();');
  const h2 = G("document.getElementById('v-calc').innerHTML");
  const selHtml = (h2.match(/<select id="i-chan"[\s\S]*?<\/select>/) || [''])[0];
  ok(selHtml.includes('<optgroup label="直流 / 专项工程') && selHtml.includes('<option value="" selected>全部通道（不限）'), '测算页顶部渲染通道下拉，直流分组在前，默认不限');
  ok(!h2.includes('toggleComp(') && !h2.includes('class="comp-box"'), '通道 chip 选择器已移除');
  const best = G('channelBest(state._res)');
  const dcOpts = [...selHtml.split('<optgroup label="交流')[0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  ok(dcOpts.length > 1 && dcOpts.every((id, k) => !k || (best[id] ?? Infinity) >= (best[dcOpts[k - 1]] ?? Infinity)), `直流通道按经过它的最低价升序（${dcOpts.length} 条）`);
  const rowsAll = G('state._res.rows');
  // 专项工程 / 直流的最低价与合并后的方案列表一致；区域网架内联络线的方案可能已被合并，最低价只会更低或相等
  const minOf = (id) => Math.min(...rowsAll.filter((r) => r.feasible && r.edges.some((e) => e.id === id)).map((r) => r.landed));
  const chMap = Object.fromEntries((G('state._res.availChannels') || []).map((c) => [c.id, c]));
  ok(Object.entries(best).every(([id, p]) => { const m = minOf(id); return chMap[id] && chMap[id].type === 'DC' ? Math.abs(p - m) < 1e-9 : (m === Infinity || p <= m + 1e-9); }), '下拉标注的通道最低价与方案列表一致');
  ok(h2.includes('<details class="explain"><summary>候选与可行的定义'), '可选路线的口径说明默认折叠');
  ok(h2.includes('<details class="explain"><summary>政策与取值依据</summary>'), '政策与取值依据默认折叠');
  ok(h2.lastIndexOf('政策与取值依据') > h2.lastIndexOf('class="layout'), '政策与取值依据位于整页最下方');
  ok(!h2.includes('market-entries') && !h2.includes('省间现货 · 待拓展'), '中长期 / 现货入口按钮已移除');
  // 选择通道：重算并带上筛选条件；已选时最低价仍按全量候选计算
  G(`state.mustHave=['${dc.id}'];state.sel=0;state._res=solveState();renderCalc();`);
  ok(G('state._res.mustHave.length') === 1 && G('state._res.rows').every((r) => r.edges.some((e) => e.id === dc.id)), '选定通道后只列出经过它的方案');
  ok(JSON.stringify(G('channelBest(state._res)')) === JSON.stringify(best), '选定通道后各通道最低价不变（按全量候选）');
  ok(/<select id="i-chan" class="on">/.test(G("document.getElementById('v-calc').innerHTML")), '已选通道时下拉高亮');
  G('state.mustHave=[];state._res=solveState();');
  ok(G('state._res.mustHave.length') === 0, '选回「全部通道」后恢复全量候选');
  // 换省对：已选通道不在新候选里时自动取消
  G(`state.mustHave=['${dc.id}'];state.from='GS';state.to='HN';applyBothProv();state._res=solveState();`);
  const inGsHn = (G('state._res.availChannels') || []).some((c) => c.id === dc.id);
  ok(inGsHn ? G('state.mustHave.length') === 1 : (G('state.mustHave.length') === 0 && !G('state._res.err')), '换省对后已选通道不可用时自动取消，不会筛成空结果');
  G("state.mustHave=[];state.from='SC';state.to='SH';applyBothProv();state._res=solveState();");
}

console.log('══ 十、顶部结果、价格组成、区域落点与说明折叠 ══');
{
  G("state.from='XJ';state.to='SH';state.mustHave=[];state.showBad=false;state.showAll=false;state.sel=0;state.includeDstCost=false;state.includeRegion=true;state.regionChargeMode='network';applyBothProv();state._res=solve(state, algoData());renderCalc();");
  const res = G('state._res'), r = res.rows[0];
  const h = G("document.getElementById('v-calc').innerHTML");
  // ① 送端报价是主输入，结果在页面最上方
  const iPgen = h.indexOf('id="i-pgen"'), iHero = h.indexOf('class="hero-res'), iList = h.indexOf('class="col-side"');
  ok(iPgen > 0 && iHero > iPgen && iList > iHero && h.includes('class="hero-price"'), '送端报价大输入框与测算结果位于路线列表之前');
  // FR-1（PRD-体验问题修复-20260918）：大字走 fmtCompact 缩略，完整值放 title 悬浮
  const hero = h.match(/<div class="hero-v" title="完整值 ([^"]+) 元\/MWh">([^<]*)<small>/);
  ok(hero && hero[1] === r.landed.toFixed(2) && hero[2] === G('fmtCompact(state._res.rows[0].landed,2)'),
    `顶部显示最低价 ${r.landed.toFixed(2)} 元/MWh`, hero ? `title ${hero[1]}，正文 ${hero[2]}` : '未找到 hero-v');
  // ② 价格组成：各项之和等于最终价格
  const items = G('priceItems(state._res.rows[0])');
  ok(Math.abs(items.reduce((a, x) => a + x.v, 0) - r.landed) < 1e-6, `价格组成 ${items.length} 项之和等于最终价格`);
  ok(items[0].k === 'gen' && items.every((x) => x.k === 'gen' || Math.abs(x.v) > 1e-9), '送端报价恒列首位，零值项不列');
  ok(h.includes('class="cmp-item tot"') && items.every((x) => h.includes(x.label)), '顶部价格组成逐项列出并给出合计');
  let bad = 0, n = 0;
  for (const [f, t] of [['SC', 'JS'], ['NX', 'ZJ'], ['GS', 'HN'], ['SX', 'JS']]) for (const dst of [false, true]) {
    G(`state.from='${f}';state.to='${t}';state.includeDstCost=${dst};applyBothProv();state._res=solve(state, algoData());`);
    for (const row of G('state._res.rows')) { n++; if (Math.abs(G('priceItems')(row).reduce((a, x) => a + x.v, 0) - row.landed) > 1e-6) bad++; }
  }
  ok(n > 0 && bad === 0, `${n} 条路线（两种费用边界）价格组成均闭合`, bad ? `${bad} 条不闭合` : '');
  // ③ 区域共用网络只写区域与物理落点（锁定吉泉直流方案：新疆 → 安徽落点 → 华东区域网架 → 上海）
  G("state.from='XJ';state.to='SH';state.includeDstCost=false;applyBothProv();state.mustHave=[CH.find(c=>c.n==='吉泉直流').id];state.sel=0;state._res=solveState();renderCalc();");
  const r0 = G('state._res.rows[0]');
  ok(r0.edges[0].n === '吉泉直流' && G("routeDisplayBlocks(state._res.rows[0]).length") === 2, '锁定吉泉直流：吉泉直流 + 华东区域网架', r0.nodes.join('>'));
  const stops = G('routeStops(state._res.rows[0])');
  ok(stops.map((x) => x.name).join('>') === '新疆>华东区域' && stops[1].landing === '安徽', '路线显示为「新疆 → 华东区域」、落点安徽', JSON.stringify(stops));
  const h3 = G("document.getElementById('v-calc').innerHTML");
  const head = (h3.match(/<div class="hd-route">([\s\S]*?)<\/div>/) || [])[1] || '';
  ok(head.includes('新疆') && head.includes('华东区域') && !head.includes('江苏') && !head.includes('安徽'), '方案标题不列区域内经过的省份');
  ok(/<div class="hd-landing">落点 <b>安徽<\/b>/.test(h3), '方案标题下注明落点安徽');
  ok(G('routeVia(state._res.rows[0])') === '经华东区域（落点安徽）', '路线卡片摘要只写区域与落点');
  ok(G('routeLead(state._res.rows[0])') === '吉泉直流', '路线卡片标题为核心通道');
  // 同一区域经背靠背衔接时合并；多区域时逐个保留落点
  G("state.from='SC';state.to='JS';applyBothProv();state._res=solve(state, algoData());");
  const cross = G("state._res.rows.find(x=>x.nodes.join('>')==='SC>CQ>HB>HA>HE>SX>JS')");
  const multi = cross ? G('routeStops')(cross) : [];
  ok(!cross || multi.map((x) => x.name + (x.landing ? '@' + x.landing : '')).join('>') === '四川>华中区域>华北区域@河北>江苏',
    '四川→江苏 跨区路线：华中区域内经渝鄂背靠背合并，华北区域注明落点河北', multi.map((x) => x.name + (x.landing ? '@' + x.landing : '')).join('>'));
  G("state.from='XJ';state.to='SH';applyBothProv();state.mustHave=[CH.find(c=>c.n==='吉泉直流').id];state._res=solveState();state.sel=0;renderCalc();");
  // ④ 解释说明文字全部折叠：去掉 <details> 后不得残留说明段落
  let vis = h3; let prev;
  do { prev = vis; vis = vis.replace(/<details[^>]*>(?:(?!<details)[\s\S])*?<\/details>/g, ''); } while (vis !== prev);
  ok(!/class="(note|comp-tip|route-explainer|region-rule|region-members)"/.test(vis), '测算页可见区域不含未折叠的说明文字',
    (vis.match(/class="(note|comp-tip|route-explainer|region-rule|region-members)"[^<]*<?[^<]*/g) || []).slice(0, 3).join(' | '));
  ok(!/<details class="warn" open>/.test(h3), '适用条件与缺项默认折叠');
  // ⑤ 选项文字精简
  const sheet3 = G("document.getElementById('sheet-body').innerHTML");
  ok(sheet3.includes('>不含省内输电费<') && sheet3.includes('>含省内费用<') && sheet3.includes('>途经区域各计一次<') && sheet3.includes('>另计受端区域<'), '送端报价边界与区域费范围选项已精简');
  // ⑥ 敏感性扫描改为展开时计算
  ok(/<details class="adv boxed" id="d-sens" ontoggle="[^"]*fillSensitivity/.test(h3) && !h3.includes('最优切换'), '价差敏感性默认不计算，展开时再填充');
  const sens = G('sensitivityTable()');
  ok(sens.includes('<table>') && (sens.match(/<tr/g) || []).length === 37, '敏感性扫描表 36 档');
}

console.log('══ 十一、参数弹出面板：主卡摘要、即时重算、恢复默认 ══');
{
  G("state.from='XJ';state.to='SH';state.mustHave=[];state.sel=0;Object.assign(state,PARAM_DEFAULTS);applyBothProv();state._res=solveState();renderCalc();"); syncDom();
  const v = G("document.getElementById('v-calc').innerHTML"), sh = G("document.getElementById('sheet-body').innerHTML");
  const ids = ['i-dstcost', 'i-sourcequote', 'i-originloss', 'i-region', 'i-regioncharge', 'i-regionloss', 'i-bearer', 'i-tradable', 'i-zyocc'];
  ok(ids.every((id) => sh.includes(`id="${id}"`)) && ids.every((id) => !v.includes(`id="${id}"`)), '全部参数移入弹出面板，测算页主屏不再铺开参数');
  ok(v.includes('id="btn-params"') && v.indexOf('class="cfg-bar"') < v.indexOf('class="cmp"') && v.indexOf('class="cfg-bar"') > v.indexOf('class="hero-res'), '主卡在结果下方给出口径摘要与「参数」按钮');
  ok(!/id="btn-params"[^>]*>[\s\S]*?<b>\d+<\/b><\/button>/.test(v) && !v.includes('<span class="chg">'), '默认参数时摘要不标色、按钮无角标');
  ok(v.includes('费用边界 省间交易节点') && v.includes('报价边界 不含省内输电费'), '摘要恒显示费用边界与报价边界');
  const r0 = G('state._res.rows[0]');
  ok(G("document.getElementById('sheet-price').innerHTML").startsWith(r0.landed.toFixed(2)), '面板顶部实时显示当前价格');
  // 面板里改参数：沿用 change 分支即时重算，主卡摘要标色计数
  change('i-bearer', '0.5');
  change('i-regionloss', 'exclude');
  const v2 = G("document.getElementById('v-calc').innerHTML");
  ok(G('state.lossBearer') === 0.5 && G('state.regionLossMode') === 'exclude', '面板内修改参数后状态更新');
  ok(G('state._res.rows[0].landed') !== r0.landed && G("document.getElementById('sheet-price').innerHTML").startsWith(G('state._res.rows[0].landed').toFixed(2)), '修改后即时重算，面板价格同步');
  ok((v2.match(/<span class="chg">/g) || []).length === 2 && /<b>2<\/b><\/button>/.test(v2) && v2.includes('网损承担 两端各半') && v2.includes('区域网损 不计入'), '改动项在摘要中标色，按钮角标为 2');
  // 打开 / 关闭
  G('openParams()');
  ok(G('_sheetOpen') === true, '点「参数」打开面板');
  G('closeParams()');
  ok(G('_sheetOpen') === false, '点「完成」/ 遮罩 / Esc 关闭面板');
  // 恢复默认：参数回默认，受端核定值还原，省份与报价不动
  G("state.includeDstCost=true;state.pNet=1;state.pGen=333;state.pGenManual=true;state.tradableOnly=true;state.occPct=30;state._res=solveState();renderCalc();");
  G('resetParams()');
  // dstMix 是数组：重置后须为**新**空数组（值相等但不得与 PARAM_DEFAULTS 同引用，否则 push 会污染默认值）
  ok(Object.entries(G('PARAM_DEFAULTS')).every(([k, val]) => k === 'dstMix'
    ? (Array.isArray(val) && val.length === 0 && Array.isArray(G('state')[k]) && G('state')[k] !== val)
    : G('state')[k] === val), '恢复默认后参数全部回到默认值（dstMix 为新空数组，引用不共享）');
  ok(G('state.pNet') === PV.SH.net && G('state.pGen') === 333 && G('state.from') === 'XJ' && G('state.to') === 'SH', '恢复默认不改省份与送端报价，受端输配电价回到核定值');
  const v3 = G("document.getElementById('v-calc').innerHTML");
  ok(!v3.includes('<span class="chg">') && v3.indexOf('id="d-capfee"') > v3.indexOf('class="layout'), '恢复后摘要不再标色；容量电费测算位于方案之后');
  G('state.pGenManual=false;applyBothProv();');
}

console.log('══ 十二、网损默认口径与方案 / 区域卡片 ══');
{
  ok(G('PARAM_DEFAULTS.originLossMode') === 'separate' && G('PARAM_DEFAULTS.regionLossMode') === 'historical', '默认送端省内网损另计、区域网损计入第三周期参考值');
  // 旧存档（无默认口径版本号）里的网损选项按新默认重置一次；新存档保留用户选择
  store['iproute.v2.last'] = JSON.stringify({ from: 'XJ', to: 'SH', originLossMode: 'included', regionLossMode: 'exclude', _bt: 'x' });
  G('loadStored();');
  ok(G('state.originLossMode') === 'separate' && G('state.regionLossMode') === 'historical', '旧存档的网损选项按新默认重置');
  store['iproute.v2.last'] = JSON.stringify({ from: 'XJ', to: 'SH', originLossMode: 'included', regionLossMode: 'exclude', _bt: 'x', _pdv: G('PARAM_DEFAULTS_VER') });
  G('loadStored();');
  ok(G('state.originLossMode') === 'included' && G('state.regionLossMode') === 'exclude', '带当前版本号的存档保留用户选择');
  G("Object.assign(state,PARAM_DEFAULTS);state.from='XJ';state.to='SH';state.mustHave=[];state.sel=0;state.showBad=false;applyBothProv();state._res=solveState();renderCalc();");
  // 默认口径下四川→江苏最低价回到锦苏直流（区域网损计入后绕行路线不再更便宜）
  G("state.from='SC';state.to='JS';applyBothProv();state._res=solveState();");
  ok(G("state._res.rows[0].edges.map(e=>e.n).join('+')") === '锦苏直流', '默认口径下四川→江苏最低价为锦苏直流直达', G("state._res.rows[0].edges.map(e=>e.n).join('+')"));
  // 锁定吉泉直流方案检查卡片（全网补录后新疆→上海最优为经西北网架的灵绍直流）
  G("state.from='XJ';state.to='SH';applyBothProv();state.mustHave=[CH.find(c=>c.n==='吉泉直流').id];state._res=solveState();renderCalc();");
  const h = G("document.getElementById('v-calc').innerHTML"), r = G('state._res.rows[0]');
  const plan = (h.match(/<div class="card plan">[\s\S]*?<div class="plan-actions">/) || [''])[0];
  ok(/<div class="plan-price"><b>[\d.]+<\/b>/.test(plan) && plan.indexOf('class="plan-price"') > plan.indexOf('class="hd-route"'), '方案价格放大并排在路线之后');
  const tips = [...plan.matchAll(/<i tabindex="0" style="[^"]*" data-tip="([^"]+)"><\/i>/g)].map((m) => m[1]);
  ok(tips.length === G('priceItems(state._res.rows[0]).length') && tips[0].startsWith('送端报价 '), `价格组成条 ${tips.length} 段，悬停显示分项名称与金额`);
  ok(!plan.includes('皖苏联络线') && !plan.includes('苏沪联络线') && !plan.includes('交流联络线'), '方案卡片不再列出或告警区域网架内的联络线');
  ok(plan.includes('<span class="chip">2 段</span>'), '段数按方案自有通道与区域网架计（吉泉直流 + 华东区域网架 = 2 段）');
  ok(/<span class="rl-cmp" id="region-comparison"[^>]*>区域网损<span class="">不计 <b>[\d.]+<\/b><\/span><span class="on">第三周期 <b>[\d.]+<\/b>/.test(plan), '区域网损对照压成一行并标出当前情景');
  const tl = (h.match(/<div class="card route-timeline">[\s\S]*?<details class="adv boxed" id="d-detail">/) || [''])[0];
  ok(tl.includes('<strong>华东区域网架</strong>') && !h.includes('交流网架'), '区域卡片写「华东区域网架」');
  ok(!tl.includes('皖苏联络线') && !tl.includes('苏沪联络线') && !tl.includes('region-interfaces'), '区域卡片不再展开区域内联络线');
  ok(h.includes('区域网架参考接口，不单独计费'), '区域内联络线仅保留在完整明细逐段溯源中并标注');
  // 标题正文保持简化；FR-3 起标题后可跟一句灰字说明（如容量电费测算「算一笔容量电费的独立小工具」）
  const summaryOf = (t) => new RegExp(`<summary>${t}(<span[^>]*>[^<]*</span>)?</summary>`);
  ok(['完整明细', '价差敏感性', '容量电费测算', '政策与取值依据'].every((t) => summaryOf(t).test(h)), '底部折叠标题已简化');
  ok(G("document.getElementById('sheet-body').innerHTML").includes('<option value="separate" selected>另计</option><option value="included" >不另计</option>'), '送端省内网损选项为「另计 / 不另计」');
  G('state.mustHave=[];state._res=solveState();');
}

console.log('══ 十三、选到无可行方案的通道后可回退 ══');
{
  // 找一条「候选里有、但经过它的方案全部越限」的通道
  let dead = null;
  for (const qty of [1000, 3000, 6000, 9000]) {
    G(`Object.assign(state,PARAM_DEFAULTS);state.from='XJ';state.to='SH';state.mustHave=[];state.sel=0;state.showBad=false;state.qty=${qty};applyBothProv();state._res=solveState();`);
    if (G('state._res.err')) continue;
    const best = G('channelBest(state._res)');
    dead = (G('state._res.availChannels') || []).find((c) => best[c.id] == null);
    if (dead) break;
  }
  ok(!!dead, `存在经过它的方案全部越限的通道（${dead ? dead.n : '无'}）`);
  if (dead) {
    G(`state.mustHave=['${dead.id}'];state.sel=0;state._res=solveState();renderCalc();`);
    const res = G('state._res'), h = G("document.getElementById('v-calc').innerHTML");
    ok(!!res.err && res.allInfeasible === true && (res.availChannels || []).length > 0 && res.mustHave.length === 1, '全部越限时仍返回通道清单与筛选条件');
    ok(h.includes('id="i-chan"') && h.includes(`<option value="${dead.id}" selected>`), '顶部通道下拉仍在并保持选中，可改选');
    ok(h.includes('onclick="clearChannel()"') && h.includes('显示越限方案</button>'), '错误卡给出「取消通道筛选」与「显示越限方案」');
    G('clearChannel()');
    ok(G('state.mustHave.length') === 0 && !G('state._res.err'), '取消通道筛选后恢复正常结果');
    G(`state.mustHave=['${dead.id}'];state._res=solveState();state.showBad=true;state.sel=0;state._res=solveState();`);
    ok(!G('state._res.err') && G('state._res.rows.length') > 0, '改看越限方案后可见该通道的方案');
    G('state.mustHave=[];state.showBad=false;state.qty=1000;state._res=solveState();');
  }
}

console.log('══ 十四、受端到户：电网主体 × 电压档 × 计价方式，容需量与系统运行费，送端专属送出价 ══');
{
  const VT = G('DATA.VT'), SRCX = G('DATA.SRCX');
  {
    // VT 的省集合必须与省级参数（PV）一致：2026-09-17 海南补录、2026-09-18 D1 复核后为 31 省。
    // 不写死人数快照，改为集合相等并逐省列出缺项，下次补省不会再让断言过期、也不会漏检。
    const vtKeys = Object.keys(VT || {}).filter((k) => k[0] !== '_');
    const pvKeys = Object.keys(G('PV'));
    const miss = pvKeys.filter((k) => !vtKeys.includes(k));
    const extra = vtKeys.filter((k) => !pvKeys.includes(k));
    ok(VT && miss.length === 0 && extra.length === 0 && SRCX,
      `构建载荷含受端分电压输配电价（${vtKeys.length} 省，与省级参数省份集合一致）与送端电站专属送出价`,
      `字段 VT：缺 ${miss.join(',') || '无'}；多出 ${extra.join(',') || '无'}`);
  }
  const inp = () => G('solveInput()');
  G("Object.assign(state,PARAM_DEFAULTS);state.from='SX';state.to='HE';state.mustHave=[];state.sel=0;state.showBad=true;state.includeDstCost=true;state.pGenManual=false;applyBothProv();state._res=solveState();renderCalc();"); syncDom();
  // 默认：河北南网 · 220千伏及以上 · 两部制 = 原默认输配电价
  ok(G('state.pNet') === G('PV.HE.net') && G('dstTariff().tier.档别') === '220千伏及以上' && G('dstTariff().billing') === 'twopart', '默认主体、最高电压档、两部制，输配电价与原口径一致');
  const base = G('state._res.rows[0]');
  ok(inp().dstInLossPct === G('PV.HE.inLoss') && inp().dstBilling === 'twopart', '默认主体线损率与省默认一致');
  const sheet0 = G("document.getElementById('sheet-body').innerHTML"), v0 = G("document.getElementById('v-calc').innerHTML");
  ok(sheet0.includes('id="i-dstentity"') && sheet0.includes('>冀北电网<') && sheet0.includes('id="i-dsttier"') && sheet0.includes('id="i-dstbilling"') && sheet0.includes('id="i-dstsysop"'), '参数面板渲染主体 / 电压档 / 计价方式 / 系统运行费');
  ok(v0.includes('class="cfg-warn"') && v0.includes('两部制未含容量/需量电费'), '两部制未计容需量电费时主卡醒目提示');
  ok(G('state._res.rows[0].pricingIssues').some((x) => x.includes('未含容量/需量电费')) && G('state._res.rows[0].pricingIssues').some((x) => x.includes('系统运行费未计入')), '适用条件提示两部制缺项与系统运行费缺项');
  // 切到冀北：输配电价与注3 线损率随主体变化
  // 与 boot.js 的 i-dstentity / i-dsttier / i-dstbilling 分支一致：先读其余输入，再按所选档带入输配电价；渲染后回写模拟 DOM
  const pick = (patch) => { G(`readInputs();Object.assign(state,${JSON.stringify(patch)});${'dstEntity' in patch ? 'state.pNetManual=false;' : ''}{const vt=dstTariff();state.dstBilling=vt.billing;if(vt.net!=null)state.pNet=vt.net;}state.sel=0;state._res=solveState();renderCalc();`); syncDom(); };
  pick({ dstEntity: 'HE_JB', dstTier: null });
  const jb = VT.HE.主体.find((e) => e.id === 'HE_JB');
  ok(G('state.pNet') === jb.档位.at(-1).两部制 && inp().dstInLossPct === jb.省内上网环节线损率, `冀北：输配电价 ${jb.档位.at(-1).两部制}、线损率 ${jb.省内上网环节线损率}%`);
  // 10kV 两部制 → 单一制
  pick({ dstEntity: 'HE', dstTier: '1~10（20）千伏', dstBilling: 'twopart' });
  const t10 = VT.HE.主体[0].档位.find((t) => t.档别 === '1~10（20）千伏');
  ok(G('state.pNet') === t10.两部制, `河北 10kV 两部制 ${t10.两部制}`);
  const r10 = G('state._res.rows[0]');
  ok(Math.abs((r10.landed - base.landed) - (t10.两部制 - VT.HE.主体[0].档位.at(-1).两部制)) < 1e-6, '换电压档只改变输配电价项，到户价差等于电价差');
  pick({ dstBilling: 'single' });
  ok(G('state.pNet') === t10.单一制 && !G("document.getElementById('v-calc').innerHTML").includes('class="cfg-warn"'), `单一制 ${t10.单一制}，不再提示容需量缺项`);
  // 两部制 + 按需量分摊，负荷率 60%
  pick({ dstBilling: 'twopart', dstCapMode: 'demand', dstLoadFactor: 60 });
  const capExp = t10.需量电价 * 12 / (8.76 * 0.6);
  const rc = G('state._res.rows[0]');
  ok(Math.abs(rc.comp.cap - capExp) < 1e-9 && Math.abs(rc.landed - r10.landed - capExp) < 1e-6, `需量 ${t10.需量电价} 元/kW·月、负荷率 60% → ${capExp.toFixed(2)} 元/MWh 计入到户价`);
  ok(!G("document.getElementById('v-calc').innerHTML").includes('class="cfg-warn"') && G('priceItems(state._res.rows[0])').some((x) => x.k === 'cap'), '计入容需量电费后提示消失，价格组成含该项');
  ok(Math.abs(rc.yuan.total / rc.amountQty - rc.landed) < 1e-6, '金额与单价闭合（含新增两项）');
  // 系统运行费手填
  pick({ dstSysOpFee: 12.5 });
  const rs = G('state._res.rows[0]');
  ok(Math.abs(rs.comp.sysOp - 12.5) < 1e-12 && Math.abs(rs.landed - rc.landed - 12.5) < 1e-6 && !rs.pricingIssues.some((x) => x.includes('系统运行费未计入')), '系统运行费手填计入，缺项提示消失');
  // 省界口径下两项不计
  G('state.includeDstCost=false;state._res=solveState();');
  ok(G('state._res.rows[0].comp.cap') === 0 && G('state._res.rows[0].comp.sysOp') === 0, '省间交易节点口径不计容需量与系统运行费');
  // 换受端省：主体 / 档别回到默认
  G("state.includeDstCost=true;state.dstEntity='HE_JB';state.dstTier='35千伏';state.to='JS';state.dstEntity=null;state.dstTier=null;applyToProv();state._res=solveState();");
  ok(G('state.pNet') === G('PV.JS.net'), '换受端省后回到该省默认主体与最高电压档');
  // 深圳：结构特殊、电价含线损
  G("state.to='GD';state.dstEntity='GD_SZ';state.dstTier=null;state._res=solveState();renderCalc();");
  ok(G('solveInput().dstInLossPct') === 0 && G("document.getElementById('sheet-body').innerHTML").includes('请手填受端输配电价'), '深圳电价已含线损（受端线损按 0），提示手填');
  // P2：广东手填输配电价后切深圳，手改标记必须一并清除——同省换主体不触发 applyToProv 的换省判定，
  // 旧值会被当成深圳的手填值继续参与计算（界面却只提示「请核对适用档」）。
  G("state.dstEntity=null;state.dstTier=null;applyToProv();state.pNet=123.4;state.pNetManual=true;state._res=solveState();renderCalc();"); syncDom();
  ok(G('state.pNet') === 123.4 && G('state.pNetManual') === true, '广东主体下手填输配电价 123.4 生效');
  pick({ dstEntity: 'GD_SZ', dstTier: null });
  ok(G('state.pNet') == null && !G('state.pNetManual') && G("document.getElementById('sheet-body').innerHTML").includes('请手填受端输配电价'),
    '切到深圳主体后清除手改标记，不沿用广东的手填电价');
  // M10：深圳电价已含上网环节线损费用——线损率只折算到户电量，省界及以前各项仍按节点交付电量实付
  G("state.pNet=150;state.pNetManual=true;state.dstCapMode='none';state.dstSysOpFee=null;state._res=solveState();renderCalc();"); syncDom();
  {
    const sz = G('state._res.rows[0]'), rho = G('dstTariff().qtyLossPct'), qty = G('state.qty');
    const up = ['gen', 'loss', 'send', 'trans', 'reg', 'originLoss'].reduce((a, k) => a + sz.yuan[k], 0);
    ok(rho > 0 && Math.abs(sz.consumerQty - qty * (1 - rho / 100)) < 1e-9 && Math.abs(sz.amountQty - sz.consumerQty) < 1e-9,
      `深圳：节点交付 ${qty} MWh 按 ${rho}% 折成到户 ${sz.consumerQty.toFixed(2)} MWh`);
    ok(Math.abs(up - sz.border * qty) < 1e-6, '折量不改省界及以前的实付总额（上游金额 = 省界价 × 节点交付电量）',
      `${up.toFixed(2)} ≠ ${(sz.border * qty).toFixed(2)}`);
    ok(sz.yuan.inLoss === 0 && sz.comp.inLoss === 0, '电价已含线损：不单列受端上网环节线损费用');
    ok(Math.abs(sz.yuan.total / sz.amountQty - sz.landed) < 1e-9
      && Math.abs(sz.landed - (sz.border / (1 - rho / 100) + sz.comp.net + sz.comp.fund + sz.comp.cap + sz.comp.sysOp)) < 1e-9,
      '金额与单价闭合：landed = 省界价/(1−ρ) + 受端各项');
  }
  // 送端电站专属送出价：四川 锦屏官地（送江苏）
  G("Object.assign(state,PARAM_DEFAULTS);state.from='SC';state.to='JS';state.includeDstCost=false;state.showBad=true;applyBothProv();state._res=solveState();renderCalc();");
  const jinsu = () => G("state._res.rows.find(r=>r.edges.length===1&&r.edges[0].n==='锦苏直流')");
  const g0 = jinsu();
  const idx = G("srcStations().findIndex(x=>x.范围==='锦屏官地（送江苏）')");
  ok(idx >= 0 && G("document.getElementById('sheet-body').innerHTML").includes('id="i-srcstation"'), '四川送端提供电站专属送出价选项');
  G(`state.srcStation='${idx}';state._res=solveState();renderCalc();`);
  const g1 = jinsu();
  ok(g1.segs[0].sf0 === 30.4 && g1.cOriginLoss === 0 && g1.exportLossPct === 0, '锦屏官地（送江苏）：送出价 30.4、不计送端省内网损');
  ok(g1.landed < g0.landed && g1.pricingIssues.some((x) => x.includes('锦屏官地（送江苏）') && x.includes('额度')), `锦苏直流省界价 ${g0.landed.toFixed(2)} → ${g1.landed.toFixed(2)}，并提示须确认额度`);
  G("state.from='NM';state.srcStation=null;");
  ok(G('srcStations().length') === 0, '原文无数值的送出价条目（蒙西送华北）不提供选择');
  G("Object.assign(state,PARAM_DEFAULTS);state.from='SC';state.to='JS';applyBothProv();state._res=solveState();");
}

console.log('══ 十五、到户价分档对照：行数、当前行恒等、容需量口径、手填说明、深圳与口径切换、导出报告 ══');
{
  const VT = G('DATA.VT');
  const cells = (ent) => ent.档位.reduce((a, t) => a + (t.单一制 != null) + (t.两部制 != null), 0);
  const boot15 = () => G("Object.assign(state,PARAM_DEFAULTS);state.from='SC';state.to='JS';state.mustHave=[];state.sel=0;state.showBad=true;state.includeDstCost=true;state.pNetManual=false;applyBothProv();state._res=solveState();renderCalc();");
  // 直接取完整明细片段（renderDetail 的返回值），避免在整页 HTML 里找 #d-detail
  const det = () => G('renderDetail(state._res, selectedRow(state._res))');
  const secOf = () => { const h = det(), k = h.indexOf('到户价分档对照'); return k < 0 ? '' : h.slice(k, h.indexOf('电量与损耗', k)); };
  const jsEnt = VT.JS.主体[0], heEnt = VT.HE.主体.find((e) => e.id === 'HE');
  boot15(); syncDom();
  // ① 到户口径 + 江苏默认主体：行数 = 非 null 的（单一制、两部制）格子数（9 行）
  ok(secOf() && secOf().includes('电压档只影响到户价高低，不影响路线排序'), '到户口径下完整明细渲染对照表与说明行');
  ok(cells(jsEnt) === 9 && G('dstTierRows(state._res.rows[0]).length') === cells(jsEnt), `江苏默认主体对照 ${cells(jsEnt)} 行`);
  ok((secOf().match(/<tr[\s>]/g) || []).length - 1 === cells(jsEnt), '渲染表格行数与数据格子数一致');
  // ② 当前行：标「当前」+ 蓝底，pNet 未手改时到户价 = r.landed（与主卡/费用拆解合计同口径）
  const r15 = G('state._res.rows[0]');
  const cur15 = G("dstTierRows(state._res.rows[0]).find(x=>x.档别===dstTariff().tier.档别&&x.billing===dstTariff().billing)");
  ok(!!cur15 && Math.abs(cur15.landed - r15.landed) < 1e-6, 'pNet 未手改时当前行到户价 = r.landed', `${cur15 && cur15.landed} vs ${r15.landed}`);
  ok((secOf().match(/<b>当前<\/b>/g) || []).length === 1 && secOf().includes('background:var(--blue-bg)'), '当前行唯一，带「当前」文字与高亮（不只靠颜色）');
  // ③ 任意两行恒等：到户价ᵢ − 到户价ⱼ =（输配ᵢ+容需ᵢ）−（输配ⱼ+容需ⱼ）
  G("state.dstCapMode='capacity';state.dstLoadFactor=60;state._res=solveState();renderCalc();");
  const rows15 = G('dstTierRows(state._res.rows[0])');
  let badEq = 0;
  for (let a = 0; a < rows15.length; a++) for (let b = 0; b < rows15.length; b++) {
    if (Math.abs((rows15[a].landed - rows15[b].landed) - ((rows15[a].net + (rows15[a].cap || 0)) - (rows15[b].net + (rows15[b].cap || 0)))) > 1e-6) badEq++;
  }
  ok(badEq === 0, `任意两行满足到户价差 =（输配+容需）差（${rows15.length} 行全对）`);
  // ④ 容（需）量口径：不计入 → 容需量格全「—」并出现偏低注记；按容量 60% → 两部制行 = 容量电价×12/(8.76×0.6)，单一制行仍「—」
  boot15();
  const rowsNone = G('dstTierRows(state._res.rows[0])');
  ok((secOf().match(/<td>—<\/td>/g) || []).length === rowsNone.length
    && secOf().includes('两部制各行未含容（需）量电费'), '不计入口径：容需量格全「—」并出现偏低注记');
  // 口径已选（按需量）但负荷率未填：同样偏低，注记须写明原因
  G("state.dstCapMode='demand';state.dstLoadFactor=null;state._res=solveState();renderCalc();");
  ok(secOf().includes('两部制各行未含容（需）量电费（负荷率未填）'), '口径已选但负荷率未填：偏低注记写明原因');
  G("state.dstCapMode='capacity';state.dstLoadFactor=60;state._res=solveState();renderCalc();");
  const expCaps = jsEnt.档位.filter((t) => t.两部制 != null).map((t) => G('fmt')(t.容量电价 * 12 / (8.76 * 0.6)));
  const sec60 = secOf();
  ok(expCaps.length && expCaps.every((c) => sec60.includes('<td>' + c + '</td>')), `按容量 60%：两部制行容需量 = ${expCaps.join(' / ')}`);
  ok(/不满1千伏 · 单一制<\/td><td>[\d.]+<\/td><td>—<\/td>/.test(sec60), '单一制行容需量显示 —');
  ok(!sec60.includes('未含容（需）量电费'), '容需量已计入时不再出现偏低注记');
  // ⑤ 手改 #i-pnet：出现手填说明，表内各行仍是核定值；清空手填值时说明不得写成「手填 —」
  // （pNet 清空时 solve 直接报错、明细不渲染，这里直接调 renderDstTierTable 验证防御性文案）
  G("state.pNet=null;state.pNetManual=true;");
  ok(G("renderDstTierTable({landed:600,comp:{net:100,cap:0,inLoss:0,fund:29.4,sysOp:0},border:570})").includes('主卡未填受端输配电价'),
    '清空手填值：说明行写「主卡未填」');
  G("state.pNet=600;state.pNetManual=true;state._res=solveState();renderCalc();");
  ok(secOf().includes('本表各行按核定值计算') && secOf().includes(G('fmt')(600)), '手填后出现说明行（写明主卡用手填值）');
  ok(G('dstTierRows(state._res.rows[0])[0].net') === jsEnt.档位[0].单一制, '手填后表内各行仍为核定值');
  // ⑥ 深圳：无标准电压档 → 只渲染说明行；省间口径 → 不渲染该节；切回后恢复且无残留
  // （换省触发 applyToProv 清手改标记、深圳无自动带入值，故切换后须重设手填价才能出结果——与真实界面一致）
  G("state.to='GD';state.dstEntity='GD_SZ';state.dstTier=null;applyToProv();state.pNet=150;state.pNetManual=true;state._res=solveState();renderCalc();");
  const detSZ = det();
  const szSec = detSZ.includes('到户价分档对照') ? detSZ.slice(detSZ.indexOf('到户价分档对照'), detSZ.indexOf('电量与损耗', detSZ.indexOf('到户价分档对照'))) : '';
  ok(!!szSec && szSec.includes('无标准电压档对照') && !szSec.includes('<table') && !szSec.includes('<b>当前</b>'),
    '深圳主体只渲染说明行，不渲染表格');
  G("state.includeDstCost=false;state._res=solveState();renderCalc();");
  ok(!det().includes('到户价分档对照'), '省间交易节点口径不渲染该节');
  G("state.includeDstCost=true;state.to='JS';state.dstEntity=null;state.dstTier=null;applyToProv();state._res=solveState();renderCalc();");
  ok((det().match(/到户价分档对照/g) || []).length === 1, '切回到户口径后恢复渲染，无残留旧表');
  // 河北南网：10 行（不满 1 千伏也有两部制）
  G("state.to='HE';state.dstEntity=null;state.dstTier=null;applyToProv();state._res=solveState();renderCalc();");
  ok(cells(heEnt) === 10 && G('dstTierRows(state._res.rows[0]).length') === cells(heEnt), `河北南网对照 ${cells(heEnt)} 行`);
  // ⑦ 导出报告：同一张表，列与数值和界面一致
  const prevBlob = ctx.Blob;
  let report15 = null;
  ctx.Blob = function (parts) { report15 = parts[0]; };
  G('exportReport()');
  ctx.Blob = prevBlob;
  const curRep = G("dstTierRows(state._res.rows[0]).find(x=>x.档别===dstTariff().tier.档别&&x.billing===dstTariff().billing)");
  ok(!!report15 && report15.includes('## 到户价分档对照'), '导出报告含对照表小节');
  ok(report15.includes('| 电压档 · 计价方式 | 输配电价 | 容（需）量 | 到户价 |'), '导出报告列与界面一致');
  ok(report15.includes('（当前）') && report15.includes('| 220千伏及以上 两部制（当前） | ' + G('fmt')(curRep.net) + ' | ' + (curRep.cap > 0 ? G('fmt')(curRep.cap) : '—') + ' | ' + G('fmt')(curRep.landed) + ' |'),
    '导出报告当前行标注与数值和界面一致');
  boot15();
}

console.log('══ 十六、受端用户组合：加权等价、示例组合、五条校验、衔接与存档 ══');
{
  const boot16 = () => G("Object.assign(state,PARAM_DEFAULTS);state.from='SC';state.to='JS';state.mustHave=[];state.sel=0;state.showBad=true;state.includeDstCost=true;applyBothProv();state._res=solveState();renderCalc();");
  const sheet = () => G("document.getElementById('sheet-body').innerHTML");
  const page = () => G("document.getElementById('v-calc').innerHTML");
  boot16(); syncDom();

  // ② 每个「档 × 计价方式」单行 100% 组合与单一口径同档的 landed 全等（江苏 9 行循环）
  const combos = G("(function(){const out=[];for(const t of dstTiers(dstEntity())){for(const b of ['single','twopart']){if(t[b==='single'?'单一制':'两部制']!=null)out.push([t.档别,b]);}}return out;})()");
  let badEq = 0;
  for (const [tier, billing] of combos) {
    G(`state.dstMode='single';state.dstTier=${JSON.stringify(tier)};state.dstBilling='${billing}';{const vt=dstTariff();state.dstBilling=vt.billing;if(vt.net!=null)state.pNet=vt.net;}state._res=solveState();`);
    const a = G('state._res.byA[0].landed');
    G(`state.dstMode='mix';state.dstMix=[{tier:${JSON.stringify(tier)},billing:'${billing}',share:100,lf:null}];state._res=solveState();`);
    const b = G('state._res.byA[0].landed');
    if (!(Number.isFinite(a) && Math.abs(a - b) < 1e-6)) badEq++;
  }
  ok(badEq === 0 && combos.length === 9, `单行 100% 组合与单一口径同档全等（${combos.length} 行循环）`);

  // ③ 第 2.6 节示例组合：110 两部制 30% + 1~10 两部制 50% + 1~10 单一制 20%
  boot16();
  const baseLanded = G('state._res.byA[0].landed');
  G("state.dstMode='mix';state.dstMix=[{tier:'110千伏',billing:'twopart',share:30,lf:null},{tier:'1~10（20）千伏',billing:'twopart',share:50,lf:null},{tier:'1~10（20）千伏',billing:'single',share:20,lf:null}];state._res=solveState();");
  const mix30 = G('dstMixOf()'), r30 = G('state._res.byA[0]');
  ok(mix30.ok && Math.abs(mix30.net - 131.16) < 0.005, `加权输配 ${mix30.net.toFixed(3)} ≈ 131.16`);
  ok(Math.abs((r30.landed - baseLanded) - (131.16 - 51.8)) < 1e-6, '组合到户价 − 默认档到户价 = 加权输配 − 51.8（误差 < 1e-6）');
  G("state.dstCapMode='capacity';state.dstMix[0].lf=60;state.dstMix[1].lf=60;state._res=solveState();");
  const mixCap = G('dstMixOf()'), rCap = G('state._res.byA[0]');
  ok(Math.abs(mixCap.cap - 55.71) < 0.005 && Math.abs(rCap.landed - r30.landed - mixCap.cap) < 0.005, `按容量 60%：加权容需量 ${mixCap.cap.toFixed(2)} ≈ 55.71 并计入到户价`);
  // ④ 金额闭合；组合模式不写回 state.pNet
  ok(Math.abs(rCap.yuan.total / rCap.consumerQty - rCap.landed) < 1e-6, '金额闭合 yuan.total ÷ consumerQty = landed');
  ok(G('state.pNet') === G('PV.JS.net') && G('state.pNetManual') === false, '组合模式不写回 state.pNet、不动手改标记');

  // ⑥ 切到组合自动生成单行 100%（主卡价格不变）；切回单一保留组合、价格恢复
  boot16();
  const single0 = G('state._res.byA[0].landed');
  G("state.dstMode='mix';seedMixRow();state._res=solveState();renderCalc();");
  ok(G('state.dstMix.length') === 1 && G('state.dstMix[0].share') === 100 && Math.abs(G('state._res.byA[0].landed') - single0) < 1e-9,
    '切到组合自动生成当前档 100% 单行，主卡价格不变');
  G("state.dstMode='single';state._res=solveState();renderCalc();");
  ok(Math.abs(G('state._res.byA[0].landed') - single0) < 1e-9 && G('state.dstMix.length') === 1, '切回单一后价格恢复、组合保留');

  // ⑤ 五条校验：返回 err、needParams、文案具体；错误卡带「去填写」；纵深防御 pNet=NaN
  const mixErr = (patch) => { G(`state.dstMode='mix';${patch}state._res=solveState();`); return G('state._res'); };
  let res5 = mixErr('state.dstMix=[];');
  ok(!!res5.err && res5.err.includes('至少要有一行') && res5.needParams === true, '校验1 空组合：不出结果并给文案');
  res5 = mixErr("state.dstMix=[{tier:'旧档名',billing:'twopart',share:100,lf:60}];");
  ok(/第 1 行[\s\S]*不在当前电网主体的价表中/.test(res5.err || ''), '校验2 档别不存在：文案具体到行');
  res5 = mixErr("state.dstMix=[{tier:'不满1千伏',billing:'twopart',share:100,lf:60}];");
  ok(/第 1 行[\s\S]*没有两部制价格/.test(res5.err || ''), '校验2b 该档无此计价方式价格');
  res5 = mixErr("state.dstMix=[{tier:'110千伏',billing:'twopart',share:0,lf:60}];");
  ok(/电量占比须为大于 0/.test(res5.err || ''), '校验3 占比 0 拒绝');
  res5 = mixErr("state.dstMix=[{tier:'110千伏',billing:'twopart',share:90,lf:60}];");
  ok(/合计须为 100%（当前 90%）/.test(res5.err || ''), '校验4 合计 90%：文案含当前值且不自动缩放');
  res5 = mixErr("state.dstMix=[{tier:'110千伏',billing:'twopart',share:50,lf:60},{tier:'110千伏',billing:'twopart',share:50,lf:60}];");
  ok(/重复出现/.test(res5.err || ''), '校验5 同档同计价方式重复拒绝');
  G("state.dstMix=[{tier:'110千伏',billing:'twopart',share:90,lf:60}];state._res=solveState();renderCalc();");
  ok(page().includes('onclick="openParams()">去填写') && page().includes('（当前 90%）'), '错误卡带「去填写」并显示具体原因');
  ok(!Number.isFinite(G('solveInput().pNet')), '纵深防御：组合无效时 solveInput() 传 pNet=NaN（通道优选/敏感性不会静默出数）');

  // ⑦ 换受端省 / 换主体（boot.js 分支行为）/ 恢复默认 → 单一用户 + 组合清空；默认值引用不污染
  G("state.dstMode='mix';state.dstMix=[{tier:'110千伏',billing:'twopart',share:100,lf:60}];state._res=solveState();");
  G("state.to='GD';state.dstEntity=null;state.dstTier=null;state.dstMode='single';state.dstMix=[];applyToProv();state._res=solveState();");
  ok(G('state.dstMode') === 'single' && G('state.dstMix.length') === 0, '换受端省后重置为单一用户、组合清空');
  G("state.dstMode='mix';state.dstMix=[{tier:'220千伏及以上',billing:'twopart',share:100,lf:60}];state._res=solveState();");
  G("readInputs();state.dstEntity='GD_SZ';state.dstTier=null;state.pNetManual=false;state.dstMode='single';state.dstMix=[];state._res=solveState();");
  ok(G('state.dstMode') === 'single' && G('state.dstMix.length') === 0, '换主体（含深圳）后重置为单一用户、组合清空');
  G("state.dstMode='mix';state.dstMix=[{tier:'110千伏',billing:'twopart',share:100,lf:60}];");
  G('resetParams()');
  ok(G('state.dstMode') === 'single' && G('state.dstMix.length') === 0 && JSON.stringify(G('PARAM_DEFAULTS.dstMix')) === '[]',
    '恢复默认：回到单一用户、组合清空、PARAM_DEFAULTS.dstMix 引用未被污染');

  // ⑧ 存档往返；存档里档别失效 → 校验错误、不崩溃
  G("state.dstMode='mix';state.dstMix=[{tier:'110千伏',billing:'twopart',share:60,lf:60},{tier:'1~10（20）千伏',billing:'single',share:40,lf:null}];state._res=solveState();saveLast();");
  G("Object.assign(state,PARAM_DEFAULTS);state.dstMix=[];");
  G('loadStored();applyBothProv();state._res=solveState();');
  ok(G('state.dstMode') === 'mix' && G('state.dstMix.length') === 2 && !G('state._res.err'), '存档往返恢复 dstMode 与 dstMix 并正常出结果');
  store['iproute.v2.last'] = JSON.stringify({ from: 'SC', to: 'JS', marketMode: 'mlt', includeDstCost: true, dstMode: 'mix', dstMix: [{ tier: '旧档名', billing: 'twopart', share: 100, lf: 60 }], _bt: 'x' });
  G('loadStored();applyBothProv();state._res=solveState();renderCalc();');
  ok(/不在当前电网主体的价表中/.test(G('state._res.err') || '') && page().includes('去填写'), '存档档别失效：校验错误不崩溃，错误卡可去填写');

  // ⑨ 组合模式面板无 #i-pnet；切回单一后 pNetManual 与切换前一致
  boot16();
  G("state.pNet=123.4;state.pNetManual=true;state._res=solveState();renderCalc();"); syncDom();
  ok(sheet().includes('id="i-pnet"'), '单一口径面板渲染 #i-pnet');
  G("state.dstMode='mix';seedMixRow();state._res=solveState();renderCalc();"); syncDom();
  ok(!sheet().includes('id="i-pnet"') && sheet().includes('受端输配电价 · 加权'), '组合模式面板不渲染 #i-pnet，显示加权只读值');
  ok(G('state.pNet') === 123.4 && G('state.pNetManual') === true, '组合模式不动 pNet 与手改标记');
  G("state.dstMode='single';state._res=solveState();renderCalc();"); syncDom();
  ok(G('state.pNetManual') === true && G('state.pNet') === 123.4, '切回单一后 pNetManual 与切换前一致');

  // readInputs：编辑区渲染时按容器 data-rows 读回 #i-mix-*；组合未生效时不读，state.dstMix 不动
  G("state.dstMode='mix';seedMixRow();state._res=solveState();renderCalc();");
  mk('dst-mix-rows').dataset = { rows: '1' };   // 模拟 DOM 桩不解析 HTML，手动给行数计数
  mk('i-mix-tier-0').value = '110千伏'; mk('i-mix-bill-0').value = 'twopart'; mk('i-mix-share-0').value = '70'; mk('i-mix-lf-0').value = '60';
  G('readInputs();');
  ok(G('state.dstMix.length') === 1 && G('state.dstMix[0].share') === 70 && G('state.dstMix[0].lf') === 60 && G('state.dstMix[0].tier') === '110千伏',
    '组合编辑区渲染时 readInputs 按 data-rows 读回各行');
  // 清理为 readInputs 造的桩节点（模拟 DOM 不解析 innerHTML，节点与 data-rows 会跨块残留、污染后续 mixAdd/mixDel 用例）
  for (const k of Object.keys(dom)) if (k === 'dst-mix-rows' || k.startsWith('i-mix-')) delete dom[k];

  // 「添加一档 / 删除」入口函数：新行必须是有效的「档 × 计价方式」组合（不能出现空档别的坏行）
  boot16();
  G("state.dstMode='mix';seedMixRow();state._res=solveState();renderCalc();");
  G('mixAdd()');
  ok(G('state.dstMix.length') === 2 && G('state.dstMix[1].tier') === '220千伏及以上' && G('state.dstMix[1].billing') === 'single',
    '添加一档：新行预填当前档尚未使用的计价方式（非空组合）');
  ok(/第 2 行[\s\S]*电量占比/.test(G('state._res.err') || ''), '新行占比待填时提示具体到行（不是「档别未选」）');
  G("state.dstMix[0].share=70;state.dstMix[1].share=30;state._res=solveState();");
  ok(!G('state._res.err'), '补足占比后恢复出结果');
  G('mixDel(0)');
  ok(G('state.dstMix.length') === 1 && G('state.dstMix[0].tier') === '220千伏及以上' && /合计须为 100%/.test(G('state._res.err') || ''),
    '删除后行序重排（剩余行不再配平时按合计校验提示）');

  // ⑩ 口径摘要 / 副标题 / 费用拆解行名 / 缺项提示 / 对照表占比与加权行 / 导出报告
  G("state.includeDstCost=true;state.dstMode='mix';state.dstCapMode='none';state.dstMix=[{tier:'110千伏',billing:'twopart',share:30,lf:60},{tier:'1~10（20）千伏',billing:'twopart',share:50,lf:60},{tier:'1~10（20）千伏',billing:'single',share:20,lf:null}];state._res=solveState();renderCalc();");
  const v10 = page();
  ok(v10.includes('用户组合 3 档 · 加权输配 ' + G('fmt')(131.16)), '主卡摘要显示组合档数与加权输配');
  ok(v10.includes('到户价格 · 用户组合加权'), '主卡价格副标题标注用户组合加权');
  ok(v10.includes('受端省网输配电价（用户组合加权）'), '费用拆解输配电价行名按组合口径');
  ok(v10.includes('组合含两部制档，未含容（需）量电费'), '组合两部制未计容需量时醒目提示');
  const det10 = G('renderDetail(state._res, selectedRow(state._res))');
  const sec10 = det10.slice(det10.indexOf('到户价分档对照'), det10.indexOf('电量与损耗', det10.indexOf('到户价分档对照')));
  ok(sec10.includes('占 30%') && sec10.includes('占 50%') && sec10.includes('占 20%'), '对照表组合行标注占比');
  const wLanded = G('state._res.byA[0].landed');
  ok(sec10.includes('<b>用户组合加权</b>') && sec10.includes('<td>' + G('fmt')(wLanded) + '</td>') && !sec10.includes('<b>当前</b>'),
    '对照表末行为「用户组合加权」（到户价 = r.landed），组合模式无单一「当前」行');
  // 缺负荷率：不算校验失败，按 0 计并按行数提示（口径为按需量时才涉及负荷率）
  G("state.dstCapMode='demand';state.dstMix[1].lf=null;state._res=solveState();renderCalc();");
  ok(!G('state._res.err') && page().includes('组合中 1 行两部制未填负荷率'), '组合缺负荷率：按 0 计并按行数提示（不拦截结果）');
  ok(page().includes('容（需）量电费分摊（按各档负荷率假设加权）'), '费用拆解容需量行名按组合口径');
  // 导出报告：组合行（占比、负荷率）+ 加权结果
  G("state.dstMix[1].lf=60;state.dstCapMode='capacity';state._res=solveState();renderCalc();");
  let rep16 = null;
  const prevBlob16 = ctx.Blob;
  ctx.Blob = function (parts) { rep16 = parts[0]; };
  G('exportReport()');
  ctx.Blob = prevBlob16;
  ok(!!rep16 && rep16.includes('| 电压档 · 计价方式 | 占比 % | 负荷率 % | 输配电价 | 容（需）量 | 到户价 |'), '导出报告组合表含占比与负荷率列');
  ok(rep16.includes('**用户组合加权**') && rep16.includes('受端到户：用户组合 3 档按电量加权'), '导出报告含加权结果与组合摘要行');
  // 省间口径：组合配置残留不参与计算也不报错
  G("state.includeDstCost=false;state._res=solveState();renderCalc();");
  ok(!G('state._res.err') && G('state.dstMode') === 'mix', '省间口径下组合配置残留不报错（组合不生效）');
  G("state.includeDstCost=true;state._res=solveState();");
  ok(G('dstMixActive()') === true && !G('state._res.err'), '切回到户后组合自动恢复生效');
  boot16();
}

console.log(`\n${fail ? '❌' : '✅'} 结果：${pass} 项通过，${fail} 项失败`);
if (fail) { console.log('未通过项：'); problems.forEach((p) => console.log('  · ' + p)); }
process.exit(fail ? 1 : 0);
