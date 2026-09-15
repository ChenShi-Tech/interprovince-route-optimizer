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
  const expect = PV[t].net + PV[t].fund;
  ok(Math.abs((A.landed - B.landed) - expect) < 1e-6,
    `${PV[f].n}→${PV[t].n}：省界价 = 落地价 − 受端输配电价 − 基金附加`,
    `差 ${(A.landed - B.landed).toFixed(2)}，应为 ${expect.toFixed(2)}`);
  ok(B.comp.net === 0 && B.comp.fund === 0, '  不计入时受端两项归零');
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

  // ① 专项工程单向通行：长南荆存为 山西→湖北，湖北→山西 不得经它反向行进
  const cnj = G("CH.find(c=>c.n==='长南荆特高压交流')");
  ok(!!cnj && cnj.from === 'SX' && cnj.to === 'HB' && cnj.bidir === false, '长南荆存为 山西→湖北，标记为单向专项工程');
  G("state.from='HB';state.to='SX';state.maxHops=1;state.maxDetour=9;applyBothProv();state._res=solve(state, algoData());");
  const r1 = G('state._res');
  ok(!!r1.err || r1.rows.every((x) => x.edges[0].n !== '长南荆特高压交流'), '湖北→山西 1 段以内没有反向经长南荆的路线');
  G("state.from='SX';state.to='HB';state._res=solve(state, algoData());");
  const r2 = G('state._res');
  ok(!r2.err && r2.rows.some((x) => x.edges[0].n === '长南荆特高压交流'), '山西→湖北 仍可经长南荆正向行进');
  // 全网核对：任何路线都不得把专项工程段反向走
  let revProj = 0, rowsAll = 0;
  const keys = Object.keys(PV);
  for (const f of keys) for (const t of keys) {
    if (f === t) continue;
    G(`state.from='${f}';state.to='${t}';state.maxHops=3;state.maxDetour=2;applyBothProv();state._res=solve(state, algoData());`);
    const r = G('state._res');
    if (r.err) continue;
    for (const x of r.rows) { rowsAll++; x.edges.forEach((e, i) => { if (!e.bidir && x.nodes[i] !== e.from) revProj++; }); }
  }
  ok(rowsAll > 0 && revProj === 0, `全网 ${rowsAll} 条路线中没有反向行进的专项工程段`, revProj ? `${revProj} 段反向` : '');

  // ② 区域电网费只在联络线段计收、取到达省所在区域；专项工程段为 0
  const link = G("CH.find(c=>c.n==='川渝联络线')");
  ok(G(`regionFee(${ENV},CH.find(c=>c.n==='锦苏直流'),'JS')`) === 0, '专项工程段（锦苏直流，华中→华东）不收区域电网费');
  ok(G(`regionFee(${ENV},CH.find(c=>c.n==='川渝联络线'),'CQ')`) === RG['华中'] * 1000, `联络线段（川渝，同在华中）收华中电量电价 ${RG['华中'] * 1000}`);
  ok(G(`regionFee(${ENV},CH.find(c=>c.n==='川陕联络线'),'SN')`) === RG['西北'] * 1000, '跨区联络线（川陕，四川→陕西）取到达区域西北的电量电价');
  ok(G(`regionFee(${ENV},CH.find(c=>c.n==='川陕联络线'),'SC')`) === RG['华中'] * 1000, '同一联络线反向（陕西→四川）取到达区域华中的电量电价');
  ok(G(`regionFee(({REGION_OF:DATA.RGOF,RG:DATA.RG,includeRegion:false}),CH.find(c=>c.n==='川渝联络线'),'CQ')`) === 0, '不计入区域电网费时为 0');
  // 逐条核对：任意路径的区域费 = Σ 联络线段 × 到达省区域电量电价 × 段前系数，专项工程段一律为 0
  let bad = 0, checked = 0, projSeg = 0;
  for (const [f, t] of [['HB', 'JS'], ['SX', 'JS'], ['SC', 'JS'], ['GS', 'SD'], ['HB', 'HE'], ['CQ', 'JS'], ['SN', 'HB'], ['SC', 'HB'], ['NM', 'BJ'], ['CQ', 'SC']]) {
    G(`state.from='${f}';state.to='${t}';state.maxHops=3;state.maxDetour=2;applyBothProv();state._res=solve(state, algoData());`);
    const r = G('state._res');
    if (r.err) continue;
    for (const x of r.rows) {
      const expect = x.segs.filter((s) => s.e.regional).reduce((a, s) => a + (RG[RGOF[s.b]] || 0) * 1000 * s.q, 0);
      checked++;
      if (Math.abs(x.comp.reg - expect) > 1e-6) bad++;
      x.segs.forEach((s) => { if (!s.e.regional && s.rg !== 0) projSeg++; });
    }
  }
  ok(checked > 0 && bad === 0, `${checked} 条路线的区域电网费均等于联络线段累加值`, bad ? `${bad} 条不符` : '');
  ok(projSeg === 0, '没有任何专项工程段被计入区域电网费');

  // ③ 联络线反向行进时按实际送端省的送出省输电价格计价
  G("state.from='CQ';state.to='SC';state.maxHops=1;state.maxDetour=9;applyBothProv();state._res=solve(state, algoData());");
  const r3 = G('state._res');
  const cs = !r3.err && r3.rows.find((x) => x.edges[0].n === '川渝联络线');
  ok(!!cs && link.tRev !== link.t && cs.segs[0].t === link.tRev,
    `重庆→四川 反向经川渝联络线，输电价取重庆送出省价格 ${cs && cs.segs[0].t}（存储方向四川为 ${link.t}）`);
  ok(!!cs && Math.abs(cs.comp.trans - link.tRev * cs.segs[0].q) < 1e-9, '反向联络线的过网费 = tRev × 段前系数');
  G("state.from='SC';state.to='CQ';state._res=solve(state, algoData());");
  const r3b = G('state._res');
  const sc = !r3b.err && r3b.rows.find((x) => x.edges[0].n === '川渝联络线');
  ok(!!sc && sc.segs[0].t === link.t, `四川→重庆 正向经川渝联络线，输电价取四川送出省价格 ${link.t}`);

  // ④ 含输电环节线损的专项工程按落地端结算电量计费（t × 段后电量），其余按段前电量
  G("state.from='NX';state.to='ZJ';state.maxHops=1;applyBothProv();state._res=solve(state, algoData());");
  const r4 = G('state._res');
  const ls = !r4.err && r4.rows.find((x) => x.edges[0].n === '灵绍直流');
  ok(!!ls && ls.edges[0].incLoss === true && Math.abs(ls.segs[0].fee - ls.edges[0].t * ls.segs[0].qOut) < 1e-9,
    `灵绍直流（含线损）输电费 ${ls && ls.segs[0].fee.toFixed(4)} = t × 段后电量`);
  G("state.from='SC';state.to='JS';state.maxHops=1;applyBothProv();state._res=solve(state, algoData());");
  const r5 = G('state._res');
  const js = !r5.err && r5.rows.find((x) => x.edges[0].n === '锦苏直流');
  ok(!!js && js.edges[0].incLoss === false && Math.abs(js.segs[0].fee - js.edges[0].t * js.segs[0].q) < 1e-9,
    `锦苏直流（不含线损）输电费 ${js && js.segs[0].fee.toFixed(4)} = t × 段前电量`);
  ok(!!js && js.comp.reg === 0, '四川→江苏 经锦苏直流不计区域电网费');
  ok(!!js && Math.abs(js.yuan.total / js.qty - js.landed) < 1e-6, '费用总额 ÷ 电量 = 落地单价（改口径后仍自洽）');
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

console.log(`\n${fail ? '❌' : '✅'} 结果：${pass} 项通过，${fail} 项失败`);
if (fail) { console.log('未通过项：'); problems.forEach((p) => console.log('  · ' + p)); }
process.exit(fail ? 1 : 0);
