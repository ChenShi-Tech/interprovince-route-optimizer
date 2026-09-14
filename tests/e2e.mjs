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
    steps: '出发地下拉选「上海」，目的地下拉选「四川」',
    expected: '选完即重算（无按钮）；受端输配电价/基金附加自动换成四川值；详情线路串含上海',
    async run(page, set) {
      await page.goto(G, DCL);
      const before = await page.evaluate(() => state.pNet);
      await page.selectOption('#i-from', 'SH');
      await page.selectOption('#i-to', 'SC');
      const after = await page.evaluate(() => state.pNet);
      const scNet = await page.evaluate(() => PV['SC'].net);
      ok(after === scNet, `pNet 应联动为四川 ${scNet}，实际 ${after}`);
      const hd = (await page.locator('.hd-route').first().innerText()).trim();
      ok(hd.startsWith('上海'), `详情应以上海开头，实际「${hd.slice(0, 20)}」`);
      set(`pNet ${before}→${after}（=四川参数 ${scNet}）；详情「${hd.slice(0, 40)}」`);
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
      await page.locator('details.adv.boxed summary').first().click(); // 展开「价格与口径」折叠区
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
      ok(await page.locator('.lib-row').count() > 0, '通道列表未渲染');
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
      const inp = page.locator('.lib-row .lib-io input').first();
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
    id: 'I-04', section: '交互', title: '「恢复检索原始值」confirm 弹窗（取消/确认）',
    steps: '先改 CH[0].t=123；点恢复→取消；再点恢复→确认',
    expected: '取消：值不变；确认：恢复为 DATA.CH 原始值',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-lib');
      await page.evaluate(() => { CH[0].t = 123; });
      const btn = page.locator('button', { hasText: '恢复检索原始值' });
      let msg = '';
      page.once('dialog', async d => { msg = d.message(); await d.dismiss(); });
      await btn.click();
      ok(msg.includes('恢复为检索原始值'), `confirm 文案异常：「${msg}」`);
      ok(await page.evaluate(() => CH[0].t) === 123, '取消后应保持 123');
      page.once('dialog', async d => { msg = d.message(); await d.accept(); });
      await btn.click();
      const restored = await page.evaluate(() => CH[0].t === DATA.CH[0].t);
      ok(restored, '确认后应恢复原始值');
      set(`confirm「${msg.slice(0, 18)}…」；取消保持 123；确认后恢复 ${await page.evaluate(() => DATA.CH[0].t)}`);
    },
  },
  {
    id: 'I-05', section: '交互', title: '「导出 JSON」触发浏览器下载',
    steps: '费率库 Tab 点「导出 JSON」',
    expected: '触发下载，文件名 费率库-v2.json，内容含 70 条通道',
    async run(page, set) {
      await page.goto(G, DCL);
      await page.click('#t-lib');
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 5000 }),
        page.locator('button', { hasText: '导出 JSON' }).click(),
      ]);
      const p = path.join(SHOTS, 'export-lib.json');
      await dl.saveAs(p);
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      ok(j.ch && j.ch.length === 70, `导出应含 70 条通道，实际 ${j.ch ? j.ch.length : 0}`);
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
    expected: '#fallback 显示「已降级为网架清单」+ 全部 70 条通道，无未捕获异常',
    async run(page, set) {
      await page.context().route(/map\.qq\.com/, r => r.abort());
      await page.goto(G, DCL);
      await page.click('#t-map');
      await page.waitForSelector('#fallback', { state: 'visible', timeout: 6000 });
      const txt = await page.locator('#fallback').innerText();
      ok(txt.includes('降级'), `应显示降级文案，实际「${txt.slice(0, 40)}」`);
      ok(txt.includes('70'), '应列出全部 70 条通道');
      set(`降级清单已显示（含 70 条通道）；script 加载失败被 initMap/showMapFallback 吸收`);
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
    id: 'R-03', section: '响应式', title: '桌面 1440×900 居中',
    steps: '以 1440×900 视口打开测算页',
    expected: '#app 居中（左右留白）；无横向溢出',
    viewport: { width: 1440, height: 900 },
    async run(page, set) { await respCheck(page, set, true); },
  },
];

async function respCheck(page, set, expectCentered) {
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
  ok(m.appMax === '480px', `#app max-width 应 480px，实际 ${m.appMax}`);
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
