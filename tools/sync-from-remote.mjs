#!/usr/bin/env node
/**
 * 把本地工作区同步到远端某个提交的文件状态（默认远端 main 的最新提交）。
 *
 * 背景：本机 `git fetch` / `git pull` 不可用（代理对 github.com 返 502），
 * 远端历史又是 tools/push-github.mjs 用 Git Data API 重建的（sha 与本地不同源），
 * 因此无法用普通 git 操作拉齐，只能用 API 逐文件比对后取回。
 *
 * 与 tools/restore-from-remote.mjs 的区别：后者只补「本地完全没有」的文件，
 * 本脚本还会覆盖「远端已改」的文件，并列出「远端已删」的文件。
 *
 * 用法：
 *   node tools/sync-from-remote.mjs                  # 只比对，不改工作区
 *   node tools/sync-from-remote.mjs --write          # 拉取差异文件并写入
 *   node tools/sync-from-remote.mjs --write --allow-delete   # 同时删除远端已移除的文件
 *   node tools/sync-from-remote.mjs <ref> --write    # 指定分支/提交
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OWNER = 'ChenShi-Tech';
const REPO = 'interprovince-route-optimizer';

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const allowDelete = argv.includes('--allow-delete');
const ref = argv.find((a) => !a.startsWith('--')) || 'main';

const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
const H = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'wb-sync',
};

async function api(p, extraHeaders) {
  const r = await fetch(`https://api.github.com${p}`, { headers: { ...H, ...extraHeaders } });
  if (!r.ok) throw new Error(`${p} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
}
async function json(p) { return (await api(p)).json(); }
async function rawBlob(sha) {
  const buf = Buffer.from(await (await api(`/repos/${OWNER}/${REPO}/git/blobs/${sha}`,
    { Accept: 'application/vnd.github.raw' })).arrayBuffer());
  return buf;
}

// —— 远端：递归树 ——
const head = await json(`/repos/${OWNER}/${REPO}/commits/${encodeURIComponent(ref)}`);
const tree = await json(`/repos/${OWNER}/${REPO}/git/trees/${head.commit.tree.sha}?recursive=1`);
if (tree.truncated) console.warn('⚠️  远端树被截断，结果可能不完整');
const remote = new Map(tree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]));

// —— 本地：HEAD 的树 ——
const localOut = execSync('git -c core.quotepath=false ls-tree -r HEAD', { encoding: 'utf8' });
const local = new Map();
for (const line of localOut.split('\n').filter(Boolean)) {
  const [meta, p] = line.split('\t');
  local.set(p, meta.split(' ')[2]);
}

const added = [];      // 远端有、本地没有
const modified = [];   // 两边都有、内容不同
const removed = [];    // 本地有、远端没有
for (const [p, sha] of remote) {
  if (!local.has(p)) added.push([p, sha]);
  else if (local.get(p) !== sha) modified.push([p, sha]);
}
for (const p of local.keys()) if (!remote.has(p)) removed.push(p);

const show = (title, list) => {
  console.log(`\n${title}（${list.length}）`);
  for (const it of list) console.log(`  ${Array.isArray(it) ? it[0] : it}`);
};
console.log(`远端 ${ref} = ${head.sha.slice(0, 8)}  ${head.commit.message.split('\n')[0]}`);
console.log(`本地 HEAD = ${execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()}`);
console.log(`文件数：远端 ${remote.size}，本地 ${local.size}`);
show('🆕 远端新增', added);
show('✏️  远端已改', modified);
show('🗑️  远端已删（本地仍在）', removed);

if (!write) {
  console.log('\n（干跑模式，未改动工作区。加 --write 执行同步）');
  process.exit(0);
}

const targets = [...added, ...modified];
console.log(`\n开始拉取 ${targets.length} 个文件…`);
let ok = 0;
for (const [p, sha] of targets) {
  const buf = await rawBlob(sha);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  console.log(`  ✓ ${p.padEnd(56)} ${(buf.length / 1024).toFixed(1)} KB`);
  ok++;
}

if (removed.length) {
  if (allowDelete) {
    for (const p of removed) { fs.rmSync(p, { force: true }); console.log(`  ✗ 已删除 ${p}`); }
  } else {
    console.log(`\n⚠️  有 ${removed.length} 个文件远端已删但本地仍在，默认保留。确认后用 --allow-delete 清理。`);
  }
}

console.log(`\n✅ 已写入 ${ok} 个文件。注意：改动尚未 git add，先跑测试再提交。`);
