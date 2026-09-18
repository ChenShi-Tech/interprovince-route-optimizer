#!/usr/bin/env node
/**
 * 界面截图与逐像素比对（设计令牌 / 主题改造的「零视觉变化」验收工具）。
 *
 * 用法：
 *   node tools/ui-shots.mjs [输出目录] [--theme <名字>]    # 截一套图（默认 .runtime/ui-shots/<时间戳>/）
 *   node tools/ui-shots.mjs --compare <目录A> <目录B>      # 逐张逐像素比较，打印差异像素数；有差异退出码 1
 *
 * 截图对象是仓库里的构建产物 index.html（file:// 直开，与 APK 离线形态一致；先跑 node tools/build.mjs）。
 * 两个尺寸：390×844（deviceScaleFactor 2，手机主形态）与 1280×900（Web 三栏）。每个尺寸 6 个画面：
 *   calc-top     测算页首屏（视口）
 *   plan-card    方案卡（.card.plan 元素）
 *   timeline     交易连接时间线（.card.route-timeline 元素）
 *   params-open  参数弹层打开态（视口）
 *   map          网架图页（整页，内置 SVG 拓扑图）
 *   lib          费率库页（整页）
 * 另有 x- 开头的扩展画面（整页测算、价格条悬停、含区域网架的时间线、网架图叠加层、导览与错误提示、确认框、
 * 外观面板），覆盖上面 6 个画面照不到的配色。
 *
 * 确定性处理（两次截图之间只允许代码改动带来的差异）：
 *   - 每个画面用全新浏览器上下文，预置新手导览「已读」（与 tests/e2e.mjs 同口径），不带任何历史存档；
 *   - 截图关闭动画与过渡（animations:'disabled'）、隐藏光标；
 *   - 费率库页会显示构建时间 BUILD_TIME（每次构建都变），截图前把页面上的该字符串替换成固定占位。
 *
 * --theme <名字>：clear / clear-dark / tech。截图前把对应的外观偏好写进本机存储 iproute.v2.ui（页面 <head> 内联脚本
 *   据此设 data-theme，与真实用户切换走同一条路），并固定浏览器 prefers-color-scheme 为浅色；不给则为默认（清晰浅色）。
 *
 * 浏览器：用 tests/node_modules/playwright-core。若其默认版本的浏览器未安装，
 * 自动在 ms-playwright 缓存目录里找已安装的 chromium_headless_shell-*（取最高版本）兜底；
 * 也可用环境变量 UI_SHOTS_CHROME=/path/to/chrome 显式指定。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

/* ================= 比较模式 ================= */
/** 最小 PNG 解码：8 位、非隔行，灰度 / 灰度+α / RGB / RGBA（Chromium 截图只会产出这几种）。 */
function decodePng(buf) {
  const SIG = '89504e470d0a1a0a';
  if (buf.subarray(0, 8).toString('hex') !== SIG) throw new Error('不是 PNG 文件');
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (depth !== 8 || interlace || !bpp) throw new Error(`不支持的 PNG 格式（位深 ${depth}、色彩类型 ${ctype}、隔行 ${interlace}）`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  return { w, h, bpp, data: out };
}

/** 逐像素比较：返回差异像素数与差异包围盒（设备像素）。尺寸不同直接判全不同。 */
function diffPng(fa, fb) {
  const A = fs.readFileSync(fa), B = fs.readFileSync(fb);
  if (A.equals(B)) return { diff: 0 };
  const a = decodePng(A), b = decodePng(B);
  if (a.w !== b.w || a.h !== b.h) return { diff: Math.max(a.w * a.h, b.w * b.h), note: `尺寸不同 ${a.w}×${a.h} ≠ ${b.w}×${b.h}` };
  let diff = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  const px = (img, i) => img.bpp === 4 ? img.data.readUInt32BE(i * 4)
    : img.bpp === 3 ? ((img.data[i * 3] << 16) | (img.data[i * 3 + 1] << 8) | img.data[i * 3 + 2]) * 256 + 255
      : img.bpp === 2 ? img.data.readUInt16BE(i * 2) : img.data[i];
  for (let i = 0, n = a.w * a.h; i < n; i++) {
    if (px(a, i) !== px(b, i)) {
      diff++;
      const x = i % a.w, y = (i / a.w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { diff, note: diff ? `差异区域 x ${x0}–${x1}，y ${y0}–${y1}（设备像素，${a.w}×${a.h}）` : '' };
}

if (args[0] === '--compare') {
  const [dA, dB] = args.slice(1);
  if (!dA || !dB) { console.error('用法：node tools/ui-shots.mjs --compare <目录A> <目录B>'); process.exit(2); }
  const list = (d) => fs.readdirSync(d).filter((f) => f.endsWith('.png')).sort();
  const names = [...new Set([...list(dA), ...list(dB)])].sort();
  if (!names.length) { console.error('两个目录里都没有 PNG'); process.exit(2); }
  let bad = 0;
  for (const n of names) {
    const pa = path.join(dA, n), pb = path.join(dB, n);
    if (!fs.existsSync(pa) || !fs.existsSync(pb)) { bad++; console.log(`  ❌ ${n}　只在${fs.existsSync(pa) ? ' A ' : ' B '}中存在`); continue; }
    const r = diffPng(pa, pb);
    if (r.diff) bad++;
    console.log(`  ${r.diff ? '❌' : '✅'} ${n}　差异像素 ${r.diff}${r.note ? '　' + r.note : ''}`);
  }
  console.log(`\n${bad ? '❌' : '✅'} 结果：${names.length} 张，${names.length - bad} 张零差异，${bad} 张有差异`);
  process.exit(bad ? 1 : 0);
}

/* ================= 截图模式 ================= */
let outDir = null, theme = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--theme') theme = args[++i];
  else if (!args[i].startsWith('--')) outDir = args[i];
}
if (args.includes('--theme') && !theme) { console.error('--theme 需要一个名字'); process.exit(2); }
/* 主题 id → 外观偏好（与 src/app/ui/theme.js 的 resolveTheme 对应）。新增主题要加在这里：
   tools/test-design-tokens.mjs 核对这张表恰好覆盖 src/tokens.css 推导出的全部主题 */
const THEME_PREFS = { clear: { style: 'clear', mode: 'light' }, 'clear-dark': { style: 'clear', mode: 'dark' }, tech: { style: 'tech', mode: 'system' } };
if (theme && !THEME_PREFS[theme]) { console.error(`未知主题 ${theme}（可选：${Object.keys(THEME_PREFS).join(' / ')}）`); process.exit(2); }
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
outDir = path.resolve(outDir || path.join(root, '.runtime/ui-shots', stamp));
fs.mkdirSync(outDir, { recursive: true });

const indexHtml = path.join(root, 'index.html');
if (!fs.existsSync(indexHtml)) { console.error('缺少 index.html，先运行 node tools/build.mjs'); process.exit(2); }

const require = createRequire(path.join(root, 'tests/package.json'));
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (e) { console.error('找不到 playwright-core（应在 tests/node_modules 下；先在 tests/ 里 npm install）'); process.exit(2); }

/** 浏览器可执行文件：显式指定 > playwright 默认版本 > 缓存目录里已装的最高版本 headless shell。 */
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

const SIZES = [
  { tag: '390', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { tag: '1280', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
];
/* 每个画面：prepare 把页面带到目标状态；target 为 'viewport' / 'full'（整页）/ CSS 选择器（元素截图） */
const SCREENS = [
  { name: 'calc-top', target: 'viewport' },
  { name: 'plan-card', target: '.card.plan' },
  { name: 'timeline', target: '.card.route-timeline' },
  {
    name: 'params-open', target: 'viewport', async prepare(page) {
      await page.click('#btn-params');
      await page.waitForSelector('#param-sheet.open');
      await page.waitForTimeout(350);   // 过渡 .25s；截图本身也会关掉动画，这里再留余量
    },
  },
  {
    name: 'map', target: 'full', async prepare(page) {
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
    },
  },
  {
    name: 'lib', target: 'full', async prepare(page) {
      await page.click('#t-lib');
      await page.waitForSelector('#v-lib:not([hidden]) .card');
    },
  },
  /* ---- 扩展画面：覆盖上面 6 个画面照不到、但同样要保持像素不变的配色 ---- */
  { name: 'x-calc-full', target: 'full' },
  {
    // 到户价分档对照（完整明细内）：说明行、对照表与当前行蓝底高亮、偏低注记。
    // 元素高于视口时 sticky 页头 / fixed 底栏会被烘进元素中部，截图前临时隐藏（仅影响本画面）
    name: 'x-dst-tiers', target: '#d-detail', async prepare(page) {
      await page.evaluate(() => {
        state.includeDstCost = true; state.to = 'JS'; applyToProv();
        state._res = solveState(); renderCalc();
        document.getElementById('d-detail').open = true;
        document.querySelector('header').style.visibility = 'hidden';
        document.querySelector('nav').style.visibility = 'hidden';
      });
      await page.waitForSelector('#d-detail table');
    },
  },
  {
    // 价格组成条悬停提示（气泡底色 / 焦点环）
    name: 'x-pbar-tip', target: '.card.plan', async prepare(page) {
      await page.hover('.card.plan .pbar i');
    },
  },
  {
    // 含区域网架的方案：时间线里的区域共用网络卡、区域计费块
    name: 'x-timeline-region', target: '.card.route-timeline', async prepare(page) {
      const i = await page.evaluate(() => (state._res.rows || []).findIndex((r) => (r.regionItems || []).length));
      if (i < 0) throw new Error('默认省对下找不到含区域计费的方案');
      await page.evaluate((k) => { state.sel = k; renderCalc(); }, i);
      await page.waitForSelector('.card.route-timeline .region-network');
    },
  },
  {
    // 网架图叠加层：区域着色环与图例、断面晕圈与提示条、搜索结果、站点浮层
    name: 'x-map-overlays', target: 'full', async prepare(page) {
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      await mapRedraw(page, () => page.check('#i-mapregion'));
      await mapRedraw(page, () => page.selectOption('#i-mapsec', { index: 1 }));
      await page.fill('#map-q', '锦屏');
      await page.evaluate(() => document.querySelector('#map-view svg [data-st]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    },
  },
  {
    // 浮层：新手导览卡片 + 运行时错误提示条（head 里的全局兜底）
    name: 'x-overlays', target: 'viewport', async prepare(page) {
      await page.evaluate(() => { guideStart(); window.onerror('界面截图用的模拟错误'); });
      await page.waitForSelector('#guide-box [role=dialog]');
      await page.waitForSelector('#gerr-box');
    },
  },
  {
    // 应用内确认框（uiConfirm，替代原生 confirm）
    name: 'x-confirm', target: 'viewport', async prepare(page) {
      await page.evaluate(() => { uiConfirm('确认操作', '界面截图用的示例确认框。', '确定', '取消'); });
      await page.waitForSelector('[role=dialog]:not(.sheet-panel)');
    },
  },
  {
    // 外观面板（风格 / 明暗分段按钮；科技风格下「明暗」组禁用并附说明）
    name: 'x-appearance', target: 'viewport', async prepare(page) {
      await page.click('#btn-theme');
      await page.waitForSelector('#theme-sheet.open');
      await page.waitForTimeout(350);
    },
  },
];
/** 网架图重绘后 SVG 由 setTimeout(80ms) 注入：给旧 SVG 打标，等新 SVG 出现再继续。 */
async function mapRedraw(page, action) {
  await page.evaluate(() => { const g = document.querySelector('#map-view svg'); if (g) g.dataset.stale = '1'; });
  await action();
  await page.waitForSelector('#map-view svg:not([data-stale])');
}
function shotOpt(extra = {}) { return { animations: 'disabled', caret: 'hide', ...extra }; }

/** 把页面上显示的构建时间换成固定占位（每次构建都会变，与样式无关）。 */
async function normalize(page) {
  await page.evaluate(() => {
    const bt = typeof BUILD_TIME === 'string' ? BUILD_TIME : '';
    if (!bt) return;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes(bt)) n.nodeValue = n.nodeValue.split(bt).join('2000-01-01 00:00');
  });
}

const exe = resolveChrome();
/* 渲染确定性：固定 sRGB、软件光栅单线程、关闭局部重绘——实测不加时圆角抗锯齿偶发 1 级色差（约 1/4 概率 8 像素） */
const LAUNCH_ARGS = ['--force-color-profile=srgb', '--disable-gpu', '--num-raster-threads=1', '--disable-partial-raster'];
const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS, ...(exe ? { executablePath: exe } : {}) });
const url = pathToFileURL(indexHtml).href;
console.log(`浏览器：${exe || 'playwright 默认'}\n页面：${url}\n输出：${outDir}${theme ? `\n主题：data-theme="${theme}"` : ''}`);
let n = 0, errPages = 0;
try {
  for (const size of SIZES) {
    for (const scr of SCREENS) {
      const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: size.deviceScaleFactor, colorScheme: 'light' });
      await ctx.addInitScript((prefs) => {
        try {
          localStorage.setItem('iproute.v2.guide', '1');   // 存储不可用时导览会弹出，截图会暴露出来
          if (prefs) localStorage.setItem('iproute.v2.ui', JSON.stringify(prefs));
        } catch (e) { /* 同上 */ }
      }, theme ? THEME_PREFS[theme] : null);
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(String(e).split('\n')[0]));
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForSelector('.card.plan');
      const got = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      if (got !== (theme || 'clear')) throw new Error(`data-theme 应为 ${theme || 'clear'}，实际 ${got}`);
      await page.evaluate(() => document.fonts && document.fonts.ready);
      if (scr.prepare) await scr.prepare(page);
      await normalize(page);
      const png = scr.target === 'viewport' ? await page.screenshot(shotOpt())
        : scr.target === 'full' ? await page.screenshot(shotOpt({ fullPage: true }))
          : await page.locator(scr.target).first().screenshot(shotOpt());
      const file = path.join(outDir, `${size.tag}-${scr.name}.png`);
      fs.writeFileSync(file, png);
      n++;
      if (errs.length) errPages++;
      console.log(`  ${errs.length ? '❌' : '✅'} ${path.basename(file)}${errs.length ? '　页面报错：' + errs.join('；') : ''}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${errPages ? '❌' : '✅'} 结果：${n} 张截图已写入 ${path.relative(root, outDir) || outDir}${errPages ? `；其中 ${errPages} 个画面页面报错（截图可能不可信）` : ''}`);
process.exit(errPages ? 1 : 0);
