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
  classList: { toggle() {}, add() {}, remove() {} }, value: '' });
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
function syncDom() {
  const h = G("document.getElementById('v-calc').innerHTML");
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
  G(`state.from='${from}';state.to='${to}';state.showAll=true;state.maxHops=2;state.degrade=0.10;applyBothProv();state._res=solve(state, algoData());renderCalc();`);
  syncDom();
}

console.log('══ 一、切换受端省：自动按核定值核准（不需手动再点）══');
boot('SC', 'JS');
for (const [code, name] of [['SX', '山西'], ['XJ', '新疆'], ['SH', '上海'], ['GX', '广西']]) {
  change('i-to', code);
  const net = G('state.pNet'), fund = G('state.fund');
  ok(net === PV[code].net && fund === PV[code].fund,
    `受端切换为${name}后自动核准`, `得到 ${net}/${fund}，应为 ${PV[code].net}/${PV[code].fund}`);
  const rendered = G("document.getElementById('v-calc').innerHTML");
  ok(rendered.includes(`id="i-pnet" type="number" value="${PV[code].net}"`),
    `输入框同步显示${name}的核定值 ${PV[code].net}`);
  ok(rendered.includes(name), `取值依据区显示${name}`);
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
change('i-hops', '3');
ok(G('state.maxHops') === 3, '跳数上限改 3 生效');

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
ok(hEx.includes('送到受端省界'), '界面标签切换为「送到受端省界」');
ok(hEx.includes('已按口径排除'), '费用表标注受端省内费用已排除');
ok(!hEx.includes('<td>受端省网输配电价</td>'), '费用表不再列出受端输配电价行');
G('state.includeDstCost=true;state._res=solve(state, algoData());renderCalc();');
const hIn = G("document.getElementById('v-calc').innerHTML");
ok(hIn.includes('元/MWh 落地') && hIn.includes('<td>受端省网输配电价</td>'), '切回后恢复完整落地价口径');

console.log('══ 七、行进方向、区域电网费与含线损计费口径 ══');
{
  const RGOF = G('REGION_OF'), RG = G('RG');
  const ENV = "({REGION_OF:DATA.RGOF||{},RG:DATA.RG,includeRegion:true})";
  G('state.showBad=true;state.includeRegion=true;state.includeDstCost=true;');

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
  G("state.from='NM';state.to='BJ';state.maxHops=1;applyBothProv();state._res=solve(state, algoData());");
  const r6 = G('state._res');
  const mj = !r6.err && r6.rows.find((x) => x.edges[0].n === '蒙京联络线');
  ok(!!mj && Math.abs(mj.comp.reg - RG['华北'] * 1000) < 1e-9, `内蒙古→北京 同区域经蒙京联络线只计一次华北电量电价 ${RG['华北'] * 1000}`);
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
  ok(!!js && Math.abs(js.yuan.total / js.qty - js.landed) < 1e-6, '费用总额 ÷ 电量 = 落地单价（改口径后仍自洽）');
  // ⑥ 容量制工程：辛洹线边际 0，云霄取输电权报价下限
  const xh = G("CH.find(c=>c.n==='辛洹线')"), yx = G("CH.find(c=>c.n==='云霄直流')");
  ok(!!xh && xh.t === 0 && !!yx && yx.t === 25.6 && xh.bidir && yx.bidir, '辛洹线 t=0、云霄直流 t=25.6（输电权报价下限），均为双向');
}

console.log('══ 八、智能推荐：只在可行路线里选、密钥缺失即提示、结果随测算失效 ══');
{
  G("state.from='SC';state.to='SH';state.maxHops=6;state.maxDetour=9;state.showBad=true;state.sel=0;applyBothProv();state._res=solve(state, algoData());state._ai=null;renderCalc();");
  const h0 = G("document.getElementById('v-calc').innerHTML");
  ok(h0.includes('智能推荐') && h0.includes('id="i-ai-prompt"') && h0.includes('让模型推荐'), '测算页含智能推荐卡片、输入框与按钮');
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
  const h1 = G("document.getElementById('v-calc').innerHTML");
  ok(h1.includes('推荐 1') && h1.includes('线损更低') && h1.includes('onclick="pick(1)"'), '推荐结果渲染为可点击的路线卡片');
  // 参数变化后旧推荐不再显示
  G("state.to='JS';applyBothProv();state._res=solve(state, algoData());renderCalc();");
  const h2 = G("document.getElementById('v-calc').innerHTML");
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
  ok(h3.includes('通道组件') && h3.includes('toggleComp(') && h3.includes('清除全部组件'),
    '筛空时界面仍渲染组件选择器与「清除全部组件」，用户不会被困住');

  // 交互：点选 / 清除
  G('state.mustHave=[];state._res=solve(state, algoData());renderCalc();');
  const h2 = G("document.getElementById('v-calc').innerHTML");
  ok(h2.includes('通道组件') && h2.includes('chip dc') && h2.includes('必经组件'), '测算页渲染组件选择器，直流 chip 带 dc 样式');
  ok(h2.includes('<details class="explain"><summary>候选与可行的定义'), '可选路线的口径说明默认折叠');
  ok(h2.includes('<details class="explain"><summary>政策口径与取值依据'), '价格与口径的政策说明默认折叠');
  G(`toggleComp('${dc.id}')`);
  ok(G('state.mustHave.length') === 1 && G('state._res.mustHave.length') === 1, '点选组件后立即重算并带上筛选条件');
  G('clearComp()');
  ok(G('state.mustHave.length') === 0 && G('state._res.mustHave.length') === 0, '清除全部组件后恢复全量候选');
}

console.log(`\n${fail ? '❌' : '✅'} 结果：${pass} 项通过，${fail} 项失败`);
if (fail) { console.log('未通过项：'); problems.forEach((p) => console.log('  · ' + p)); }
process.exit(fail ? 1 : 0);
