#!/usr/bin/env node
/** REQ-601 单测：enumPaths 的 hitCap 标志必须区分「提前截断」与「自然枚举完」。 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const code = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</' + 'script>'));
const store = {}; const dom = {};
const mk = (id) => (dom[id] ||= { id, innerHTML: '', hidden: false, style: {}, textContent: '',
  classList: { toggle() {}, add() {}, remove() {} }, value: '0' });
const ctx = { console: { log() {} },
  document: { getElementById: mk, addEventListener() {}, createElement: () => ({ click() {}, style: {}, setAttribute() {} }), head: { appendChild() {} }, body: mk('body') },
  localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  Blob: function () {}, URL: { createObjectURL: () => '' }, confirm: () => false,
  setTimeout: f => f(), Math, JSON, Number, Object, Array, String, Date, isNaN, parseInt, parseFloat, Error, encodeURIComponent, isFinite, RegExp, Set, Map };
ctx.window = { scrollTo() {}, open() {} }; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(code, ctx);

// 合成图：4 节点完全图（双向），A→B 的简单路径恰 5 条（A>B、A>C>B、A>D>B、A>C>D>B、A>D>C>B）
const K4 = {};
for (const a of ['A', 'B', 'C', 'D']) {
  K4[a] = [];
  for (const b of ['A', 'B', 'C', 'D']) if (b !== a) K4[a].push({ e: { id: a + b, n: a + b }, to: b });
}
// 稀疏图：A→B 单边
const SPARSE = { A: [{ e: { id: 'AB', n: 'AB' }, to: 'B' }], B: [] };

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };

const g = vm.runInContext(`
  (function(){
    const r1 = enumPaths(${JSON.stringify(K4)}, 'A', 'B', 6, 3, () => 1);
    const r2 = enumPaths(${JSON.stringify(K4)}, 'A', 'B', 6, 10, () => 1);
    const r3 = enumPaths(${JSON.stringify(SPARSE)}, 'A', 'B', 1, 10, () => 1);
    return { r1n: r1.length, r1h: !!r1.hitCap, r2n: r2.length, r2h: !!r2.hitCap, r3n: r3.length, r3h: !!r3.hitCap };
  })()
`, ctx);

ok(g.r1n === 3 && g.r1h === true, `cap=3 < 全量 5：应截断（length 3, hitCap true），实际 ${g.r1n}/${g.r1h}`);
ok(g.r2n === 5 && g.r2h === false, `cap=10 > 全量 5：应自然枚举完（length 5, hitCap false），实际 ${g.r2n}/${g.r2h}`);
ok(g.r3n === 1 && g.r3h === false, `稀疏图自然穷尽：length 1, hitCap false，实际 ${g.r3n}/${g.r3h}`);

console.log(`hitCap 单测：${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
