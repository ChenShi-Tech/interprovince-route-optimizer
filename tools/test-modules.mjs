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
ok(/function regionFee\(env,\s*e,\s*toCode\)/.test(costSrc),
  'regionFee(env, e, to) 按段判断是否计收，并显式接收行进方向的到达节点');
ok(/\.regional\)/.test(costSrc), 'regionFee 只对 regional（联络线）段计收，专项工程段不收');
ok(/function tariffOf\(e,\s*fromCode\)/.test(costSrc) && /tRev/.test(costSrc), 'tariffOf(e, from) 按行进方向取联络线的输电价（反向取 tRev）');
ok(/e\.incLoss\s*\?\s*qOut\s*:\s*q/.test(costSrc), '含线损的专项工程价按段后电量计费（1490号附件4第九条、第十八条）');
ok(/if\s*\(\s*e\.bidir\s*\)/.test(netSrc), 'buildAdj 只对 bidir 边挂反向（专项工程单向通行）');
ok(/sideOf\(edges\[0\],\s*nodes\[0\]/.test(netSrc), 'detourOf 按实际行进方向取起点');

console.log(`\n${fail ? '❌' : '✅'} 结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
