#!/usr/bin/env node
/**
 * 设计令牌守卫（发版必跑第 8 组）。
 *
 * 设计令牌只在 src/tokens.css 里写值，样式与界面脚本一律引用 var(--x)——后续深色 / 科技感主题
 * 只覆盖令牌取值，不改组件样式。本脚本守住这条边界：
 *   一、颜色字面值：src/template.html（注入前）的 <style> 与其余标记、src/app/**\/*.js 中
 *       不得出现 #hex / rgb() / rgba() / hsl() / hsla()。
 *       白名单：data: URI（地图圆点等运行时拼接的 SVG）、var(--x, 字面兜底) 的兜底值、
 *       <meta name="theme-color">（浏览器状态栏色只认字面值）。
 *   二、令牌引用：var(--x) 与 JS 里以字符串传递的 '--x'（tokenColor('--x') 等）都必须在 src/tokens.css 定义；
 *       src/tokens.css 定义了但 src/ 下无人引用的令牌给出警告（不失败）。
 *   三、字号：CSS / canvas 的 font-size 只能取 FONT_SIZES；拓扑图 SVG 的 font-size 属性另按 SVG_FONT_SIZES。
 *   四、圆角：border-radius 字面值只能是 0 / 50% / 复合值（多值简写）/ 令牌引用。
 *   五、令牌文件自身：只有一个 :root 块、:root 内名字不重复、主题覆盖块（[data-theme] 等）只覆盖已定义的令牌；
 *       深色主题（clear-dark / tech）覆盖 :root 的全部颜色令牌并声明 color-scheme:dark。
 *   六、主题对比度：三套主题（clear / clear-dark / tech）逐对检查文字 ≥4.5:1、非文字 ≥3:1（别名逐层解析，
 *       半透明色按所在的底合成），任一主题不达标即失败；清晰浅色网架图省名列为已知例外。
 * 用法：node tools/test-design-tokens.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n?/g, '\n');
let pass = 0, fail = 0;
const warns = [];
const ok = (c, l, d) => { if (c) { pass++; console.log('  ✅ ' + l); } else { fail++; console.log('  ❌ ' + l + (d ? '\n' + d : '')); } };

/* 允许的字号（px）。新增字号须先进设计系统（tokens.json 的 type 分组），再同步到这里——
   不要为了让守卫变绿直接往这里加值。
   可读性下限 10.5px：原 9.5 / 10px 两档已统一提到 10.5（手机上太小）。 */
const FONT_SIZES = [10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 16, 17, 18, 19, 20, 21, 24, 26, 30, 34, 40];
/* 拓扑图 SVG 的 font-size 属性（ui/map.js）：单位是 viewBox（660×430）用户单位，随画布整体缩放，不是屏幕 px，
   不受上面的可读性下限约束。9 = 非路线省名，10 = 段序号 / 段名 / 站名，10.5 = 路线省名。 */
const SVG_FONT_SIZES = [9, 10, 10.5];


/* ---------- 读取 ---------- */
const tpl = rd('src/template.html');
const tokensCss = rd('src/tokens.css');
const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
const jsFiles = walk('src/app').sort().map((f) => ({ file: f.split(path.sep).join('/'), text: rd(f) }));

const styleOpen = tpl.indexOf('<style>'), styleClose = tpl.indexOf('</style>');
const styleCount = tpl.split('<style>').length - 1;

/* ---------- 预处理：等长抹掉（保留换行，行号不变） ---------- */
const blank = (s) => s.replace(/[^\n]/g, ' ');
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, blank);
const stripJsComments = (s) => stripCssComments(s).replace(/(^|[\s;{}(),])(\/\/[^\n]*)/gm, (m, a, b) => a + blank(b));
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, blank);
/** data: URI（引号包起来的整段）整段抹掉 */
const stripDataUri = (s) => s.replace(/(["'`])data:[\s\S]*?\1/g, blank);
/** var(--x, 兜底) 的兜底部分抹掉（兜底里可能再嵌 rgba()/var()，按括号配对） */
function stripVarFallback(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const at = s.indexOf('var(', i);
    if (at < 0) { out += s.slice(i); break; }
    out += s.slice(i, at + 4);
    let depth = 1, j = at + 4, comma = -1;
    for (; j < s.length && depth; j++) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')') depth--;
      else if (s[j] === ',' && depth === 1 && comma < 0) comma = j;
    }
    const end = j - 1;                       // 与 var( 配对的右括号
    if (depth) { out += s.slice(at + 4); break; }
    out += comma < 0 ? s.slice(at + 4, end) : s.slice(at + 4, comma) + blank(s.slice(comma, end));
    out += ')';
    i = end + 1;
  }
  return out;
}
const lineOf = (s, idx) => s.slice(0, idx).split('\n').length;
const snippet = (s, idx) => { const a = s.lastIndexOf('\n', idx) + 1, b = s.indexOf('\n', idx); return s.slice(a, b < 0 ? undefined : b).trim().slice(0, 140); };

/* ---------- 各扫描目标（已抹掉注释 / data URI / var 兜底） ---------- */
// 模板 <style>：以整个模板为坐标系（行号即模板行号），只保留 <style> 区间
const tplStyleOnly = tpl.slice(0, styleOpen + 7).replace(/[^\n]/g, ' ') + tpl.slice(styleOpen + 7, styleClose) + blank(tpl.slice(styleClose));
const styleScan = stripVarFallback(stripDataUri(stripCssComments(tplStyleOnly)));
// 模板其余部分（head 脚本、body 标记）：<meta name="theme-color"> 放行
const tplMarkupOnly = tpl.slice(0, styleOpen) + blank(tpl.slice(styleOpen, styleClose)) + tpl.slice(styleClose);
const markupScan = stripVarFallback(stripDataUri(stripJsComments(stripHtmlComments(tplMarkupOnly))))
  .replace(/<meta\s+name="theme-color"[^>]*>/g, blank);
const jsScan = jsFiles.map(({ file, text }) => ({ file, text, scan: stripVarFallback(stripDataUri(stripJsComments(text))) }));

const targets = [
  { name: 'src/template.html <style>', file: 'src/template.html', text: tpl, scan: styleScan, scanAll: styleScan },
  { name: 'src/template.html 其余标记（head 脚本 / body）', file: 'src/template.html', text: tpl, scan: markupScan, scanAll: markupScan },
  ...jsScan.map((j) => ({ name: j.file, file: j.file, text: j.text, scan: j.scan, scanAll: j.scan })),
];

/* ================= 一、颜色字面值 ================= */
console.log('══ 一、颜色字面值只允许出现在 src/tokens.css ══');
const COLOR_RE = /(?<![\w&#-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\s*\(/gi;
for (const t of targets) {
  const hits = [...t.scan.matchAll(COLOR_RE)].map((m) => `      ${t.file}:${lineOf(t.text, m.index)}　${m[0]}　${snippet(t.text, m.index)}`);
  ok(hits.length === 0, `${t.name} 无颜色字面值`, hits.slice(0, 20).join('\n') + (hits.length > 20 ? `\n      …共 ${hits.length} 处` : ''));
}
ok(styleCount === 1, '模板只有一个 <style> 块（守卫按单块扫描）');

/* ================= 二、令牌定义与引用 ================= */
console.log('\n══ 二、令牌定义与引用 ══');
const tokScan = stripCssComments(tokensCss);
const rootBlocks = tokScan.match(/(^|[\s}]):root\s*\{/g) || [];
ok(rootBlocks.length === 1, `src/tokens.css 只有一个 :root 块（实际 ${rootBlocks.length} 个）`);
// 基础定义只看 :root 块（后续主题会在 [data-theme=…] 块里覆盖同名令牌，那不算重复）
const rootAt = tokScan.search(/(^|[\s}]):root\s*\{/);
const rootBody = rootAt < 0 ? '' : tokScan.slice(tokScan.indexOf('{', rootAt) + 1, tokScan.indexOf('}', tokScan.indexOf('{', rootAt)));
const defs = [...rootBody.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
const dup = defs.filter((d, i) => defs.indexOf(d) !== i);
ok(dup.length === 0, `:root 内令牌名不重复（共 ${defs.length} 个）`, '      ' + dup.join('、'));
const overrideOnly = [...tokScan.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).filter((d) => !defs.includes(d));
ok(overrideOnly.length === 0, '主题覆盖块里的令牌都先在 :root 定义过', '      ' + [...new Set(overrideOnly)].join('、'));
const defined = new Set(defs);
// 引用：var(--x)；JS 里以字符串传递的令牌名 '--x'（tokenColor('--x')、dotSvg('--x')、var(${…?'--x':'--y'}) 等）
const refsIn = (s) => [
  ...[...s.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]),
  ...[...s.matchAll(/['"`](--[a-z][\w-]*)['"`]/g)].map((m) => m[1]),
];
const refSources = [
  { file: 'src/template.html', text: stripHtmlComments(stripJsComments(tpl)) },
  ...jsFiles.map((j) => ({ file: j.file, text: stripJsComments(j.text) })),
];
const undefinedRefs = [];
const used = new Set();
for (const { file, text } of refSources) {
  for (const r of refsIn(text)) { used.add(r); if (!defined.has(r)) undefinedRefs.push(`${file}：${r}`); }
}
// 令牌之间的别名引用（--chart-gen: var(--blue)）也算引用，且被引用者必须已定义
for (const m of tokScan.matchAll(/(--[\w-]+)\s*:([^;]*);/g)) {
  for (const r of refsIn(m[2])) { used.add(r); if (!defined.has(r)) undefinedRefs.push(`src/tokens.css（${m[1]}）：${r}`); }
}
ok(undefinedRefs.length === 0, `所有令牌引用都在 src/tokens.css 中有定义（引用 ${used.size} 个不同令牌）`,
  [...new Set(undefinedRefs)].map((x) => '      ' + x).join('\n'));
// 未引用的令牌：警告不失败。断点令牌只供查阅（@media 条件不能用 var()），不计入
const unused = defs.filter((d) => !used.has(d) && !d.startsWith('--bp-'));
if (unused.length) warns.push(`src/tokens.css 中 ${unused.length} 个令牌在 src/ 下暂无引用（已定义、供后续使用）：${unused.join(' ')}`);
console.log(`  ⚠ 未引用令牌 ${unused.length} 个（警告，不失败；断点 --bp-* 仅供查阅，不计）`);

/* ================= 三、字号 ================= */
console.log('\n══ 三、字号只能取现有取值（新增字号须先进设计系统）══');
const fsHits = [];
const allowed = new Set(FONT_SIZES.map(String));
const allowedSvg = new Set(SVG_FONT_SIZES.map(String));
const checkFs = (file, text, idx, raw, v, set = allowed) => {
  const n = String(Number(v));
  if (!set.has(n)) fsHits.push(`      ${file}:${lineOf(text, idx)}　${raw}`);
};
for (const t of [{ file: 'src/template.html', text: tpl, scan: stripHtmlComments(stripJsComments(tpl)) }, ...jsScan]) {
  const s = t.scan;
  for (const m of s.matchAll(/font-size\s*:\s*([^;"'`}\n]+)/g)) {
    const v = m[1].trim();
    if (/^var\(/.test(v) || v === 'inherit') continue;
    const px = /^(\d+(?:\.\d+)?)px$/.exec(v);
    if (!px) fsHits.push(`      ${t.file}:${lineOf(t.text, m.index)}　font-size:${v}（只允许 px 取值或令牌）`);
    else checkFs(t.file, t.text, m.index, 'font-size:' + v, px[1]);
  }
  // SVG font-size 属性（无单位即 px）；模板表达式 ${a?10.5:9} 里的每个数字都查
  for (const m of s.matchAll(/font-size="([^"]*)"/g)) {
    for (const x of m[1].match(/\d+(?:\.\d+)?/g) || []) checkFs(t.file, t.text, m.index, `font-size="${m[1]}"`, x, allowedSvg);
  }
  // canvas 字体（ctx.font='16px sans-serif'）
  for (const m of s.matchAll(/\.font\s*=\s*['"`](\d+(?:\.\d+)?)px/g)) checkFs(t.file, t.text, m.index, m[0], m[1]);
}
ok(fsHits.length === 0, `字号全部在允许集合内（CSS ${FONT_SIZES.length} 档：${FONT_SIZES.join(' / ')}；拓扑图 SVG 属性：${SVG_FONT_SIZES.join(' / ')}）`, fsHits.join('\n'));

/* ================= 四、圆角 ================= */
console.log('\n══ 四、圆角字面值只能是 0 / 50% / 复合值 / 令牌引用 ══');
const radHits = [];
const radOk = (v) => /^0(px)?$/.test(v) || v === '50%' || /var\(/.test(v) || /\s/.test(v) || v === 'inherit';
for (const t of targets) {
  for (const m of t.scan.matchAll(/border-radius\s*:\s*([^;"'`}\n]+)/g)) {
    const v = m[1].trim();
    if (!radOk(v)) radHits.push(`      ${t.file}:${lineOf(t.text, m.index)}　border-radius:${v}`);
  }
  for (const m of t.scan.matchAll(/\.style\.borderRadius\s*=\s*(['"`])(.*?)\1/g)) {
    if (!radOk(m[2].trim())) radHits.push(`      ${t.file}:${lineOf(t.text, m.index)}　style.borderRadius='${m[2]}'`);
  }
}
ok(radHits.length === 0, '单值圆角全部使用令牌（--r / --radius-*）', radHits.join('\n'));

/* ================= 五、主题覆盖块：完整性 ================= */
console.log('\n══ 五、主题覆盖块：深色主题覆盖全部颜色令牌 ══');
/** 解析一个选择器块里的「--名字: 值;」（值里可能含 url("data:…")，不含分号与花括号） */
const parseDecls = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const rootTokens = parseDecls(rootBody);
const themeBlocks = Object.fromEntries([...tokScan.matchAll(/\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g)].map((m) => [m[1], { decls: parseDecls(m[2]), body: m[2] }]));
const THEMES = ['clear', 'clear-dark', 'tech'];
ok(Object.keys(themeBlocks).sort().join() === 'clear-dark,tech', `主题覆盖块恰为 clear-dark / tech（实际：${Object.keys(themeBlocks).join(' / ') || '无'}；clear 即 :root）`);
// 「颜色令牌」= :root 里取值含颜色字面值的令牌（含阴影、焦点环、下拉箭头 data: URI）；别名（var(--x)）随被引用者变化，不要求重写
const HAS_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(|%23[0-9a-f]{6}/i;
const colorTokens = Object.keys(rootTokens).filter((k) => HAS_COLOR.test(rootTokens[k]));
for (const th of THEMES.slice(1)) {
  const blk = themeBlocks[th] || { decls: {}, body: '' };
  const miss = colorTokens.filter((k) => !(k in blk.decls));
  ok(miss.length === 0, `${th}：${colorTokens.length} 个颜色令牌全部有值`, '      缺：' + miss.join(' '));
  ok(/color-scheme\s*:\s*dark/.test(blk.body), `${th}：声明 color-scheme:dark（原生控件、滚动条随之变深）`);
}

/* ================= 六、主题对比度（WCAG 2.x） ================= */
console.log('\n══ 六、主题对比度：文字 ≥4.5:1，非文字 ≥3:1 ══');
/** 某主题下令牌的最终取值：:root ← 主题块覆盖，别名 var(--x[, 兜底]) 逐层解析 */
function themeValue(th, name, depth = 0) {
  const v = (th !== 'clear' && themeBlocks[th] && name in themeBlocks[th].decls) ? themeBlocks[th].decls[name] : rootTokens[name];
  if (v == null) throw new Error(`${th}：令牌 ${name} 未定义`);
  const m = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(v);
  if (m) { if (depth > 10) throw new Error(`${th}：${name} 别名循环`); return themeValue(th, m[1], depth + 1); }
  return v;
}
/** 颜色字符串 → [r,g,b,a]（0–255, 0–1）；只接受 #hex 与 rgb()/rgba() */
function parseColor(s) {
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]];
  throw new Error(`不是可解析的颜色：${s}`);
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);   // 源在上的 alpha 合成
const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** 前景 fg 在背景 bg 上的对比度；透明色按所在的底合成：bg 半透明时先叠到 base 上（缺省 card，base 自身再叠到 bg 上） */
function contrast(th, fg, bg, base = '--card') {
  const page = parseColor(themeValue(th, '--bg'));
  const baseC = base === '--bg' ? page : over(parseColor(themeValue(th, base)), page);
  const b = over(parseColor(themeValue(th, bg)), baseC);
  return ratio(over(parseColor(themeValue(th, fg)), b), b);
}
const TEXT = 4.5, UI = 3;
const PAIRS = [
  ...['--ink', '--ink2', '--ink3'].flatMap((f) => ['--card', '--bg', '--gray-bg'].map((b) => [f, b, TEXT])),
  ['--ink2', '--blue-bg', TEXT],
  ['--blue', '--card', TEXT], ['--blue', '--blue-bg', TEXT],
  ['--blue-ink', '--blue-bg', TEXT], ['--blue-ink', '--card', TEXT],
  ['--teal', '--teal-bg', TEXT], ['--amber', '--amber-bg', TEXT], ['--red', '--red-bg', TEXT],
  ['--coral', '--coral-bg', TEXT], ['--gray', '--gray-bg', TEXT],
  ['--on-fill', '--blue', TEXT], ['--on-fill', '--amber', TEXT],
  ['--tooltip-ink', '--tooltip-bg', TEXT],   // 气泡浮在方案卡上：半透明气泡底按 card 合成
  ['--error-text', '--card', TEXT],
  ['--teal', '--region-bg', TEXT],
  ['--field-border', '--field-bg', UI], ['--blue', '--field-bg', UI],   // 非文字：输入框边框、聚焦边框
  ['--map-label', '--map-ground', UI],
];
/* 已知例外：清晰浅色的网架图非路线省名 #9A9A95 在画布 #F7F8FA 上只有 2.66:1——源码原值，
   刻意弱化（路线外省份只作方位参照，路线上的省名用 --map-label-on、对比度充足）。清晰浅色外观不改，列为例外；
   深色两套主题不享受此例外，须 ≥3:1。 */
const KNOWN_EXCEPTIONS = { clear: ['--map-label/--map-ground'] };
for (const th of THEMES) {
  const rows = [];
  for (const [f, b, min] of PAIRS) {
    let r = NaN, err = '';
    try { r = contrast(th, f, b); } catch (e) { err = e.message; }
    rows.push({ key: `${f}/${b}`, r, min, err, exempt: (KNOWN_EXCEPTIONS[th] || []).includes(`${f}/${b}`) });
  }
  const bad = rows.filter((x) => x.err || (!(x.r >= x.min) && !x.exempt));
  const low = rows.filter((x) => !x.err && !x.exempt).sort((a, b) => a.r / a.min - b.r / b.min).slice(0, 4)
    .map((x) => `${x.key} ${x.r.toFixed(2)}`).join('，');
  const ex = rows.filter((x) => x.exempt).map((x) => `${x.key} ${x.r.toFixed(2)}（已知例外）`).join('，');
  ok(bad.length === 0, `${th}：对比度 ${rows.length} 对（文字 ≥4.5、非文字 ≥3）；最低 ${low}${ex ? '；' + ex : ''}`,
    bad.map((x) => `      ${x.key} ${x.err || x.r.toFixed(2) + ' < ' + x.min}`).join('\n'));
}

/* ---------- 汇总 ---------- */
if (warns.length) { console.log('\n⚠ 警告（不影响结果）：'); warns.forEach((w) => console.log('  · ' + w)); }
console.log(`\n${fail ? '❌' : '✅'} 结果：${pass} 项通过，${fail} 项失败，警告 ${warns.length} 条`);
process.exit(fail ? 1 : 0);
