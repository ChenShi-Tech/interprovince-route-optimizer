// E2E 测试：省间路径优选测算（默认 http://127.0.0.1:8734/，可用 E2E_BASE 覆盖）
// 运行：BROWSER=chrome node tests/e2e.mjs   （需先 node tools/build.mjs 并启动静态服务）
// 多会话并行时用私有端口：E2E_BASE=http://127.0.0.1:8741/ BROWSER=chrome node tests/e2e.mjs
// 产出：tests/report.md + tests/shots/*.png + tests/results.json
// 未实现的功能用例在测试定义里标 skip（见文件内注释），报告单列「未实现，不计入通过率」。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 被测地址默认 8734（tests/dev-server.mjs 的默认端口）。多会话并行时该端口可能被别的
// 工作区占用，允许用 E2E_BASE 指向自己的私有端口（如 E2E_BASE=http://127.0.0.1:8741/）。
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8734/';
const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const results = [];

async function runTest(browser, def) {
  const rec = { id: def.id, section: def.section, title: def.title, steps: def.steps, expected: def.expected, actual: '', pass: false, skipped: false, skipReason: def.skip || '', shot: '', logs: { console: [], pageErrors: [], failedReq: [], badStatus: [] } };
  // 未实现的功能用例：显式跳过并列入报告，不参与通过率，也不假装通过。
  if (def.skip) {
    rec.skipped = true;
    rec.actual = '未实现，不计入通过率：' + def.skip;
    results.push(rec);
    console.log(`⏭️  ${def.id} ${def.title}（未实现，不计入通过率）`);
    return;
  }
  const context = await browser.newContext({ viewport: def.viewport || { width: 390, height: 844 } });
  // FR-3 新手导览预置「已读」：导览仅在安装后首启弹出，若不预置会闯进每个用例的点击路径与截图。
  // 导览自身行为由 UX-06 专项验证（清除该键后重载触发首启分支）。
  await context.addInitScript(() => { try { localStorage.setItem('iproute.v2.guide', '1'); } catch (e) {} });
  const page = await context.newPage();
  const logs = rec.logs;
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.console.push(`[${m.type()}] ${m.text().slice(0, 160)}`); });
  page.on('pageerror', e => logs.pageErrors.push(String(e).split('\n')[0].slice(0, 160)));
  page.on('requestfailed', r => logs.failedReq.push(`${(r.failure() && r.failure().errorText) || 'failed'} ${r.url().slice(0, 90)}`));
  page.on('response', r => { if (r.status() >= 400) logs.badStatus.push(`${r.status()} ${r.url().slice(0, 90)}`); });

  try {
    await def.run(page, s => { rec.actual = s; });
    if (!rec.actual) rec.actual = '通过';
    rec.pass = true;
  } catch (e) {
    rec.pass = false;
    rec.actual = (rec.actual ? rec.actual + ' ｜ ' : '') + '❌ ' + String(e.message || e).slice(0, 300);
  }
  try {
    await page.screenshot({ path: path.join(SHOTS, def.id + '.png'), fullPage: true });
    rec.shot = `shots/${def.id}.png`;
  } catch (e) { rec.shot = '(截图失败: ' + String(e.message).slice(0, 60) + ')'; }
  await context.close();
  results.push(rec);
  console.log(`${rec.pass ? '✅' : '❌'} ${def.id} ${def.title}${rec.pass ? '' : '\n   ' + rec.actual.slice(0, 200)}`);
}

/* 应用内确认框（uiConfirm，state.js）与参数弹出面板都带 role="dialog"，
   定位确认框必须排除 .sheet-panel，否则 Playwright strict mode 报 2 个匹配。 */
const confirmDlg = (page) => page.locator('[role="dialog"]:not(.sheet-panel)');
/* 参数弹出面板：费用口径 / 受端到户 / 网损承担方 / 通道范围 / 中长期占用等输入都在面板里，
   面板收起时这些控件不可见，必须先打开再操作。 */
const openParams = async (page) => {
  if (await page.evaluate(() => !document.getElementById('param-sheet').classList.contains('open'))) {
    await page.click('#btn-params');
    await page.waitForTimeout(150);
  }
};

/* 扩区点击命中审计（UI-HIT）：小控件用透明 ::after 把点击区扩到 44px（src/template.html「可点区域 ≥44px」一段），
   扩出去的部分不得盖住相邻的可点控件。对 scope 内每个挂了扩区（absolute、z-index:-1 的 ::after）的可见控件：
   ① 在可见矩形外 1–2px、扩区外沿与中线取样，elementFromPoint 命中的必须是控件自己或非可点元素；
      扩区之外的取样只追究「别的控件经它自己的扩区伸过来」，相邻控件本体贴得近不算；
   ② 反向：临时撤掉本控件的伪元素，扩区内同一点原本命中的不能是别的可点控件（否则就是本控件抢了邻居边缘的点击）。
      例外：叠在输入框里的按钮（密钥显隐）占用输入框给它预留的右内边距，那一段本来就归按钮。
   返回 { n: 检查的控件数, names: 控件清单, bad: 违例清单 }。 */
const hitAudit = (page, scope) => page.evaluate(async (scope) => {
  const CLICK = 'button,a[href],input,select,textarea,label,summary,[onclick],[role="button"],[role="radio"]';
  const host = document.querySelector(scope);
  if (!host) return { n: 0, names: [], bad: [`找不到 ${scope}`] };
  if (!document.getElementById('__hit-off-css')) {
    const st = document.createElement('style'); st.id = '__hit-off-css';
    st.textContent = '.__hit-off::after{display:none!important}'; document.head.appendChild(st);
  }
  const px = (v) => parseFloat(v) || 0;
  const name = (el) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : ''}「${(el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 14)}」`;
  const ctrls = [...host.querySelectorAll('*')].filter((el) => {
    const a = getComputedStyle(el, '::after');
    if (!(a.content !== 'none' && a.content !== 'normal' && a.position === 'absolute' && a.zIndex === '-1' && el.getClientRects().length)) return false;
    // change: grid-map-single-route-and-fixes：闭合 details 的内容在本环境仍有布局盒（可被取样命中），
    // 但对用户不可见、不可点（content-visibility:hidden 不绘制）——不属扩区守卫对象
    for (let a2 = el; a2 && a2 !== document.body; a2 = a2.parentElement) if (a2.tagName === 'DETAILS' && !a2.open) return false;
    return true;
  });
  const bad = [], names = [];
  for (const el of ctrls) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((r) => requestAnimationFrame(() => r()));
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (r.width < 1 || cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) continue;   // 收起的弹层等不在屏上的控件
    const own = (h) => h && (h === el || el.contains(h));
    const c0 = document.elementFromPoint(cx, cy);
    if (!own(c0)) { const cl = c0 && c0.closest(CLICK); if (cl && !cl.contains(el)) { bad.push(`${name(el)} 的中心被 ${name(cl)} 盖住`); continue; } }
    names.push(name(el));
    const cs = getComputedStyle(el), a = getComputedStyle(el, '::after');
    const R = {   // 伪元素相对控件的内边距盒定位：扩出后的命中矩形
      top: r.top + px(cs.borderTopWidth) + px(a.top), bottom: r.bottom - px(cs.borderBottomWidth) - px(a.bottom),
      left: r.left + px(cs.borderLeftWidth) + px(a.left), right: r.right - px(cs.borderRightWidth) - px(a.right),
    };
    const inR = (x, y) => x >= R.left && x < R.right && y >= R.top && y < R.bottom;
    const inRect = (q, x, y) => x >= q.left && x < q.right && y >= q.top && y < q.bottom;
    const xs = [r.left + 2, cx, r.right - 2], ys = [r.top + 2, cy, r.bottom - 2];
    const pts = [];
    for (const d of [1, 2]) {
      for (const x of xs) { pts.push([x, r.top - d, '上']); pts.push([x, r.bottom + d - 0.01, '下']); }
      for (const y of ys) { pts.push([r.left - d, y, '左']); pts.push([r.right + d - 0.01, y, '右']); }
    }
    if (R.top < r.top - 0.5) for (const x of xs) pts.push([x, R.top + 0.5, '上扩区外沿'], [x, (R.top + r.top) / 2, '上扩区']);
    if (R.bottom > r.bottom + 0.5) for (const x of xs) pts.push([x, R.bottom - 0.5, '下扩区外沿'], [x, (R.bottom + r.bottom) / 2, '下扩区']);
    if (R.left < r.left - 0.5) for (const y of ys) pts.push([R.left + 0.5, y, '左扩区外沿'], [(R.left + r.left) / 2, y, '左扩区']);
    if (R.right > r.right + 0.5) for (const y of ys) pts.push([R.right - 0.5, y, '右扩区外沿'], [(R.right + r.right) / 2, y, '右扩区']);
    for (const [x, y, side] of pts) {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const at = `${side}(${x.toFixed(1)},${y.toFixed(1)})`;
      const h = document.elementFromPoint(x, y);
      if (h && !own(h)) {   // ① 命中了别人
        const cl = h.closest(CLICK);
        if (cl && !cl.contains(el)) {
          const viaExt = !inRect(cl.getBoundingClientRect(), x, y);
          if (inR(x, y) || viaExt) bad.push(`${name(el)} ${at} → ${name(cl)}${viaExt ? '（经其扩区）' : ''}`);
        }
        continue;
      }
      if (!h || !inR(x, y) || inRect(r, x, y)) continue;
      el.classList.add('__hit-off');   // ② 命中了自己的扩区：撤掉扩区，看这一点原本归谁
      const u = document.elementFromPoint(x, y);
      el.classList.remove('__hit-off');
      const cl = u && !own(u) && u.closest(CLICK);
      if (!cl || cl.contains(el)) continue;
      if (/^(INPUT|TEXTAREA)$/.test(cl.tagName)) {
        const ic = getComputedStyle(cl), ir = cl.getBoundingClientRect();
        if (x >= ir.right - px(ic.paddingRight) - px(ic.borderRightWidth)) continue;
      }
      bad.push(`${name(el)} ${at} 扩区压住 ${name(cl)}`);
    }
  }
  return { n: names.length, names, bad: [...new Set(bad)] };
}, scope);

const G = BASE, DCL = { waitUntil: 'domcontentloaded', timeout: 20000 };
const tests = [

  /* ================= 主流程 ================= */
  {
    id: 'F-01', section: '主流程', title: '首次加载默认测算',
    steps: '打开 http://127.0.0.1:8734/',
    expected: '默认四川→江苏；自动渲染可选路线下拉（默认推荐 #1）与选中方案详情；无页面脚本错误',
    async run(page, set) {
      await page.goto(G, DCL);
      ok(await page.locator('#i-from').inputValue() === 'SC', '出发地应为 SC(四川)');
      ok(await page.locator('#i-to').inputValue() === 'JS', '目的地应为 JS(江苏)');
      // change: grid-map-single-route-and-fixes：路线卡片改为下拉（#i-calcroute），默认选中推荐 #1
      const optCount = await page.locator('#i-calcroute option').count();
      ok(optCount > 0, '可选路线下拉应至少 1 项，实际 ' + optCount);
      const cur = await page.evaluate(() => { const el = document.getElementById('i-calcroute'); return el.options[el.selectedIndex]?.textContent || ''; });
      ok(cur.includes('#1') && cur.includes('推荐'), `下拉应默认选中推荐 #1，实际「${cur.slice(0, 30)}」`);
      // 修正(2026-09-18)：落地价元素已由 .big 改为方案卡 .plan-price b / 顶部主卡 .hero-v（calc.js renderDetail），
      // 断言语义（落地价已渲染且为数字）不变。
      const planPrice = (await page.locator('.plan-price b').first().innerText()).trim();
      ok(/^[\d.]+$/.test(planPrice), `落地价未渲染，实际「${planPrice}」`);
      const hero = (await page.locator('.hero-v').first().innerText()).trim();
      ok(/^[\d.]+/.test(hero), `顶部主卡落地价未渲染，实际「${hero}」`);
      const hd = (await page.locator('.hd-route').first().innerText()).trim();
      set(`默认 SC→JS；下拉 ${optCount} 项默认「${cur.slice(0, 24)}」；方案卡落地价 ${planPrice} 元/MWh；pageerror=${logs0(page)}`);
    },
  },
  {
    id: 'F-02', section: '主流程', title: '切换省对自动重算+省级参数联动',
    steps: '出发地下拉选「宁夏」，目的地下拉选「浙江」',
    expected: '选完即重算（无按钮）；受端输配电价/基金附加自动换成浙江值；详情线路串以宁夏开头',
    async run(page, set) {
      // 适配 main 通道方向重构（2026-09-15）：原「上海→四川」在方向性通道模型下
      // 无连通路径（复奉直流单向 SC→SH），页面渲染错误卡片无 .hd-route；
      // 改用灵绍直达省对 宁夏→浙江，断言语义不变。
      await page.goto(G, DCL);
      const before = await page.evaluate(() => state.pNet);
      await page.selectOption('#i-from', 'NX');
      await page.selectOption('#i-to', 'ZJ');
      const after = await page.evaluate(() => state.pNet);
      const dstNet = await page.evaluate(() => PV['ZJ'].net);
      ok(after === dstNet, `pNet 应联动为浙江 ${dstNet}，实际 ${after}`);
      const hd = (await page.locator('.hd-route').first().innerText()).trim();
      ok(hd.startsWith('宁夏'), `详情应以宁夏开头，实际「${hd.slice(0, 20)}」`);
      set(`pNet ${before}→${after}（=浙江参数 ${dstNet}）；详情「${hd.slice(0, 40)}」`);
    },
  },
  {
    id: 'F-03', section: '主流程', title: '路线下拉切换方案',
    steps: '在「选择路线」下拉选第 2 条候选',
    expected: 'state.sel=1；下拉呈高亮选中态（.on）；详情标题变为「方案 #2」',
    async run(page, set) {
      await page.goto(G, DCL);
      // change: grid-map-single-route-and-fixes：路线卡片改为下拉切换
      await page.selectOption('#i-calcroute', '1');
      ok(await page.evaluate(() => state.sel) === 1, 'state.sel 应为 1');
      const onCls = await page.evaluate(() => document.getElementById('i-calcroute').classList.contains('on'));
      ok(onCls, '选择非推荐路线后下拉应为高亮选中态（.on）');
      // 修正(2026-09-18)：详情标题已由 .sec-title（现仅用于「可选路线 / 交易连接与区域计费」）改为方案卡 .plan-no。
      const hd = await page.locator('.plan-no').first().innerText();
      ok(hd.includes('方案 #2'), `详情标题应含「方案 #2」，实际「${hd.trim().slice(0, 20)}」`);
      set(`sel=1，下拉 .on 高亮，详情「${hd.trim().slice(0, 12)}」`);
    },
  },
  {
    id: 'F-04', section: '主流程', title: '路线排序固定按落地价升序（排序按钮已移除）',
    steps: '检查页面无排序控件；读取可行方案的落地价序列与列表页脚说明',
    expected: '排序口径固定为「按价格从低到高」（state.sortBy=A，界面不再提供过网费/送端收益排序）；可见可行方案 landed 单调不减',
    async run(page, set) {
      await page.goto(G, DCL);
      // 修正(2026-09-18)：REQ 重构（570473e）后排序按钮整体移除，排序固定按落地价升序（test-interaction 亦守住该口径）。
      // 原用例点击「过网费」按钮断言 sortBy=B，属已移除的功能，改为断言当前唯一存在的排序行为。
      const btns = await page.locator('.seg.small button', { hasText: /过网费|送端收益|落地价/ }).count();
      ok(btns === 0, `排序按钮应已移除，实际仍有 ${btns} 个`);
      const foot = await page.locator('.rlist-foot').first().innerText();
      ok(foot.includes('按价格从低到高'), `列表页脚应标注排序口径，实际「${foot.trim().slice(0, 30)}」`);
      const r = await page.evaluate(() => ({
        sortBy: state.sortBy,
        landed: state._res.rows.filter(x => x.feasible).map(x => x.landed),
      }));
      const sorted = r.landed.every((v, i) => i === 0 || r.landed[i - 1] <= v + 1e-9);
      ok(sorted, `可行方案应按落地价升序，实际前 5 项 ${r.landed.slice(0, 5).map(v => v.toFixed(1)).join(',')}`);
      ok(r.sortBy === 'A', `排序口径应固定为 A，实际 ${r.sortBy}`);
      set(`无排序控件；页脚「${foot.trim()}」；可行方案 ${r.landed.length} 条按落地价升序（首项 ${r.landed[0].toFixed(1)} 元/MWh）`);
    },
  },
  {
    id: 'F-05', section: '主流程', title: '电量参数重算（总额线性放大）',
    steps: '电量输入 3000 后失焦',
    expected: '费用总额变为原 3 倍；落地单价不变',
    async run(page, set) {
      await page.goto(G, DCL);
      // 修正(2026-09-17)：电量放大 3 倍可能让原最优路线越限沉底（如 SC>ZJ>JS 在 3000MW 下超容）,
      // rows[0] 随之换路线,旧断言「前后 rows[0] 相比」会误报非线性。改为锁定同一条路线对比。
      const base = await page.evaluate(() => {
        const r = state._res.rows[0];
        return { key: r.nodes.join('>'), total: r.yuan.total, landed: r.landed };
      });
      await page.fill('#i-qty', '3000');
      await page.locator('#i-qty').blur();
      const after = await page.evaluate((key) => {
        state.showBad = true;   // 原路线可能越限沉底,纳入越限方案保证可追踪
        state._res = solve(state, algoData());
        const r = state._res.rows.find(x => x.nodes.join('>') === key);
        if (!r) throw new Error('原最优路线在候选集中消失');
        return { total: r.yuan.total, landed: r.landed };
      }, base.key);
      ok(Math.abs(after.total - base.total * 3) < 1, `同路线总额应 ${base.total * 3}，实际 ${after.total}`);
      ok(after.landed === base.landed, `单价应不变 ${base.landed} vs ${after.landed}`);
      set(`同一路线(${base.key})总额 ${base.total.toFixed(0)}→${after.total.toFixed(0)}（×3）；单价保持 ${base.landed} 元/MWh`);
    },
  },
  {
    id: 'F-06', section: '主流程', title: '网损承担方切换为送端',
    steps: '「价格与口径」中网损承担方选「送端承担」',
    expected: 'comp.loss=0；费用拆解表不再出现「网损折价」行',
    async run(page, set) {
      await page.goto(G, DCL);
      // 修正(2026-09-18)：参数（含网损承担方）已从页内展开区移入「参数」弹出面板（122e970），
      // 面板收起时控件不可见，须先打开面板再操作；断言语义不变。
      await openParams(page);
      await page.selectOption('#i-bearer', '0');
      const loss = await page.evaluate(() => state._res.rows[0].comp.loss);
      ok(loss === 0, `comp.loss 应为 0，实际 ${loss}`);
      const row = await page.evaluate(() => {
        const tr = [...document.querySelectorAll('#d-detail tr')].find(t => t.textContent.includes('网损折价'));
        return tr ? tr.textContent.replace(/\s+/g, ' ').trim() : '(未找到行)';
      });
      // 修正(2026-09-17)：计费明示后网损行文案含「，含线损段不另收」后缀（Dphys≠D 的段）,正则放宽括号内文案
      ok(/^网损折价（受端承担部分[^）]*）\s*0\.0/.test(row), `网损行单价应显示 0.0，实际「${row.slice(0, 50)}」`);
      const landed = await page.evaluate(() => state._res.rows[0].landed);
      set(`lossBearer=0；comp.loss=0；网损行显示 0；落地单价 ${landed} 元/MWh`);
    },
  },
  {
    id: 'F-07', section: '主流程', title: '勾选「含越限」展示不可行路线',
    steps: '勾选「含越限」复选框',
    expected: 'showBad=true；下拉候选数不少于之前；顶部显示「共 X 条候选 · 可行 Y 条」',
    async run(page, set) {
      await page.goto(G, DCL);
      // 修正(2026-09-18)：跳数输入已移除（界面固定取上限 MAX_HOPS=10），原 #i-hops 选择作废。
      await page.selectOption('#i-to', 'SH');
      const before = await page.locator('#i-calcroute option').count();
      await page.locator('.tg input').check();
      const after = await page.locator('#i-calcroute option').count();
      ok(await page.evaluate(() => state.showBad) === true, 'showBad 应为 true');
      ok(after >= before, `下拉候选应不减少：${before}→${after}`);
      const hint = await page.locator('.sec-title .hint').first().innerText();
      ok(/共 \d+ 条候选/.test(hint), `提示文案异常：${hint}`);
      set(`含越限前候选 ${before} 条、勾选后 ${after} 条；提示「${hint.trim()}」`);
    },
  },
  {
    id: 'F-08', section: '主流程', title: '展开全部路线（>18 条）',
    steps: '四川→上海，点「展开全部」',
    expected: '默认只列成本接近的若干条；点「展开全部」后下拉候选等于全部候选，展开入口消失（showAll=true）',
    async run(page, set) {
      await page.goto(G, DCL);
      // 修正(2026-09-18)：跳数输入已移除（固定 MAX_HOPS=10），原 #i-hops=5 选择作废。
      await page.selectOption('#i-to', 'SH');
      const btn = page.locator('button', { hasText: '展开全部' });
      ok(await btn.count() > 0, '应出现「展开全部」按钮');
      await btn.first().click();
      const n = await page.locator('#i-calcroute option').count();
      const rows = await page.evaluate(() => state._res.rows.length);
      ok(rows > 18, `候选应 >18 条才有展开意义，实际 ${rows}`);
      ok(n === rows, `下拉项 ${n} 应等于候选总数 ${rows}`);
      // 修正(2026-09-18)：展开后 hiddenN=0，按钮整体移除（renderRouteList 只在 hiddenN>0 时渲染切换按钮），
      // 原期望「按钮变收起」在现实现里不可达；断言语义改为「展开后不再有展开入口且 showAll 已置位」。
      ok(await page.evaluate(() => state.showAll === true), 'state.showAll 应为 true');
      ok(await page.locator('button', { hasText: '展开全部' }).count() === 0, '展开后不应再出现「展开全部」按钮');
      set(`展开后下拉 ${n} 项 = 候选总数 ${rows}；展开入口消失（showAll=true）`);
    },
  },
  {
    id: 'F-09', section: '主流程', title: '底部 Tab 跳转（测算/网架图/费率库）',
    steps: '依次点击网架图、费率库、测算 Tab',
    expected: '对应 section 显示、其余隐藏（hidden 属性切换）',
    async run(page, set) {
      await page.goto(G, DCL);
      const vis = async id => page.evaluate(v => !document.getElementById(v).hidden, id);
      await page.click('#t-map');
      ok(await vis('v-map') && !(await vis('v-calc')), '网架图应显示且测算隐藏');
      await page.click('#t-lib');
      ok(await vis('v-lib') && !(await vis('v-map')), '费率库应显示且网架图隐藏');
      // 修正(2026-09-15)：通道卡片类名已由 .lib-row 改为 .libcard（lib.js:54），原选择器恒为 0
      ok(await page.locator('.libcard').count() > 0, '通道列表未渲染');
      await page.click('#t-calc');
      ok(await vis('v-calc') && !(await vis('v-lib')), '测算应显示且费率库隐藏');
      set('三个 Tab 均正确切换，section 的 hidden 属性与按钮高亮同步');
    },
  },

  /* ================= 交互 ================= */
  {
    id: 'I-01', section: '交互', title: '省份下拉：省份齐全 + 同省互斥禁用',
    steps: '检查出发地下拉选项数；检查目的地中「四川」是否禁用',
    expected: '选项数与省级参数表一致；目的地中与出发地相同的省份 disabled',
    async run(page, set) {
      await page.goto(G, DCL);
      const n = await page.locator('#i-from option').count();
      const exp = await page.evaluate(() => Object.keys(DATA.PV).length);
      ok(n === exp, `省份下拉应含全部 ${exp} 个省份（含 2026-09-17 补录的海南），实际 ${n}`);
      const dis = await page.evaluate(() => { const o = [...document.getElementById('i-to').options].find(o => o.value === 'SC'); return o && o.disabled; });
      ok(dis === true, '目的地中四川应被禁用');
      set(`下拉 ${n} 项（=省级参数省份数）；目的地中四川 disabled=${dis}`);
    },
  },
  {
    id: 'I-02', section: '交互', title: '「完整明细」折叠展开',
    steps: '点击「完整明细」summary 展开',
    expected: '默认收起（无 open 属性）；点击后展开且费用拆解表在 DOM 中',
    async run(page, set) {
      await page.goto(G, DCL);
      const det = page.locator('#d-detail');
      ok((await det.getAttribute('open')) === null, '默认应收起');
      await det.locator('summary').click();
      ok((await det.getAttribute('open')) !== null, '点击后应展开');
      const tables = await page.locator('#d-detail table tr').count();
      ok(tables > 5, `费用拆解表应有>5 行，实际 ${tables}`);
      set(`open=null→已展开；费用拆解表 ${tables} 行`);
    },
  },
  {
    id: 'I-03', section: '交互', title: '费率库改价：即时生效+本地持久化',
    steps: '费率库 Tab，把第 1 条通道输电价改为 99 后失焦',
    expected: 'CH[0].t=99；顶部徽标变「费率已本地修改」（带 .mod、title 为全文），320px 下也不截断、按钮不被挤出屏；localStorage 已写入',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-lib');
      // 修正(2026-09-15)：输入框在 details.libcard 内，卡片默认收起，需先展开再 fill
      const card = page.locator('.libcard').first();
      await card.locator('summary').click();
      const inp = card.locator('.lib-io input').first();
      await inp.fill('99');
      await inp.blur();
      ok(await page.evaluate(() => CH[0].t) === 99, 'CH[0].t 应为 99');
      const badge = await page.locator('#verBadge').innerText();
      ok(badge.includes('本地修改'), `徽标应提示修改，实际「${badge}」`);
      const bs = await page.evaluate(() => { const b = document.getElementById('verBadge'); return { t: b.textContent, title: b.title, mod: b.classList.contains('mod') }; });
      ok(bs.mod && bs.title === bs.t, `修改态徽标应带 .mod 且 title 等于全文，实际 ${JSON.stringify(bs)}`);
      // 窄屏：修改态徽标不收缩、不截断，由标题让位；两个按钮仍在屏内
      await page.setViewportSize({ width: 320, height: 700 });
      const nw = await page.evaluate(() => {
        const b = document.getElementById('verBadge'), help = document.getElementById('btn-help').getBoundingClientRect();
        return { cut: b.scrollWidth > b.clientWidth + 0.5, helpRight: Math.round(help.right), vw: innerWidth, over: document.documentElement.scrollWidth - innerWidth };
      });
      ok(!nw.cut, '320px 下修改态徽标不应被截断');
      ok(nw.helpRight <= nw.vw && nw.over <= 0, `320px 下「帮助」按钮应在屏内且页面无横向溢出，实际右沿 ${nw.helpRight}/${nw.vw}，溢出 ${nw.over}px`);
      const ls = await page.evaluate(() => JSON.parse(localStorage.getItem('iproute.v2.lib')).ch[0].t);
      ok(ls === 99, `localStorage 应存 99，实际 ${ls}`);
      set(`CH[0].t=99；徽标「${badge}」（.mod，title 全文，320px 不截断）；localStorage 已持久化`);
    },
  },
  {
    id: 'I-04', section: '交互', title: '「恢复检索原始值」应用内确认框（取消/确认）',
    steps: '先改 CH[0].t=123；点恢复→取消；再点恢复→确认',
    expected: '取消：值不变、徽标仍是「费率已本地修改」；确认：恢复为 DATA.CH 原始值，徽标回到默认文案',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-lib');
      await page.evaluate(() => { setCh(0, 't', 123); });
      const badge0 = await page.evaluate(() => document.getElementById('verBadge').dataset.base);
      const btn = page.locator('button', { hasText: '恢复检索原始值' });
      // 修正(2026-09-18)：role=dialog 现有两个（应用内确认框 + 参数弹出面板 .sheet-panel），须排除后者。
      const dlg = confirmDlg(page);
      await btn.click();
      await dlg.waitFor({ state: 'visible', timeout: 3000 });
      const msg = await dlg.innerText();
      ok(msg.includes('恢复为检索原始值'), `确认框文案异常：「${msg}」`);
      await dlg.locator('button', { hasText: '取消' }).click();
      ok(await page.evaluate(() => CH[0].t) === 123, '取消后应保持 123');
      ok(await page.evaluate(() => document.getElementById('verBadge').classList.contains('mod')), '取消后徽标应仍是修改态');
      await btn.click();
      await dlg.waitFor({ state: 'visible', timeout: 3000 });
      await dlg.locator('button', { hasText: '恢复原始值' }).click();
      const restored = await page.evaluate(() => CH[0].t === DATA.CH[0].t);
      ok(restored, '确认后应恢复原始值');
      const bb = await page.evaluate(() => { const b = document.getElementById('verBadge'); return { t: b.textContent, title: b.title, mod: b.classList.contains('mod') }; });
      ok(!bb.mod && bb.t === badge0 && bb.title === badge0, `恢复后徽标应回到默认「${badge0}」，实际 ${JSON.stringify(bb)}`);
      set(`应用内确认框「${msg.slice(0, 18)}…」；取消保持 123；确认后恢复 ${await page.evaluate(() => DATA.CH[0].t)}`);
    },
  },
  {
    id: 'I-05', section: '交互', title: '「导出 JSON」触发浏览器下载',
    steps: '费率库 Tab 点「导出 JSON」',
    expected: '触发下载，文件名 费率库-v2.json，内容含全部通道（与 CH.length 一致，当前 64）',
    async run(page, set) {
      await page.goto(G, DCL);
      const expectN = await page.evaluate(() => CH.length);
      await page.click('#t-lib');
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 5000 }),
        page.locator('button', { hasText: '导出 JSON' }).click(),
      ]);
      const p = path.join(SHOTS, 'export-lib.json');
      await dl.saveAs(p);
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      // 适配 main 联络线清单修订（2026-09-15）：删除 6 条物理不存在的联络线，
      // 通道数 70→64；断言改为与运行时 CH.length 动态对齐，避免数据变更再过期。
      ok(j.ch && j.ch.length === expectN, `导出应含 ${expectN} 条通道，实际 ${j.ch ? j.ch.length : 0}`);
      set(`下载 ${dl.suggestedFilename()}；解析得通道 ${j.ch.length} 条、断面 ${j.sec.length} 个`);
    },
  },
  {
    id: 'I-06', section: '交互', title: '步进器连续操作（重渲染焦点观察）',
    steps: '聚焦电量输入框，按 3 次 ArrowUp 步进',
    expected: '每步 qty+100 且焦点保持在输入框（若丢失即为全量重渲染缺陷）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.focus('#i-qty');
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(80);
      const r = await page.evaluate(() => ({
        qty: state.qty,
        focused: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none',
        domId: (document.getElementById('i-qty') || {}).id || 'gone',
      }));
      const focusLost = r.focused !== 'i-qty';
      set(`ArrowUp×3 后 state.qty=${r.qty}（起点 1000）；焦点在 ${r.focused}${focusLost ? ' ← 焦点已丢失，连点被打断（缺陷证实）' : ''}`);
      ok(r.qty > 1000, `qty 应递增，实际 ${r.qty}`);
      ok(!focusLost, '重渲染导致输入框焦点丢失（renderCalc 整体替换 DOM），连续步进被打断');
    },
  },

  /* ================= 边界 ================= */
  {
    id: 'B-01', section: '边界', title: '电量清空→回落默认值',
    steps: '清空电量输入框后失焦',
    expected: `+''||1000 → state.qty=1000，页面回显 1000`,
    async run(page, set) {
      await page.goto(G, DCL);
      await page.fill('#i-qty', '');
      await page.locator('#i-qty').blur();
      const q = await page.evaluate(() => state.qty);
      ok(q === 1000, `应回落 1000，实际 ${q}`);
      ok(await page.locator('#i-qty').inputValue() === '1000', '页面应回显 1000');
      set(`state.qty=${q}，输入框回显 ${await page.locator('#i-qty').inputValue()}`);
    },
  },
  {
    id: 'B-02', section: '边界', title: '电量输入 0→回落默认值',
    steps: '电量输入 0 后失焦',
    expected: '0 为 falsy → 回落 1000（HTML min=1 不约束 JS 读值）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.fill('#i-qty', '0');
      await page.locator('#i-qty').blur();
      ok(await page.evaluate(() => state.qty) === 1000, '应回落 1000');
      set('state.qty=1000，正常重算');
    },
  },
  {
    id: 'B-03', section: '边界', title: '电量输入负数→拒绝并回落默认',
    steps: '电量输入 -5 后失焦',
    expected: 'readInputs 正数归一化：state.qty=1000，页面回显 1000，费用与功率无负值',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.fill('#i-qty', '-5');
      await page.locator('#i-qty').blur();
      const q = await page.evaluate(() => state.qty);
      ok(q === 1000, `负数应回落 1000，实际 ${q}`);
      ok(await page.locator('#i-qty').inputValue() === '1000', '页面应回显 1000');
      const mw = await page.evaluate(() => state._res.rows[0].segLd[0].mw);
      ok(mw > 0, `首段入口功率应为正，实际 ${mw}`);
      set(`输入 -5 → state.qty=${q}，输入框回显 1000，首段功率 ${mw.toFixed(1)} MW（正值）——负数已被归一化拒绝`);
    },
  },
  {
    id: 'B-04', section: '边界', title: '超大电量→全部越限引导文案',
    steps: '电量输入 1000000000 后失焦',
    expected: '所有候选不可行，页面显示「全部 N 条候选路线均超出通道容量…可勾选显示越限」，不崩溃',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.fill('#i-qty', '1000000000');
      await page.locator('#i-qty').blur();
      const msg = await page.locator('.empty').innerText();
      ok(msg.includes('超出'), `应显示越限引导文案，实际「${msg.slice(0, 50)}」`);
      set(`空态卡片：「${msg.trim().slice(0, 60)}」`);
    },
  },
  {
    id: 'B-05', section: '边界', title: '天地图密钥超长输入（5 万字符）',
    steps: '网架图→天地图→密钥框粘贴 50000+4 特殊字符→应用密钥→切回测算',
    expected: '保存不崩溃（localStorage quota 被吞）、可切回测算页正常测算',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.locator('button', { hasText: '天地图' }).click();
      const big = 'A'.repeat(50000) + '<>&"';
      await page.fill('#i-tk', big);
      await page.locator('button', { hasText: '应用密钥' }).click();
      ok(await page.evaluate(() => state.tiandituKey.length) === 50004, '50504 字符应完整保存');
      await page.click('#t-calc');
      ok(await page.locator('#i-calcroute').first().isVisible(), '切回测算应正常');
      set('50504 字符保存成功、无崩溃；切回测算页路线列表正常渲染');
    },
  },
  {
    id: 'B-06', section: '边界', title: '密钥注入脚本（XSS 防护）',
    steps: '密钥输入 <img src=x onerror=...> 后应用密钥',
    expected: '脚本不执行（value 经 esc 转义、URL 经 encodeURIComponent）；页面走降级',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.locator('button', { hasText: '天地图' }).click();
      await page.fill('#i-tk', '<img src=x onerror="window.__xss=1">');
      await page.locator('button', { hasText: '应用密钥' }).click();
      await page.waitForTimeout(600);
      ok(await page.evaluate(() => window.__xss) === undefined, '注入脚本不应执行');
      set('window.__xss 未定义（未执行）；无效密钥走 loadTianditu onerror 降级；输入框回显为转义文本');
    },
  },
  {
    id: 'B-07', section: '边界', title: 'localStorage 存入损坏 JSON 后刷新',
    steps: '写入 {oops 到 iproute.v2.last，刷新页面',
    expected: 'try/catch 吸收解析异常，回落全部默认值，应用正常渲染，无未捕获异常',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.evaluate(() => localStorage.setItem('iproute.v2.last', '{oops'));
      await page.reload(DCL);
      ok(await page.locator('#i-from').inputValue() === 'SC', '应回落默认四川');
      const cards = await page.locator('#i-calcroute option').count();
      ok(cards > 0, '刷新后应正常渲染卡片');
      set(`损坏 JSON 被吞掉；回落 SC→JS；卡片 ${cards} 张正常渲染`);
    },
  },

  /* ================= 异常 ================= */
  {
    id: 'E-01', section: '异常', title: '底图 SDK 加载失败→应用内确认框反馈（2026-09-18 重写，REQ-703 已解冻）',
    steps: '拦截 map.qq.com 请求（模拟代理不可用/断网），网架图点击「腾讯地图」并选择「保持内置拓扑图」',
    expected: '应用内确认框说明不可用并提供选择（不再静默回退）；保持后仍为内置拓扑图。与 RQ-703 分工：本例在 SDK 请求被拦截路径上验证反馈，RQ-703 验证常规切换路径',
    async run(page, set) {
      await page.context().route(/map\.qq\.com/, r => r.abort());
      await page.goto(G, DCL);
      const clickQQ = async () => {
        await page.locator('#v-map button', { hasText: '腾讯地图' }).click().catch(async () => {
          await page.evaluate(() => go('map'));
          await page.locator('#v-map button', { hasText: '腾讯地图' }).click();
        });
      };
      await clickQQ();
      const dlg = page.locator('[role="dialog"]:not(.sheet-panel)');
      await dlg.waitFor({ state: 'visible', timeout: 5000 });
      const msg = await dlg.innerText();
      ok(msg.includes('腾讯地图') && msg.includes('不可用'), `应弹框说明，实际「${msg.slice(0, 40)}」`);
      await dlg.locator('button', { hasText: '保持内置拓扑图' }).click();
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => ({ p: state.mapProvider, svg: !!document.querySelector('#map-view svg') }));
      ok(r.p === 'svg' && r.svg, `保持后应为内置拓扑图，实际 provider=${r.p}`);
      set(`SDK 被拦截下点击腾讯地图→确认框；保持→svg（provider=${r.p}）`);
    },
  },

  {
    id: 'E-02', section: '异常', title: '天地图无效密钥→降级',
    steps: '网架图→天地图，输入 FAKEKEY123，应用密钥',
    expected: 'loadTianditu onerror → 降级清单，无崩溃',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.locator('button', { hasText: '天地图' }).click();
      await page.fill('#i-tk', 'FAKEKEY123');
      await page.locator('button', { hasText: '应用密钥' }).click();
      await page.waitForSelector('#fallback', { state: 'visible', timeout: 10000 });
      const txt = await page.locator('#fallback').innerText();
      ok(txt.includes('降级'), '应显示降级文案');
      set('无效 tk → script onerror → showMapFallback 降级清单');
    },
  },
  {
    id: 'E-03', section: '异常', title: '服务不可用时刷新页面',
    steps: '页面加载后切 Offline，执行 reload',
    expected: '重载失败（ERR_INTERNET_DISCONNECTED 类错误）；已加载的 DOM 不受影响',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.context().setOffline(true);
      let err = '(未抛错)';
      try { await page.reload({ timeout: 6000 }); } catch (e) { err = String(e.message).split('\n')[0].slice(0, 110); }
      await page.context().setOffline(false);
      ok(/ERR_|Timeout|net::/.test(err), `reload 应失败，实际：${err}`);
      const still = await page.locator('#i-calcroute option').count();
      set(`reload 报「${err}」；重载前已渲染的 ${still} 张卡片仍在 DOM（纯前端可继续操作）`);
    },
  },
  {
    id: 'E-04', section: '异常', title: '断网状态下应用内继续操作',
    steps: '切 Offline 后把省对改为 云南→广东',
    expected: '测算链路零网络请求，重算完全正常',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.context().setOffline(true);
      await page.selectOption('#i-from', 'YN');
      await page.selectOption('#i-to', 'GD');
      const n = await page.evaluate(() => state._res.rows.length);
      ok(n > 0, `断网重算应有路线，实际 ${n}`);
      set(`Offline 下 云南→广东 重算出 ${n} 条路线；核心功能离线可用`);
    },
  },
  {
    id: 'E-05', section: '异常', title: '空结果：无连通路径的错误引导',
    steps: '出发地北京，目的地贵州（库内北方与南方电网间无已录入的连通边）',
    expected: '显示「在 10 段以内没有 北京 到 贵州 的连通路径」空态卡片（跳数已固定为上限，不再提示放宽跳数）',
    async run(page, set) {
      await page.goto(G, DCL);
      // 修正(2026-09-18)：跳数输入已移除，原「北京 + 1 段」构造的空态不再成立（BJ 已是连通节点）。
      // 改用真实的库内不连通省对 北京→贵州（南网 5 条物理直流 pricePending，不参与枚举），语义不变。
      await page.selectOption('#i-from', 'BJ');
      await page.selectOption('#i-to', 'GZ');
      const msg = await page.locator('.empty').innerText();
      ok(msg.includes('暂无接入') || msg.includes('连通路径'), `应显示空态引导，实际「${msg.slice(0, 50)}」`);  // 2026-09-18：文案已演进为「XX 暂无接入的跨省通道」
      set(`空态卡片：「${msg.trim()}」`);
    },
  },

  /* ================= 运行时健壮性（harden-web-runtime） ================= */
  {
    id: 'HR-01', section: '运行时健壮性', title: '存储写入失败→可见提示+去重+功能不受影响',
    steps: '把 setItem 替换为抛错版本，触发重算与方案切换',
    expected: '测算页出现恰好一条存储故障提示；多次失败不重复弹条；测算与切换照常、无未捕获异常',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('#i-calcroute option', { state: 'attached' });
      await page.evaluate(() => {
        window.__origSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function () { throw new Error('HR01 模拟配额超限'); };
      });
      // 修正(2026-09-18)：跳数输入已移除，改用同样会触发重算与持久化的「成本阈值」下拉。
      await page.selectOption('#i-degrade', '0.05');
      await page.waitForTimeout(150);
      const r1 = await page.evaluate(() => ({
        warnN: [...document.querySelectorAll('#v-calc .warn')].filter(w => w.textContent.includes('本机存储不可用')).length,
        rows: state._res.rows.length,
      }));
      ok(r1.warnN === 1, `存储故障提示应恰好 1 条，实际 ${r1.warnN}`);
      ok(r1.rows > 0, `存储故障下测算应正常，实际 ${r1.rows} 条`);
      await page.selectOption('#i-calcroute', '1');
      await page.selectOption('#i-degrade', '0.2');
      await page.waitForTimeout(150);
      const r2 = await page.evaluate(() => [...document.querySelectorAll('#v-calc .warn')].filter(w => w.textContent.includes('本机存储不可用')).length);
      ok(r2 === 1, `多次写入失败后提示仍应 1 条，实际 ${r2}`);
      await page.evaluate(() => { Storage.prototype.setItem = window.__origSetItem; });
      set(`提示恰好 1 条（多次失败去重，防渲染循环）；故障下重算 ${r1.rows} 条、切方案正常`);
    },
  },
  {
    id: 'HR-02', section: '运行时健壮性', title: '重渲染保持折叠态（完整明细 + 无 id 说明面板）',
    steps: '展开「完整明细」与任一口径说明面板，改价格、切成本阈值触发重算',
    expected: '重建后两者仍为展开态（修复前完整明细会被收回）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('#i-calcroute option', { state: 'attached' });
      await page.evaluate(() => {
        document.getElementById('d-detail').open = true;
        const ex = document.querySelector('details.explain'); if (ex) ex.open = true;
      });
      await page.fill('#i-pgen', '333');
      await page.locator('#i-pgen').blur();
      await page.waitForTimeout(150);
      ok(await page.evaluate(() => document.getElementById('d-detail').open), '改价格后完整明细应保持展开');
      const ex1 = await page.evaluate(() => { const d = document.querySelector('details.explain'); return d ? d.open : null; });
      // 修正(2026-09-18)：跳数输入已移除，改用「成本阈值」下拉触发第二次重渲染。
      await page.selectOption('#i-degrade', '0.05');
      await page.waitForTimeout(150);
      ok(await page.evaluate(() => document.getElementById('d-detail').open), '切成本阈值后完整明细应保持展开');
      const ex2 = await page.evaluate(() => [...document.querySelectorAll('details.explain')].some(d => d.open));
      ok(ex2 === true, `无 id 说明面板展开态应保持，实际 ${ex2}`);
      set(`d-detail 保持展开；说明面板 open=${ex1}→${ex2}`);
    },
  },
  {
    id: 'HR-03', section: '运行时健壮性', title: '错误态往返不发生错位恢复',
    steps: '展开完整明细后切到无连通路径省对（错误态），再切回',
    expected: '错误态正常渲染空态卡片；切回后 d-detail 按 id 恢复展开，无错位、无异常',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('#i-calcroute option', { state: 'attached' });
      await page.evaluate(() => { document.getElementById('d-detail').open = true; });
      // 修正(2026-09-18)：跳数输入已移除（固定 10 段）。错误态改用库内真实不连通的 北京→贵州，
      // 往返仍是「错误态 → 恢复结果态」，与 M11 的按 id 恢复展开断言一致。
      await page.selectOption('#i-from', 'BJ');
      await page.selectOption('#i-to', 'GZ');
      await page.waitForTimeout(150);
      const err = await page.evaluate(() => ({ empty: !!document.querySelector('.empty'), dets: document.querySelectorAll('#v-calc details').length }));
      ok(err.empty, '应进入错误空态');
      await page.selectOption('#i-to', 'JS');
      await page.waitForTimeout(150);
      const back = await page.evaluate(() => ({
        detailOpen: document.getElementById('d-detail').open,
        cards: document.querySelectorAll('#i-calcroute option').length,
      }));
      ok(back.cards > 0, '应恢复正常结果态');
      ok(back.detailOpen, '切回后完整明细应按 id 恢复展开');
      set(`错误态面板 ${err.dets} 个（数量守卫分支）；切回后卡片 ${back.cards} 张、d-detail 按 id 恢复展开`);
    },
  },
  {
    id: 'HR-04', section: '运行时健壮性', title: '最坏参数下持久化记录 < 2KB',
    steps: '西藏→江苏（跳数固定上限 10、绕行不限，候选数百条）触发保存',
    expected: 'iproute.v2.last 低于 2048 字节且不含求解结果（修复前最坏约 12MB）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('#i-calcroute option', { state: 'attached' });
      // 修正(2026-09-18)：6 段 / 绕行度输入已移除（固定 MAX_HOPS、不限绕行），默认即最坏口径。
      await page.evaluate(() => {
        const setv = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
        setv('i-from', 'XZ'); setv('i-to', 'JS');
      });
      await page.waitForTimeout(200);
      const r = await page.evaluate(() => {
        const raw = localStorage.getItem('iproute.v2.last') || '';
        return { bytes: raw.length, hasRes: raw.includes('_res'), n: state._res.total };
      });
      ok(r.n > 50, `最坏省对候选应 >50 条，实际 ${r.n}`);
      ok(r.bytes < 2048, `持久化记录应 <2KB，实际 ${r.bytes}B`);
      ok(!r.hasRes, '持久化记录不得包含 _res 求解结果');
      set(`候选 ${r.n} 条；记录 ${r.bytes}B（修复前最坏约 12MB）；含 _res=${r.hasRes}`);
    },
  },
  {
    id: 'HR-05', section: '运行时健壮性', title: '全局错误兜底：提示条去重计数且不吞控制台',
    steps: '注入两次相同未捕获异常与一次不同异常',
    expected: '提示条出现且相同错误合并为 ×2；不同错误单列；pageerror 事件照常触发（控制台留痕）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('#i-calcroute option', { state: 'attached' });
      const errs = [];
      page.on('pageerror', e => errs.push(String(e)));
      await page.evaluate(() => setTimeout(() => { throw new Error('hr05-重复错误'); }, 0));
      await page.waitForTimeout(250);
      let box = await page.evaluate(() => { const b = document.getElementById('gerr-box'); return b ? b.innerText : ''; });
      ok(box.includes('hr05-重复错误'), `提示条应含错误摘要，实际「${box.slice(0, 60)}」`);
      await page.evaluate(() => setTimeout(() => { throw new Error('hr05-重复错误'); }, 0));
      await page.waitForTimeout(250);
      const dup = await page.evaluate(() => { const b = document.getElementById('gerr-box'); return (b ? b.innerText : '').includes('×2'); });
      ok(dup, '相同错误第二次应合并为 ×2 而非新增一条');
      await page.evaluate(() => setTimeout(() => { throw new Error('hr05-另一错误'); }, 0));
      await page.waitForTimeout(250);
      const both = await page.evaluate(() => { const b = document.getElementById('gerr-box'); return b ? b.innerText : ''; });
      ok(both.includes('hr05-另一错误'), '不同错误应单独显示');
      const n = errs.filter(e => e.includes('hr05')).length;
      ok(n >= 3, `pageerror 应照常触发 ≥3 次（不吞控制台），实际 ${n}`);
      set(`提示条含 2 类错误（重复项合并 ×2）；pageerror 触发 ${n} 次未被吞`);
    },
  },
  {
    id: 'HR-06', section: '运行时健壮性', title: '费率库整页重建保持卡片展开态',
    steps: '展开第一张通道卡片后切到测算再切回费率库',
    expected: '切回后第一张通道卡仍为展开态（此前 renderLib 整页替换会收起）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-lib');
      await page.locator('.libcard summary').first().click();
      ok(await page.evaluate(() => document.querySelector('.libcard').open), '前置：卡片应已展开');
      await page.click('#t-calc');
      await page.click('#t-lib');
      await page.waitForTimeout(150);
      ok(await page.evaluate(() => document.querySelector('.libcard').open), '切回费率库后第一张通道卡应保持展开');
      set('通道卡展开态跨 Tab 往返保持');
    },
  },

  /* ================= 响应式 ================= */
  {
    id: 'R-01', section: '响应式', title: '手机竖屏 375×667（iPhone SE）',
    steps: '以 375×667 视口打开测算页',
    expected: '无横向溢出；#app 限宽 480 生效；底部导航与路线卡片可见可用',
    viewport: { width: 375, height: 667 },
    async run(page, set) { await respCheck(page, set, false); },
  },
  {
    id: 'R-02', section: '响应式', title: '平板 768×1024',
    steps: '以 768×1024 视口打开测算页',
    expected: '无横向溢出；600–899px 平板档 #app max-width:none（铺满视口，不套手机限宽）；布局不拉伸错乱',
    viewport: { width: 768, height: 1024 },
    // 修正(2026-09-18)：600–899px 断点已把 #app 置为 max-width:none（template.html:513），
    // 原「居中限宽 480」是手机档口径，与当前平板适配矛盾。
    async run(page, set) { await respCheck(page, set, false, false, 'none'); },
  },
  {
    id: 'R-03', section: '响应式', title: '桌面 1440×900 宽布局',
    steps: '以 1440×900 视口打开测算页',
    expected: '#app 铺满视口（桌面宽布局 max-width 1480px）；无横向溢出',
    viewport: { width: 1440, height: 900 },
    async run(page, set) { await respCheck(page, set, false, true); },
  },
  {
    id: 'R-04', section: '响应式', title: '两栏 900–1279px：列表与方案同排，不得留大片空白',
    steps: '以 900 / 1100 / 1279 视口打开测算页，量两栏布局、两栏顶边差与栏距；再滚动验证左栏吸附',
    expected: '均落在两栏布局（348px + 剩余）；.col-side 与 .col-main 同处第一行、顶边齐平（差 ≤2px）；滚动后左栏 sticky 仍吸在 78px（M14）',
    viewport: { width: 1100, height: 900 },
    async run(page, set) {
      await page.goto(G, DCL);
      const out = [];
      for (const w of [900, 1100, 1279]) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.waitForSelector('.layout', { timeout: 15000 });
        // 修正(2026-09-18)：AI_ENABLED=false 时不再渲染 .col-ai，两栏改为 .col-side/.col-main 同处 grid-row:1
        //（.layout.no-ai，template.html:576）。原用例对 .col-ai 调 getBoundingClientRect 必抛 TypeError。
        // 断言改为当前布局的等价几何：两栏同排、顶边齐平、栏距=gap，并补上左栏 sticky 生效（M14 overflow-x:clip）。
        const m = await page.evaluate(() => {
          const layout = document.querySelector('.layout');
          const cs = getComputedStyle(layout);
          const side = document.querySelector('.col-side'), main = document.querySelector('.col-main');
          const sr = side.getBoundingClientRect(), mr = main.getBoundingClientRect();
          return { cols: cs.gridTemplateColumns.split(' ').length, gap: parseFloat(cs.gap),
            ai: !!document.querySelector('.col-ai'),
            dTop: +(mr.top - sr.top).toFixed(1), dLeft: +(mr.left - sr.right).toFixed(1),
            sideRow: getComputedStyle(side).gridRow };
        });
        // 回归背景（2026-09-16 修复）：左栏 sticky + max-height 只占 grid-row:1 时会把第一行撑满整屏，
        // 方案详情被推到屏幕外。当前无 AI 的两栏把两栏同放第一行，故直接量两栏顶边差与栏距。
        ok(m.cols === 2, `${w}px 应为两栏布局，实际 ${m.cols} 栏`);
        ok(!m.ai, `${w}px：智能推荐已隐藏（AI_ENABLED=false）时不应存在 .col-ai，实际存在=${m.ai}`);
        ok(Math.abs(m.dTop) <= 2, `${w}px：列表与详情应顶边齐平，实际差 ${m.dTop}px`);
        ok(m.dLeft >= m.gap - 1 && m.dLeft <= m.gap + 1, `${w}px：两栏间距应=${m.gap}px，实际 ${m.dLeft}px`);
        ok(m.sideRow === '1', `${w}px：.col-side 在无 AI 两栏下应 grid-row:1，实际 ${m.sideRow}`);
        out.push(`${w}px 顶边差=${m.dTop}px 栏距=${m.dLeft}px`);
      }
      // 左栏吸附：main 的 overflow-x 必须是 clip，hidden 会把 main 变成滚动容器使 sticky 失效（M14）。
      // 吸附位置要在「自然位置已越过 78px」且「grid 容器底部仍留有余量」之间取值，否则会停在容器底部约束处
      // （左栏高 ≈ container 高时，滚过头看到的是 bottom 约束而不是吸附失效）。
      const y = await page.evaluate(() => {
        const side = document.querySelector('.col-side'), layout = document.querySelector('.layout');
        const top0 = layout.getBoundingClientRect().top + window.scrollY;
        const lh = layout.getBoundingClientRect().height, sh = side.getBoundingClientRect().height;
        const yMin = top0 - 78 + 10, yMax = top0 + lh - sh - 78 - 10;
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        const pick = yMax > yMin ? yMin + (yMax - yMin) / 2 : yMin;
        return Math.max(0, Math.min(maxScroll, pick));
      });
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(150);
      const st = await page.evaluate(() => ({
        scrollY: Math.round(window.scrollY),
        top: +document.querySelector('.col-side').getBoundingClientRect().top.toFixed(1),
        pos: getComputedStyle(document.querySelector('.col-side')).position,
        cssTop: getComputedStyle(document.querySelector('.col-side')).top,
        mainOverflowX: getComputedStyle(document.querySelector('main')).overflowX,
      }));
      ok(st.scrollY > 0, `页面应可滚动，实际 scrollY=${st.scrollY}`);
      ok(st.pos === 'sticky' && st.cssTop === '78px', `左栏应为 sticky top:78px，实际 position=${st.pos} top=${st.cssTop}`);
      ok(st.mainOverflowX === 'clip', `main 的 overflow-x 应为 clip（不得让 main 成为 sticky 的新滚动容器），实际 ${st.mainOverflowX}`);
      ok(Math.abs(st.top - 78) <= 1.5, `滚动到 ${st.scrollY}px 时左栏应吸附在 78px，实际 top=${st.top}px（sticky 失效会让左栏随页滚出）`);
      set(out.join('；') + `；滚动 ${st.scrollY}px 后左栏吸附 top=${st.top}px（position:${st.pos}，main overflow-x:${st.mainOverflowX}）`);
    },
  },

  {
    id: 'RQ-01', section: 'PRD-IPRO', title: 'REQ-101：incLoss 通道按落地端结算电量计费',
    steps: '宁夏→浙江 取灵绍单段路线 segs[0].fee；四川→江西 取雅湖单段路线 segs[0].fee',
    expected: 'REQ-101 新口径正确值：灵绍 48.80±0.01 / 雅湖 68.50±0.01（incLoss 通道输电费 = 通道电价 × 落地端电量 qOut，依据发改价格规〔2025〕1490号附件4第十八条）。已取代送端电量旧口径（50.97/72.87）',
    async run(page, set) {
      // REQ-101 新口径正确值：incLoss 通道 fee = e.t × 落地端电量 qOut，
      // 依据发改价格规〔2025〕1490号附件4第十八条「专项工程实际输电量按落地端
      // 结算电量进行统计确认」。单段路线 qOut=1，故 fee 恰等于通道电价本身。
      const segFee = async (from, to, name) => {
        await page.goto(G, DCL);
        await page.selectOption('#i-from', from);
        await page.selectOption('#i-to', to);
        return page.evaluate(n => {
          const row = state._res.rows.find(r => r.segs.length === 1 && r.segs[0].e.n === n);
          return row ? row.segs[0].fee : null;
        }, name);
      };
      const ls = await segFee('NX', 'ZJ', '灵绍直流');
      ok(ls !== null, '宁夏→浙江 应存在灵绍单段路线');
      ok(Math.abs(ls - 48.80) <= 0.01, `灵绍 fee 应为 48.80±0.01（落地端电量新口径），实际 ${ls}`);
      const yh = await segFee('SC', 'JX', '雅湖直流');
      ok(yh !== null, '四川→江西 应存在雅湖单段路线');
      ok(Math.abs(yh - 68.50) <= 0.01, `雅湖 fee 应为 68.50±0.01（落地端电量新口径），实际 ${yh}`);
      set(`灵绍 fee=${ls.toFixed(4)}、雅湖 fee=${yh.toFixed(4)}（落地端电量新口径，1490号第十八条）`);
    },
  },
  {
    id: 'RQ-603', section: 'PRD-IPRO', title: 'REQ-603+702：拓扑 SVG 五档视口防裁切/高度自适应',
    steps: '五档视口（1920×1080 / 1366×768 / 900×700 / 390×844 / 375×667）打开网架图→拓扑图；再切天地图验证非 svg 模式容器高度行为不变',
    expected: '各视口 svg.bottom ≤ 容器.bottom+1；被裁文字节点=0；容器高与绘制高之差 ≤ 容器高×10%；td 模式容器仍走固定高（aspect-ratio 不生效），修复前实测缺陷（1920 裁 126px/1366 裁 322px）已消除',
    async run(page, set) {
      await page.goto(G, DCL);
      const VPS = [[1920, 1080], [1366, 768], [900, 700], [390, 844], [375, 667]];
      const summary = [];
      for (const [w, h] of VPS) {
        await page.setViewportSize({ width: w, height: h });
        await page.click('#t-calc');
        await page.click('#t-map');
        await page.waitForSelector('#map-view svg', { timeout: 6000 });
        const r = await page.evaluate(() => {
          const box = document.getElementById('map-view');
          const svg = box.querySelector('svg');
          const br = box.getBoundingClientRect(), sr = svg.getBoundingClientRect();
          let clipped = 0;
          for (const t of svg.querySelectorAll('text')) {
            const r = t.getBoundingClientRect();
            const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
            const outside = cx < br.left - .5 || cx > br.right + .5 || cy < br.top - .5 || cy > br.bottom + .5;
            const straddle = r.right > br.left - .5 && r.left < br.right + .5 && r.bottom > br.top - .5 && r.top < br.bottom + .5;
            if (outside && straddle) clipped++;   // 2026-09-18：视野聚焦后离线路径标签整体出画属预期，只计跨边界的半截字
          }
          return { over: +(sr.bottom - br.bottom).toFixed(1), clipped, diffPct: +(Math.abs(br.height - sr.height) / br.height * 100).toFixed(1), boxH: Math.round(br.height) };
        });
        ok(r.over <= 1, `${w}x${h}：svg 底部超出容器 ${r.over}px（应 ≤1）`);
        ok(r.clipped === 0, `${w}x${h}：被裁文字节点 ${r.clipped} 个（应=0）`);
        ok(r.diffPct <= 10, `${w}x${h}：容器与绘制高差 ${r.diffPct}%（应 ≤10%）`);
        summary.push(`${w}x${h} 容器高${r.boxH}px/越底${r.over}/裁字${r.clipped}/高差${r.diffPct}%`);
      }
      // qq/td 底图模式容器高度行为不变：td 模式不应带 aspect-ratio，仍吃固定高 calc(100vh-290px)
      await page.setViewportSize({ width: 390, height: 844 });
      await page.click('#t-calc');
      await page.click('#t-map');
      await page.locator('button', { hasText: '天地图' }).click();
      await page.waitForTimeout(400);
      const td = await page.evaluate(() => {
        const cs = getComputedStyle(document.getElementById('map-view'));
        return { aspect: cs.aspectRatio, h: parseFloat(cs.height) };
      });
      ok(td.aspect === 'auto', `td 模式容器不应有 aspect-ratio，实际 ${td.aspect}`);
      ok(Math.abs(td.h - (844 - 290)) <= 2, `td 模式容器高应≈554px（844-290），实际 ${td.h}px`);
      set(summary.join('；') + `；td 模式 aspect=${td.aspect} 高=${td.h}px（固定高不变）`);
    },
  },
  {
    id: 'RQ-701', section: 'PRD-IPRO', title: 'REQ-701：费率库省级参数三输入框对齐',
    steps: '375×667 与 390×844 展开任一省级参数卡片，量三个 number 输入框 y 坐标；改出清价验证 setPv 取值逻辑',
    expected: '三个输入框 y 坐标一致（≤1px）；标签完整可读无裁字截断；setPv 即时生效（PV 更新并按新费率重算），切回测算页结果区仍渲染（H6 修复后不再落入空态）',
    async run(page, set) {
      await page.goto(G, DCL);
      const out = [];
      for (const [w, h] of [[375, 667], [390, 844]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.click('#t-lib');
        await page.locator('button', { hasText: /^省级参数/ }).click();
        const card = page.locator('.libcard').first();
        // harden-web-runtime 后展开态跨 Tab 保持：二次循环进来的卡片可能已展开，盲点 summary 会把它收起，改为「收起才展开」
        if ((await card.getAttribute('open')) === null) await card.locator('summary').click();
        const r = await card.evaluate(() => {
          const inputs = [...document.querySelectorAll('.libcard .lib-io input')].slice(0, 3);
          const labels = [...document.querySelectorAll('.libcard .lib-io label')].slice(0, 3);
          const ys = inputs.map(i => i.getBoundingClientRect().top);
          const clip = el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
          return { dys: ys.map(y => +(y - ys[0]).toFixed(2)), clipped: labels.filter(clip).map(l => l.innerText) };
        });
        ok(Math.max(...r.dys.map(Math.abs)) <= 1, `${w}x${h}：三输入框 y 相对差 ${JSON.stringify(r.dys)}（应 ≤1px）`);
        ok(r.clipped.length === 0, `${w}x${h}：标签被裁截断 ${JSON.stringify(r.clipped)}`);
        out.push(`${w}x${h} dy=${JSON.stringify(r.dys)}`);
      }
      // setPv 取值逻辑 + H6 修复后的重算行为：改出清价 → PV 即时更新并立即重算，
      // 切回测算页结果区仍渲染（修复前只把 _res 置 null，会落入误导性的「请选择不同的出发地与目的地」空态）。
      await page.locator('.libcard .lib-io input').first().fill('123');
      await page.locator('.libcard .lib-io input').first().blur();
      await page.waitForTimeout(150);
      const sv = await page.evaluate(() => ({
        pv: Object.values(PV).some(p => p.clear === 123),
        hasRes: !!state._res,
        rows: state._res && state._res.rows ? state._res.rows.length : 0,
        err: state._res ? (state._res.err || '') : '(无结果对象)',
      }));
      ok(sv.pv === true, `setPv 后 PV 中应有 clear=123（实际 ${sv.pv}）`);
      ok(sv.hasRes && sv.rows > 0 && !sv.err, `setPv 应立即重算出结果（H6），实际 rows=${sv.rows} err=${sv.err}`);
      await page.click('#t-calc');
      await page.waitForTimeout(150);
      const back = await page.evaluate(() => ({
        cards: document.querySelectorAll('#v-calc #i-calcroute option').length,
        empty: !!document.querySelector('#v-calc .empty'),
      }));
      ok(back.cards > 0 && !back.empty, `切回测算页应仍渲染方案卡片，实际卡片=${back.cards} 空态=${back.empty}`);
      set(out.join('；') + `；setPv 生效 PV=${sv.pv}，重算 rows=${sv.rows}，切回测算页卡片 ${back.cards} 张（未落入空态）`);
    },
  },
  {
    id: 'RQ-704', section: 'PRD-IPRO', title: 'REQ-704：测算②受端输配电价/基金输入框对齐',
    steps: '打开「参数」面板并切到「到户已列费用」；在 375×667 与 390×844 量 #i-pnet 与 #i-fund 输入框 y 坐标；改 #i-pnet 后点「恢复」验证 resetOne 还原',
    expected: '两输入框 y 坐标一致（≤1px）；标签完整可读（「受端输配电价」「恢复」无截断）；resetOne 点击后还原核定值（SC→JS 为核定输配电价）',
    async run(page, set) {
      // 修正(2026-09-18)：受端两项已移入「参数」弹出面板（122e970），且只在「到户已列费用」口径下渲染。
      // 须先开面板并切口径；标签文案随面板同时精简为「受端输配电价 / 恢复」（原「受端省网输配电价 / 恢复核定值」）。
      await page.goto(G, DCL);
      await openParams(page);
      await page.selectOption('#i-dstcost', '1');
      await page.waitForTimeout(200);
      const out = [];
      for (const [w, h] of [[375, 667], [390, 844]]) {
        await page.setViewportSize({ width: w, height: h });
        await openParams(page);
        const r = await page.evaluate(() => {
          const pn = document.getElementById('i-pnet'), fd = document.getElementById('i-fund');
          const spans = [pn, fd].map(i => i.closest('label.f').querySelector('span'));
          const clip = el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
          return { dy: Math.abs(pn.getBoundingClientRect().top - fd.getBoundingClientRect().top),
            txt: spans.map(s => s.textContent.replace(/\s+/g, ' ').trim()), clipped: spans.filter(clip).length };
        });
        ok(r.dy <= 1, `${w}x${h}：#i-pnet 与 #i-fund y 差 ${r.dy.toFixed(2)}px（应 ≤1px）`);
        ok(r.txt[0].includes('受端输配电价') && r.txt[0].includes('恢复'), `主标签应完整含「受端输配电价/恢复」，实际「${r.txt[0]}」`);
        ok(r.clipped === 0, `${w}x${h}：标签被裁截断 ${r.clipped} 处`);
        out.push(`${w}x${h} dy=${r.dy.toFixed(2)}`);
      }
      // resetOne 行为不变：改值 → 点「恢复」→ 还原为所选档核定值（dstAutoNet）
      const rr = await page.evaluate(async () => {
        const net0 = state.pNet;
        const inp = document.getElementById('i-pnet');
        inp.value = String(net0 + 1); inp.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 150));
        const changed = state.pNet;
        // 重算后参数面板正文整体重画，旧引用已脱离文档，须按 id 重新取节点再点「恢复」
        document.getElementById('i-pnet').closest('label.f').querySelector('a').click();
        await new Promise(r => setTimeout(r, 150));
        return { net0, changed, restored: state.pNet, inputVal: parseFloat(document.getElementById('i-pnet').value) };
      });
      ok(rr.changed === rr.net0 + 1, `改值后 pNet 应为 ${rr.net0 + 1}，实际 ${rr.changed}`);
      ok(rr.restored === rr.net0 && rr.inputVal === rr.net0, `resetOne 应还原 ${rr.net0}，实际 state=${rr.restored} 输入框=${rr.inputVal}`);
      set(out.join('；') + `；resetOne ${rr.net0}→${rr.changed}→${rr.restored}`);
    },
  },
  {
    id: 'RQ-401', section: 'PRD-IPRO', title: 'REQ-401：容量电费测算器（折叠卡 · 电压档选择 · 不参与路径比选）',
    steps: '打开测算页展开「容量电费测算」卡：断言默认档预选=1~10（20）千伏、P5 固定标注存在；容量方式输入 1000 kVA + 年用电量 12000 MWh → 年费用/分摊断言；切电压档 → 输出随之变化；年电量 0 → 分摊显示 —；西藏（D1 已补录 30/15）按需量校验；再临时移除条目验证缺数据时「暂无数据」',
    expected: '默认预选档规则（1~10（20）千伏，无此档取第一档）生效；北京按容量 33 元/kVA·月×1000×12=396,000 元/年、分摊 33.00 元/MWh；切 220千伏及以上档 → 336,000 元/年；P5 固定标注「容量电费与电量来自省内或省外无关，不参与路径比选」含发改价格〔2020〕1441号 / 〔2023〕532号；年电量 0 显示 — 不出 Infinity；西藏需量 30 元/千瓦·月、分摊 30.00 元/MWh；缺 CAP 条目时显示「暂无数据」不补估',
    async run(page, set) {
      await page.goto(G, DCL);
      const card = page.locator('#d-capfee');
      ok(await card.getAttribute('open') === null, '容量电费卡默认应收起（独立折叠卡）');
      // 2026-09-18 FR-5：卡内新增「本省全部电压档单价」嵌套 details，summary 需取直接子级（应用行为正确，断言适配）
      await card.locator('> summary').click();
      ok(await card.getAttribute('open') !== null, '点击 summary 应展开');
      // P5 固定标注（政策口径声明，含文号）
      const note = await card.locator('.cap-note').innerText();
      ok(note.includes('容量电费与电量来自省内或省外无关，不参与路径比选'), `P5 固定标注缺失：「${note.slice(0, 40)}」`);
      ok(note.includes('1441') && note.includes('532'), 'P5 标注应含发改价格〔2020〕1441号 / 〔2023〕532号');
      // 默认档预选：受端 JS(江苏) 默认档 = 1~10（20）千伏
      ok(await page.locator('#i-captier').inputValue() === '1~10（20）千伏', `默认预选档应为 1~10（20）千伏，实际「${await page.locator('#i-captier').inputValue()}」`);
      // 手算比对：北京按容量 33×1000×12=396000；按需量 52×1000×12=624000（默认档月单价）
      const run = async (prov, mode, val, qty) => page.evaluate(([p, m, v, q]) => {
        state.capProv = p; state.capTier = null; setCapMode(m);
        const iv = document.getElementById('i-capval'); iv.value = String(v); iv.dispatchEvent(new Event('change', { bubbles: true }));
        const iq = document.getElementById('i-capqty'); iq.value = String(q); iq.dispatchEvent(new Event('change', { bubbles: true }));
        const mc = document.querySelectorAll('#d-capfee .mc .v');
        return { annual: mc[1].textContent.trim(), per: mc[2].textContent.trim() };
      }, [prov, mode, val, qty]);
      let r = await run('BJ', 'cap', 1000, 12000);
      // 2026-09-18 FR-1：三卡大数走 fmtCompact 缩略（396000→39.6万），正常量级单价/分摊 toFixed 透传不变
      ok(r.annual === '39.6万元/年', `BJ 按容量年费用应缩略为 39.6万元/年，实际「${r.annual}」`);
      ok(r.per === '33.00元/MWh', `BJ 按容量分摊应 33.00 元/MWh，实际「${r.per}」`);
      r = await run('BJ', 'demand', 1000, 12000);
      ok(r.annual === '62.4万元/年', `BJ 按需量年费用应缩略为 62.4万元/年，实际「${r.annual}」`);
      ok(r.per === '52.00元/MWh', `BJ 按需量分摊应 52.00 元/MWh，实际「${r.per}」`);
      // 切档联动：220千伏及以上 容量 28 → 336,000
      await page.evaluate(() => { state.capProv = 'BJ'; state.capTier = null; setCapMode('cap'); });
      await page.selectOption('#i-captier', '220千伏及以上');
      r = await page.evaluate(() => ({
        annual: document.querySelectorAll('#d-capfee .mc .v')[1].textContent.trim(),
        tier: document.getElementById('i-captier').value,
      }));
      ok(r.annual === '33.6万元/年', `切 220千伏及以上档后年费用应缩略为 33.6万元/年，实际「${r.annual}」`);
      // 负向 1：年电量 0 → 分摊显示 —（不报错、不出 Infinity）
      await page.evaluate(() => {
        const iq = document.getElementById('i-capqty'); iq.value = '0'; iq.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const per0 = await page.evaluate(() => document.querySelectorAll('#d-capfee .mc .v')[2].textContent.trim());
      ok(per0 === '—元/MWh' && !per0.includes('Infinity'), `年电量 0 时分摊应显示 —，实际「${per0}」`);
      // 正向：西藏已由 D1 补录官方两部制容/需量电价（30 / 15，西藏发改委 2026-07-31 通知附件），应显示数值而非缺数据
      await page.evaluate(() => { state.capProv = 'XZ'; state.capTier = null; state.capValue = 1000; state.capQty = 12000; setCapMode('demand'); });
      const xz = await page.evaluate(() => {
        const mc = document.querySelectorAll('#d-capfee .mc .v');
        return { price: mc[0].textContent.trim(), per: mc[2].textContent.trim() };
      });
      ok(xz.price.startsWith('30') && xz.per === '30.00元/MWh', `西藏需量 30 元/千瓦·月、分摊 30.00 元/MWh，实际「${xz.price}」「${xz.per}」`);
      // 负向：缺数据的省必须 fail-closed（显示「暂无数据」，不补估、不沿用其它省）。
      // D1 后 31 省均有 CAP 数据，真实数据里已无该情形；运行时临时移除条目守住该分支（不改数据文件）。
      await page.evaluate(() => { window.__capXZ = CAP.XZ; delete CAP.XZ; state.capProv = 'XZ'; renderCalc(); });
      const xzTxt = await card.locator('.warn').innerText();
      ok(xzTxt.includes('暂无数据'), `缺数据时应显示暂无数据，实际「${xzTxt.slice(0, 40)}」`);
      await page.evaluate(() => { CAP.XZ = window.__capXZ; delete window.__capXZ; });
      set(`默认档预选=1~10（20）千伏；BJ 容量 396,000/33.00、需量 624,000/52.00；切档 336,000；年电量0→—；XZ 需量 30.00；移除条目后→暂无数据`);
    },
  },
  {
    id: 'RQ-705', section: 'PRD-IPRO', title: 'REQ-705：通道（直流）作为必经组件筛方案 + 说明文字可折叠',
    steps: '检查 details.explain 默认收起；四川→上海下读取顶部「通道」下拉（直流分组置顶）；选一条直流，再改回「全部通道」',
    expected: '长段说明默认收起、点击可展开；通道下拉完整列出候选通道、直流分组在最前；选中后方案全部包含该通道，且下拉清单不被收窄（仍可改选）；改回全部通道后恢复全量',
    viewport: { width: 1440, height: 900 },
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('.layout', { timeout: 15000 });
      // 长段解释文字默认收起（原来是整段摊在卡片里）
      const ex = await page.evaluate(() => [...document.querySelectorAll('details.explain')]
        .map((d) => ({ open: d.open, len: (d.querySelector('.inner') || {}).textContent.trim().length })));
      ok(ex.length >= 2, `应有多处可折叠说明，实际 ${ex.length} 处`);
      ok(ex.every((d) => !d.open), '说明区应默认收起');
      ok(ex.every((d) => d.len > 60), '折叠区应有实际内容，不是空壳');
      await page.click('details.explain > summary');
      await page.waitForTimeout(150);
      ok(await page.evaluate(() => document.querySelector('details.explain').open), '点击标题应能展开');

      // 修正(2026-09-18)：组件选择器已由 .comps button.chip 改为顶部主卡的原生单选下拉 #i-chan
      //（d56fc4a「通道改为单选下拉」），按下拉分组与选项重新对齐；筛选语义不变。
      await page.evaluate(() => { state.from = 'SC'; state.to = 'SH'; state.maxHops = MAX_HOPS; state.maxDetour = null;
        state.showBad = true; state.mustHave = []; state.sel = 0; applyBothProv(); doSolve(); });
      await page.waitForTimeout(250);
      const b = await page.evaluate(() => {
        const av = state._res.availChannels || [];
        const selEl = document.getElementById('i-chan');
        const groups = selEl ? [...selEl.querySelectorAll('optgroup')].map((g) => ({ label: g.label, n: g.querySelectorAll('option').length })) : [];
        const optVals = selEl ? [...selEl.querySelectorAll('option')].filter((o) => o.value).map((o) => o.value) : [];
        const dcN = av.filter((c) => c.type === 'DC' || c.type === 'AC/DC').length;
        return { n: av.length, rows: state._res.rows.length, groups, dcN, optN: optVals.length,
          optMatch: optVals.every((id) => av.some((c) => c.id === id)) && optVals.length === av.length,
          dcFirst: groups.length > 0 && /^直流/.test(groups[0].label) && groups[0].n === dcN };
      });
      ok(b.n > 0 && b.optMatch, `通道下拉应列出全部可选通道（${b.optN}/${b.n}）`);
      ok(b.dcFirst, `直流（专项工程）分组应排在最前且条数完整（${JSON.stringify(b.groups)}）`);

      // 选中直流分组的第一条通道（下拉选项顺序即「直流优先、组内按经过它的最低价」）
      const firstDc = await page.evaluate(() => {
        const g = document.querySelector('#i-chan optgroup');
        const o = g && g.querySelector('option');
        return o ? o.value : '';
      });
      ok(!!firstDc, '直流分组应有可选项');
      await page.selectOption('#i-chan', firstDc);
      await page.waitForTimeout(250);
      const a = await page.evaluate(() => ({
        must: state.mustHave.slice(), rows: (state._res.rows || []).length,
        allOk: (state._res.rows || []).every((r) => state.mustHave.every((id) => r.edges.some((e) => e.id === id))),
        avail: (state._res.availChannels || []).length,
        opts: document.querySelectorAll('#i-chan option').length - 1,
        hint: (document.querySelector('.sec-title .hint') || {}).textContent || '',
      }));
      ok(a.must.length === 1, `选中后应记为必经组件，实际 ${a.must.length} 个`);
      ok(a.rows > 0 && a.allOk, `筛出的 ${a.rows} 条方案应全部包含该组件`);
      ok(a.avail === b.n && a.opts === b.n, `通道清单不得被筛选收窄（候选 ${a.avail}/${b.n}、下拉 ${a.opts}/${b.n}），否则其余通道再也选不回来`);
      ok(/已按通道筛选/.test(a.hint), `标题应提示已按通道筛选，实际「${a.hint.trim()}」`);

      await page.selectOption('#i-chan', '');
      await page.waitForTimeout(250);
      const c = await page.evaluate(() => ({ must: state.mustHave.length, rows: state._res.rows.length }));
      ok(c.must === 0 && c.rows === b.rows, `改回「全部通道」后应恢复全量 ${b.rows} 条候选，实际 ${c.rows} 条`);
      set(`说明区 ${ex.length} 处默认收起；下拉 ${b.n} 条（直流分组 ${b.dcN} 条置顶）；筛出 ${a.rows}/${b.rows} 条；改回全部通道后恢复`);
    },
  },
  {
    id: 'RQ-602', section: 'PRD-IPRO', title: 'REQ-602：本地价格覆盖 priceVersion 校验',
    steps: '预置旧版本地费率覆盖（pv=0000）后加载页面，应用内确认框点「丢弃本地修改」',
    expected: '出现应用内提示并丢弃旧覆盖，CH 恢复当前核定值（条数与 DATA.CH 一致且内容非占位）',
    async run(page, set) {
      // 覆盖存档的通道条数必须与当前 CH 一致，否则 state.js 的版本校验分支会被整段跳过
      // （state.js：if (s.ch && s.ch.length === CH.length)）。故先取实际条数再预置。
      await page.goto(G, DCL);
      const NCH = await page.evaluate(() => DATA.CH.length);
      await page.addInitScript((n) => {
        localStorage.setItem('iproute.v2.lib', JSON.stringify({
          pv: '0000dead', at: 'old',
          ch: Array.from({ length: n }, (_, i) => ({ id: 'X' + i, n: '占位通道' + i, from: 'SC', to: 'JS', type: 'DC', kv: '±0kV', loss: 0, t: 1, tRaw: 1, sendFee: 0, cap: null, capRated: null, capActual: null, capBasis: 'unknown', capSrc: '', priceType: 'energy', capPrice: null, capEq: null, tier: 'est', doc: '', eff: '', bill: '', tax: true, incLoss: false, excerpt: '', hist: [], tradable: true, status: '', note: '', sourceIssue: null, fn: '', lenKm: null, stFrom: null, stTo: null, regional: false, dirNote: '', docTitle: '', docVersion: null, pubDate: '', sourceIssue2: null })),
        }));
      }, NCH);
      await page.goto(G, DCL);
      const dlg = confirmDlg(page);   // 排除参数弹出面板 .sheet-panel，见 confirmDlg 说明
      await dlg.waitFor({ state: 'visible', timeout: 5000 });
      const tip = await dlg.innerText();
      ok(tip.includes('priceVersion') && tip.includes('不一致'), `应有旧版本提示（应用内确认框），实际「${tip.slice(0, 30)}」`);
      await dlg.locator('button', { hasText: '丢弃本地修改' }).click();
      await page.waitForTimeout(200);
      const ch = await page.evaluate(() => ({ n: CH.length, first: CH[0].n, stale: !!state._libStale }));
      ok(ch.n === NCH && !String(ch.first).includes('占位') && !ch.stale, `旧覆盖应被丢弃恢复核定值（应 ${NCH} 条），实际 CH[0].n=${ch.first} stale=${ch.stale}`);
      set(`应用内提示出现（priceVersion 不一致）；丢弃后 CH 恢复核定值（${ch.n} 条）`);
    },
  },
  {
    id: 'RQ-602b', section: 'PRD-IPRO', title: 'REQ-602b：保留旧版价格覆盖时费率库出现核对横幅',
    steps: '预置旧版本地费率覆盖后加载，应用内确认框选「暂保留」，进入费率库；再点「恢复检索原始值」',
    expected: '费率库顶部出现「旧版价格数据」核对横幅；应用内确认恢复后横幅消失',
    async run(page, set) {
      // 覆盖存档的通道条数必须与当前 CH 一致，否则 state.js 的版本校验分支会被整段跳过
      // （state.js：if (s.ch && s.ch.length === CH.length)）。故先取实际条数再预置。
      await page.goto(G, DCL);
      const NCH = await page.evaluate(() => DATA.CH.length);
      await page.addInitScript((n) => {
        localStorage.setItem('iproute.v2.lib', JSON.stringify({
          pv: '0000dead', at: 'old',
          ch: Array.from({ length: n }, (_, i) => ({ id: 'X' + i, n: '占位通道' + i, from: 'SC', to: 'JS', type: 'DC', kv: '±0kV', loss: 0, t: 1, tRaw: 1, sendFee: 0, cap: null, capRated: null, capActual: null, capBasis: 'unknown', capSrc: '', priceType: 'energy', capPrice: null, capEq: null, tier: 'est', doc: '', eff: '', bill: '', tax: true, incLoss: false, excerpt: '', hist: [], tradable: true, status: '', note: '', sourceIssue: null, fn: '', lenKm: null, stFrom: null, stTo: null, regional: false, dirNote: '', docTitle: '', docVersion: null, pubDate: '', sourceIssue2: null })),
        }));
      }, NCH);
      await page.goto(G, DCL);
      const dlg = confirmDlg(page);   // 排除参数弹出面板 .sheet-panel，见 confirmDlg 说明
      await dlg.waitFor({ state: 'visible', timeout: 5000 });
      const tip = await dlg.innerText();
      ok(tip.includes('priceVersion') && tip.includes('不一致'), '应弹出旧版本提示（应用内确认框）');
      await dlg.locator('button', { hasText: '暂保留' }).click();
      await page.waitForTimeout(150);
      const kept = await page.evaluate(() => ({ stale: !!state._libStale, first: CH[0].n }));
      ok(kept.stale && String(kept.first).includes('占位'), '「暂保留」后应保留旧覆盖（_libStale=true）');
      await page.click('#t-lib');
      await page.waitForTimeout(150);
      const banner = await page.evaluate(() => {
        const w = [...document.querySelectorAll('#v-lib .warn')].find(x => x.textContent.includes('旧版价格数据'));
        return w ? w.textContent.trim().slice(0, 40) : '';
      });
      ok(banner.includes('旧版价格数据'), `费率库应出现核对横幅，实际「${banner}」`);
      await page.locator('#v-lib button', { hasText: '恢复检索原始值' }).click();
      await dlg.waitFor({ state: 'visible', timeout: 3000 });
      await dlg.locator('button', { hasText: '恢复原始值' }).click();
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => ({ stale: !!state._libStale, banner: [...document.querySelectorAll('#v-lib .warn')].some(x => x.textContent.includes('旧版价格数据')) }));
      ok(!after.stale && !after.banner, '恢复原始值后横幅应消失');
      set(`暂保留时横幅出现：「${banner}…」；恢复后横幅消失`);
    },
  },
  {
    id: 'RQ-02a', section: 'PRD-IPRO', title: 'REQ-201：方案含未确认通道黄条',
    steps: '北京→四川 测算（首条经渝鄂背靠背直流，tradable=false 且非区域网架接口）；再对照 江苏→上海（仅苏沪联络线，属区域网架）',
    expected: '方案自有段含未确认通道时出现「当期可交易性待确认」黄条；区域网架内的联络线不再触发告警（REQ-201 范围收窄为自有通道）',
    async run(page, set) {
      await page.goto(G, DCL);
      // 修正(2026-09-18)：告警范围已收窄为「方案自有通道」，区域网架内的联络线（regional=true，如苏沪）不再告警
      //（calc.js renderDetail：ntSegs 只取 ownEdges；test-interaction 第十二节同口径）。
      // 原用例用 江苏→上海 的苏沪联络线构造，现行为下不会出现黄条；改用首条含 渝鄂联络线（背靠背直流，非区域网架）的省对。
      await page.selectOption('#i-from', 'BJ');
      await page.selectOption('#i-to', 'SC');
      await page.waitForTimeout(150);
      const hit = await page.evaluate(() => ({
        warn: [...document.querySelectorAll('.col-main .warn')].some(w => w.textContent.includes('当期可交易性待确认')),
        ownBad: ownEdges(state._res.rows[0]).filter(e => e.tradable === false).map(e => e.n),
      }));
      ok(hit.ownBad.length > 0 && hit.warn, `自有未确认段 ${hit.ownBad.join('、')} 应触发黄条，实际黄条=${hit.warn}`);
      // 对照：区域网架内的联络线不告警
      await page.selectOption('#i-to', 'SH');
      await page.selectOption('#i-from', 'JS');
      await page.waitForTimeout(150);
      const suhu = await page.evaluate(() => ({
        regionalBad: state._res.rows[0].edges.filter(e => e.tradable === false),
        warn: [...document.querySelectorAll('.col-main .warn')].some(w => w.textContent.includes('当期可交易性待确认')),
      }));
      ok(suhu.regionalBad.length > 0 && suhu.regionalBad.every(e => e.regional) && !suhu.warn,
        `苏沪联络线属区域网架，不应触发黄条（实际 warn=${suhu.warn}）`);
      set(`BJ→SC 自有未确认段 ${hit.ownBad.join('、')} → 黄条；JS→SH 区域网架联络线 → 无黄条`);
    },
  },
  {
    id: 'RQ-02b', section: 'PRD-IPRO', title: 'REQ-202：通道交易网络徽标',
    steps: '费率库搜索「苏沪联络线」，展开卡片',
    expected: '卡片摘要可见「交易网络·待确认」徽标；时间轴同款',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-lib');
      await page.fill('#lib-q', '苏沪');
      await page.waitForTimeout(100);
      const n = await page.locator('.libcard').count();
      ok(n >= 1, '应至少匹配 1 条');
      await page.locator('.libcard summary').first().click();
      const badge = await page.evaluate(() => document.body.innerHTML.includes('交易网络·待确认'));
      ok(badge, '应可见「交易网络·待确认」徽标');
      set(`匹配 ${n} 条，徽标可见`);
    },
  },
  {
    id: 'RQ-02c', section: 'PRD-IPRO', title: 'REQ-203：仅按已确认可交易通道开关',
    steps: '出发地北京，在「参数」面板把通道范围切为「仅专项工程」',
    expected: '北京相连通道均为未确认联络线，开启后为空态引导文案（非脚本报错）',
    async run(page, set) {
      await page.goto(G, DCL);
      // 修正(2026-09-18)：跳数输入已移除；「通道范围」下拉随参数面板迁移，须先开面板再切换。
      // 北京无专项工程接入，开启「仅专项工程」后仍为空态引导（err 文案：北京 暂无接入的跨省通道）。
      await page.selectOption('#i-from', 'BJ');
      await openParams(page);
      await page.selectOption('#i-tradable', '1');
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => ({ err: state._res.err || '', empty: document.querySelector('.empty')?.textContent || '' }));
      ok(!!r.err && r.empty.length > 0, `应为空态引导，实际 err=${r.err} empty=${r.empty.slice(0, 30)}`);
      set(`空态：${r.err.slice(0, 40)}`);
    },
  },
  {
    id: 'RQ-03a', section: 'PRD-IPRO', title: 'REQ-301：容量校验口径声明',
    steps: '查看方案区容量口径固定小字',
    expected: '声明存在且含「ATC」',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('#i-calcroute option', { state: 'attached' });
      const ok1 = await page.evaluate(() => document.getElementById('v-calc').innerText.includes('ATC'));
      ok(ok1, '方案区应含 ATC 口径声明');
      set('ATC 声明可见');
    },
  },
  {
    id: 'RQ-03b', section: 'PRD-IPRO', title: 'REQ-302：中长期占用扣减容量校验',
    steps: '中长期占用填 30 后失焦',
    expected: '方案区占用按 cap×(1−0.3) 放大约 1/(1−0.3) 倍，越限判定联动',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#btn-params');   // 2026-09-18：i-zyocc 已迁入参数面板
      const m0 = await page.evaluate(() => state._res.rows[0].maxLoad);
      // 修正(2026-09-18)：中长期占用输入已随参数面板迁移，须先打开「参数」面板再填写。
      await openParams(page);
      await page.fill('#i-zyocc', '30');
      await page.locator('#i-zyocc').blur();
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => ({ m1: state._res.rows[0].maxLoad, occ: state.occPct }));
      const ratio = r.m1 / m0;
      ok(r.occ === 30 && Math.abs(ratio - 1 / 0.7) < 1e-6, `占用应放大约 ${1 / 0.7} 倍，实际 ${ratio}`);
      set(`occ=30；maxLoad ${m0.toFixed(4)}→${r.m1.toFixed(4)}（×${ratio.toFixed(4)}）`);
    },
  },
  {
    id: 'RQ-04', section: 'PRD-IPRO', title: 'REQ-303：单时点测算声明',
    steps: '展开「政策与取值依据」折叠区，查看测算范围声明',
    expected: '声明存在且写明单时段边界（「省间中长期单时段交付成本…合同分时曲线、交易组织…需另行处理」）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('#i-calcroute option', { state: 'attached' });
      // 修正(2026-09-18)：声明文案随测算页重构（570473e）由「96 时段」改写为「单时段交付成本 + 合同分时曲线另行处理」，
      // 且移入默认收起的「政策与取值依据」内，须先展开再断言；单时点边界声明的语义不变。
      await page.evaluate(() => { document.querySelectorAll('details.explain').forEach(d => d.open = true); });
      await page.waitForTimeout(80);
      const t = await page.evaluate(() => document.getElementById('v-calc').innerText);
      ok(t.includes('单时段') && t.includes('合同分时曲线'), `应含单时段边界声明，实际片段「${t.replace(/\s+/g, ' ').slice(0, 60)}」`);
      set('单时段边界声明可见（合同分时曲线、交易组织、安全校核另行处理）');
    },
  },
  {
    id: 'RQ-05', section: 'PRD-IPRO', title: 'REQ-304：口径三非结算口径标注',
    steps: '（未实现）查看「送端收益」按钮提示与⑦口径位置标注',
    expected: '按钮 title 含「非结算口径」；⑦口径位置旁有同义标注',
    // skip 依据：界面重构（570473e）后口径比选排序入口整体移除（排序固定按价格，state.sortBy 恒为 A），
    //「送端收益」按钮与其 title、⑦口径标注均不存在；构建产物全文搜索 '非结算' 命中 0。
    // 待产品确认是否以其它形式补「非结算口径」标注后再恢复本用例。
    skip: '口径比选入口已随界面重构移除（排序固定），「送端收益」按钮与「非结算口径」标注在构建产物中不存在',
  },
  /* 用例已移除（RQ-05）：原 REQ-304 口径三排序按钮已随「排序口径下线」移除（boot.js:97），所测 title 与标注不复存在 用例所测对象已下线。2026-09-18 e2e 清算。 */
  {
    id: 'RQ-06', section: 'PRD-IPRO', title: 'REQ-305：区域电网费适用性标注',
    steps: '（未实现）查看②区区域电网输电价格说明',
    expected: '说明含 S14 3.4.2(a) 统一计入口径（新语义）',
    // skip 依据：REQ-305 指定的 S14 3.4.2(a)「统一计入买方区域」标注不存在（构建产物 '3.4.2' 命中 0）。
    // 区域费范围现为「途经区域各计一次」（network，默认）与「另计受端区域」（buyer）二选一口径，
    // 属语义变更而非文案迁移；按未实现处理，是否补标注待产品确认。
    skip: 'REQ-305 的 S14 3.4.2(a)「统一计入买方区域」标注已随区域计费口径改为 network 默认而不存在',
  },
  {
    id: 'RQ-306', section: 'PRD-IPRO', title: 'REQ-306：结算机制折叠区',
    steps: '（未实现）展开完整明细，查看「结算机制」',
    expected: '折叠块存在且四条齐备（买方支出/卖方边际价/执行顺序/日清月结 D+5）',
    // skip 依据：构建产物全文搜索 '结算机制' / 'D+5' 命中 0；该折叠区已随界面重构移除。
    skip: '「结算机制」折叠区（买方支出/卖方边际价/执行顺序/日清月结 D+5）在构建产物中不存在',
  },
  {
    id: 'RQ-307', section: 'PRD-IPRO', title: 'REQ-307：页脚定位声明',
    steps: '任意 Tab 滚到底',
    expected: '页脚存在「不构成交易建议」声明',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('footer');
      const t = await page.evaluate(() => document.querySelector('footer')?.textContent || '');
      ok(t.includes('不构成交易建议') && t.includes('电力交易中心公布'), `页脚文案=${t.slice(0, 40)}`);
      set('页脚声明可见');
    },
  },
  {
    id: 'RQ-405', section: 'PRD-IPRO', title: 'REQ-405：费率库筛选扩展',
    steps: '点击「含线损」「落地端计费」chips',
    expected: '匹配计数与列表正确（当前数据各 9 条）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-lib');
      const out = [];
      for (const label of ['含线损', '落地端计费']) {
        await page.locator('.seg.small button', { hasText: label }).click();
        await page.waitForTimeout(80);
        const cnt = await page.evaluate(() => parseInt(document.querySelector('.libcount')?.textContent.replace(/[^0-9]/g, '')) || 0);
        const cards = await page.locator('#lib-list .libcard').count();
        ok(cnt === 9 && cards === cnt, `${label} 应匹配 9 条，实际计数=${cnt} 卡片=${cards}`);
        out.push(`${label}:${cnt}`);
      }
      set(out.join('；'));
    },
  },
  {
    id: 'RQ-402', section: 'PRD-IPRO', title: 'REQ-402：价格时效徽标',
    steps: '费率库搜索「灵绍」，查看摘要徽标',
    expected: '显示「现行」徽标含 558 号；展开可见 2 条调价历史',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-lib');
      await page.fill('#lib-q', '灵绍');
      await page.waitForTimeout(100);
      const sum = await page.locator('.libcard summary').first().innerText();
      ok(sum.includes('现行') && sum.includes('558'), `徽标应含 现行/558，实际「${sum.replace(/\\s+/g, ' ').slice(0, 60)}」`);
      await page.locator('.libcard summary').first().click();
      await page.waitForTimeout(80);
      const hist = await page.evaluate(() => (document.body.innerText.match(/调价历史/g) || []).length);
      ok(hist >= 1, '展开后应含调价历史');
      set(`徽标含 现行/558；调价历史区块=${hist}`);
    },
  },
  {
    id: 'RQ-404', section: 'PRD-IPRO', title: 'REQ-404：方案报告导出',
    steps: '测算页点「导出报告」',
    expected: '触发 Markdown 下载，含三口径、费用拆解、逐段文号与 priceVersion',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('#i-calcroute option', { state: 'attached' });
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 5000 }),
        page.locator('button', { hasText: '导出报告' }).click(),
      ]);
      const p = path.join(SHOTS, 'export-report.md');
      await dl.saveAs(p);
      const t = fs.readFileSync(p, 'utf8');
      ok(t.includes('priceVersion') && t.includes('文号') && t.includes('落地成本') && t.includes('不构成交易建议'),
        `报告应含 priceVersion/文号/落地成本/声明，实际长度 ${t.length}`);
      set(`下载 ${dl.suggestedFilename()}，${t.length} 字符，含全部关键段`);
    },
  },
  {
    id: 'RQ-403', section: 'PRD-IPRO', title: 'REQ-403：价差敏感性分析',
    steps: '展开「价差敏感性」折叠卡',
    expected: '36 个价格档（100~800 步长 20）全量输出，含最优路线与落地成本列',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('#i-calcroute option', { state: 'attached' });
      await page.evaluate(() => { const d = document.getElementById('d-sens'); if (d) d.open = true; });
      await page.waitForTimeout(80);
      const r = await page.evaluate(() => {
        const d = document.getElementById('d-sens');
        return { rows: d ? d.querySelectorAll('table tr').length : 0, txt: d ? d.innerText : '' };
      });
      ok(r.rows === 37, `应 36 档 + 表头 = 37 行，实际 ${r.rows}`);
      ok(r.txt.includes('100') && r.txt.includes('800'), '应覆盖 100~800 价格区间');
      set(`敏感性表 ${r.rows - 1} 档`);
    },
  },
  {
    id: 'RQ-703', section: 'PRD-IPRO', title: 'REQ-703：底图切换不可用时应用内弹框反馈',
    steps: '非代理环境点击「腾讯地图」，应用内确认框分别走「保持内置拓扑图」与「改用天地图」',
    expected: '应用内弹框说明不可用并提供选择；取消后保持拓扑图（provider 仍 svg），确定后切到天地图',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('#i-calcroute option', { state: 'attached' });
      const dlg = confirmDlg(page);   // 排除参数弹出面板 .sheet-panel，见 confirmDlg 说明
      const clickQQ = async () => {
        await page.locator('#v-map button', { hasText: '腾讯地图' }).click().catch(async () => {
          await page.evaluate(() => go('map'));
          await page.locator('#v-map button', { hasText: '腾讯地图' }).click();
        });
      };
      await clickQQ();
      await dlg.waitFor({ state: 'visible', timeout: 3000 });
      const msg = await dlg.innerText();
      ok(msg.includes('腾讯地图') && msg.includes('不可用'), `应弹框说明，实际「${msg.slice(0, 30)}」`);
      await dlg.locator('button', { hasText: '保持内置拓扑图' }).click();
      await page.waitForTimeout(200);
      const r = await page.evaluate(() => ({ p: state.mapProvider, on: document.querySelector('#v-map .seg.small button.on')?.textContent }));
      ok(r.p === 'svg' && r.on === '拓扑图', '取消后应保持拓扑图');
      await clickQQ();
      await dlg.waitFor({ state: 'visible', timeout: 3000 });
      await dlg.locator('button', { hasText: '改用天地图' }).click();
      await page.waitForTimeout(200);
      const r2 = await page.evaluate(() => ({ p: state.mapProvider, on: document.querySelector('#v-map .seg.small button.on')?.textContent }));
      ok(r2.p === 'td' && r2.on === '天地图', '确定后应切到天地图');
      set(`应用内弹框="腾讯地图不可用…"；保持→${r.p}；改用→${r2.p}`);
    },
  },
  /* ================= 网架图升级（upgrade-grid-map） ================= */
  {
    id: 'MAP-01', section: '网架升级', title: '仅渲染选中方案：开关与候选/全网架图例退场',
    steps: '打开网架图拓扑视图，检查连线归属、开关与图例；重载后复查（change: grid-map-single-route-and-fixes）',
    expected: 'SVG 的 data-chan 热区仅属选中方案通道；「显示全网架」开关与「其它候选/全网架/价格线型」图例不存在；重载后无 mapNet 状态',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      const r1 = await page.evaluate(() => {
        const rows = state._res.rows;
        const hotIds = new Set(rows[Math.min(state.sel, rows.length - 1)].edges.map(e => e.id));
        const chans = [...document.querySelectorAll('#map-view svg [data-chan]')].map(el => el.getAttribute('data-chan'));
        const txt = document.getElementById('v-map').innerText;
        return {
          chans,
          onlyHot: chans.length > 0 && chans.every(id => hotIds.has(id)),
          noToggle: !document.querySelector('#i-mapnet'),
          legendGone: ['其它候选', '全网架', '价格线型'].every(t => !txt.includes(t)),
        };
      });
      ok(r1.onlyHot, `data-chan 热区应全部属于选中方案通道，实际 ${JSON.stringify(r1.chans)}`);
      ok(r1.noToggle, '「显示全网架」开关应已移除');
      ok(r1.legendGone, '其它候选/全网架/价格线型图例应已移除');
      await page.reload({ waitUntil: 'load' });
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      ok(!(await page.evaluate(() => 'mapNet' in state)), '重载后不应存在 mapNet 状态');
      set(`仅选中方案 ${r1.chans.length} 条通道在线；开关与图例已移除；重载一致`);
    },
  },
  {
    id: 'MAP-06', section: '网架升级', title: '路线选择下拉：默认推荐 #1，切换即重绘',
    steps: '打开网架图拓扑视图检查下拉默认值；选择另一条候选路线后核对地图与测算页选中态（change: grid-map-single-route-and-fixes）',
    expected: '下拉默认选中推荐路线（#1）；切换后 state.sel 更新、图上 data-chan 全部属于新方案；测算页选中卡片一致',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#i-maproute');
      const first = await page.evaluate(() => {
        const sel = document.querySelector('#i-maproute');
        const opt = sel.options[sel.selectedIndex];
        return { value: +sel.value, text: opt.textContent, isRec: opt.textContent.includes('推荐') };
      });
      ok(first.value === 0 && first.isRec, `下拉应默认选中推荐 #1，实际 #${first.value + 1}「${first.text.slice(0, 24)}」`);
      const second = await page.evaluate(() => {
        const sel = document.querySelector('#i-maproute');
        return sel.options.length > 1 ? +sel.options[1].value : null;
      });
      if (second == null) { set('候选仅一条，下拉仅推荐一项（符合规格）'); return; }
      await page.selectOption('#i-maproute', String(second));
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => {
        const rows = state._res.rows;
        const hotIds = new Set(rows[Math.min(state.sel, rows.length - 1)].edges.map(e => e.id));
        const chans = [...document.querySelectorAll('#map-view svg [data-chan]')].map(el => el.getAttribute('data-chan'));
        const sel = document.querySelector('#i-maproute');
        return { sel: state.sel, onlyHot: chans.length > 0 && chans.every(id => hotIds.has(id)), opt: sel.options[sel.selectedIndex].textContent };
      });
      ok(after.sel === second, `切换后 state.sel 应为 ${second}，实际 ${after.sel}`);
      ok(after.onlyHot, '切换后图上应只画新方案通道');
      await page.click('#t-calc');
      await page.waitForTimeout(300);
      // change: grid-map-single-route-and-fixes：测算页路线选择同为下拉（#i-calcroute），value=原候选下标
      const calcSel = await page.evaluate(() => +document.getElementById('i-calcroute').value);
      ok(calcSel === second, `测算页路线下拉应为 #${second + 1}，实际 #${calcSel + 1}`);
      set(`默认推荐 #1；切到 #${second + 1}（${after.opt.slice(0, 24)}…）后仅画新方案；测算页下拉同步 #${calcSel + 1}`);
    },
  },
  {
    id: 'MAP-07', section: '网架升级', title: '拓扑图标注防重叠：省名>站名>段名',
    steps: '深链打开川→陕→甘→宁（换流站与省节点几乎同点的拥挤路线），两两检查拓扑图文字标注矩形',
    expected: '任意两个文字标注的相交面积 ≤4px²；省名优先保留，冲突的站名/段名换侧或省略（change: grid-map-single-route-and-fixes）',
    async run(page, set) {
      await page.goto(G + '#from=SC&to=NX', DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg text');
      const r = await page.evaluate(() => {
        const texts = [...document.querySelectorAll('#map-view svg text')];
        const rs = texts.map(t => t.getBoundingClientRect());
        let worst = 0, pair = '';
        for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
          const a = rs[i], b = rs[j];
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 0 && h > 0 && w * h > worst) { worst = w * h; pair = texts[i].textContent + '|' + texts[j].textContent; }
        }
        return { n: texts.length, worst, pair };
      });
      ok(r.n >= 4, `应有足够标注参与检查，实际 ${r.n} 个文字`);
      ok(r.worst <= 4, `文字标注两两相交面积应 ≤4px²，最差 ${r.worst.toFixed(1)}px²（${r.pair}）`);
      set(`${r.n} 个文字标注，最大相交 ${r.worst.toFixed(1)}px²（${r.pair}）`);
    },
  },
  {
    id: 'MAP-02', section: '网架升级', title: '选中方案线路名与站名标注 + 视野聚焦',
    steps: '打开网架图拓扑视图（默认四川→江苏锦苏直流）',
    expected: 'SVG 含段线路名「锦苏直流」、段序号 1、起止站名标注；viewBox 聚焦路线包围盒',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      const r = await page.evaluate(() => {
        const texts = [...document.querySelectorAll('#map-view svg text')].map(t => t.textContent);
        return { name: texts.includes('锦苏直流'), seq: texts.includes('1'), st: texts.some(t => t.includes('换流站')), vb: document.querySelector('#map-view svg').getAttribute('viewBox') };
      });
      ok(r.name, '应含段线路名标注（锦苏直流）');
      ok(r.seq, '应含段序号标注');
      ok(r.st, '应含站点名标注');
      ok(r.vb && r.vb !== '0 0 660 430', `视野应聚焦路线，viewBox=${r.vb}`);
      set(`标注齐备；viewBox=${(r.vb || '').slice(0, 32)}…`);
    },
  },
  {
    id: 'MAP-03', section: '网架升级', title: '点击通道=必经过滤联动测算页',
    steps: '拓扑图点击选中方案上的一条通道段，再点击一次取消',
    expected: '点击后 state.mustHave 含该通道、测算页 i-chan 同步、路线图重绘；再点恢复',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      // change: grid-map-single-route-and-fixes：候选/全网架层退场后，点击热区仅剩选中方案通道段（polyline）
      await page.waitForSelector('#map-view svg polyline[data-chan]');
      const cid = await page.evaluate(() => document.querySelector('#map-view svg polyline[data-chan]').getAttribute('data-chan'));
      await page.evaluate(id => document.querySelector(`#map-view svg polyline[data-chan="${id}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true })), cid);
      await page.waitForTimeout(300);
      ok(JSON.stringify(await page.evaluate(() => state.mustHave)) === JSON.stringify([cid]), `mustHave 应为 [${cid}]`);
      const chan = await page.evaluate(() => (document.getElementById('i-chan') || {}).value);
      ok(chan === cid, `测算页通道筛选应同步为 ${cid}，实际 ${chan}`);
      await page.evaluate(id => { const l = document.querySelector(`#map-view svg [data-chan="${id}"]`); if (l) l.dispatchEvent(new MouseEvent('click', { bubbles: true })); }, cid);
      // 2026-09-18 批次 B：选中方案段为 polyline 渲染（走廊折线化），热区选择器不限标签
      await page.waitForTimeout(300);
      ok((await page.evaluate(() => state.mustHave.length)) === 0, '再次点击应解除过滤');
      set(`点击 ${cid} → mustHave 联动并同步测算页；再点解除`);
    },
  },
  {
    id: 'MAP-04', section: '网架升级', title: '点击站点展示站点信息浮层',
    steps: '拓扑图点击选中路线上的站点标记',
    expected: '浮层显示站名与省份/站址信息，可关闭',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg [data-st]');
      const st = await page.evaluate(() => document.querySelector('#map-view svg [data-st]').getAttribute('data-st'));
      await page.evaluate(id => document.querySelector(`#map-view svg [data-st="${id}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true })), st);
      await page.waitForTimeout(150);
      const pop = await page.evaluate(() => document.getElementById('map-pop').innerText);
      ok(pop.trim().length > 5, `浮层应含站点信息，实际「${pop.slice(0, 40)}」`);
      await page.evaluate(() => document.querySelector('#map-pop button').click());
      ok((await page.evaluate(() => document.getElementById('map-pop').innerText.trim())) === '', '关闭后浮层应清空');
      set(`站点浮层：${pop.slice(0, 30)}…`);
    },
  },
  {
    id: 'MAP-05', section: '网架升级', title: '拓扑图快照导出 PNG',
    steps: '拓扑图视图点击「导出快照 PNG」，拦截下载动作检查文件名',
    expected: '触发下载且文件名含 iproute-grid-<priceVersion> 前缀（内容与水印已由导出样张实证）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      const name = await page.evaluate(() => new Promise(res => {
        let got = '';
        const orig = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () { got = this.download || ''; };
        try { exportTopo(); } catch (e) { HTMLAnchorElement.prototype.click = orig; return res('ERR:' + e); }
        setTimeout(() => { HTMLAnchorElement.prototype.click = orig; res(got); }, 2500);
      }));
      ok(name.startsWith('iproute-grid-'), `下载文件名应含 iproute-grid- 前缀，实际「${name}」`);
      set(`导出触发成功，文件名=${name}…`);
    },
  },

  /* ================= 体验修复（PRD-体验问题修复-20260918，change: grid-map-p1-and-ux-fixes） ================= */
  {
    id: 'UX-01', section: '体验修复', title: 'FR-1 送端报价超长数字：钳制+缩略+版式稳定',
    steps: '送端报价输入 20 位数字后失焦，再改回合法值',
    expected: 'state 只存钳制值 10000；红框红字提示出现；hero 大字不溢出、title 可见完整值；修正后提示消失',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.fill('#i-pgen', '32405156513821294592');
      await page.locator('#i-pgen').blur();
      await page.waitForTimeout(300);
      ok(await page.evaluate(() => state.pGen) === 10000, `state.pGen 应钳制为 10000，实际 ${await page.evaluate(() => state.pGen)}`);
      ok(await page.locator('.clamp-hint').count() > 0, '应出现钳制红字提示');
      ok((await page.locator('#i-pgen').getAttribute('class') || '').includes('clamp-bad'), '输入框应有红框标记');
      const m = await page.evaluate(() => {
        const el = document.querySelector('.hero-v');
        return { sw: el.scrollWidth, cw: el.clientWidth, title: el.getAttribute('title') || '' };
      });
      ok(m.sw <= m.cw + 1, `hero 大字不应溢出：scrollWidth ${m.sw} > clientWidth ${m.cw}`);
      ok(m.title.includes('完整值'), `hero 应带完整值 title，实际「${m.title.slice(0, 40)}」`);
      await page.fill('#i-pgen', '320');
      await page.locator('#i-pgen').blur();
      await page.waitForTimeout(300);
      ok(await page.locator('.clamp-hint').count() === 0, '修正后红字提示应消失');
      set(`pGen→10000 钳制；提示出现/消失均断言；hero ${m.sw}/${m.cw}px 不溢出`);
    },
  },
  {
    id: 'UX-02', section: '体验修复', title: 'FR-1 容量电费测算器超大输入：三卡不破版',
    steps: '展开容量电费测算卡，容量输入 5e9 后失焦',
    expected: 'capValue 钳制为 1e6 并提示；三卡 .mc .v 全部入视口（V2 曾推出右缘 170px）；年费用以万/亿缩略',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.evaluate(() => { document.getElementById('d-capfee').open = true; });
      await page.fill('#i-capval', '5000000000');
      await page.locator('#i-capval').blur();
      await page.waitForTimeout(300);
      ok(await page.evaluate(() => state.capValue) === 1000000, `capValue 应钳制为 1e6，实际 ${await page.evaluate(() => state.capValue)}`);
      const r = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#d-capfee .mc .v')];
        return { edges: cards.map(el => Math.round(el.getBoundingClientRect().right)), txt: cards[1] ? cards[1].textContent : '' };
      });
      ok(r.edges.length === 3, '应渲染三卡');
      ok(r.edges.every(x => x <= 391), `三卡右缘应入视口，实际 [${r.edges.join(',')}]（视口 390）`);
      ok(/[万亿]/.test(r.txt), `年容量电费应缩略显示，实际「${r.txt}」`);
      set(`capValue→1e6；三卡右缘 [${r.edges.join(',')}]；年费用「${r.txt.slice(0, 10)}」`);
    },
  },
  {
    id: 'UX-03', section: '体验修复', title: 'FR-1 钳制值持久化：重启不复发',
    steps: '超限输入触发钳制后重载页面',
    expected: '重载后 state.pGen 为钳制后合法值（saveLast 只存钳制值），版式正常',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.fill('#i-pgen', '77777777777');
      await page.locator('#i-pgen').blur();
      await page.waitForTimeout(300);
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(250);
      const v = await page.evaluate(() => state.pGen);
      ok(v === 10000, `重载后 pGen 应为 10000，实际 ${v}`);
      // 边界补测（2026-09-18 验证轮）：FR-1 之前的旧存档没有上限，恢复时也必须钳制（PRD AC3 对历史存档同样成立）
      await page.evaluate(() => localStorage.setItem('iproute.v2.last', JSON.stringify({ pGen: 1e20, pGenManual: true, qty: 5e9, capValue: 9e9, from: 'SC', to: 'JS' })));
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(300);
      const lg = await page.evaluate(() => ({
        pGen: state.pGen, qty: state.qty, capValue: state.capValue,
        sw: (() => { const el = document.querySelector('.hero-v'); return el ? el.scrollWidth - el.clientWidth : -1; })(),
      }));
      ok(lg.pGen === 10000 && lg.qty === 10000000 && lg.capValue === 1000000, `旧存档恢复应钳制（pGen=${lg.pGen}, qty=${lg.qty}, capValue=${lg.capValue}）`);
      ok(lg.sw <= 1, `旧存档大数不破版：hero 溢出 ${lg.sw}px`);
      set(`重载后 pGen=${v}（钳制值持久化）；旧版未钳制存档恢复亦钳制且不破版`);
    },
  },
  {
    id: 'UX-04', section: '体验修复', title: 'FR-2 空输入保留密钥 + 清除密钥降级',
    steps: '预置已存密钥切到天地图：清空输入点「应用密钥」；再点「清除密钥」',
    expected: '空输入不改动已存密钥并显示常驻灰字；清除后立即降级拓扑图，密钥清空并持久化（重启不回弹）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.evaluate(() => localStorage.setItem('iproute.v2.map', JSON.stringify({ mapProvider: 'td', tiandituKey: 'TESTKEY1234' })));
      await page.reload({ waitUntil: 'load' });
      await page.click('#t-map');
      await page.waitForTimeout(400);
      ok(await page.evaluate(() => state.tiandituKey) === 'TESTKEY1234', '已存密钥应被加载');
      await page.fill('#i-tk', '');
      await page.locator('#v-map .row3 button', { hasText: '应用密钥' }).click();
      await page.waitForTimeout(150);
      const msg = await page.locator('#tk-msg').innerText();
      ok(msg.includes('已保留本机已存密钥'), `空输入应提示保留已存密钥，实际「${msg.slice(0, 40)}」`);
      ok(await page.evaluate(() => state.tiandituKey) === 'TESTKEY1234', '空输入不得清掉已存密钥');
      await page.locator('#v-map .row3 button', { hasText: '清除密钥' }).click();
      await page.waitForTimeout(250);
      ok(await page.evaluate(() => state.mapProvider) === 'svg', '清除后应立即降级为拓扑图');
      ok(await page.evaluate(() => state.tiandituKey) === '', '清除后 tiandituKey 应为空');
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('iproute.v2.map') || '{}'));
      ok(saved.mapProvider === 'svg' && !saved.tiandituKey, '清除操作应持久化（重启不回弹）');
      set(`空输入保留 TESTKEY1234（灰字常驻）；清除后 svg + 密钥清空持久化`);
    },
  },
  {
    id: 'UX-05', section: '体验修复', title: 'FR-2 瓦片级探针状态机（mock Image 两分支）',
    steps: '切天地图，注入 T 桩与受控 Image 桩，分别触发探针 onload / onerror',
    expected: 'onload(naturalWidth≥256) → 绿字「密钥有效」；onerror → 自动切回内置拓扑图 + 红字降级说明（区分「密钥无效/被风控拦截」与「网络不可达」，grid-map-device-fixes D4 推翻 D-2 保留容器口径）；全程无「加载成功」假阳性',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.locator('#v-map .seg.small button', { hasText: '天地图' }).click();
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        window.T = { Protocol: { value: 'https:' }, Domain: 'gov.cn' };
        window.__imgOk = true;
        window.Image = class {
          set src(v) {
            setTimeout(() => {
              if (window.__imgOk) { this.naturalWidth = 256; if (this.onload) this.onload(); }
              else if (this.onerror) this.onerror();
            }, 10);
          }
        };
        // onerror 分支会用 no-cors fetch 二分定性（密钥无效 vs 网络不可达）；
        // 测试网络下真实 fetch 可能长时间挂起，替换为立即 resolve（定性=服务端有响应=被拒）
        window.fetch = () => Promise.resolve({ ok: true });
      });
      await page.evaluate(() => tkMsg('ok'));
      await page.waitForTimeout(100);
      ok((await page.locator('#tk-msg').innerText()).includes('密钥有效'), 'onload 分支应显示「密钥有效，底图可用」');
      await page.evaluate(() => { window.__imgOk = false; tkMsg('ok'); });
      await page.waitForTimeout(400);
      // grid-map-device-fixes D4（推翻 PRD D-2）：onerror 不再保留无底图叠加物，自动切回拓扑图 + 红字说明
      ok(await page.evaluate(() => state.mapProvider) === 'svg', 'onerror 应自动降级回内置拓扑图');
      const note = await page.evaluate(() => document.getElementById('v-map').innerText);
      ok(note.includes('密钥无效或被风控拦截') && note.includes('已自动切回内置拓扑图'), `降级红字说明应在场，实际「${note.slice(0, 60)}」`);
      set(`onload→密钥有效；onerror→自动降级 svg + 红字说明（密钥无效或被风控拦截）`);
    },
  },
  {
    id: 'UX-06', section: '体验修复', title: 'FR-3 新手导览：首启弹出/跳过持久化/帮助入口/不阻塞',
    steps: '独立干净 context（无导览预置）加载 → 验证不阻塞 → 跳过 → 重载 → 点页头「帮助」',
    expected: '首启自动弹出导览且主流程可正常操作；跳过写键、重载不再弹；帮助入口可重开导览',
    async run(page, set) {
      // runTest 的 addInitScript 会给本 context 预置导览键，首启分支须用干净 context 验证
      const ctx2 = await page.context().browser().newContext({ viewport: { width: 390, height: 844 } });
      const p2 = await ctx2.newPage();
      try {
        await p2.goto(G, DCL);
        await p2.waitForSelector('#guide-box', { timeout: 4000 });
        await p2.selectOption('#i-calcroute', '1');
        ok(await p2.evaluate(() => state.sel) === 1, '导览在场时测算主流程应可正常操作（AC3 不阻塞）');
        await p2.locator('#guide-box button', { hasText: '跳过导览' }).click();
        ok(await p2.locator('#guide-box').count() === 0, '跳过后导览应关闭');
        ok(await p2.evaluate(() => localStorage.getItem('iproute.v2.guide')) === '1', '跳过应写导览键（与走完同等）');
        await p2.reload({ waitUntil: 'load' });
        await p2.waitForTimeout(800);
        ok(await p2.locator('#guide-box').count() === 0, '跳过后重载不应再弹出（AC1：结束进程重开不重弹）');
        await p2.click('#btn-help');
        await p2.waitForSelector('#guide-box', { timeout: 2000 });
        ok(await p2.locator('#guide-box button', { hasText: '下一步' }).count() > 0, '帮助入口应可重开导览（AC2）');
        await p2.locator('#guide-box button', { hasText: '跳过导览' }).click();
        set(`干净 context 首启自动弹出且不阻塞（sel=1 可点）；跳过持久化；重载不弹；帮助入口重开成功`);
      } finally {
        await ctx2.close();
      }
      // 报告证据图：主 page（本 context 预置了导览键，不自动弹）加载后通过帮助入口重开导览供截图
      await page.goto(G, DCL);
      await page.click('#btn-help');
      await page.waitForSelector('#guide-box', { timeout: 2000 });
      await page.locator('#guide-box button', { hasText: '跳过导览' }).click();
    },
  },
  {
    id: 'UX-07', section: '体验修复', title: 'FR-4 推荐失效提示（renderAI 两分支）',
    steps: '构造旧结果对象挂 state._ai，渲染 renderAI 对比 res 不一致/一致',
    expected: '不一致 → 含「参数已变化，原推荐已失效」与「重新推荐」按钮；一致 → 无失效提示',
    async run(page, set) {
      await page.goto(G, DCL);
      const stale = await page.evaluate(() => {
        state._ai = { result: { recs: [], summary: '', caveats: '' }, res: { stale: true } };
        return renderAI(state._res);
      });
      ok(stale.includes('参数已变化，原推荐已失效') && stale.includes('重新推荐'), '过期分支应显示失效提示与重新推荐按钮');
      const fresh = await page.evaluate(() => {
        state._ai = { result: { recs: [], summary: '', caveats: '' }, res: state._res };
        return renderAI(state._res);
      });
      ok(!fresh.includes('已失效'), '一致分支不应显示失效提示');
      set(`过期分支含提示+按钮（${stale.includes('重新推荐') ? '有' : '无'}按钮）；一致分支无提示`);
    },
  },
  {
    id: 'UX-08', section: '体验修复', title: 'FR-5 费率库容量电价分区：搜索/筛选/与测算器同源',
    steps: '费率库切「容量电价」分区，搜索「北京」，交叉核对首档容量电价与 CAP 取值',
    expected: '分区含省份/档别/容量电价/需量电价/来源；搜索北京命中；表内数值与测算器 CAP 同源一致；筛选可用',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-lib');
      await page.locator('.seg button', { hasText: '容量电价' }).click();
      await page.waitForTimeout(200);
      await page.fill('#cap-q', '北京');
      await page.waitForTimeout(200);
      const list = await page.evaluate(() => document.getElementById('cap-list').innerText);
      ok(list.includes('北京'), '搜索「北京」应命中（AC）');
      const cross = await page.evaluate(() => {
        const e = CAP['BJ'];
        if (!e || !(e.容量电价 || []).length) return null;
        const t = e.容量电价[0];
        return { price: t.价, fmted: fmt(t.价), src: e.来源 || '' };
      });
      ok(!!cross, 'CAP 应含北京数据');
      ok(list.includes(cross.fmted), `表内应含北京首档容量电价 ${cross.fmted}（与测算器同源）`);
      ok(cross.src && list.includes(cross.src.slice(0, 8)), '应展示来源字段');
      await page.fill('#cap-q', '');
      await page.locator('.seg.small button', { hasText: '缺需量价' }).click();
      await page.waitForTimeout(200);
      const r2 = await page.evaluate(() => {
        const m = (document.getElementById('cap-list').innerText.match(/匹配 (\d+) 省/) || [])[1];
        return {
          total: capProvinces().length,
          shown: m == null ? 0 : +m,
          expect: capProvinces().filter(k => !(CAP[k].需量电价 || []).length).length,
        };
      });
      ok(r2.shown === r2.expect, `缺需量价筛选应显示 ${r2.expect} 省（≤全部 ${r2.total}），实际 ${r2.shown}`);
      ok((await page.locator('.seg.small button.on', { hasText: '缺需量价' }).count()) === 1, '筛选按钮应呈选中态');
      set(`搜索北京命中；首档容量电价 ${cross.fmted} 元/千伏安·月与 CAP 同源；筛选 ${r2.shown}/${r2.total} 省`);
    },
  },
  {
    id: 'UX-09', section: '体验修复', title: 'A5 状态深链：hash 恢复 / 非法参数容错 / 复制链接',
    steps: '打开 #from=NX&to=ZJ&sel=1；再打开非法参数（XX 省 + 越界 sel）；网架图点「复制链接」',
    expected: '恢复宁夏→浙江且 sel=1、hash 用后即清；非法参数按默认态打开无报错、越界 sel 收敛；复制链接产出含三参数的 URL',
    async run(page, set) {
      await page.goto(G + '#from=NX&to=ZJ&sel=1', DCL);
      await page.waitForTimeout(350);
      ok(await page.evaluate(() => state.from) === 'NX' && await page.evaluate(() => state.to) === 'ZJ', `深链应恢复 NX→ZJ，实际 ${await page.evaluate(() => state.from + '→' + state.to)}`);
      ok(await page.evaluate(() => state.sel) === 1, `深链应恢复 sel=1，实际 ${await page.evaluate(() => state.sel)}`);
      ok((await page.evaluate(() => location.hash)) === '', '恢复后应清掉 hash（刷新/后退不重复解释）');
      const hd = (await page.locator('.hd-route').first().innerText()).trim();
      ok(hd.startsWith('宁夏'), `详情应以宁夏开头，实际「${hd.slice(0, 12)}」`);
      // 非法参数：未知省代码 + 越界方案序号 → 默认态打开，无脚本错误。
      // 注意：上一个 URL 已被 replaceState 去掉 hash，这里只差 fragment 的 goto 会走同文档
      // fragment 导航（不重载、boot 不重跑），先跳 about:blank 强制真实导航
      await page.goto('about:blank');
      await page.goto(G + '#from=XX&to=JS&sel=99999', DCL);
      await page.waitForTimeout(350);
      const r2 = await page.evaluate(() => ({ from: state.from, sel: state.sel, rows: state._res.rows.length }));
      ok(r2.from === 'SC', `非法 from 应回退默认 SC，实际 ${r2.from}`);
      ok(r2.sel < r2.rows, `越界 sel 应收敛到合法范围，实际 ${r2.sel}/${r2.rows}`);
      // 页面脚本错误由 runTest 统一采集：本用例报告条目控制台报错应为「无」
      // 复制链接：断言 URL 构造（剪贴板写入依赖权限，不做端到端断言，只要求点击不抛错）
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      const u = await page.evaluate(() => mapLinkURL());
      ok(/#from=SC&to=JS&sel=\d+$/.test(u), `复制链接应产出带三参数的 URL，实际「${u.slice(-46)}」`);
      await page.locator('#v-map button', { hasText: '复制链接' }).click();
      await page.waitForTimeout(150);
      set(`深链恢复 NX→ZJ sel=1；非法参数回退 SC/sel 收敛无报错；链接 URL=${u.slice(-32)}`);
    },
  },

  /* ================= 网架图 P1（批次 B，change: grid-map-p1-and-ux-fixes） ================= */
  {
    id: 'P1-01', section: '网架P1', title: '走廊折线渲染：waypoints 折线化且计价不变',
    steps: '运行时给锦苏直流注入 2 个走廊中间点后重绘网架图',
    expected: '该通道以 polyline（4 点）渲染；候选路线与落地价与注入前完全一致（走廊仅影响呈现，spec 硬约束）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      const before = await page.evaluate(() => ({ landed: state._res.rows[0].landed, total: state._res.total }));
      const id = await page.evaluate(() => {
        const c = CH.find(x => x.n === '锦苏直流');
        c.waypoints = [[104.5, 29.2], [108.8, 30.6]];
        renderMap();
        return c.id;
      });
      await page.waitForTimeout(300);
      const poly = await page.evaluate(id => document.querySelector(`#map-view svg polyline[data-chan="${id}"]`)?.getAttribute('points') || '', id);
      ok(poly, '注入 waypoints 后该通道应以折线渲染');
      ok(poly.split(' ').length === 4, `折线应为 4 个点（起+2 中间+止），实际 ${poly.split(' ').length}`);
      const after = await page.evaluate(() => ({ landed: state._res.rows[0].landed, total: state._res.total }));
      ok(after.landed === before.landed && after.total === before.total, `走廊注入不得改变测算结果（${before.landed}→${after.landed}）`);
      set(`折线点数=4；落地价/候选数注入前后一致（${before.landed} 元/MWh）`);
    },
  },
  {
    id: 'P1-02', section: '网架P1', title: '单一选中层：弱化层与 tier 图例退场、选中层无 dash',
    steps: '拓扑视图检查无任何 dasharray 虚线与「价格线型」图例；选中方案线无 dasharray（change: grid-map-single-route-and-fixes）',
    expected: '全网/候选弱化层移除后全图无 dasharray；图例不含「价格线型」；选中蓝线存在且无 dasharray',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      const r = await page.evaluate(() => {
        const svg = document.querySelector('#map-view svg');
        const dash = svg.querySelectorAll('[stroke-dasharray]').length;
        // 拓扑图配色走设计令牌（style="stroke:var(--map-route)"），按令牌名识别选中层
        const selDash = [...svg.querySelectorAll('line, polyline')].filter(el => el.style.stroke === 'var(--map-route)' && el.getAttribute('stroke-dasharray')).length;
        const selLines = [...svg.querySelectorAll('line, polyline')].filter(el => el.style.stroke === 'var(--map-route)').length;
        const legend = document.getElementById('v-map').innerText;
        return { dash, selDash, selLines, noTierLegend: !legend.includes('价格线型') };
      });
      ok(r.selLines > 0, `应能按令牌识别到选中方案线（实际 ${r.selLines} 条），否则下一条断言失去意义`);
      ok(r.selDash === 0, '选中方案线不得被 tier 线型干扰（spec）');
      ok(r.dash === 0, `弱化层移除后全图不应再有 dasharray 虚线，实际 ${r.dash} 处`);
      ok(r.noTierLegend, '「价格线型」图例应已移除');
      set(`选中线 ${r.selLines} 条；全图 0 处 dasharray；tier 图例已移除`);
    },
  },
  {
    id: 'P1-03', section: '网架P1', title: '容量浮层：信息+待补+必经切换',
    steps: '搜索定位一条容量待补且不在当前方案中的通道（mapGotoChan）打开浮层，再点浮层「设为必经通道」',
    expected: '浮层显示输电价/容量（缺失显「待补」）/占用与必经按钮；点按钮后 mustHave 生效且浮层显示必经过滤中',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg [data-chan]');
      const pick = await page.evaluate(() => {
        const hot = new Set(state._res.rows.flatMap(row => row.edges.map(e => e.id)));
        // 从当前省对「可用通道」里选（不在可用集内的通道会被 solveState 自动摘除必经，断言失真）
        const avail = (state._res.availChannels || []).find(c => !hot.has(c.id));
        return avail ? avail.id : '';
      });
      ok(!!pick, '当前省对应存在非选中的可用通道');
      const capNull = await page.evaluate(id => (CH.find(x => x.id === id) || {}).cap == null, pick);
      // change: grid-map-single-route-and-fixes：非选中通道不再上图、无点击热区，
      // 浮层改经搜索定位入口（mapGotoChan）打开；必经过滤由浮层按钮驱动，语义不变
      await page.evaluate(id => mapGotoChan(id), pick);
      await page.waitForTimeout(400);
      const pop = await page.evaluate(() => document.getElementById('map-pop').innerText);
      ok(pop.includes('容量'), '浮层应含容量字段');
      if (capNull) ok(pop.includes('待补'), `容量缺失通道浮层应显「待补」，实际「${pop.slice(0, 50)}」`);
      ok(pop.includes('占用'), '浮层应含占用率字段');
      // 点浮层「设为必经通道」→ mustHave 生效，浮层转「解除必经过滤」
      await page.evaluate(() => [...document.querySelectorAll('#map-pop button')].find(b => b.textContent.includes('设为必经通道')).click());
      await page.waitForTimeout(400);
      ok(pop.includes('设为必经通道'), '浮层应提供「设为必经通道」按钮');
      ok(JSON.stringify(await page.evaluate(() => state.mustHave)) === JSON.stringify([pick]), '设为必经后 mustHave 应生效（MAP-03 同语义）');
      const pop1 = await page.evaluate(() => document.getElementById('map-pop').innerText);
      ok(pop1.includes('必经过滤中') && pop1.includes('解除必经过滤'), '开启后浮层应显示必经过滤中与解除按钮');
      // 点浮层「解除必经过滤」→ 过滤解除，浮层转回「设为必经通道」
      await page.evaluate(() => [...document.querySelectorAll('#map-pop button')].find(b => b.textContent.includes('解除必经过滤')).click());
      await page.waitForTimeout(400);
      ok((await page.evaluate(() => state.mustHave.length)) === 0, '点解除后 mustHave 应清空');
      const pop2 = await page.evaluate(() => document.getElementById('map-pop').innerText);
      ok(pop2.includes('设为必经通道'), '解除后浮层应提供「设为必经通道」按钮');
      set(`通道 ${pick}：浮层含容量(待补)/占用/按钮；设为必经联动生效`);
    },
  },
  {
    id: 'P1-04', section: '网架P1', title: '断面选择器：成员高亮与限额提示',
    steps: '网架图选择一个成员可映射且含非当前方案成员的断面，再切回不选',
    expected: '选中断面后出现紫色晕圈垫层与限额提示条；清除后晕圈与提示条消失',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      const sec = await page.evaluate(() => {
        const hot = new Set(state._res.rows.flatMap(row => row.edges.map(e => e.id)));
        const hit = SEC.find(s => {
          const mapped = CH.filter(c => (s.edges || []).includes(c.n));
          return mapped.length && mapped.some(c => !hot.has(c.id));
        });
        return hit ? hit.id : '';
      });
      ok(!!sec, '数据中应存在成员可映射的断面');
      await page.selectOption('#i-mapsec', sec);
      await page.waitForTimeout(300);
      const r1 = await page.evaluate(id => {
        const s = SEC.find(x => x.id === id);
        const members = (s.edges || []).filter(n => CH.some(c => c.n === n)).length;
        return {
          halo: [...document.querySelectorAll('#map-view svg polyline, #map-view svg line')].filter(el => el.style.stroke === 'var(--map-section)').length,
          strip: (document.getElementById('v-map').innerText || '').includes('断面高亮：'),
          members,
        };
      }, sec);
      ok(r1.halo >= 1, `成员通道应出现晕圈垫层（可映射成员 ${r1.members}，晕圈 ${r1.halo}）`);
      ok(r1.strip, '应显示断面限额提示条');
      await page.selectOption('#i-mapsec', '');
      await page.waitForTimeout(300);
      const r2 = await page.evaluate(() => ({
        halo: [...document.querySelectorAll('#map-view svg polyline, #map-view svg line')].filter(el => el.style.stroke === 'var(--map-section)').length,
        // 注意：下拉框首项文案「按断面高亮…」含相似字样，必须用带冒号的提示条标记判别
        strip: (document.getElementById('v-map').innerText || '').includes('断面高亮：'),
      }));
      ok(r2.halo === 0 && !r2.strip, '清除选择后晕圈与提示条应消失');
      set(`断面 ${sec}：晕圈 ${r1.halo}（可映射成员 ${r1.members}）、提示条在场；清除后归零`);
    },
  },
  {
    id: 'P1-05', section: '网架P1', title: '站点/通道搜索：聚焦+浮层+无结果反馈',
    steps: '搜索「锦屏」点命中项；再搜不存在的词',
    expected: '命中后视野收拢到站点并弹站名浮层；无命中给明确提示；搜索与聚焦不改变 state.sel 与 mustHave',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      const vb0 = await page.evaluate(() => document.querySelector('#map-view svg').getAttribute('viewBox'));
      await page.fill('#map-q', '锦屏');
      await page.waitForTimeout(150);
      await page.locator('#map-search-out button', { hasText: '锦屏换流站' }).first().click();
      await page.waitForTimeout(300);
      const vb1 = await page.evaluate(() => document.querySelector('#map-view svg').getAttribute('viewBox'));
      ok(vb1 !== vb0, `搜索聚焦应收拢视野：${(vb0 || '').slice(0, 18)} → ${(vb1 || '').slice(0, 18)}`);
      const pop = await page.evaluate(() => document.getElementById('map-pop').innerText);
      ok(pop.includes('锦屏换流站'), `站点浮层应显示站名，实际「${pop.slice(0, 30)}」`);
      await page.fill('#map-q', '绝对不存在的站');
      await page.waitForTimeout(150);
      ok((await page.evaluate(() => document.getElementById('map-search-out').innerText)).includes('无匹配'), '无命中应给明确提示');
      ok(await page.evaluate(() => state.sel) === 0, '搜索不得改变选中方案');
      ok((await page.evaluate(() => state.mustHave.length)) === 0, '搜索不得改变必经过滤');
      set(`聚焦收拢（${(vb0 || '').slice(0, 14)}…→${(vb1 || '').slice(0, 14)}…）；浮层在场；无命中提示在场；sel/mustHave 不变`);
    },
  },
  {
    id: 'P1-06', section: '网架P1', title: '区域归属上图：着色环+图例+浮层归属',
    steps: '开启「按区域着色」检查省份节点区域环与图例；点途经站点看区域归属；关闭后恢复',
    expected: '开启后节点出现多色区域环、图例列出六大区域、站点浮层含区域归属；关闭后环消失、恢复默认分层显示',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      await page.locator('#i-mapregion').check();
      await page.waitForTimeout(300);
      const r1 = await page.evaluate(() => {
        const rings = [...document.querySelectorAll('#map-view svg circle[fill="none"]')];
        // 区域环颜色是令牌引用 var(--map-region-N)，按计算后的实际颜色去重
        const colors = [...new Set(rings.map(c => getComputedStyle(c).stroke))];
        const legend = document.getElementById('v-map').innerText;
        return {
          n: rings.length, colors,
          hasAll: ['华北', '华东', '华中', '东北', '西北', '南方'].every(x => legend.includes(x)),
          basis: legend.includes('区域电网分区'),
        };
      });
      ok(r1.n >= 20, `区域着色环应覆盖省份节点（实际 ${r1.n} 个）`);
      ok(r1.colors.length >= 6, `应出现 ≥6 种区域颜色，实际 ${r1.colors.length} 色`);
      ok(r1.hasAll, '图例应列出六大区域');
      ok(r1.basis, '图例应标注着色依据（区域电网分区）');
      const st = await page.evaluate(() => document.querySelector('#map-view svg [data-st]').getAttribute('data-st'));
      await page.evaluate(id => document.querySelector(`#map-view svg [data-st="${id}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true })), st);
      await page.waitForTimeout(150);
      ok((await page.evaluate(() => document.getElementById('map-pop').innerText)).includes('区域归属'), '站点浮层应含区域归属');
      await page.locator('#i-mapregion').uncheck();
      await page.waitForTimeout(300);
      const n2 = await page.evaluate(() => [...document.querySelectorAll('#map-view svg circle[fill="none"]')].length);
      ok(n2 === 0, `关闭后区域环应消失，实际 ${n2} 个`);
      set(`区域环 ${r1.n} 个 / ${r1.colors.length} 色；六区域图例+依据在场；浮层含归属；关闭恢复默认`);
    },
  },

  /* ================= 真机修复（v1.2.0 真机验收反馈，change: grid-map-device-fixes） ================= */
  {
    id: 'MF-01', section: '真机修复', title: '页头一行化：360px 视口单行（D1）',
    steps: '360px 视口打开应用；再在费率库修改一条费率后回页头',
    expected: '标题/徽章/？按钮同行（bottom 差≤2px）且无横向溢出；徽章默认「公开数据」，改价后「费率已本地修改」仍单行',
    viewport: { width: 360, height: 740 },
    async run(page, set) {
      const measure = () => page.evaluate(() => {
        const bs = [document.querySelector('h1'), document.getElementById('verBadge'), document.getElementById('btn-help')].map(e => e.getBoundingClientRect());
        return {
          centers: bs.map(b => Math.round((b.top + b.bottom) / 2)), heights: bs.map(b => Math.round(b.height)),
          badge: document.getElementById('verBadge').textContent,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          hdH: Math.round(document.querySelector('.hd-top').getBoundingClientRect().height),
        };
      });
      // 单行判据：三元素垂直中心对齐（.hd-top align-items:center）、无换行（中心差≤3px 且各行高≤按钮高）、无横向溢出
      const oneLine = m => new Set(m.centers).size === 1 || (Math.max(...m.centers) - Math.min(...m.centers) <= 3 && m.heights.every(h => h <= 40));
      await page.goto(G, DCL);
      const m = await measure();
      ok(m.badge === '公开数据', `徽章默认文案应为「公开数据」，实际「${m.badge}」`);
      ok(m.overflow <= 1, `360px 视口不应横向溢出，实际 ${m.overflow}px`);
      ok(oneLine(m), `页头三元素应单行居中，centers=${m.centers} heights=${m.heights}`);
      await page.click('#t-lib');
      await page.evaluate(() => setCh(0, 't', 123.4));
      await page.click('#t-calc');
      const m2 = await measure();
      ok(m2.badge === '费率已本地修改', `改价后徽章应为「费率已本地修改」，实际「${m2.badge}」`);
      ok(m2.overflow <= 1 && oneLine(m2), `改价后页头仍应单行，centers=${m2.centers} heights=${m2.heights} 溢出=${m2.overflow}px`);
      set(`默认「公开数据」单行（溢出 ${m.overflow}px）；改价后「费率已本地修改」仍单行`);
    },
  },
  {
    id: 'MF-02', section: '真机修复', title: '拓扑图触摸：平移/捏合/双击复位 + 拖动不误触（D2）',
    steps: '合成 pointer 事件：单指拖动（>6px）、拖动同步派发 click、再普通点通道、双指捏合、双击',
    expected: '拖动平移 viewBox 且不触发过滤；拖动后的 click 被吞、之后普通点击照常；捏合改变视野宽度；双击回到聚焦视野',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      const vb0 = await page.evaluate(() => document.querySelector('#map-view svg').getAttribute('viewBox'));
      const mkPtr = (t, id, x, y) => document.getElementById('map-view').dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 1 }));
      // 单指拖动（位移 120px > 阈值 6px）→ 平移
      await page.evaluate(() => {
        const mk = (t, id, x, y) => document.getElementById('map-view').dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 1 }));
        mk('pointerdown', 1, 300, 200); mk('pointermove', 1, 180, 200); mk('pointerup', 1, 180, 200);
      });
      await page.waitForTimeout(100);
      const r1 = await page.evaluate(() => ({ vb: document.querySelector('#map-view svg').getAttribute('viewBox'), mv: !!state.mapView, mh: state.mustHave.length }));
      ok(r1.mv && r1.vb !== vb0, `单指拖动应平移视野：${vb0.slice(0, 20)}… → ${r1.vb.slice(0, 20)}…`);
      ok(r1.mh === 0, '拖动不得触发通道必经过滤');
      // 拖动结束后的 click（真实浏览器在 pointerup 同一任务内同步派发）应被吞掉
      await page.evaluate(() => {
        const mk = (t, id, x, y) => document.getElementById('map-view').dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 1 }));
        mk('pointerdown', 1, 300, 200); mk('pointermove', 1, 200, 200); mk('pointerup', 1, 200, 200);
        document.querySelector('#map-view svg [data-chan]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForTimeout(200);
      ok((await page.evaluate(() => state.mustHave.length)) === 0, '拖动后的 click 应被吞掉，不触发过滤');
      // 拖动结束后再普通点击 → 过滤照常生效（点击能力未被破坏）
      const cid = await page.evaluate(() => document.querySelector('#map-view svg [data-chan]').getAttribute('data-chan'));
      await page.evaluate(id => document.querySelector(`#map-view svg [data-chan="${id}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true })), cid);
      await page.waitForTimeout(300);
      ok(JSON.stringify(await page.evaluate(() => state.mustHave)) === JSON.stringify([cid]), '拖动后普通点击仍应触发必经过滤');
      await page.evaluate(id => document.querySelector(`#map-view svg [data-chan="${id}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true })), cid);
      await page.waitForTimeout(300);
      // 双指捏合（间距 200→120，因子 0.6 → 视野放宽）
      const vbA = await page.evaluate(() => document.querySelector('#map-view svg').getAttribute('viewBox'));
      await page.evaluate(() => {
        const mk = (t, id, x, y) => document.getElementById('map-view').dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 1 }));
        mk('pointerdown', 1, 200, 200); mk('pointerdown', 2, 400, 200);
        mk('pointermove', 1, 240, 200); mk('pointermove', 2, 360, 200);
        mk('pointerup', 1, 240, 200); mk('pointerup', 2, 360, 200);
      });
      await page.waitForTimeout(100);
      const w = s => +s.split(' ')[2];
      const vbB = await page.evaluate(() => document.querySelector('#map-view svg').getAttribute('viewBox'));
      ok(w(vbB) > w(vbA) * 1.2, `双指捏合应缩放视野：宽 ${w(vbA)} → ${w(vbB)}`);
      // 双击复位回聚焦视野（= 初始 vb0）
      await page.evaluate(() => document.getElementById('map-view').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
      await page.waitForTimeout(100);
      const vbC = await page.evaluate(() => ({ vb: document.querySelector('#map-view svg').getAttribute('viewBox'), mv: state.mapView }));
      ok(vbC.mv === null && vbC.vb === vb0, `双击应复位到聚焦视野：${vbC.vb.slice(0, 24)}…`);
      set(`平移（${vb0.slice(0, 16)}…→${r1.vb.slice(0, 16)}…）；拖动 click 被吞、普通点击照常；捏合宽 ${w(vbA)}→${w(vbB)}；双击复位`);
    },
  },
  {
    id: 'MF-03', section: '真机修复', title: '触摸视野保持与复位时机（D2）',
    steps: '手动缩放后切 Tab 再回来；回测算页点另一张路线卡片再进网架图',
    expected: '切 Tab 视野保持（重绘从 state.mapView 恢复）；选中方案变化后视野复位到聚焦且 mapView 清空',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      await page.evaluate(() => topoViewSet({ x: 40, y: 30, w: 330, h: 215 }));
      const vbZoom = await page.evaluate(() => document.querySelector('#map-view svg').getAttribute('viewBox'));
      await page.click('#t-calc');
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      ok((await page.evaluate(() => document.querySelector('#map-view svg').getAttribute('viewBox'))) === vbZoom, '切 Tab 回来视野应保持');
      await page.click('#t-calc');
      await page.selectOption('#i-calcroute', '1');   // 选中方案变化 → 复位
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      const vb2 = await page.evaluate(() => ({ vb: document.querySelector('#map-view svg').getAttribute('viewBox'), mv: state.mapView }));
      ok(vb2.vb !== vbZoom && vb2.mv === null, `选中方案变化后视野应复位：${vbZoom.slice(0, 20)}… → ${vb2.vb.slice(0, 20)}…`);
      set(`切 Tab 视野保持（${vbZoom.slice(0, 20)}…）；点路线卡片后复位（${vb2.vb.slice(0, 20)}…）`);
    },
  },
  {
    id: 'MF-04', section: '真机修复', title: '缩放后导出快照所见即所得（D2）',
    steps: '手动缩放后调用 exportTopo，拦截导出 SVG 源检查 viewBox',
    expected: '导出序列化包含当前所见 viewBox（与画面一致）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      await page.evaluate(() => topoViewSet({ x: 60, y: 40, w: 300, h: 196 }));
      const vb = await page.evaluate(() => document.querySelector('#map-view svg').getAttribute('viewBox'));
      const src = await page.evaluate(() => new Promise(res => {
        let got = '';
        const origURL = URL.createObjectURL, origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {};   // 不真下载（MAP-05 同款拦截）
        URL.createObjectURL = b => { if (b.type === 'image/svg+xml') b.text().then(t => { got = t; }).catch(() => {}); return origURL(b); };
        try { exportTopo(); } catch (e) { URL.createObjectURL = origURL; HTMLAnchorElement.prototype.click = origClick; return res('ERR:' + e); }
        setTimeout(() => { URL.createObjectURL = origURL; HTMLAnchorElement.prototype.click = origClick; res(got); }, 2500);
      }));
      ok(typeof src === 'string' && src.startsWith('<svg'), '导出应序列化 SVG 源');
      ok(src.includes(`viewBox="${vb}"`), `导出应包含当前所见 viewBox「${vb}」`);
      set(`缩放后导出源含 viewBox=${vb}`);
    },
  },
  {
    id: 'MF-05', section: '真机修复', title: '清空搜索恢复路线视野（D3）',
    steps: '搜索「锦屏」点命中聚焦后清空输入',
    expected: '聚焦后视野收拢；清空后视野回到路线聚焦且搜索聚焦清除，sel/mustHave 不变',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      const vb0 = await page.evaluate(() => document.querySelector('#map-view svg').getAttribute('viewBox'));
      await page.fill('#map-q', '锦屏');
      await page.waitForTimeout(150);
      await page.locator('#map-search-out button', { hasText: '锦屏换流站' }).first().click();
      await page.waitForTimeout(300);
      const vb1 = await page.evaluate(() => document.querySelector('#map-view svg').getAttribute('viewBox'));
      ok(vb1 !== vb0, `聚焦应收拢视野：${vb0.slice(0, 20)}… → ${vb1.slice(0, 20)}…`);
      await page.fill('#map-q', '');
      await page.waitForTimeout(450);   // 清空触发 renderMap（80ms 延时 + SVG 注入）
      const vb2 = await page.evaluate(() => document.querySelector('#map-view svg').getAttribute('viewBox'));
      ok(vb2 === vb0, `清空后应回到路线聚焦：${vb2.slice(0, 24)}… vs ${vb0.slice(0, 24)}…`);
      ok((await page.evaluate(() => state.mapFocusLL)) === null, '清空后搜索聚焦应清除');
      ok((await page.evaluate(() => state.sel)) === 0, '清空不得改变选中方案');
      ok((await page.evaluate(() => state.mustHave.length)) === 0, '清空不得改变必经过滤');
      set(`聚焦收拢后清空 → 回到路线聚焦；sel/mustHave 不变`);
    },
  },
  {
    id: 'MF-06', section: '真机修复', title: '无密钥进天地图视图：SDK 常驻也不画（D4）',
    steps: '注入天地图 SDK 桩（模拟本页已常驻），无密钥切入天地图视图',
    expected: '不绘制任何叠加物（SDK 桩零实例化），直接降级为网架清单并提示填密钥',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      await page.evaluate(() => {
        // 模拟 SDK 已在本页常驻（天地图 api 端点对无效 tk 仍下发 SDK 的真实行为）
        let n = 0;
        const Cls = function () { n++; this.centerAndZoom = () => {}; this.clearOverLays = () => {}; this.addOverLay = () => {}; };
        window.__tdNew = () => n;
        window.T = { Map: Cls, LngLat: function () {}, Point: function () {}, Icon: function () {}, Marker: Cls, Polyline: Cls, Label: Cls, Protocol: { value: 'https:' }, Domain: 'gov.cn' };
        state.tiandituKey = ''; tdReady = false;
      });
      await page.locator('#v-map .seg.small button', { hasText: '天地图' }).click();
      await page.waitForTimeout(400);
      ok(await page.evaluate(() => state.mapProvider) === 'td', '应已切入天地图视图');
      ok(await page.evaluate(() => window.__tdNew()) === 0, 'SDK 桩不得被实例化（无密钥一律不画）');
      ok(await page.evaluate(() => document.getElementById('map-view').style.display === 'none'), '地图容器应隐藏');
      ok(await page.evaluate(() => document.getElementById('fallback').style.display === 'block'), '应直接降级为网架清单');
      const msg = await page.locator('#tk-msg').innerText();
      ok(msg.includes('尚未填入密钥'), `应提示填入密钥，实际「${msg.slice(0, 40)}」`);
      set('SDK 常驻桩零实例化；容器隐藏 + 网架清单 + 提示填密钥');
    },
  },
  {
    id: 'MF-07', section: '真机修复', title: '错误密钥瓦片探针失败：自动降级拓扑图（D4）',
    steps: '注入 SDK 桩 + mock Image（onerror）+ fetch 立即 resolve；填入密钥点「应用密钥」',
    expected: '探针 onerror 自动切回内置拓扑图并显示红字说明（区分原因），mapProvider=svg 持久化，不出现无底图叠加物画面',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      await page.evaluate(() => {
        const Cls = function () { this.centerAndZoom = () => {}; this.clearOverLays = () => {}; this.addOverLay = () => {}; };
        window.T = { Map: Cls, LngLat: function () {}, Point: function () {}, Icon: function () {}, Marker: Cls, Polyline: Cls, Label: Cls, Protocol: { value: 'https:' }, Domain: 'gov.cn' };
        window.__imgOk = false;
        window.Image = class {
          set src(v) { setTimeout(() => { if (window.__imgOk) { this.naturalWidth = 256; if (this.onload) this.onload(); } else if (this.onerror) this.onerror(); }, 10); }
        };
        window.fetch = () => Promise.resolve({ ok: true });
      });
      await page.locator('#v-map .seg.small button', { hasText: '天地图' }).click();
      await page.waitForTimeout(300);
      await page.fill('#i-tk', 'BADKEY0000');
      await page.locator('#v-map .row3 button', { hasText: '应用密钥' }).click();
      await page.waitForTimeout(500);
      ok(await page.evaluate(() => state.mapProvider) === 'svg', '探针失败应自动切回内置拓扑图');
      const note = await page.evaluate(() => document.getElementById('v-map').innerText);
      ok(note.includes('密钥无效或被风控拦截') && note.includes('已自动切回内置拓扑图'), `降级红字说明应在场，实际「${note.slice(0, 80)}」`);
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('iproute.v2.map') || '{}'));
      ok(saved.mapProvider === 'svg', '降级选择应持久化');
      set('探针 onerror → 自动降级 svg + 红字说明（密钥无效或被风控拦截）；持久化');
    },
  },

  /* ================= 外观主题（clear / clear-dark / tech） ================= */
  {
    id: 'TH-01', section: '外观主题', title: '外观面板切换三套主题：data-theme 与系统栏颜色同步',
    steps: '点页头「外观」→ 明暗选「深色」→「浅色」→ 风格选「科技」→ 再切回「清晰」',
    expected: 'data-theme 依次为 clear-dark / clear / tech / clear；<meta name="theme-color"> 与安卓壳桥 IPRouteShell.setSystemBars 随主题取 --system-bar（深底配浅色图标）；偏好写入 iproute.v2.ui',
    async run(page, set) {
      // 模拟安卓壳注入的桥：记录每次调用（Web / iOS 没有这个对象，页面应静默跳过）
      await page.addInitScript(() => { window.__bars = []; window.IPRouteShell = { setSystemBars: (hex, lightIcons) => window.__bars.push(hex + (lightIcons ? '/浅色图标' : '/深色图标')) }; });
      await page.goto(G, DCL);
      await page.waitForSelector('.card.plan');
      const th = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      const meta = () => page.evaluate(() => document.querySelector('meta[name="theme-color"]').getAttribute('content'));
      ok(await th() === 'clear', `默认（跟随系统，浏览器为浅色）应为 clear，实际 ${await th()}`);
      await page.click('#btn-theme');
      await page.waitForSelector('#theme-sheet.open');
      const seen = [];
      for (const [sel, want, bar] of [['[data-ui-mode="dark"]', 'clear-dark', '#1C1F24'], ['[data-ui-mode="light"]', 'clear', '#FFFFFF'],
        ['[data-ui-style="tech"]', 'tech', '#070E1A'], ['[data-ui-style="clear"]', 'clear', '#FFFFFF']]) {
        await page.click('#theme-body ' + sel);
        const got = await th(), m = await meta();
        ok(got === want, `点 ${sel} 后 data-theme 应为 ${want}，实际 ${got}`);
        ok(m === bar, `${want} 的 theme-color 应为 ${bar}，实际 ${m}`);
        ok(await page.locator('#theme-body ' + sel).getAttribute('aria-checked') === 'true', `${sel} 应处于选中态`);
        seen.push(`${want}(${m})`);
      }
      const bars = await page.evaluate(() => window.__bars);
      ok(['#FFFFFF/深色图标', '#1C1F24/浅色图标', '#070E1A/浅色图标'].every((x) => bars.includes(x)), `安卓壳桥应收到三种系统栏配色，实际 ${bars.join('、')}`);
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('iproute.v2.ui')));
      ok(saved.style === 'clear' && saved.mode === 'light', `偏好应存为 clear/light，实际 ${JSON.stringify(saved)}`);
      await page.click('#theme-close');
      ok(!(await page.evaluate(() => document.getElementById('theme-sheet').classList.contains('open'))), '关闭按钮应收起外观面板');
      set(`依次切换：${seen.join(' → ')}；偏好存本机；面板可关闭`);
    },
  },
  {
    id: 'TH-02', section: '外观主题', title: '主题偏好刷新后保持，首帧即生效；「跟随系统」随系统明暗切换',
    steps: '选「科技」→ 刷新 → 检查首个脚本执行时的 data-theme；改回「清晰 · 跟随系统」→ 模拟系统深色 / 浅色',
    expected: '刷新后 data-theme 仍为 tech，且在应用脚本运行前（DOMContentLoaded 之前）已设好，<meta name="theme-color"> 同时已是科技的 --system-bar；跟随系统时系统切深色 → clear-dark、切浅色 → clear',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('.card.plan');
      await page.click('#btn-theme');
      await page.click('#theme-body [data-ui-style="tech"]');
      // 记录首帧：<body> 一出现（此时只跑过 <head> 里的脚本，应用脚本还没执行）就读 data-theme
      await page.addInitScript(() => {
        new MutationObserver((m, o) => {
          if (document.body) {
            window.__th0 = document.documentElement.getAttribute('data-theme');
            const m = document.querySelector('meta[name="theme-color"]');
            window.__meta0 = m && m.getAttribute('content');
            o.disconnect();
          }
        }).observe(document, { childList: true, subtree: true });
      });
      await page.reload(DCL);
      await page.waitForSelector('.card.plan');
      const t0 = await page.evaluate(() => window.__th0), t1 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      ok(t0 === 'tech' && t1 === 'tech', `刷新后应保持 tech（首帧 ${t0}，启动后 ${t1}）`);
      const meta0 = await page.evaluate(() => window.__meta0);
      ok(meta0 === '#070E1A', `首帧（应用脚本执行前）theme-color 应已是科技的 #070E1A，实际 ${meta0}`);
      await page.click('#btn-theme');
      await page.click('#theme-body [data-ui-style="clear"]');
      await page.click('#theme-body [data-ui-mode="system"]');
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForTimeout(150);
      const d = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForTimeout(150);
      const l = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      ok(d === 'clear-dark' && l === 'clear', `跟随系统：深色应为 clear-dark、浅色应为 clear，实际 ${d} / ${l}`);
      // 显式选了「浅色」后不再跟随系统
      await page.click('#theme-body [data-ui-mode="light"]');
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForTimeout(150);
      const fixed = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      await page.emulateMedia({ colorScheme: 'light' });
      ok(fixed === 'clear', `选定浅色后系统切深色不应跟随，实际 ${fixed}`);
      set(`刷新保持 tech（首帧即 ${t0}，theme-color ${meta0}）；跟随系统 深→${d} 浅→${l}；选定浅色后不跟随（${fixed}）`);
    },
  },
  {
    id: 'TH-03', section: '外观主题', title: '科技风格下「明暗」组禁用并说明；网架图页切换主题即重绘',
    steps: '进入网架图页 → 打开「外观」→ 选「科技」→ 检查明暗三按钮与说明 → 切回「清晰」',
    expected: '科技风格下明暗三按钮 disabled，出现「科技风格固定为深色」；切回清晰后恢复可点；网架图 SVG 随主题重绘（画布底色取新主题的 --map-ground）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('.card.plan');
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      const ground = () => page.evaluate(() => getComputedStyle(document.querySelector('#map-view svg rect')).fill);
      const g0 = await ground();
      await page.evaluate(() => { document.querySelector('#map-view svg').dataset.stale = '1'; });
      await page.click('#btn-theme');
      await page.click('#theme-body [data-ui-style="tech"]');
      await page.waitForSelector('#map-view svg:not([data-stale])', { timeout: 3000 });
      const g1 = await ground();
      const dis = await page.evaluate(() => [...document.querySelectorAll('#theme-body [data-ui-mode]')].map((b) => b.disabled));
      ok(dis.length === 3 && dis.every(Boolean), `科技风格下明暗三按钮应全部禁用，实际 ${JSON.stringify(dis)}`);
      ok((await page.locator('#theme-body').innerText()).includes('科技风格固定为深色'), '应显示「科技风格固定为深色」说明');
      ok(g0 !== g1, `切到科技后网架图画布底色应变化（${g0} → ${g1}）`);
      await page.click('#theme-body [data-ui-style="clear"]');
      const dis2 = await page.evaluate(() => [...document.querySelectorAll('#theme-body [data-ui-mode]')].map((b) => b.disabled));
      ok(dis2.every((x) => !x), '切回清晰后明暗按钮应恢复可点');
      ok(!(await page.locator('#theme-body').innerText()).includes('科技风格固定为深色'), '切回清晰后说明应消失');
      set(`科技：明暗组禁用 + 说明；网架图画布 ${g0} → ${g1} 重绘；切回清晰恢复`);
    },
  },
  {
    id: 'UI-HIT', section: '外观主题', title: '小控件扩大的点击区不抢相邻控件（测算页 390/320px、网架图搜索结果与工具条、弹层）',
    steps: '对挂了透明扩区的控件逐个取样：测算页（390px、320px；默认与「全部路线 + 含越限」）、网架图搜索「换流站」后的结果与工具条、天地图密钥栏、参数弹层、外观面板；另外实点「锦屏换流站」下沿与「含越限」上方那张路线卡的下沿',
    expected: '每个控件外沿 1–2px 与扩区内命中的都是控件自己或空白，扩区不压别的可点控件；点「锦屏换流站」下沿打开的是锦屏的浮层（不是下一行的奉贤）；点路线卡下沿选中该路线、「含越限」不被切换',
    async run(page, set) {
      const seen = [], bad = [];
      const audit = async (label, scope) => {
        const r = await hitAudit(page, scope);
        ok(r.n > 0, `${label}：没找到挂扩区的控件（选择器或页面结构变了？）`);
        seen.push(`${label} ${r.n} 个`);
        bad.push(...r.bad.map((b) => `${label}：${b}`));
      };
      // 每轮先清掉上一轮存下的测算状态（全部路线 / 含越限），测的是默认界面；导览「已读」由 init 脚本每次加载重设
      const fresh = async () => { await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} }); await page.goto(G, DCL); await page.waitForSelector('.card.plan'); };
      await page.goto(G, DCL);
      for (const w of [320, 390]) {
        await page.setViewportSize({ width: w, height: 844 });
        await fresh();
        await page.waitForSelector('.card.plan');
        await audit(`测算页 ${w}px`, 'body');
        await page.evaluate(() => { state.showBad = true; state.showAll = true; state.sel = 0; doSolve(); });
        await page.waitForSelector('.card.plan');
        await audit(`测算页·全部路线 ${w}px`, 'body');
      }
      // 以下 390px。回归点 1：「含越限」正上方那张路线卡的下沿（原先被复选框标签的扩区接走 3–7px）
      await fresh();
      // change: grid-map-single-route-and-fixes：路线卡改下拉后，「含越限」正上方为路线下拉；
      // 回归点改为「下拉与复选框之间的空档点击不得被 .tg 扩区接走切换含越限、也不改变选中路线」
      const rc = await page.evaluate(() => {
        const tg = document.querySelector('.rlist-foot .tg');
        tg.scrollIntoView({ block: 'center' });
        const t = tg.getBoundingClientRect();
        const sel = document.getElementById('i-calcroute').getBoundingClientRect();
        return { x: t.left + 10, y: (sel.bottom + t.top) / 2, gap: +(t.top - sel.bottom).toFixed(1), sel: +document.getElementById('i-calcroute').value, showBad: state.showBad };
      });
      ok(rc.gap >= 0, '「含越限」应位于路线下拉下方');
      await page.mouse.click(rc.x, rc.y);
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => ({ sel: +document.getElementById('i-calcroute').value, showBad: state.showBad }));
      ok(after.sel === rc.sel && after.showBad === rc.showBad, `空档点击不应改变状态：sel=${rc.sel}→${after.sel}、含越限 ${rc.showBad}→${after.showBad}`);
      // 回归点 2：网架图搜索结果换行排布、行距 6px，点「锦屏换流站」下沿原先会打开下一行「奉贤换流站」
      await page.click('#t-map');
      await page.waitForSelector('#map-view svg');
      await page.fill('#map-q', '换流站');
      await page.waitForTimeout(200);
      const jp = page.locator('#map-search-out button', { hasText: '锦屏换流站' }).first();
      await jp.scrollIntoViewIfNeeded();
      const jb = await jp.boundingBox();
      ok(jb, '搜索「换流站」应列出「锦屏换流站」');
      await page.mouse.click(jb.x + jb.width / 2, jb.y + jb.height - 1);
      await page.waitForTimeout(300);
      const pop = await page.evaluate(() => document.getElementById('map-pop').innerText);
      ok(pop.includes('锦屏换流站'), `点「锦屏换流站」下沿应打开锦屏的浮层，实际「${pop.slice(0, 20)}」`);
      await page.fill('#map-q', '换流站');   // 聚焦后结果仍在；再填一次确保列表完整
      await page.waitForTimeout(200);
      await audit('网架图·搜索结果与工具条', '#v-map');
      await page.evaluate(() => switchMap('td'));
      await page.waitForSelector('#i-tk');
      await audit('网架图·天地图密钥栏', '#v-map');
      await page.evaluate(() => switchMap('svg'));
      await page.click('#t-calc');
      await page.waitForSelector('.card.plan');
      await openParams(page);
      await page.waitForTimeout(300);
      await audit('参数弹层', '#param-sheet');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.click('#btn-theme');
      await page.waitForSelector('#theme-sheet.open');
      await page.waitForTimeout(300);
      await audit('外观面板', '#theme-sheet');
      ok(bad.length === 0, `扩区抢点 ${bad.length} 处：\n      ` + bad.slice(0, 12).join('\n      '));
      set(`取样 ${seen.join('、')}，无抢点；下拉与「含越限」空档 ${rc.gap}px 点击无状态变化；「锦屏换流站」下沿打开锦屏浮层`);
    },
  },
];

async function respCheck(page, set, expectCentered, desktop = false, expectMax = '480px') {
  await page.goto(G, DCL);
  const m = await page.evaluate(() => {
    const de = document.documentElement, app = document.getElementById('app');
    return {
      overflow: de.scrollWidth - de.clientWidth,
      appMax: getComputedStyle(app).maxWidth,
      left: app.getBoundingClientRect().left,
      vw: de.clientWidth,
      nav: !!document.querySelector('nav'),
      route: !!document.querySelector('#i-calcroute option'),
    };
  });
  ok(m.overflow <= 1, `存在横向溢出 ${m.overflow}px`);
  if (desktop) {
    // 修正(2026-09-15)：≥900px 进入桌面宽布局（template.html:210/270，#app max-width 1320/1480px），
    // 原断言「max-width:480px 且 left>100 居中」是移动端限宽口径，与现版本桌面适配矛盾。
    ok(['1320px', '1480px'].includes(m.appMax), `桌面端 #app max-width 应 1320/1480px，实际 ${m.appMax}`);
    ok(m.left <= 1, `桌面宽布局 #app 应铺满视口，left=${m.left}`);
  } else {
    ok(m.appMax === expectMax, `#app max-width 应 ${expectMax}，实际 ${m.appMax}`);
  }
  ok(m.nav && m.route, '底部导航/路线下拉缺失');
  if (expectCentered) ok(m.left > 100, `桌面端 #app 应居中留白，left=${m.left}`);
  set(`横向溢出 ${m.overflow}px；#app max-width=${m.appMax}，left=${Math.round(m.left)}px（视口 ${m.vw}px）；导航与卡片正常`);
}

function logs0() { return '见报告控制台记录'; }

/* ================= 主入口 ================= */
const channel = process.env.BROWSER || 'msedge';
console.log(`启动浏览器 channel=${channel} → ${BASE}`);
const browser = await chromium.launch({ channel, headless: true });
for (const t of tests) await runTest(browser, t);
await browser.close();

// 汇总
const sections = [...new Set(results.map(r => r.section))];
const ran = results.filter(r => !r.skipped);          // 跳过 = 未实现，不计入通过率
const skipped = results.filter(r => r.skipped);
let md = `# E2E 测试报告 — 省间路径优选测算\n\n`;
md += `- 被测地址：${BASE}\n- 执行时间：${new Date().toLocaleString('zh-CN')}\n- 浏览器：Playwright headless（channel=${channel}）\n- 默认视口：390×844（响应式用例单独指定）\n`;
md += `- 用例总数：${results.length}，执行 ${ran.length}，通过 ${ran.filter(r => r.pass).length}，失败 ${ran.filter(r => !r.pass).length}，跳过 ${skipped.length}（未实现，不计入通过率）\n\n`;
md += `| 分组 | 通过/执行 | 跳过（未实现） |\n|---|---|---|\n`;
for (const s of sections) {
  const g = results.filter(r => r.section === s);
  const gr = g.filter(r => !r.skipped);
  md += `| ${s} | ${gr.filter(r => r.pass).length}/${gr.length} | ${g.filter(r => r.skipped).length} |\n`;
}
if (skipped.length) {
  md += `\n## 未实现用例（跳过，不计入通过率）\n\n`;
  for (const r of skipped) md += `- **${r.id} ${r.title}**：${r.skipReason}\n`;
}
md += `\n---\n`;
for (const r of results) {
  const head = r.skipped ? '⏭️ SKIP（未实现，不计入通过率）' : (r.pass ? '✅ PASS' : '❌ FAIL');
  md += `\n### ${r.id} ${r.title} — ${head}\n`;
  md += `- **操作步骤**：${r.steps}\n- **预期**：${r.expected}\n- **实际结果**：${r.actual}\n`;
  md += `- **截图**：${r.shot.startsWith('shots/') ? `[${r.shot}](${r.shot})` : r.shot}\n`;
  const errs = [];
  if (r.logs.pageErrors.length) errs.push(...r.logs.pageErrors.map(x => `[pageerror] ${x}`));
  if (r.logs.console.length) errs.push(...r.logs.console.slice(0, 5).map(x => x));
  if (r.logs.badStatus.length) errs.push(...r.logs.badStatus.slice(0, 3).map(x => `[HTTP≥400] ${x}`));
  if (r.logs.failedReq.length) errs.push(...r.logs.failedReq.slice(0, 3).map(x => `[请求失败] ${x}`));
  md += `- **控制台报错**：${errs.length ? errs.map(e => '`' + e + '`').join('<br>') : '无'}\n`;
}
fs.writeFileSync(path.join(here, 'report.md'), md);
fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n完成：${ran.filter(r => r.pass).length}/${ran.length} 通过（跳过 ${skipped.length} 个未实现用例，不计入通过率）；报告 tests/report.md`);
process.exit(ran.some(r => !r.pass) ? 1 : 0);
