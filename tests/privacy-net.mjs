#!/usr/bin/env node
/**
 * #1 上架合规取证：同意前零网络请求（可断言证据，非口头保证）。
 *
 * 全新 context（不预置隐私同意键）+ request 计数：
 *   ① 打开 index.html，静置 3s            ⇒ 断言 0 外部请求
 *   ② 测算页输入联动 + go('map')（路由层）⇒ 断言 0 外部请求 且 #v-map.hidden===true（真不可达）
 *       （弹窗遮罩会物理挡住底部导航 Tab，属预期；真实点击路径由 tests/e2e.mjs UX-10 验证）
 *   ③ 点「同意并继续」                    ⇒ 断言键已写 {v:1,at}、弹窗关闭；再进网架 ⇒ 断言可达
 *   ④ 重载（已同意）                      ⇒ 断言弹窗不再出现
 * 只统计 http(s) 请求：页面本身是 file:// 自包含单文件，合规口径是「零外部网络请求」。
 * 任一断言失败退出码非 0。
 *
 * 用法：node tests/privacy-net.mjs（先 node tools/build.mjs；playwright-core 在 tests/node_modules）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = path.join(root, 'index.html');
if (!fs.existsSync(indexHtml)) { console.error('缺少 index.html，先运行 node tools/build.mjs'); process.exit(2); }

const require = createRequire(path.join(root, 'tests/package.json'));
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (e) { console.error('找不到 playwright-core（应在 tests/node_modules 下；先在 tests/ 里 npm install）'); process.exit(2); }

/** 与 tools/ui-shots.mjs 同一套浏览器解析：显式指定 > playwright 默认 > 缓存目录最高版本 headless shell。 */
function resolveChrome() {
  if (process.env.UI_SHOTS_CHROME) return process.env.UI_SHOTS_CHROME;
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return undefined; } catch { /* 走兜底 */ }
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'), path.join(os.homedir(), 'AppData/Local/ms-playwright')].filter(Boolean);
  for (const c of caches) {
    if (!fs.existsSync(c)) continue;
    const dirs = fs.readdirSync(c).map((d) => ({ d, m: d.match(/^chromium_headless_shell-(\d+)$/) }))
      .filter((x) => x.m).sort((x, y) => +y.m[1] - +x.m[1]);
    for (const { d } of dirs) {
      for (const sub of fs.readdirSync(path.join(c, d))) {
        for (const exe of ['chrome-headless-shell', 'chrome-headless-shell.exe']) {
          const p = path.join(c, d, sub, exe);
          if (fs.existsSync(p)) return p;
        }
      }
    }
  }
  throw new Error('未找到可用的 Chromium：请安装 playwright 浏览器，或设置 UI_SHOTS_CHROME=/path/to/chrome');
}

let step = 0, failed = 0;
function ok(cond, label) {
  step++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failed++; console.log(`  ❌ ${label}`); }
}

const LAUNCH_ARGS = ['--force-color-profile=srgb', '--disable-gpu', '--num-raster-threads=1', '--disable-partial-raster'];
const exe = resolveChrome();
const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS, ...(exe ? { executablePath: exe } : {}) });
const url = pathToFileURL(indexHtml).href;

/* 干净 context：不预置任何键——隐私弹窗首启自动弹出 */
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const reqs = [];
page.on('request', (r) => { const u = r.url(); if (u.startsWith('http://') || u.startsWith('https://')) reqs.push(u); });
try {
  console.log(`页面：${url}`);
  await page.goto(url, { waitUntil: 'load' });

  console.log('步骤① 加载并静置 3s（同意前）');
  await page.waitForSelector('#privacy-box', { timeout: 4000 });
  ok(true, '首启自动弹出隐私政策弹窗');
  await page.waitForTimeout(3000);
  ok(reqs.length === 0, `静置 3s 零网络请求（实际 ${reqs.length} 个${reqs.length ? '：' + reqs.slice(0, 3).join('，') : ''}）`);

  console.log('步骤② 测算页输入联动 + go("map") 路由闸门（同意前）');
  await page.selectOption('#i-from', 'XJ');
  await page.waitForTimeout(300);
  await page.selectOption('#i-to', 'HA');
  await page.waitForTimeout(300);
  await page.evaluate(() => go('map'));   // 弹窗遮罩会物理挡住 #t-map（预期行为），路由层闸门用 evaluate 直验
  await page.waitForTimeout(300);
  ok(reqs.length === 0, `输入联动 + go("map") 后仍零外部请求（实际 ${reqs.length} 个）`);
  ok(await page.evaluate(() => document.getElementById('v-map').hidden) === true, '网架页不可达：#v-map 保持 hidden（真不可达）');
  ok(await page.locator('#privacy-box').count() === 1, 'go("map") 被拦且隐私弹窗在场（未同意不放行）');

  console.log('步骤③ 同意并继续');
  await page.locator('#privacy-box button', { hasText: '同意并继续' }).click();
  const key = await page.evaluate(() => JSON.parse(localStorage.getItem('iproute.v2.privacy') || 'null'));
  ok(!!key && key.v === 1 && !!key.at, `同意键已写 {v:1,at}（实际 ${JSON.stringify(key)}）`);
  ok(await page.locator('#privacy-box').count() === 0, '弹窗已关闭');
  // svg 拓扑底图离线可达：同意后进网架页仍应零外部请求
  // 同意会补弹导览（guide 键缺席，拍板②）：先跳过，避免导览卡片遮挡底部导航
  try {
    await page.waitForSelector('#guide-box', { timeout: 2500 });
    await page.locator('#guide-box button', { hasText: '跳过导览' }).click();
  } catch (e) { /* 导览未弹（例如已看过）则忽略 */ }
  await page.click('#t-map');
  await page.waitForSelector('#map-view svg', { timeout: 4000 });
  ok(await page.evaluate(() => document.getElementById('v-map').hidden) === false, '同意后网架页可达（内置 SVG 拓扑图）');
  ok(reqs.length === 0, `全程（含同意后 svg 底图）零外部请求（实际 ${reqs.length} 个）`);

  console.log('步骤④ 重载（已同意）');
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  ok(await page.locator('#privacy-box').count() === 0, '已同意重载不再弹弹窗');
} catch (e) {
  failed++;
  console.log(`  ❌ 异常：${String(e.message || e).slice(0, 200)}`);
} finally {
  await browser.close();
}
console.log(`\n${failed ? '❌' : '✅'} 隐私零请求取证：${step - failed}/${step} 条断言通过${failed ? '，退出码 1' : ''}`);
process.exit(failed ? 1 : 0);
