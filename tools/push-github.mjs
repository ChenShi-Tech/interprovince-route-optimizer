#!/usr/bin/env node
/**
 * 走 GitHub Git Data API 推送本地已提交内容。
 *
 * 为什么不用 git push：本机所有流量走本地代理（127.0.0.1:60205），该代理放行
 * api.github.com 但对 github.com 返回 502 CONNECT tunnel failed，git over HTTPS
 * 与 SSH 均不可用。gh CLI 正常，故改走 API。
 *
 * ⚠️ 关键：必须用 base_tree 在远端现有树上叠加本地文件。
 *    早期实现用「本地文件重建整棵树」，只要本地不存在的文件就会从提交里消失 ——
 *    2026-09-14 因此误删了另一会话推送的 android/ 与 tests/ 共 18 个文件。
 *    现在改为 base_tree 叠加，并在推送前列出「远端有、本地没有」的文件，
 *    默认保留；确实要删时须显式加 --allow-delete。
 *
 * 用法：node tools/push-github.mjs [--allow-delete]
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const OWNER = 'ChenShi-Tech';
const REPO = 'interprovince-route-optimizer';
const BRANCH = 'main';
const ALLOW_DELETE = process.argv.includes('--allow-delete');

const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
const H = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'wb-push' };

async function api(method, p, body) {
  const r = await fetch(`https://api.github.com${p}`, {
    method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

const localFiles = execSync('git -c core.quotepath=false ls-files', { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
const message = execSync('git log -1 --pretty=%B', { encoding: 'utf8' }).trim();
const author = {
  name: execSync('git config user.name', { encoding: 'utf8' }).trim(),
  email: execSync('git config user.email', { encoding: 'utf8' }).trim(),
  date: new Date().toISOString(),
};

// ── 远端当前状态 ──
let parent = null, baseTree = null, remoteFiles = [];
try {
  const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  parent = ref.object.sha;
  const commit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${parent}`);
  baseTree = commit.tree.sha;
  const tree = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${parent}?recursive=1`);
  remoteFiles = tree.tree.filter((t) => t.type === 'blob').map((t) => t.path);
  console.log(`远端 ${BRANCH}：${parent.slice(0, 12)}（${remoteFiles.length} 个文件）`);
} catch {
  console.log('远端无 main 分支，将创建初始提交');
}

// ── 防误删检查 ──
const localSet = new Set(localFiles);
const willVanish = remoteFiles.filter((f) => !localSet.has(f));
if (willVanish.length) {
  console.log(`\n⚠️  远端有 ${willVanish.length} 个文件不在本地：`);
  willVanish.slice(0, 30).forEach((f) => console.log('     ' + f));
  if (willVanish.length > 30) console.log(`     …还有 ${willVanish.length - 30} 个`);
  if (ALLOW_DELETE) console.log('  --allow-delete 已指定，这些文件将从远端移除');
  else console.log('  使用 base_tree 叠加，这些文件会被保留');
}

// ── 上传本地文件 ──
const tree = [];
for (const p of localFiles) {
  const buf = fs.readFileSync(p);
  const b = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`,
    { content: buf.toString('base64'), encoding: 'base64' });
  tree.push({ path: p, mode: '100644', type: 'blob', sha: b.sha });
}
console.log(`  ✓ 上传 ${tree.length} 个本地文件`);

// base_tree：远端已有、本地没有的文件继续保留
const t = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`,
  baseTree && !ALLOW_DELETE ? { base_tree: baseTree, tree } : { tree });
const c = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`,
  { message, tree: t.sha, author, committer: author, parents: parent ? [parent] : [] });
console.log(`  ✓ commit ${c.sha.slice(0, 12)}`);

if (parent) await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: c.sha });
else await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: c.sha });
console.log(`  ✓ ${BRANCH} → ${c.sha.slice(0, 12)}`);

// ── 校验 ──
const final = await api('GET', `/repos/${OWNER}/${REPO}/commits?sha=${BRANCH}&per_page=5`);
const ft = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`);
const finalFiles = ft.tree.filter((x) => x.type === 'blob').map((x) => x.path);
const missing = localFiles.filter((f) => !finalFiles.includes(f));
console.log(`\n远端提交数 ${final.length}｜最新 ${final[0].sha.slice(0, 12)}｜文件 ${finalFiles.length} 个`);
if (missing.length) {
  console.error(`❌ 本地有 ${missing.length} 个文件未出现在远端：`);
  missing.slice(0, 10).forEach((f) => console.error('     ' + f));
  process.exit(1);
}
if (willVanish.length) {
  const kept = willVanish.filter((f) => finalFiles.includes(f)).length;
  console.log(`  远端原有 ${willVanish.length} 个本地没有的文件，保留了 ${kept} 个`);
}
console.log(`✅ 本地全部文件已在远端：https://github.com/${OWNER}/${REPO}`);
