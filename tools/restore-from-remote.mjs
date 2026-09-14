#!/usr/bin/env node
/**
 * 从远端历史提交中恢复被误删的文件。
 *
 * 背景：tools/push-github.mjs 原实现用「本地文件构建整棵树」的方式生成提交，
 * 只要本地不存在的文件就会从该提交的树里消失。当远端有其它会话推送的内容而
 * 本地没有时，一次推送就会把它们删掉。本脚本从指定历史提交取回被删文件。
 *
 * 用法：node tools/restore-from-remote.mjs <commit_sha> [文件路径...]
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OWNER = 'ChenShi-Tech';
const REPO = 'interprovince-route-optimizer';
const ref = process.argv[2];
if (!ref) { console.error('用法：node tools/restore-from-remote.mjs <commit_sha>'); process.exit(1); }

const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
const H = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'wb-restore' };

async function api(p) {
  const r = await fetch(`https://api.github.com${p}`, { headers: H });
  if (!r.ok) throw new Error(`${p} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// 该提交的全部文件
const tree = await api(`/repos/${OWNER}/${REPO}/git/trees/${ref}?recursive=1`);
const remoteFiles = tree.tree.filter((t) => t.type === 'blob').map((t) => t.path);

// 本地已有
const local = new Set(execSync('git -c core.quotepath=false ls-files', { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean));
// 工作区里额外存在的（未纳入 git 的）
const onDisk = new Set();
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else onDisk.add(path.relative(process.cwd(), p));
  }
})(process.cwd());

const targets = process.argv.slice(3).length ? process.argv.slice(3)
  : remoteFiles.filter((f) => !local.has(f) && !onDisk.has(f));

console.log(`从 ${ref.slice(0, 12)} 恢复 ${targets.length} 个文件\n`);
let ok = 0;
for (const f of targets) {
  const blob = await api(`/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(f)}?ref=${ref}`);
  const buf = Buffer.from(blob.content, 'base64');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
  console.log(`  ✓ ${f.padEnd(52)} ${(buf.length / 1024).toFixed(1)} KB`);
  ok++;
}
console.log(`\n✅ 已恢复 ${ok} 个文件`);
console.log('注意：这些文件尚未纳入本地 git 索引，需 git add 后提交。');
