#!/usr/bin/env node
/**
 * 基线校验（v2）：以 docs/regression-baseline-v2.json 为正确答案，
 * 重跑一份算法实现并逐字段比对。
 *
 * 用法：
 *   node tools/baseline-check.mjs                  # 校验 index.html 内嵌算法
 *   node tools/baseline-check.mjs <你的引擎.js>     # 校验外部引擎
 *
 * 迁移到 React Native / Flutter 后，把新引擎包装成导出 solve / state / CH /
 * PV 的同名接口，再跑本脚本，任何数值漂移都会立刻暴露。
 *
 * 重新生成基线：node tools/baseline2.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'docs/regression-baseline-v2.json'), 'utf8'));

const target = process.argv[2];
let code;
if (target) {
  code = fs.readFileSync(path.resolve(target), 'utf8');
} else {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const i = html.lastIndexOf('<script>');
  const j = html.lastIndexOf('</' + 'script>');
  code = html.slice(i + 8, j);
}

const store = {};
const dom = {};
const mk = (id) => (dom[id] ||= { id, innerHTML: '', hidden: false, style: {}, textContent: '',
  classList: { toggle() {}, add() {}, remove() {} }, value: '0' });
const ctx = {
  console: { log() {} },
  document: { getElementById: mk, addEventListener() {},
    createElement: () => ({ click() {}, style: {}, setAttribute() {} }),
    head: { appendChild() {} }, body: mk('body') },
  localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  Blob: function () {}, URL: { createObjectURL: () => '' }, confirm: () => false,
  setTimeout: (f) => f(), Math, JSON, Number, Object, Array, String, Date, isNaN, parseInt,
  parseFloat, Error, encodeURIComponent, isFinite, RegExp, Set, Map,
};
ctx.window = { scrollTo() {}, open() {} };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);

// 还原基线费率快照，排除费率差异干扰
vm.runInContext(`CH = ${JSON.stringify(baseline.tariff_snapshot)};`, ctx);

const TOL = 1e-4;
let checked = 0, failed = 0;
const problems = [];

for (const c of baseline.cases) {
  const p = c.inputs;
  vm.runInContext(
    `Object.assign(state,{from:${JSON.stringify(c.from)},to:${JSON.stringify(c.to)},
      pGen:${p.pGen},pDst:${p.pDst},pNet:${p.pNet},fund:${p.fund},
      lossBearer:${p.lossBearer},qty:${p.qty},hours:${p.hours},showBad:true,sortBy:"A",showAll:true,
      maxHops:${p.maxHops},maxDetour:${p.maxDetour},K:6,includeRegion:${p.includeRegion}});`, ctx);
  const R = vm.runInContext('solve(state, algoData())', ctx);
  if (R.err) { failed++; problems.push(`${c.from}→${c.to}: 基线有解但现引擎报错「${R.err}」`); continue; }
  if (R.rows.length !== c.routeTotal) {
    failed++; problems.push(`${c.from}→${c.to}: 路线总数 ${R.rows.length} ≠ 基线 ${c.routeTotal}`); continue;
  }
  for (let k = 0; k < c.routes.length; k++) {
    const e = c.routes[k], a = R.rows[k];
    const d = [];
    if (e.nodes.join('>') !== a.nodes.join('>')) d.push(`路径 ${a.nodes.join('>')} ≠ ${e.nodes.join('>')}`);
    if (Math.abs(e.landed - a.landed) > TOL) d.push(`落地 ${a.landed.toFixed(4)} ≠ ${e.landed}`);
    if (Math.abs(e.channelOnly - a.channelOnly) > TOL) d.push(`过网费 ${a.channelOnly.toFixed(4)} ≠ ${e.channelOnly}`);
    if (Math.abs(e.senderNet - a.senderNet) > TOL) d.push(`送端净收益 ${a.senderNet.toFixed(4)} ≠ ${e.senderNet}`);
    if (Math.abs(e.delivery - a.D) > 1e-6) d.push(`送达系数 ${a.D.toFixed(6)} ≠ ${e.delivery}`);
    if (e.feasible !== a.feasible) d.push(`可行性与基线不符`);
    checked++;
    if (d.length) { failed++; problems.push(`${c.from}→${c.to} #${k + 1}: ${d.join('; ')}`); }
  }
}

console.log(`基线：${baseline.case_count} 个省对，${baseline.cases.reduce((s, c) => s + c.routes.length, 0)} 条路径`);
console.log(`费率快照 sha256 ${baseline.tariff_snapshot_sha256.slice(0, 20)}…（已还原，排除费率差异）`);
console.log(`校验对象：${target || 'index.html 内嵌算法'}`);
console.log(`结果：${checked - failed}/${checked} 通过`);
if (failed) {
  console.log(`\n❌ ${failed} 项不一致，前 15 条：`);
  problems.slice(0, 15).forEach((p) => console.log('  · ' + p));
  process.exit(1);
}
console.log('\n✅ 全部一致，实现与基线等价。');
