#!/usr/bin/env node
/**
 * P1 门禁变异测试：用四个反事实验证「门禁确实会变红」。
 *
 *   ① 改一条费率    龙政直流 输电价 ×1.2（无依据的改价）
 *   ② 反转一个方向  锦苏直流（单向送电）标成双向
 *   ③ 删一个数据字段 龙政直流删掉「输电价」
 *   ④ 破坏一个占位符 src/template.html 的注入占位符改名
 *
 * 为什么需要它（H4）：baseline-check 会先用基线里的费率快照覆盖 CH，
 * 因此费率被改后它可以照样全绿；只有「只读核对 + 差异必须显式 --accept」的
 * baseline2 才能拦住。本脚本就是这条断言的自动化版本。
 *
 * 做法：在系统临时目录复制仓库（绝不改动工作区）→ 先在该副本内建立一份
 * 已被接受的基线（--accept，保证控制组是绿的）→ 施加变异 → 重跑门禁。
 * 判定：控制组为绿、变异后变红的门禁才算「拦住」；四组全部被拦住才算通过。
 *
 * 用法：
 *   node tools/test-mutation.mjs          # 跑完删除临时目录
 *   node tools/test-mutation.mjs --keep   # 保留临时目录便于排查
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const NODE = process.execPath;
const TMP = path.join(os.tmpdir(), 'iproute-mutation');

// 复制仓库时排除的目录/文件（版本库、并行 worktree、依赖、截图产物）
const EXCLUDE = new Set(['.git', '.worktrees', 'node_modules', 'shots']);
function copyRepo(dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(root, dst, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(root, src);
      if (!rel) return true;
      return !rel.split(path.sep).some((seg) => EXCLUDE.has(seg));
    },
  });
}

/** 从「已被接受基线」的控制组副本再复制一份，作为变异副本（保证控制组与变异组同起点）。 */
function copyFromBase(base, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(base, dst, { recursive: true });
}

/** 跑一个门禁脚本；返回 {code, tail}。 */
function runGate(cwd, script, args = []) {
  const r = spawnSync(NODE, [script, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const text = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
  const lines = text.split('\n').filter((l) => l.trim());
  return { code: r.status == null ? 1 : r.status, tail: lines[lines.length - 1] || '(无输出)' };
}

const GATES = [
  ['build.mjs 构建期断言', 'tools/build.mjs', []],
  ['baseline2 只读核对', 'tools/baseline2.mjs', []],
  ['baseline-check 实现回归', 'tools/baseline-check.mjs', []],
  ['test-modules 模块/纯度', 'tools/test-modules.mjs', []],
  ['test-data-share 两端数据', 'tools/test-data-share.mjs', []],
  ['test-hitcap 枚举上限', 'tools/test-hitcap.mjs', []],
  ['audit-fees 费率库审计', 'tools/audit-fees.mjs', []],
];

const MUTATIONS = [
  {
    name: '① 改一条费率：龙政直流 输电价 ×1.2（无依据）',
    where: 'data/fixed-prices.json',
    apply: (dir) => editJson(dir, (j) => {
      const p = (j.专项工程 || []).find((r) => /龙政/.test(r.名称 || ''));
      if (!p || typeof p.输电价 !== 'number') return false;
      p.输电价 = +(p.输电价 * 1.2).toFixed(2);
      return true;
    }),
  },
  {
    name: '② 反转一个方向：锦苏直流（单向）标记为双向',
    where: 'data/fixed-prices.json',
    apply: (dir) => editJson(dir, (j) => {
      const p = (j.专项工程 || []).find((r) => /锦苏/.test(r.名称 || ''));
      if (!p) return false;
      p.双向 = true;
      return true;
    }),
  },
  {
    name: '③ 删一个数据字段：龙政直流删掉「输电价」',
    where: 'data/fixed-prices.json',
    apply: (dir) => editJson(dir, (j) => {
      const p = (j.专项工程 || []).find((r) => /龙政/.test(r.名称 || ''));
      if (!p || !('输电价' in p)) return false;
      delete p.输电价;
      return true;
    }),
  },
  {
    name: '④ 破坏一个占位符：template.html 的注入占位符改名',
    where: 'src/template.html',
    gates: ['tools/build.mjs'],   // 占位符坏了就没有可信产物，只跑构建断言
    apply: (dir) => {
      const f = path.join(dir, 'src/template.html');
      const s = fs.readFileSync(f, 'utf8');
      if (!s.includes('/*__DATA__*/')) return false;
      fs.writeFileSync(f, s.replace('/*__DATA__*/', '/*_DATA_*/'));
      return true;
    },
  },
];

/** 读改写 data/fixed-prices.json；fn 返回 false 表示目标条目未找到（脚本需更新）。 */
function editJson(dir, fn) {
  const f = path.join(dir, 'data/fixed-prices.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const ok = fn(j);
  if (ok === false) return false;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  return true;
}

let failed = 0;
function cleanup(dir) { if (!keep) fs.rmSync(dir, { recursive: true, force: true }); }

console.log('=== 门禁变异测试（P1）：四个反事实必须变红 ===\n');

// ── 控制组：建立一份被接受的新基线，确认门禁在未变异时是绿的 ──
const base = path.join(TMP, 'base');
copyRepo(base);
console.log('控制组（未变异，副本 ' + base + '）');
const ctlBuild = runGate(base, 'tools/build.mjs');
if (ctlBuild.code !== 0) {
  console.error('  ❌ 副本构建失败，无法继续：' + ctlBuild.tail);
  process.exit(1);
}
const ctlAccept = runGate(base, 'tools/baseline2.mjs', ['--accept']);
if (ctlAccept.code !== 0) {
  console.error('  ❌ 副本内 --accept 生成基线失败，无法继续：' + ctlAccept.tail);
  process.exit(1);
}
const control = {};
for (const [label, script, args] of GATES) {
  const r = runGate(base, script, args);
  control[script] = r.code;
  const mark = r.code === 0 ? '✅' : '⚠️ 控制组已红（不计入拦截判定）';
  console.log(`  ${script.padEnd(28)} exit ${r.code} ${mark}`);
}

// ── 逐条反事实（副本从控制组复制，保证基线一致）──
for (const mut of MUTATIONS) {
  const dir = path.join(TMP, mut.name.slice(0, 1));
  copyFromBase(base, dir);
  if (mut.apply(dir) === false) {
    console.error(`\n${mut.name}\n  ❌ 变异目标在当前数据中不存在，请更新 tools/test-mutation.mjs`);
    failed++;
    continue;
  }
  console.log(`\n${mut.name}`);
  console.log(`  变异位置：${mut.where}`);
  const gates = (mut.gates || GATES.map((g) => g[1]));
  const catchers = [];
  for (const [label, script, args] of GATES) {
    if (!gates.includes(script)) continue;
    const r = runGate(dir, script, args);
    const ctlGreen = control[script] === 0;
    const caught = ctlGreen && r.code !== 0;
    if (caught) catchers.push(label);
    const note = caught ? '✅ 拦住'
      : r.code !== 0 ? '⚠️ 红，但控制组本来就是红的（不可归因）'
      : '绿';
    console.log(`  ${label.padEnd(28)} exit ${r.code}　${note}${r.code !== 0 ? '　' + r.tail.slice(0, 100) : ''}`);
  }
  if (catchers.length) console.log(`  → ✅ 已拦住（拦截者：${catchers.join('、')}）`);
  else { console.log('  → ❌ 拦不住：该反事实下没有任何门禁变红'); failed++; }
  if (!catchers.length) console.log(`  （临时目录保留：${dir}）`);
  else cleanup(dir);
}

console.log(`\n结果：${MUTATIONS.length - failed}/${MUTATIONS.length} 个反事实被门禁拦住。`);
if (!failed && !keep && fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
else if (fs.existsSync(TMP)) console.log(`临时目录保留：${TMP}（排查后手动删除，或下次运行时自动清理）`);
process.exit(failed ? 1 : 0);
