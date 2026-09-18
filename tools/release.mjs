#!/usr/bin/env node
/**
 * 一键发版：构建 → 全量测试 → 数据审计 → 提交 → 推送。
 *
 * 用法：
 *   node tools/release.mjs "提交信息"              # 完整流程
 *   node tools/release.mjs "提交信息" --no-push     # 只到提交为止
 *   node tools/release.mjs "提交信息" --mutation    # 额外跑门禁变异测试（四个反事实必须变红）
 *
 * 数据审计（发版前置，能跑就跑）：audit-fees.mjs（费率库单位换算/来源）、
 * audit-voltage-tariffs.mjs（用 pdftotext 逐值回对 1077号附件1 原件；缺 pdftotext 时
 * 明确打印跳过原因，不静默）、test-hitcap.mjs（枚举上限单测）。任一非 0 即中止发版。
 *
 * 门禁变异测试（tools/test-mutation.mjs）不进默认流程：它要复制仓库并重复构建，
 * 适合改动构建/门禁后手动跑一次，或用 --mutation 显式纳入本次发版。
 *
 * 注意：推送到 GitHub 走 Git Data API（本机 github.com:443 不可达，仅 api.github.com 通）。
 * 线上发布（发布为应用）需在对话中另行触发，脚本不含该步骤。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const msg = args.find((a) => !a.startsWith('--'));
const noPush = args.includes('--no-push');
const withMutation = args.includes('--mutation');
const NODE = process.execPath;

if (!msg) { console.error('用法：node tools/release.mjs "提交信息" [--no-push] [--mutation]'); process.exit(1); }

const run = (cmd, opts = {}) => {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { cwd: root, stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8', ...opts });
};

// ── 1. 构建 ──
run(`${NODE} tools/build.mjs`);
const iosWeb=path.join(root,'ios/app/InterprovinceRoute/InterprovinceRoute/index.html');
if(fs.existsSync(iosWeb)) fs.copyFileSync(path.join(root,'index.html'),iosWeb);

// ── 2. 全量测试 ──
const tests = [
  ['模块结构与算法纯度', 'tools/test-modules.mjs'],
  ['两端数据一致性', 'tools/test-data-share.mjs'],
  ['算法回归基线', 'tools/baseline-check.mjs'],
  ['全模型独立公式与适用期', 'tools/test-model-audit.mjs'],
  ['全国区域计费回归', 'tools/test-regional-billing.mjs'],
  ['受端参数预填行为', 'tools/test-prefill.mjs'],
  ['交互行为回归', 'tools/test-interaction.mjs'],
  ['设计令牌守卫', 'tools/test-design-tokens.mjs'],
];
let failed = 0;
for (const [name, f] of tests) {
  try {
    const out = run(`${NODE} ${f}`, { quiet: true });
    const tail = out.trim().split('\n').slice(-1)[0];
    console.log(`  ✅ ${name}　${tail}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log((e.stdout || '').split('\n').slice(-15).join('\n'));
  }
}
if (failed) { console.error(`\n${failed} 项测试未通过，已中止发版。`); process.exit(1); }
console.log('\n✅ 全部测试通过');

// ── 3. 数据审计（发版前置：能跑就跑；需外部工具而缺失时明确跳过并打印原因，不得静默）──
const audits = [
  ['费率库内部审计', 'tools/audit-fees.mjs'],
  ['分电压输配电价回对原件', 'tools/audit-voltage-tariffs.mjs', 'pdftotext'],
  ['枚举上限单测（hitCap）', 'tools/test-hitcap.mjs'],
];
if (withMutation) audits.push(['门禁变异测试（四反事实）', 'tools/test-mutation.mjs']);

// 外部工具探测：先认环境变量指定的绝对路径，再查 PATH（与 audit-voltage-tariffs.mjs 同口径）
const hasTool = (tool) => {
  if (process.env[tool.toUpperCase()]) return true;
  try { execSync(`command -v ${tool}`, { stdio: 'ignore' }); return true; } catch { return false; }
};
const skipReason = (f) => {
  if (f === 'tools/audit-voltage-tariffs.mjs' && !hasTool('pdftotext')) {
    return '未找到 pdftotext（该脚本用 pdftotext -layout 逐值回对 1077号附件1 原件；'
      + '安装 poppler 或设置 PDFTOTEXT=/path/to/pdftotext 后重跑）';
  }
  return null;
};
const summarize = (out, f) => {
  if (f.includes('audit-voltage')) {
    try {
      const j = JSON.parse(out.slice(out.indexOf('{')));
      return `不符 ${j.failures.length} 项` + (j.failures.length
        ? '：' + j.failures.slice(0, 2).map((x) => `${x.entity} ${x.field} ${x.actual}`).join('；') : '');
    } catch { /* 输出不是 JSON 时退回末行 */ }
  }
  const lines = out.trim().split('\n').filter((l) => l.trim());
  return lines[lines.length - 1] || '(无输出)';
};

console.log('\n── 数据审计（发版前置）──');
let auditFailed = 0;
for (const [name, f] of audits) {
  const why = skipReason(f);
  if (why) { console.log(`  ⏭ ${name}　跳过：${why}`); continue; }
  try {
    const out = run(`${NODE} ${f}${f.includes('audit-voltage') ? ' .' : ''}`, { quiet: true });
    console.log(`  ✅ ${name}　${summarize(out, f)}`);
  } catch (e) {
    auditFailed++;
    console.log(`  ❌ ${name}`);
    console.log((e.stdout || '').split('\n').filter((l) => l.trim()).slice(-12).join('\n'));
  }
}
if (auditFailed) { console.error(`\n${auditFailed} 项数据审计未通过，已中止发版。`); process.exit(1); }
console.log('\n✅ 数据审计通过');

// ── 4. 提交 ──
const status = run('git status --porcelain', { quiet: true }).trim();
if (!status) { console.log('\n工作区无改动，无需提交。'); process.exit(0); }
console.log('\n改动文件：');
console.log(status.split('\n').map((l) => '  ' + l).join('\n'));
fs.writeFileSync('/tmp/_relmsg.txt', msg);
run('git add -A');
run('git commit -q -F /tmp/_relmsg.txt');
const head = run('git log --oneline -1', { quiet: true }).trim();
console.log(`\n✅ 已提交：${head}`);

// ── 5. 推送（Git Data API） ──
if (noPush) { console.log('\n--no-push：跳过推送。'); process.exit(0); }
try {
  const out = run(`${NODE} tools/push-github.mjs`, { quiet: true });
  console.log(out.trim().split('\n').slice(-4).join('\n'));
} catch (e) {
  console.error('\n推送失败：');
  console.error((e.stdout || '') + (e.stderr || ''));
  console.error('提交已在本地完成，可稍后重跑推送。');
  process.exit(1);
}
