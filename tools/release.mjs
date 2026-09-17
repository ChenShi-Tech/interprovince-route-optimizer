#!/usr/bin/env node
/**
 * 一键发版：构建 → 全量测试 → 提交 → 推送。
 *
 * 用法：
 *   node tools/release.mjs "提交信息"        # 完整流程
 *   node tools/release.mjs "提交信息" --no-push   # 只到提交为止
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
const NODE = process.execPath;

if (!msg) { console.error('用法：node tools/release.mjs "提交信息" [--no-push]'); process.exit(1); }

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

// ── 3. 提交 ──
const status = run('git status --porcelain', { quiet: true }).trim();
if (!status) { console.log('\n工作区无改动，无需提交。'); process.exit(0); }
console.log('\n改动文件：');
console.log(status.split('\n').map((l) => '  ' + l).join('\n'));
fs.writeFileSync('/tmp/_relmsg.txt', msg);
run('git add -A');
run('git commit -q -F /tmp/_relmsg.txt');
const head = run('git log --oneline -1', { quiet: true }).trim();
console.log(`\n✅ 已提交：${head}`);

// ── 4. 推送（Git Data API） ──
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
