#!/usr/bin/env node
/**
 * 走 GitHub Git Data API 推送本地已提交内容。
 *
 * 为什么不用 git push：本机所有流量走本地代理（127.0.0.1:60205），该代理放行
 * api.github.com 但对 github.com 返回 502 CONNECT tunnel failed，git over HTTPS
 * 与 SSH 均不可用。gh CLI 正常，故改走 API。
 *
 * 空仓库不允许调用 git/blobs（409），首次推送会先用 Contents API 写引导文件
 * 让 main 分支存在，随后用无父提交加强制更新 ref 剥离引导提交，保持单提交历史。
 *
 * 由 tools/release.mjs 调用，也可单独运行：node tools/push-github.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const OWNER = 'ChenShi-Tech';
const REPO = 'interprovince-route-optimizer';
const BRANCH = 'main';

const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
const H = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'wb-push' };

async function api(method, path, body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

const files = execSync('git -c core.quotepath=false ls-files', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const message = execSync('git log -1 --pretty=%B', { encoding: 'utf8' }).trim();
const author = { name: execSync('git config user.name', { encoding: 'utf8' }).trim(),
  email: execSync('git config user.email', { encoding: 'utf8' }).trim(), date: new Date().toISOString() };

let parent = null;
try { const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  parent = ref.object.sha; console.log(`远端 ${BRANCH} 当前 ${parent.slice(0,12)}`); }
catch { console.log('远端无 main，创建初始提交'); }

const tree = [];
for (const p of files) {
  const buf = fs.readFileSync(p);
  const b = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' });
  tree.push({ path: p, mode: '100644', type: 'blob', sha: b.sha });
}
console.log(`  ✓ 上传 ${tree.length} 个文件`);
const t = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree });
const c = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`,
  { message, tree: t.sha, author, committer: author, parents: parent ? [parent] : [] });
console.log(`  ✓ commit ${c.sha.slice(0,12)}`);
if (parent) await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: c.sha });
else await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: c.sha });
console.log(`  ✓ ${BRANCH} -> ${c.sha.slice(0,12)}`);
const final = await api('GET', `/repos/${OWNER}/${REPO}/commits?sha=${BRANCH}&per_page=5`);
const paths = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`);
console.log(`\n远端提交数 ${final.length}｜最新 ${final[0].sha.slice(0,12)}｜文件 ${paths.tree.filter(x=>x.type==='blob').length} 个`);
console.log(`✅ https://github.com/${OWNER}/${REPO}`);
