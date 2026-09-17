// E2E 测试：省间路径优选测算（http://127.0.0.1:8734/）
// 运行：node tests/e2e.mjs   （需先 node tools/build.mjs 并启动静态服务）
// 产出：tests/report.md + tests/shots/*.png + tests/results.json
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:8734/';
const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const results = [];

async function runTest(browser, def) {
  const context = await browser.newContext({ viewport: def.viewport || { width: 390, height: 844 } });
  const page = await context.newPage();
  const logs = { console: [], pageErrors: [], failedReq: [], badStatus: [] };
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.console.push(`[${m.type()}] ${m.text().slice(0, 160)}`); });
  page.on('pageerror', e => logs.pageErrors.push(String(e).split('\n')[0].slice(0, 160)));
  page.on('requestfailed', r => logs.failedReq.push(`${(r.failure() && r.failure().errorText) || 'failed'} ${r.url().slice(0, 90)}`));
  page.on('response', r => { if (r.status() >= 400) logs.badStatus.push(`${r.status()} ${r.url().slice(0, 90)}`); });

  const rec = { id: def.id, section: def.section, title: def.title, steps: def.steps, expected: def.expected, actual: '', pass: false, shot: '', logs };
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

const G = BASE, DCL = { waitUntil: 'domcontentloaded', timeout: 20000 };
const tests = [

  /* ================= 主流程 ================= */
  {
    id: 'F-01', section: '主流程', title: '首次加载默认测算',
    steps: '打开 http://127.0.0.1:8734/',
    expected: '默认四川→江苏；自动渲染可选路线卡片与选中方案详情；无页面脚本错误',
    async run(page, set) {
      await page.goto(G, DCL);
      ok(await page.locator('#i-from').inputValue() === 'SC', '出发地应为 SC(四川)');
      ok(await page.locator('#i-to').inputValue() === 'JS', '目的地应为 JS(江苏)');
      const cards = await page.locator('.rc').count();
      ok(cards > 0, '路线卡片应>0，实际 ' + cards);
      ok(await page.locator('.big').count() > 0, '落地价未渲染');
      const hd = (await page.locator('.hd-route').first().innerText()).trim();
      set(`默认 SC→JS；卡片 ${cards} 张；详情「${hd.slice(0, 36)}」；pageerror=${logs0(page)}`);
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
    id: 'F-03', section: '主流程', title: '点击路线卡片切换方案',
    steps: '点击第 2 张路线卡片',
    expected: 'state.sel=1；第 2 张卡片高亮；详情标题变为「方案 #2」',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.locator('.rc').nth(1).click();
      ok(await page.evaluate(() => state.sel) === 1, 'state.sel 应为 1');
      const onIdx = await page.evaluate(() => [...document.querySelectorAll('.rc')].findIndex(b => b.classList.contains('on')));
      ok(onIdx === 1, `高亮卡片应为第 2 张(index 1)，实际 ${onIdx}`);
      const hd = await page.locator('.sec-title', { hasText: '方案' }).first().innerText();
      ok(hd.includes('方案 #2'), `详情标题应含「方案 #2」，实际「${hd.trim().slice(0, 20)}」`);
      set(`sel=1，第 2 张卡片 .on 高亮，详情「${hd.trim().slice(0, 12)}」`);
    },
  },
  {
    id: 'F-04', section: '主流程', title: '三口径排序（过网费升序）',
    steps: '点击排序按钮「过网费」',
    expected: 'sortBy=B；路线按过网费升序排列；选中重置为第 1 条',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.locator('.seg.small button', { hasText: '过网费' }).click();
      ok(await page.evaluate(() => state.sortBy) === 'B', 'sortBy 应为 B');
      ok(await page.evaluate(() => state.sel) === 0, '选中应重置为 0');
      const ch = await page.evaluate(() => state._res.rows.map(r => r.channelOnly));
      const sorted = ch.every((v, i) => i === 0 || ch[i - 1] <= v);
      ok(sorted, `过网费应升序，实际前 5 项 ${ch.slice(0, 5).join(',')}`);
      set(`sortBy=B；过网费序列升序（首项 ${ch[0].toFixed(1)} 元/MWh，共 ${ch.length} 条）`);
    },
  },
  {
    id: 'F-05', section: '主流程', title: '电量参数重算（总额线性放大）',
    steps: '电量输入 3000 后失焦',
    expected: '费用总额变为原 3 倍；落地单价不变',
    async run(page, set) {
      await page.goto(G, DCL);
      const t1 = await page.evaluate(() => state._res.rows[0].yuan.total);
      const p1 = await page.evaluate(() => state._res.rows[0].landed);
      await page.fill('#i-qty', '3000');
      await page.locator('#i-qty').blur();
      const t2 = await page.evaluate(() => state._res.rows[0].yuan.total);
      const p2 = await page.evaluate(() => state._res.rows[0].landed);
      ok(Math.abs(t2 - t1 * 3) < 1, `总额应 ${t1 * 3}，实际 ${t2}`);
      ok(p1 === p2, `单价应不变 ${p1} vs ${p2}`);
      set(`总额 ${t1}→${t2}（×3）；单价保持 ${p1} 元/MWh`);
    },
  },
  {
    id: 'F-06', section: '主流程', title: '网损承担方切换为送端',
    steps: '「价格与口径」中网损承担方选「送端承担」',
    expected: 'comp.loss=0；费用拆解表不再出现「网损折价」行',
    async run(page, set) {
      await page.goto(G, DCL);
      // 修正(2026-09-15)：价格与口径区默认即展开（calc.js:39 带 open），原写法先点 summary
      // 反而把它折叠，#i-bearer 不可见导致 selectOption 超时。
      await page.selectOption('#i-bearer', '0');
      const loss = await page.evaluate(() => state._res.rows[0].comp.loss);
      ok(loss === 0, `comp.loss 应为 0，实际 ${loss}`);
      const row = await page.evaluate(() => {
        const tr = [...document.querySelectorAll('#d-detail tr')].find(t => t.textContent.includes('网损折价'));
        return tr ? tr.textContent.replace(/\s+/g, ' ').trim() : '(未找到行)';
      });
      ok(/^网损折价（受端承担部分）\s*0\.0/.test(row), `网损行单价应显示 0.0，实际「${row.slice(0, 50)}」`);
      const landed = await page.evaluate(() => state._res.rows[0].landed);
      set(`lossBearer=0；comp.loss=0；网损行显示 0；落地单价 ${landed} 元/MWh`);
    },
  },
  {
    id: 'F-07', section: '主流程', title: '勾选「含越限」展示不可行路线',
    steps: '勾选「含越限」复选框',
    expected: 'showBad=true；列表卡片数不少于之前；顶部显示「共 X 条候选 · 可行 Y 条」',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.selectOption('#i-to', 'SH');
      await page.selectOption('#i-hops', '5');
      const before = await page.locator('.rc').count();
      await page.locator('.tg input').check();
      const after = await page.locator('.rc').count();
      ok(await page.evaluate(() => state.showBad) === true, 'showBad 应为 true');
      ok(after >= before, `卡片应不减少：${before}→${after}`);
      const hint = await page.locator('.sec-title .hint').first().innerText();
      ok(/共 \d+ 条候选/.test(hint), `提示文案异常：${hint}`);
      set(`含越限前卡片 ${before} 张、勾选后 ${after} 张；提示「${hint.trim()}」`);
    },
  },
  {
    id: 'F-08', section: '主流程', title: '展开全部路线（>18 条）',
    steps: '四川→上海，跳数选 5，点「展开全部」',
    expected: '全部候选渲染为卡片（README：5 段 162 条量级）；按钮变「收起」',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.selectOption('#i-to', 'SH');
      await page.selectOption('#i-hops', '5');
      const btn = page.locator('button', { hasText: '展开全部' });
      ok(await btn.count() > 0, '应出现「展开全部」按钮');
      await btn.first().click();
      const n = await page.locator('.rc').count();
      const rows = await page.evaluate(() => state._res.rows.length);
      ok(n === rows, `卡片数 ${n} 应等于 rows ${rows}`);
      set(`展开后卡片 ${n} 张 = 候选总数 ${rows}`);
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
    id: 'I-01', section: '交互', title: '省份下拉：30 省齐全 + 同省互斥禁用',
    steps: '检查出发地下拉选项数；检查目的地中「四川」是否禁用',
    expected: '选项 30 个；目的地中与出发地相同的省份 disabled',
    async run(page, set) {
      await page.goto(G, DCL);
      const n = await page.locator('#i-from option').count();
      ok(n === 30, `应 30 个省份选项，实际 ${n}`);
      const dis = await page.evaluate(() => { const o = [...document.getElementById('i-to').options].find(o => o.value === 'SC'); return o && o.disabled; });
      ok(dis === true, '目的地中四川应被禁用');
      set(`下拉 30 项；目的地中四川 disabled=${dis}`);
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
    expected: 'CH[0].t=99；顶部徽标变「费率已本地修改」；localStorage 已写入',
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
      const ls = await page.evaluate(() => JSON.parse(localStorage.getItem('iproute.v2.lib')).ch[0].t);
      ok(ls === 99, `localStorage 应存 99，实际 ${ls}`);
      set(`CH[0].t=99；徽标「${badge}」；localStorage 已持久化`);
    },
  },
  {
    id: 'I-04', section: '交互', title: '「恢复检索原始值」应用内确认框（取消/确认）',
    steps: '先改 CH[0].t=123；点恢复→取消；再点恢复→确认',
    expected: '取消：值不变；确认：恢复为 DATA.CH 原始值',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-lib');
      await page.evaluate(() => { CH[0].t = 123; });
      const btn = page.locator('button', { hasText: '恢复检索原始值' });
      const dlg = page.locator('[role="dialog"]');
      await btn.click();
      await dlg.waitFor({ state: 'visible', timeout: 3000 });
      const msg = await dlg.innerText();
      ok(msg.includes('恢复为检索原始值'), `确认框文案异常：「${msg}」`);
      await dlg.locator('button', { hasText: '取消' }).click();
      ok(await page.evaluate(() => CH[0].t) === 123, '取消后应保持 123');
      await btn.click();
      await dlg.waitFor({ state: 'visible', timeout: 3000 });
      await dlg.locator('button', { hasText: '恢复原始值' }).click();
      const restored = await page.evaluate(() => CH[0].t === DATA.CH[0].t);
      ok(restored, '确认后应恢复原始值');
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
      ok(await page.locator('.rc').first().isVisible(), '切回测算应正常');
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
      const cards = await page.locator('.rc').count();
      ok(cards > 0, '刷新后应正常渲染卡片');
      set(`损坏 JSON 被吞掉；回落 SC→JS；卡片 ${cards} 张正常渲染`);
    },
  },

  /* ================= 异常 ================= */
  {
    id: 'E-01', section: '异常', title: '底图 SDK 加载失败→降级网架清单',
    steps: '拦截 map.qq.com 请求（模拟代理不可用/断网），打开网架图 Tab',
    expected: '非代理环境：qq 底图被静默回退为内置拓扑图（map.js:240），#fallback 不显示、拓扑 SVG 正常渲染，无未捕获异常。⚠️ 此期望对应当前缺陷行为（REQ-703 记录），REQ-703 解冻实现后必须翻转本用例',
    async run(page, set) {
      // 修正(2026-09-15)：原期望「#fallback 显示降级清单」只在代理环境成立。当前产品行为是
      // 非代理环境把 qq 静默回退 svg（map.js:240，即 REQ-703 记录的缺陷），fallback 永不出现。
      // 按 owner 决策改期望匹配现状，并保留上方 ⚠️ 注释作为 REQ-703 解冻后必须回来翻转的钩子。
      await page.context().route(/map\.qq\.com/, r => r.abort());
      await page.goto(G, DCL);
      await page.click('#t-map');
      // renderMap 在 setTimeout(80ms) 后注入拓扑 SVG（map.js:291），需等待
      await page.waitForSelector('#map-view svg', { timeout: 6000 });
      const r = await page.evaluate(() => ({
        provider: state.mapProvider,
        svg: !!document.querySelector('#map-view svg'),
        fbVisible: !!document.querySelector('#fallback') && getComputedStyle(document.querySelector('#fallback')).display !== 'none',
      }));
      ok(r.provider === 'svg', `非代理环境应回退为 svg 拓扑，实际 provider=${r.provider}`);
      ok(r.svg, '拓扑 SVG 应已渲染');
      ok(!r.fbVisible, '当前缺陷行为下 #fallback 不应显示（REQ-703 解冻后需翻转此断言）');
      set(`provider=${r.provider}；拓扑 SVG 已渲染；#fallback 隐藏（对应 REQ-703 现状缺陷）`);
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
      const still = await page.locator('.rc').count();
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
    steps: '出发地北京，跳数选 1（无直达通道）',
    expected: '显示「在 1 段以内没有…连通路径，请放宽跳数上限」空态卡片',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.selectOption('#i-from', 'BJ');
      await page.selectOption('#i-hops', '1');
      const msg = await page.locator('.empty').innerText();
      ok(msg.includes('连通路径'), `应显示连通性引导，实际「${msg.slice(0, 50)}」`);
      set(`空态卡片：「${msg.trim()}」`);
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
    expected: '无横向溢出；#app 居中限宽 480；布局不拉伸错乱',
    viewport: { width: 768, height: 1024 },
    async run(page, set) { await respCheck(page, set, false); },
  },
  {
    id: 'R-03', section: '响应式', title: '桌面 1440×900 宽布局',
    steps: '以 1440×900 视口打开测算页',
    expected: '#app 铺满视口（桌面宽布局 max-width 1480px）；无横向溢出',
    viewport: { width: 1440, height: 900 },
    async run(page, set) { await respCheck(page, set, false, true); },
  },
  {
    id: 'R-04', section: '响应式', title: '两栏 900–1279px：智能推荐与方案之间不得留大片空白',
    steps: '以 900 / 1100 / 1279 视口打开测算页，量 .col-ai 底边到 .col-main 顶边的垂直距离',
    expected: '均落在两栏布局（348px + 剩余）；该距离等于正常 grid gap，而不是被左栏撑成整屏高',
    viewport: { width: 1100, height: 900 },
    async run(page, set) {
      await page.goto(G, DCL);
      const out = [];
      for (const w of [900, 1100, 1279]) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.waitForSelector('.layout', { timeout: 15000 });
        const m = await page.evaluate(() => {
          const box = (s) => document.querySelector(s).getBoundingClientRect();
          const cs = getComputedStyle(document.querySelector('.layout'));
          return { cols: cs.gridTemplateColumns.split(' ').length, gap: cs.gap,
            d: box('.col-main').top - box('.col-ai').bottom,
            sideCross: getComputedStyle(document.querySelector('.col-side')).gridRow };
        });
        // 回归背景（2026-09-16 修复）：左栏 sticky + max-height 只占 grid-row:1 时会把第一行撑满整屏，
        // 而智能推荐也在第一行 —— 推荐卡片下方于是空出几百像素，方案详情被推到屏幕外。
        ok(m.cols === 2, `${w}px 应为两栏布局，实际 ${m.cols} 栏`);
        ok(m.d >= -2 && m.d <= 40, `${w}px：推荐底边到方案顶边应等于正常行距，实际 ${m.d.toFixed(1)}px（gap ${m.gap}）`);
        out.push(`${w}px gap=${m.d.toFixed(1)}px`);
      }
      set(out.join('；'));
    },
  },

  /* ================= PRD-IPRO-2026-001 ================= */
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
            if (r.left < br.left - .5 || r.right > br.right + .5 || r.top < br.top - .5 || r.bottom > br.bottom + .5) clipped++;
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
    expected: '三个输入框 y 坐标一致（≤1px）；标签完整可读无裁字截断；setPv 即时生效（PV 更新并触发重算），取值逻辑不变',
    async run(page, set) {
      await page.goto(G, DCL);
      const out = [];
      for (const [w, h] of [[375, 667], [390, 844]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.click('#t-lib');
        await page.locator('button', { hasText: /^省级参数/ }).click();
        const card = page.locator('.libcard').first();
        await card.locator('summary').click();
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
      // setPv 取值逻辑不变：改出清价 → PV 即时更新并重算（state._res 清空）
      await page.locator('.libcard .lib-io input').first().fill('123');
      await page.locator('.libcard .lib-io input').first().blur();
      const sv = await page.evaluate(() => ({
        pv: Object.values(PV).some(p => p.clear === 123),
        resCleared: state._res === null,
      }));
      ok(sv.pv === true, `setPv 后 PV 中应有 clear=123（实际 ${sv.pv}）`);
      ok(sv.resCleared === true, `setPv 应清空 _res 触发重算（实际 ${sv.resCleared}）`);
      set(out.join('；') + `；setPv 生效 PV=${sv.pv} 重算=${sv.resCleared}`);
    },
  },
  {
    id: 'RQ-704', section: 'PRD-IPRO', title: 'REQ-704：测算②受端输配电价/基金输入框对齐',
    steps: '375×667 与 390×844 量 #i-pnet 与 #i-fund 输入框 y 坐标；改 #i-pnet 后点「恢复核定值」验证 resetOne 还原',
    expected: '两输入框 y 坐标一致（≤1px）；标签完整可读（「受端省网输配电价」「恢复核定值」无截断）；resetOne 点击后还原核定值（SC→JS 为 51.8）',
    async run(page, set) {
      await page.goto(G, DCL);
      const out = [];
      for (const [w, h] of [[375, 667], [390, 844]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.click('#t-calc');
        const r = await page.evaluate(() => {
          const pn = document.getElementById('i-pnet'), fd = document.getElementById('i-fund');
          const spans = [pn, fd].map(i => i.closest('label.f').querySelector('span'));
          const clip = el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
          return { dy: Math.abs(pn.getBoundingClientRect().top - fd.getBoundingClientRect().top),
            txt: spans.map(s => s.textContent.replace(/\s+/g, ' ').trim()), clipped: spans.filter(clip).length };
        });
        ok(r.dy <= 1, `${w}x${h}：#i-pnet 与 #i-fund y 差 ${r.dy.toFixed(2)}px（应 ≤1px）`);
        ok(r.txt[0].includes('受端省网输配电价') && r.txt[0].includes('恢复核定值'), `主标签应完整含「受端省网输配电价/恢复核定值」，实际「${r.txt[0]}」`);
        ok(r.clipped === 0, `${w}x${h}：标签被裁截断 ${r.clipped} 处`);
        out.push(`${w}x${h} dy=${r.dy.toFixed(2)}`);
      }
      // resetOne 行为不变：改值 → 点「恢复核定值」→ 还原为 PV[state.to].net
      const rr = await page.evaluate(async () => {
        const net0 = state.pNet;
        const inp = document.getElementById('i-pnet');
        inp.value = String(net0 + 1); inp.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        const changed = state.pNet;
        inp.closest('label.f').querySelector('a').click();
        await new Promise(r => setTimeout(r, 100));
        return { net0, changed, restored: state.pNet, inputVal: parseFloat(document.getElementById('i-pnet').value) };
      });
      ok(rr.changed === rr.net0 + 1, `改值后 pNet 应为 ${rr.net0 + 1}，实际 ${rr.changed}`);
      ok(rr.restored === rr.net0 && rr.inputVal === rr.net0, `resetOne 应还原 ${rr.net0}，实际 state=${rr.restored} 输入框=${rr.inputVal}`);
      set(out.join('；') + `；resetOne ${rr.net0}→${rr.changed}→${rr.restored}`);
    },
  },
  {
    id: 'RQ-401', section: 'PRD-IPRO', title: 'REQ-401：容量电费测算器（折叠卡 · 电压档选择 · 不参与路径比选）',
    steps: '打开测算页展开「容量电费测算」卡：断言默认档预选=1~10（20）千伏、P5 固定标注存在；容量方式输入 1000 kVA + 年用电量 12000 MWh → 年费用/分摊断言；切电压档 → 输出随之变化；年电量 0 → 分摊显示 —；西藏 → 暂无数据（负向）',
    expected: '默认预选档规则（1~10（20）千伏，无此档取第一档）生效；北京按容量 33 元/kVA·月×1000×12=396,000 元/年、分摊 33.00 元/MWh；切 220千伏及以上档 → 336,000 元/年；P5 固定标注「容量电费与电量来自省内或省外无关，不参与路径比选」含发改价格〔2020〕1441号 / 〔2023〕532号；年电量 0 显示 — 不出 Infinity；西藏显示「暂无数据」',
    async run(page, set) {
      await page.goto(G, DCL);
      const card = page.locator('#d-capfee');
      ok(await card.getAttribute('open') === null, '容量电费卡默认应收起（独立折叠卡）');
      await card.locator('summary').click();
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
      ok(r.annual.replace(/,/g, '') === '396000元/年', `BJ 按容量年费用应 396,000 元/年，实际「${r.annual}」`);
      ok(r.per === '33.00元/MWh', `BJ 按容量分摊应 33.00 元/MWh，实际「${r.per}」`);
      r = await run('BJ', 'demand', 1000, 12000);
      ok(r.annual.replace(/,/g, '') === '624000元/年', `BJ 按需量年费用应 624,000 元/年，实际「${r.annual}」`);
      ok(r.per === '52.00元/MWh', `BJ 按需量分摊应 52.00 元/MWh，实际「${r.per}」`);
      // 切档联动：220千伏及以上 容量 28 → 336,000
      await page.evaluate(() => { state.capProv = 'BJ'; state.capTier = null; setCapMode('cap'); });
      await page.selectOption('#i-captier', '220千伏及以上');
      r = await page.evaluate(() => ({
        annual: document.querySelectorAll('#d-capfee .mc .v')[1].textContent.trim(),
        tier: document.getElementById('i-captier').value,
      }));
      ok(r.annual.replace(/,/g, '') === '336000元/年', `切 220千伏及以上档后年费用应 336,000 元/年，实际「${r.annual}」`);
      // 负向 1：年电量 0 → 分摊显示 —（不报错、不出 Infinity）
      await page.evaluate(() => {
        const iq = document.getElementById('i-capqty'); iq.value = '0'; iq.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const per0 = await page.evaluate(() => document.querySelectorAll('#d-capfee .mc .v')[2].textContent.trim());
      ok(per0 === '—元/MWh' && !per0.includes('Infinity'), `年电量 0 时分摊应显示 —，实际「${per0}」`);
      // 负向 2：西藏（缺省省）→ 暂无数据，不补估
      await page.evaluate(() => { state.capProv = 'XZ'; renderCalc(); });
      const xzTxt = await card.locator('.warn').innerText();
      ok(xzTxt.includes('暂无数据'), `西藏应显示暂无数据，实际「${xzTxt.slice(0, 40)}」`);
      set(`默认档预选=1~10（20）千伏；BJ 容量 396,000/33.00、需量 624,000/52.00；切档 336,000；年电量0→—；XZ→暂无数据`);
    },
  },
  {
    id: 'RQ-705', section: 'PRD-IPRO', title: 'REQ-705：通道组件（直流）作为必经组件筛方案 + 说明文字可折叠',
    steps: '检查 details.explain 默认收起；放宽跳数/绕行让候选含多条直流；点选一个直流组件，再清除',
    expected: '长段说明默认收起、点击可展开；直流组件排在最前；点选后列表只保留含该通道的方案，且组件清单仍为完整候选集（其余组件仍可取消）；清除后恢复全量',
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

      // 放宽条件，让候选里出现多条直流
      await page.evaluate(() => { state.from = 'SC'; state.to = 'SH'; state.maxHops = 6; state.maxDetour = 9;
        state.showBad = true; state.mustHave = []; state.sel = 0; applyBothProv(); doSolve(); });
      await page.waitForTimeout(200);
      const b = await page.evaluate(() => {
        const av = state._res.availChannels || [];
        const firstAc = av.findIndex((c) => c.type !== 'DC' && c.type !== 'AC/DC');
        return { n: av.length, chips: document.querySelectorAll('.comps button.chip').length,
          dcFirst: av.slice(0, firstAc < 0 ? av.length : firstAc).every((c) => c.type === 'DC' || c.type === 'AC/DC'),
          rows: state._res.rows.length };
      });
      ok(b.n > 0 && b.chips === b.n, `组件选择器应列出全部可选通道（${b.chips}/${b.n}）`);
      ok(b.dcFirst, '直流（专项工程）组件应排在最前');

      await page.click('.comps button.chip');
      await page.waitForTimeout(250);
      const a = await page.evaluate(() => ({
        must: state.mustHave.slice(), rows: (state._res.rows || []).length,
        allOk: (state._res.rows || []).every((r) => state.mustHave.every((id) => r.edges.some((e) => e.id === id))),
        avail: (state._res.availChannels || []).length,
        hint: (document.querySelector('.sec-title .hint') || {}).textContent || '',
      }));
      ok(a.must.length === 1, `点选后应记为必经组件，实际 ${a.must.length} 个`);
      ok(a.rows > 0 && a.allOk, `筛出的 ${a.rows} 条方案应全部包含该组件`);
      ok(a.avail === b.n, `组件清单不得被筛选收窄（${a.avail}/${b.n}），否则其余组件再也点不回来`);
      ok(/按 1 个组件筛选/.test(a.hint), `标题应提示已按组件筛选，实际「${a.hint.trim()}」`);

      await page.click('button:has-text("清除全部组件")');
      await page.waitForTimeout(250);
      const c = await page.evaluate(() => ({ must: state.mustHave.length, rows: state._res.rows.length }));
      ok(c.must === 0 && c.rows === b.rows, `清除后应恢复全量 ${b.rows} 条候选，实际 ${c.rows} 条`);
      set(`说明区 ${ex.length} 处默认收起；组件 ${b.chips} 个（直流优先）；筛出 ${a.rows}/${b.rows} 条；清除后恢复`);
    },
  },
  {
    id: 'RQ-602', section: 'PRD-IPRO', title: 'REQ-602：本地价格覆盖 priceVersion 校验',
    steps: '预置旧版本地费率覆盖（pv=0000）后加载页面，应用内确认框点「丢弃本地修改」',
    expected: '出现应用内提示并丢弃旧覆盖，CH 恢复当前核定值（64 条且内容非占位）',
    async run(page, set) {
      await page.addInitScript(() => {
        localStorage.setItem('iproute.v2.lib', JSON.stringify({
          pv: '0000dead', at: 'old',
          ch: Array.from({ length: 64 }, (_, i) => ({ id: 'X' + i, n: '占位通道' + i, from: 'SC', to: 'JS', type: 'DC', kv: '±0kV', loss: 0, t: 1, tRaw: 1, sendFee: 0, cap: null, capRated: null, capActual: null, capBasis: 'unknown', capSrc: '', priceType: 'energy', capPrice: null, capEq: null, tier: 'est', doc: '', eff: '', bill: '', tax: true, incLoss: false, excerpt: '', hist: [], tradable: true, status: '', note: '', sourceIssue: null, fn: '', lenKm: null, stFrom: null, stTo: null, regional: false, dirNote: '', docTitle: '', docVersion: null, pubDate: '', sourceIssue2: null })),
        }));
      });
      await page.goto(G, DCL);
      const dlg = page.locator('[role="dialog"]');
      await dlg.waitFor({ state: 'visible', timeout: 5000 });
      const tip = await dlg.innerText();
      ok(tip.includes('priceVersion') && tip.includes('不一致'), `应有旧版本提示（应用内确认框），实际「${tip.slice(0, 30)}」`);
      await dlg.locator('button', { hasText: '丢弃本地修改' }).click();
      await page.waitForTimeout(200);
      const ch = await page.evaluate(() => ({ n: CH.length, first: CH[0].n, stale: !!state._libStale }));
      ok(ch.n === 64 && !String(ch.first).includes('占位') && !ch.stale, `旧覆盖应被丢弃恢复核定值，实际 CH[0].n=${ch.first} stale=${ch.stale}`);
      set(`应用内提示出现（priceVersion 不一致）；丢弃后 CH 恢复核定值（${ch.n} 条）`);
    },
  },
  {
    id: 'RQ-602b', section: 'PRD-IPRO', title: 'REQ-602b：保留旧版价格覆盖时费率库出现核对横幅',
    steps: '预置旧版本地费率覆盖后加载，应用内确认框选「暂保留」，进入费率库；再点「恢复检索原始值」',
    expected: '费率库顶部出现「旧版价格数据」核对横幅；应用内确认恢复后横幅消失',
    async run(page, set) {
      await page.addInitScript(() => {
        localStorage.setItem('iproute.v2.lib', JSON.stringify({
          pv: '0000dead', at: 'old',
          ch: Array.from({ length: 64 }, (_, i) => ({ id: 'X' + i, n: '占位通道' + i, from: 'SC', to: 'JS', type: 'DC', kv: '±0kV', loss: 0, t: 1, tRaw: 1, sendFee: 0, cap: null, capRated: null, capActual: null, capBasis: 'unknown', capSrc: '', priceType: 'energy', capPrice: null, capEq: null, tier: 'est', doc: '', eff: '', bill: '', tax: true, incLoss: false, excerpt: '', hist: [], tradable: true, status: '', note: '', sourceIssue: null, fn: '', lenKm: null, stFrom: null, stTo: null, regional: false, dirNote: '', docTitle: '', docVersion: null, pubDate: '', sourceIssue2: null })),
        }));
      });
      await page.goto(G, DCL);
      const dlg = page.locator('[role="dialog"]');
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
    id: 'RQ-02a', section: 'PRD-IPRO', title: 'REQ-201：方案含未确认联络线黄条',
    steps: '江苏→上海 测算，查看方案区告警',
    expected: '默认方案含苏沪联络线（tradable=false）时出现「未确认属于省间现货交易网络」黄条',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.selectOption('#i-to', 'SH');     // 先改受端，避免「江苏」作为当前受端被互斥禁用
      await page.selectOption('#i-from', 'JS');
      await page.waitForTimeout(150);
      const hit = await page.evaluate(() =>
        [...document.querySelectorAll('.col-main .warn')].some(w => w.textContent.includes('未确认属于省间现货交易网络')));
      const viaSuhu = await page.evaluate(() => state._res.rows[0].edges.some(e => e.tradable === false));
      ok(hit && viaSuhu, `黄条应出现（默认方案含未确认联络线=${viaSuhu}），实际黄条=${hit}`);
      set(`JS→SH 默认方案含 tradable=false 段；黄条出现=${hit}`);
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
    steps: '出发地北京、跳数 1，开启「仅按已确认可交易通道」',
    expected: '北京相连通道均为未确认联络线，开启后为空态引导文案（非脚本报错）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.selectOption('#i-from', 'BJ');
      await page.selectOption('#i-hops', '1');
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
      await page.waitForSelector('.rc');
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
      const m0 = await page.evaluate(() => state._res.rows[0].maxLoad);
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
    steps: '查看方案区落地价下方声明',
    expected: '声明存在且含「96 时段」',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('.rc');
      const ok1 = await page.evaluate(() => document.getElementById('v-calc').innerText.includes('96 时段'));
      ok(ok1, '应含 96 时段单时点声明');
      set('单时点声明可见');
    },
  },
  {
    id: 'RQ-05', section: 'PRD-IPRO', title: 'REQ-304：口径三非结算口径标注',
    steps: '查看「送端收益」按钮提示与⑦口径位置标注',
    expected: '按钮 title 含「非结算口径」；⑦口径位置旁有同义标注',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('.rc');
      const r = await page.evaluate(() => ({
        btn: document.querySelector('#v-calc .seg.small button[title]')?.getAttribute('title') || '',
        note: (document.getElementById('v-calc').textContent || '').includes('非结算口径'),
      }));
      ok(r.btn.includes('非结算口径') && r.note, `按钮 title=${r.btn}，标注=${r.note}`);
      set(`title="${r.btn}"；⑦标注可见`);
    },
  },
  {
    id: 'RQ-06', section: 'PRD-IPRO', title: 'REQ-305：区域电网费适用性标注',
    steps: '查看②区区域电网输电价格说明',
    expected: '说明含 S14 3.4.2(a) 统一计入口径（新语义）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.waitForSelector('.rc');
      // 说明文字已改为默认收起的 details.explain（RQ-705），innerText 不含未渲染内容，须先展开再断言
      await page.evaluate(() => { document.querySelectorAll('details.explain').forEach(d => d.open = true); });
      await page.waitForTimeout(80);
      const r = await page.evaluate(() => {
        const t = document.getElementById('v-calc').innerText;
        return t.includes('3.4.2(a)') && t.includes('买方节点所在区域');
      });
      ok(r, '应含新口径说明（3.4.2(a) 统一计入买方区域）');
      set('新口径说明可见');
    },
  },
  {
    id: 'RQ-306', section: 'PRD-IPRO', title: 'REQ-306：结算机制折叠区',
    steps: '展开完整明细，查看「结算机制」',
    expected: '折叠块存在且四条齐备（买方支出/卖方边际价/执行顺序/日清月结 D+5）',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.evaluate(() => { document.getElementById('d-detail').open = true; });
      await page.waitForTimeout(80);
      const t = await page.evaluate(() => document.getElementById('d-detail').innerText);
      ok(t.includes('结算机制') && t.includes('边际价格') && t.includes('D+5') && t.includes('执行电量'), '四条内容应齐备');
      set('结算机制四条齐备');
    },
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
      await page.waitForSelector('.rc');
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
      await page.waitForSelector('.rc');
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
      await page.waitForSelector('.rc');
      const dlg = page.locator('[role="dialog"]');
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
];

async function respCheck(page, set, expectCentered, desktop = false) {
  await page.goto(G, DCL);
  const m = await page.evaluate(() => {
    const de = document.documentElement, app = document.getElementById('app');
    return {
      overflow: de.scrollWidth - de.clientWidth,
      appMax: getComputedStyle(app).maxWidth,
      left: app.getBoundingClientRect().left,
      vw: de.clientWidth,
      nav: !!document.querySelector('nav'),
      card: !!document.querySelector('.rc'),
    };
  });
  ok(m.overflow <= 1, `存在横向溢出 ${m.overflow}px`);
  if (desktop) {
    // 修正(2026-09-15)：≥900px 进入桌面宽布局（template.html:210/270，#app max-width 1320/1480px），
    // 原断言「max-width:480px 且 left>100 居中」是移动端限宽口径，与现版本桌面适配矛盾。
    ok(['1320px', '1480px'].includes(m.appMax), `桌面端 #app max-width 应 1320/1480px，实际 ${m.appMax}`);
    ok(m.left <= 1, `桌面宽布局 #app 应铺满视口，left=${m.left}`);
  } else {
    ok(m.appMax === '480px', `#app max-width 应 480px，实际 ${m.appMax}`);
  }
  ok(m.nav && m.card, '底部导航/路线卡片缺失');
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
let md = `# E2E 测试报告 — 省间路径优选测算\n\n`;
md += `- 被测地址：${BASE}\n- 执行时间：${new Date().toLocaleString('zh-CN')}\n- 浏览器：Playwright headless（channel=${channel}）\n- 默认视口：390×844（响应式用例单独指定）\n- 用例总数：${results.length}，通过 ${results.filter(r => r.pass).length}，失败 ${results.filter(r => !r.pass).length}\n\n`;
md += `| 分组 | 通过/总数 |\n|---|---|\n`;
for (const s of sections) {
  const g = results.filter(r => r.section === s);
  md += `| ${s} | ${g.filter(r => r.pass).length}/${g.length} |\n`;
}
md += `\n---\n`;
for (const r of results) {
  md += `\n### ${r.id} ${r.title} — ${r.pass ? '✅ PASS' : '❌ FAIL'}\n`;
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
console.log(`\n完成：${results.filter(r => r.pass).length}/${results.length} 通过；报告 tests/report.md`);
process.exit(results.some(r => !r.pass) ? 1 : 0);
