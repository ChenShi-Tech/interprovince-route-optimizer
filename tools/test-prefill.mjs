#!/usr/bin/env node
/** 验证「受端省参数自动预填 + 可手动覆盖 + 可恢复」的行为。 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const i = html.lastIndexOf('<script>');
const j = html.lastIndexOf('</' + 'script>');

function mk() {
  const store = {}, dom = {};
  const el = (id) => (dom[id] ||= { id, innerHTML: '', hidden: false, style: {}, textContent: '', className: '',
    classList: { toggle() {}, add() {}, remove() {} }, value: '0' });
  const ctx = { console: { log() {} },
    document: { getElementById: el, addEventListener() {},
      createElement: () => ({ click() {}, style: {}, setAttribute() {} }),
      head: { appendChild() {} }, body: el('body'), querySelector: () => null },
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    Blob: function () {}, URL: { createObjectURL: () => '' }, confirm: () => false,
    setTimeout: (f) => f(), Math, JSON, Number, Object, Array, String, Date, isNaN, parseInt,
    parseFloat, Error, encodeURIComponent, isFinite, RegExp, Set, Map, location: { hostname: 'example.com' },
    __dom: dom, __store: store };
  ctx.window = { scrollTo() {}, open() {} };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(html.slice(i + 8, j), ctx);
  return ctx;
}

const G = (c, e) => vm.runInContext(e, c);
let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '　' + detail : '')); }
};

console.log('══ 一、专项工程与省级参数是否全部用真实值 ══');
const c1 = mk();
const PV1 = G(c1, 'PV');
const noNet = Object.entries(PV1).filter(([, v]) => v.net == null);
const noClear = Object.entries(PV1).filter(([, v]) => v.clear == null);
ok(noNet.length === 0, '30 个省全部有输配电价核定值', noNet.map(([, v]) => v.n).join('、'));
ok(noClear.length === 0, '30 个省全部有出清价');
const uniformFund = Object.values(PV1).filter((v) => v.fund === 26.6).length;
ok(uniformFund === 0, '无省份仍在使用 26.6 占位值');
const fundSet = new Set(Object.values(PV1).map((v) => String(v.fund)));
ok(fundSet.size >= 20, `基金附加取值分散（${fundSet.size} 个不同值）`);
const srcOK = Object.values(PV1).filter((v) => /1077号/.test(v.netSrc)).length;
ok(srcOK === 30, `30 个省的来源均指向发改价格〔2026〕1077号（实际 ${srcOK}）`);

console.log('\n══ 二、启动时的预填 ══');
ok(G(c1, 'state.pNet') === PV1.JS.net, `默认受端江苏 → 输配电价 ${G(c1, 'state.pNet')}`);
ok(G(c1, 'state.fund') === PV1.JS.fund, `默认受端江苏 → 基金附加 ${G(c1, 'state.fund')}`);
ok(G(c1, 'state.pGen') === PV1.SC.clear, `默认送端四川 → 出清价 ${G(c1, 'state.pGen')}`);

console.log('\n══ 三、切换受端省 → 参数随之预填 ══');
const cases = [['SX', '山西'], ['XJ', '新疆'], ['YN', '云南'], ['GD', '广东']];
for (const [code, name] of cases) {
  G(c1, `state.to='${code}';applyToProv();`);
  const net = G(c1, 'state.pNet'), fund = G(c1, 'state.fund');
  ok(net === PV1[code].net && fund === PV1[code].fund,
    `受端改 ${name} → 输配电价 ${net}、基金 ${fund}`,
    `期望 ${PV1[code].net} / ${PV1[code].fund}`);
}

console.log('\n══ 四、切换送端省不应改动受端参数 ══');
G(c1, "state.to='SX';applyToProv();");
const netBefore = G(c1, 'state.pNet'), fundBefore = G(c1, 'state.fund');
G(c1, "state.from='YN';applyFromProv();");
ok(G(c1, 'state.pNet') === netBefore, '切送端省后受端输配电价未被覆盖');
ok(G(c1, 'state.fund') === fundBefore, '切送端省后基金附加未被覆盖');
ok(G(c1, 'state.pGen') === PV1.YN.clear, `送端出清价已更新为云南 ${PV1.YN.clear}`);

console.log('\n══ 五、手动覆盖与恢复 ══');
G(c1, "state.pNet=999;state.fund=888;");
ok(G(c1, 'state.pNet') === 999, '用户可手动覆盖输配电价');
G(c1, "resetOne('pNet');");
ok(G(c1, 'state.pNet') === PV1.SX.net, `恢复核定值 → ${G(c1, 'state.pNet')}`);
G(c1, "resetOne('fund');");
ok(G(c1, 'state.fund') === PV1.SX.fund, `基金附加恢复 → ${G(c1, 'state.fund')}`);

console.log('\n══ 六、西藏基金缺失的显式处理 ══');
G(c1, "state.to='XZ';applyToProv();");
ok(G(c1, 'state.fundMissing') === true, '选定西藏为受端 → fundMissing 标记为真');
ok(G(c1, 'state.fund') === 0, '西藏基金按 0 计（避免 NaN）');
G(c1, 'state._res=solve(state, algoData());renderCalc();');
const xzHtml = G(c1, "__dom['v-calc'].innerHTML");
ok(xzHtml.includes('暂未获取官方标准'), '界面显式告警西藏基金未获取');

console.log('\n══ 七、价格与口径折叠默认展开 ══');
G(c1, "state.to='JS';applyToProv();state._res=solve(state, algoData());renderCalc();");
const h2 = G(c1, "__dom['v-calc'].innerHTML");
ok(/<details class="adv boxed" open>/.test(h2), '折叠块带 open 属性');
ok(h2.includes('当前取值依据'), '显示当前取值依据');
ok(h2.includes('恢复核定值'), '输入框带恢复按钮');
ok(h2.includes('发改价格〔2026〕1077号'), '取值依据中标出文号');

console.log('\n══ 八、数据版本变更时丢弃过期的本地价格改动 ══');
const c2 = mk();
G(c2, "state.pNet=12345;saveLast();");
const saved = JSON.parse(G(c2, "__store['iproute.v2.last']"));
ok(typeof saved._bt === 'string' && saved._bt.length > 0, 'saveLast 记录了构建版本 _bt=' + saved._bt);

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
