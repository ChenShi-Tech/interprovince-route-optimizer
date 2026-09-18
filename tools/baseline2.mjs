#!/usr/bin/env node
/**
 * v2 基线生成 + 校验 + 渲染冒烟测试。
 *
 * 用法：
 *   node tools/baseline2.mjs            # 只读核对：与已提交基线逐项比对，不写任何文件
 *   node tools/baseline2.mjs --accept   # 显式接受差异并覆写 docs/regression-baseline-v2.json
 *
 * 为什么默认不覆写（H4）：基线是回归门的「答案」。若每次都直接覆写再用新答案自比，
 * 任何费率错值都会自证通过（实测龙政直流价 +20% 后 7 组测试仍全绿）。因此覆写必须显式
 * --accept，且覆写前打印 priceVersion 变化、变更条目数与条目名，供人工确认是有据改价。
 *
 * 报错省对（solve 返回 err）不再静默剔除（2026-09-18）：过去 continue 会让它们从基线里
 * 无声消失（如坐标修正后的 GS→SX，426→425）并失去回归覆盖；现在记入基线 skipped 元数据
 * （省对 + err 文本）并在生成时打印，集合变化同样计入 drift。是让缺口可见，不是放宽用例。
 *
 * ⚠️ tools/baseline-check.mjs 校验时会先用基线里的费率快照覆盖 CH，因此
 * **它只证明实现未漂移，不证明费率数值正确**——费率/数据正确性必须另靠审计脚本与来源核对。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const accept = process.argv.includes('--accept');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const i = html.lastIndexOf('<script>');
const j = html.lastIndexOf('</' + 'script>');
const code = html.slice(i + 8, j);
const priceVersion = (html.match(/const PRICE_VERSION='([^']+)'/) || [])[1] || '(未找到)';

function makeCtx() {
  const store = {};
  const dom = {};
  const mk = (id) => (dom[id] ||= { id, innerHTML: '', hidden: false, style: {}, textContent: '',
    classList: { toggle() {}, add() {}, remove() {} }, value: '0' });
  const ctx = {
    console: { log() {} },
    document: { getElementById: mk, addEventListener() {},
      createElement: () => ({ click() {}, style: {}, setAttribute() {} }),
      head: { appendChild() {} }, body: mk('body') },
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    Blob: function () {}, URL: { createObjectURL: () => '' }, confirm: () => false,
    setTimeout: (f) => f(), Math, JSON, Number, Object, Array, String, Date, isNaN, parseInt,
    parseFloat, Error, encodeURIComponent, isFinite, RegExp, Set, Map,
    __dom: dom, __store: store,
  };
  ctx.window = { scrollTo() {}, open() {} };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

// ---------- 生成基线（内存中，是否落盘由 --accept 决定）----------
const ctx = makeCtx();
const G = (c, e) => vm.runInContext(e, c);
const PV = G(ctx, "PV"), CH = G(ctx, "CH");
const keys = Object.keys(PV);

function runOn(c, f, t) {
  vm.runInContext(`Object.assign(state,{from:${JSON.stringify(f)},to:${JSON.stringify(t)},
    qty:1000,hours:1,pGen:${PV[f].clear},pDst:${PV[t].clear},pNet:${PV[t].net},fund:${PV[t].fund},
    lossBearer:1,K:6,maxHops:3,maxDetour:2,includeRegion:true,showBad:true,sortBy:"A",showAll:true,
    originLossMode:'included',regionLossMode:'exclude'});`, c);
  return vm.runInContext('solve(state, algoData())', c);
}

const cases = [];
// 报错省对（solve 返回 err，如绕行度上限把所有候选筛掉）：**不静默剔除**。
// 过去直接 continue，报错省对就从基线里消失（426→425）且无人知晓，从此失去回归覆盖。
// 现在登记进基线的 skipped 元数据并在生成时打印；是否保留为用例由人工决策，门禁不放宽。
const skipped = [];
for (const f of keys) for (const t of keys) {
  if (f === t) continue;
  const R = runOn(ctx, f, t);
  if (R.err) { skipped.push({ from: f, to: t, err: String(R.err) }); continue; }
  const pack = (r) => ({
    nodes: r.nodes, landed: +r.landed.toFixed(4), channelOnly: +r.channelOnly.toFixed(4),
    senderNet: +r.senderNet.toFixed(4), delivery: +r.D.toFixed(6), lossPct: +((1 - r.D) * 100).toFixed(4),
    hops: r.hops, detour: +r.detour.toFixed(4), feasible: r.feasible,
    secHits: r.secHits.map((h) => [h.sec.id, +h.mw.toFixed(1), h.over]),
  });
  cases.push({
    from: f, to: t,
    inputs: { pGen: PV[f].clear, pDst: PV[t].clear, pNet: PV[t].net, fund: PV[t].fund,
      qty: 1000, hours: 1, lossBearer: 1, maxHops: 3, maxDetour: 2, includeRegion: true },
    routes: R.rows.slice(0, 25).map(pack),
    routeTotal: R.rows.length,
    feasibleCount: R.feasibleCount,
    best: { landed: R.byA[0].nodes, channelOnly: R.byB[0].nodes, senderNet: R.byC[0].nodes },
  });
}

// ---------- 分档警告文案：从实际数据统计生成，四档之和必须等于 CH 长度 ----------
const byTier = CH.reduce((a, c) => (a[c.tier] = (a[c.tier] || 0) + 1, a), {});
const TIER_KEYS = ['gov', 'grid', 'region', 'est'];
const tierSum = TIER_KEYS.reduce((a, k) => a + (byTier[k] || 0), 0);
if (tierSum !== CH.length) {
  console.error(`❌ tier 分档计数 ${tierSum} ≠ CH 长度 ${CH.length}（分档定义漏了取值，先修 build.mjs）`);
  process.exit(1);
}
const tierText = `费率中 ${byTier.gov || 0} 条为发改委核定价、${byTier.grid || 0} 条为国网披露价、`
  + `${byTier.region || 0} 条为区域/送出省口径、${byTier.est || 0} 条为待补（价格待核）。`;

const tariffSnapshot = JSON.stringify(CH);
const newSnapshotSha = crypto.createHash('sha256').update(tariffSnapshot).digest('hex');
const baselinePath = path.join(root, 'docs/regression-baseline-v2.json');
const oldBaseline = fs.existsSync(baselinePath)
  ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
const skippedKeys = skipped.map((s) => s.from + '>' + s.to);
const oldSkippedKeys = (oldBaseline && Array.isArray(oldBaseline.skipped) ? oldBaseline.skipped : [])
  .map((s) => s.from + '>' + s.to);

const newBaseline = {
  schema: 'iproute-regression-baseline/v2',
  generated_at: new Date().toISOString(),
  engine: 'prototype-web-v2 (真实检索费率 · 第四监管周期)',
  priceVersion,
  tariff_snapshot_sha256: newSnapshotSha,
  warning: tierText + '注意 tools/baseline-check.mjs 会先用本文件的费率快照覆盖 CH，'
    + '因此它只证明实现未漂移、不证明费率数值正确。'
    + (skipped.length ? `另有 ${skipped.length} 个省对求解报错未入用例（见 skipped，是缺口不是通过）。` : ''),
  tariff_snapshot: CH,
  case_count: cases.length,
  cases,
  // 求解报错的省对（含 err 文本）：这里如实登记，避免它们从回归覆盖里静默消失。
  skipped,
};

// ---------- 与已提交基线比对（覆写前的强制打印）----------
const DIFF_FIELDS = ['t', 'tRaw', 'sendFee', 'sendFeeRev', 'tRev', 'bidir', 'from', 'to',
  'loss', 'cap', 'capBasis', 'tier', 'pricePending', 'incLoss', 'eff', 'doc'];
function diffTariff(oldCH, newCH) {
  const oldById = new Map(oldCH.map((c) => [c.id, c]));
  const newById = new Map(newCH.map((c) => [c.id, c]));
  const changed = [];
  for (const [id, n] of newById) {
    const o = oldById.get(id);
    if (!o) continue;
    const fields = DIFF_FIELDS.filter((f) => JSON.stringify(o[f]) !== JSON.stringify(n[f]))
      .map((f) => `${f} ${JSON.stringify(o[f])} → ${JSON.stringify(n[f])}`);
    if (fields.length) changed.push(`${id} ${n.n}：${fields.join('；')}`);
  }
  return {
    changed,
    added: [...newById.keys()].filter((id) => !oldById.has(id)).map((id) => `${id} ${newById.get(id).n}`),
    removed: [...oldById.keys()].filter((id) => !newById.has(id)).map((id) => `${id} ${oldById.get(id).n}`),
  };
}
function diffCases(oldCases, newCases) {
  const key = (c) => c.from + '>' + c.to;
  const oldMap = new Map(oldCases.map((c) => [key(c), c]));
  const newMap = new Map(newCases.map((c) => [key(c), c]));
  const names = [];
  for (const [k, c] of newMap) {
    const o = oldMap.get(k);
    if (!o) continue;
    if (o.routeTotal !== c.routeTotal) { names.push(`${k} 路线数 ${o.routeTotal}→${c.routeTotal}`); continue; }
    for (let x = 0; x < Math.min(o.routes.length, c.routes.length); x++) {
      const a = o.routes[x], b = c.routes[x];
      if (a.nodes.join('>') !== b.nodes.join('>') || Math.abs(a.landed - b.landed) > 1e-4) {
        names.push(`${k} #${x + 1} ${a.landed}→${b.landed} ${b.nodes.join('>')}`); break;
      }
    }
  }
  return { changed: names.length, names,
    added: [...newMap.keys()].filter((k) => !oldMap.has(k)).length,
    removed: [...oldMap.keys()].filter((k) => !newMap.has(k)).length };
}

console.log('=== 基线比较（写盘前必须人工确认）===');
console.log(`本次构建 priceVersion：${priceVersion}`);
console.log(`本次生成：可用用例 ${cases.length} 个省对；求解报错 ${skipped.length} 个（记入 skipped，未入用例）`);
if (oldBaseline) {
  const oldPV = oldBaseline.priceVersion || '（旧基线未记录 priceVersion）';
  console.log(`已提交基线 priceVersion：${oldPV}${oldBaseline.priceVersion && oldBaseline.priceVersion !== priceVersion ? '  ← 有变化' : ''}`);
  console.log(`费率快照 sha256：${String(oldBaseline.tariff_snapshot_sha256).slice(0, 20)}… → ${newSnapshotSha.slice(0, 20)}…`
    + (oldBaseline.tariff_snapshot_sha256 === newSnapshotSha ? '（未变）' : '（已变）'));
  const td = diffTariff(oldBaseline.tariff_snapshot, CH);
  console.log(`通道条目变更：${td.changed.length} 条修改｜${td.added.length} 条新增｜${td.removed.length} 条删除`);
  td.changed.slice(0, 12).forEach((s) => console.log('  · ' + s));
  if (td.changed.length > 12) console.log(`  · …另有 ${td.changed.length - 12} 条`);
  td.added.slice(0, 6).forEach((s) => console.log('  + ' + s));
  td.removed.slice(0, 6).forEach((s) => console.log('  - ' + s));
  const cd = diffCases(oldBaseline.cases, cases);
  console.log(`数值结果变化：${cd.changed}/${cases.length} 个省对（另有新增 ${cd.added}、删除 ${cd.removed}）`);
  cd.names.slice(0, 6).forEach((s) => console.log('  · ' + s));
  if (cd.names.length > 6) console.log(`  · …另有 ${cd.names.length - 6} 个省对变化`);
  const skAdded = skippedKeys.filter((k) => !oldSkippedKeys.includes(k));
  const skRemoved = oldSkippedKeys.filter((k) => !skippedKeys.includes(k));
  const fmt = (arr) => arr.slice(0, 8).join('、') + (arr.length > 8 ? `（…另有 ${arr.length - 8} 个）` : '');
  console.log(`报错省对（skipped）变化：${oldSkippedKeys.length} → ${skippedKeys.length}`
    + `（新增 ${skAdded.length}${skAdded.length ? '：' + fmt(skAdded) : ''}；`
    + `恢复 ${skRemoved.length}${skRemoved.length ? '：' + fmt(skRemoved) : ''}）`);
} else {
  console.log('未找到已提交基线 docs/regression-baseline-v2.json（首次生成）。');
}

// 报错省对明细：打印全量，避免「静默消失」（err 文本逐条给出，便于判断是路径不可达还是绕行度筛空）
if (skipped.length) {
  console.log(`求解报错省对明细（${skipped.length} 个，未入用例；同样写入基线 skipped 字段）：`);
  skipped.forEach((s) => console.log(`  ! ${s.from}→${s.to}：${s.err}`));
}

const drift = !oldBaseline
  || oldBaseline.tariff_snapshot_sha256 !== newSnapshotSha
  || JSON.stringify(oldBaseline.cases) !== JSON.stringify(cases)
  // 报错省对集合的变化同样视为漂移（新增报错=覆盖减少，恢复=覆盖增加），防止静默丢失
  || JSON.stringify(oldSkippedKeys) !== JSON.stringify(skippedKeys);

if (!accept) {
  // 只读模式：不写任何文件，出现漂移即红。
  if (!oldBaseline) {
    console.error('\n❌ 本次未覆写基线：没有可比对的已提交基线。确认后用 --accept 生成：node tools/baseline2.mjs --accept');
    process.exit(1);
  }
  if (drift) {
    console.error('\n❌ 检测到与已提交基线的差异；本次未覆写基线（未改动任何文件）。');
    console.error('   若差异确为「有来源依据的数据修正」，人工确认后运行：node tools/baseline2.mjs --accept');
    process.exit(1);
  }
  console.log('\n✅ 与已提交基线一致；本次未覆写基线（未改动任何文件）。');
} else {
  fs.writeFileSync(baselinePath, JSON.stringify(newBaseline));
  console.log('\n✅ 已按 --accept 覆写 docs/regression-baseline-v2.json');
  console.log(`   省对 ${cases.length} 个｜路径 ${cases.reduce((s, c) => s + c.routes.length, 0)} 条｜费率快照 sha256 ${newSnapshotSha.slice(0, 20)}…`);
  console.log(`   文件 ${(fs.statSync(baselinePath).size / 1024).toFixed(0)} KB`);
}

// ---------- 校验（对「本次运行后生效的基线」自比，只证明实现与快照一致）----------
const active = accept ? newBaseline : oldBaseline;
if (active) {
  const ctx2 = makeCtx();
  vm.runInContext(`CH = ${JSON.stringify(active.tariff_snapshot)};`, ctx2);
  let checked = 0, failed = 0;
  const probs = [];
  for (const c of active.cases) {
    const R = runOn(ctx2, c.from, c.to);
    if (R.err) { failed++; probs.push(`${c.from}→${c.to} 报错`); continue; }
    // 基线只保存前 25 条路线（routes），总数另存在 routeTotal；比对总数必须用 routeTotal，
    // 不能拿截断后的 routes.length 当总数（路线数超过 25 的省对会误报）。
    const total = c.routeTotal != null ? c.routeTotal : c.routes.length;
    if (R.rows.length !== total) { failed++; probs.push(`${c.from}→${c.to} 路径数 ${R.rows.length}≠${total}`); continue; }
    for (let k = 0; k < c.routes.length; k++) {
      const e = c.routes[k], a = R.rows[k];
      checked++;
      if (e.nodes.join('>') !== a.nodes.join('>')) { failed++; probs.push(`${c.from}→${c.to}#${k + 1} 路径不一致`); continue; }
      for (const [key, val, tol] of [['landed', a.landed, 1e-4], ['channelOnly', a.channelOnly, 1e-4], ['senderNet', a.senderNet, 1e-4]]) {
        if (Math.abs(e[key] - val) > tol) { failed++; probs.push(`${c.from}→${c.to}#${k + 1} ${key} ${val.toFixed(4)}≠${e[key]}`); }
      }
    }
  }
  console.log(`\n${failed ? '❌' : '✅'} 基线校验（${accept ? '新基线' : '已提交基线'}，费率快照已还原）：${checked - failed}/${checked} 通过`);
  console.log('   注意：快照还原只证明实现未漂移，不证明费率数值正确。');
  probs.slice(0, 8).forEach((p) => console.log('   · ' + p));
  if (failed) process.exitCode = 1;
}

// ---------- 渲染冒烟测试（提示性，不影响退出码）----------
console.log('\n=== 渲染冒烟测试（提示性，不影响退出码）===');
const c3 = makeCtx();
const checks = [
  ['renderCalc() 测算页', 'state.from="SC";state.to="SH";state.sel=0;state._res=solve(state, algoData());renderCalc();', 'v-calc',
    // 界面改版后的对应文案：落地成本 → 顶部结果标签「省界价格」（默认费用边界为省间交易节点）；
    // 「送端收益」排序口径已随排序按钮移除（固定按价格排序）；「在网架图上查看」→ 方案卡按钮「网架图」
    ['出发地', '目的地', '可选路线', '省界价格', '交易连接与区域计费', '完整明细', '逐段溯源', '口径位置', '送端省内段', '成本阈值',
     '条候选', 'tl-seg-card', 'rc-price', `onclick="go('map')">网架图</button>`, '原文摘录', '调价历史']],
  ['方案切换 sel=1', 'state.sel=1;renderCalc();', 'v-calc', ['方案 #2', '交易连接与区域计费', '段入口功率', '段损耗 ']],
  ['renderMap() 内置拓扑图', "state.mapProvider='svg';renderMap();", 'v-map', ['内置拓扑图', '全网架', '不依赖任何外部地图服务', '拓扑图']],
  // 顶部选择区已并入主卡 .hero（原 .topbar）；智能推荐隐藏时布局类为「layout no-ai」，只校验前缀
  ['响应式结构（桌面双栏）', 'state.from="SC";state.to="SH";state._res=solve(state, algoData());renderCalc();', 'v-calc', ['class="hero"', 'class="layout', 'class="col-side"', 'class="col-main"']],
  ['renderLib() 通道页', "state.libQ='';state.libFilter='all';libTab='ch';renderLib();", 'v-lib', ['搜索通道名', 'libcard', '匹配', '容量制', '实际输送能力', '送出省输电价格']],
  ['费率库搜索命中', "state.libQ='锦苏';renderLib();", 'v-lib', ['锦苏', '匹配 1 条']],
  ['费率库筛选容量制', "state.libQ='';state.libFilter='capacity';renderLib();", 'v-lib', ['容量制', '辛洹', '云霄']],
  ['renderLib() 省级页', "libTab='pv';renderLib();", 'v-lib', ['输配电价', '待补']],
  ['renderLib() 断面页', "libTab='sec';renderLib();", 'v-lib', ['川渝断面', '真实可交易能力须由对应交易机构与调度机构确认']],
  ['renderMap() 腾讯底图', "state.mapProvider='qq';renderMap();", 'v-map', ['腾讯地图', '天地图', 'map-view']],
  ['renderMap() 天地图分支', "state.mapProvider='td';renderMap();", 'v-map', ['天地图密钥', 'cloudcenter.tianditu.gov.cn']],
];
let smokePass = 0;
for (const [name, call, target, expects] of checks) {
  try {
    vm.runInContext(call, c3);
    const htmlOut = c3.__dom[target] ? c3.__dom[target].innerHTML : '';
    const miss = expects.filter((e) => !htmlOut.includes(e));
    const hasKey = c3.__dom['fallback'] && c3.__dom['fallback'].innerHTML.length > 0;
    if (!miss.length) smokePass++;
    console.log(`  ${miss.length ? '❌' : '✅'} ${name}　输出 ${htmlOut.length} 字符${miss.length ? '　缺: ' + miss.join(',') : ''}${hasKey ? '　(底图降级已触发)' : ''}`);
  } catch (e) { console.log(`  ❌ ${name}　${e.message}`); }
}
console.log(`  冒烟汇总：${smokePass}/${checks.length} 通过`);

// 底图安全性检查
console.log('\n=== 底图合规检查 ===');
const ck = [
  ['腾讯地图代理占位符保留', html.includes('__WB_HTTP_PORT__') && html.includes('__WB_TMAP_SECRET__')],
  ['腾讯 SDK 未携带 key', !/gljs\?v=1\.exp[^"'`]*key=/.test(html)],
  ['天地图密钥不内嵌', !/tianditu\.gov\.cn\/api\?v=4\.0&tk=[A-Za-z0-9]{8,}/.test(html)],
  ['无境外地图源', !/googleapis|openstreetmap|mapbox|mapboxgl/i.test(html)],
  ['仅用白名单底图', /map\.qq\.com\/api\/gljs/.test(html) && /api\.tianditu\.gov\.cn/.test(html)],
];
ck.forEach(([n, ok]) => console.log(`  ${ok ? '✅' : '❌'} ${n}`));
