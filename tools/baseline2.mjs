#!/usr/bin/env node
/**
 * v2 基线生成 + 校验 + 渲染冒烟测试。
 * 生成 docs/regression-baseline-v2.json（真实费率下的全量断面组合结果），
 * 再重跑一遍逐字段比对，确认实现与基线等价。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const i = html.lastIndexOf('<script>');
const j = html.lastIndexOf('</' + 'script>');
const code = html.slice(i + 8, j);

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

// ---------- 生成基线 ----------
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
for (const f of keys) for (const t of keys) {
  if (f === t) continue;
  const R = runOn(ctx, f, t);
  if (R.err) continue;
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

const tariffSnapshot = JSON.stringify(CH);
const baseline = {
  schema: 'iproute-regression-baseline/v2',
  generated_at: new Date().toISOString(),
  engine: 'prototype-web-v2 (真实检索费率 · 第四监管周期)',
  warning: '费率中 38 条为发改委核定价、8 条为国网披露价、24 条为区域/送出省口径。用于实现迁移时的数值回归比对。',
  tariff_snapshot_sha256: crypto.createHash('sha256').update(tariffSnapshot).digest('hex'),
  tariff_snapshot: CH,
  case_count: cases.length,
  cases,
};
fs.writeFileSync(path.join(root, 'docs/regression-baseline-v2.json'), JSON.stringify(baseline));
console.log('✅ 基线已生成 docs/regression-baseline-v2.json');
console.log(`   省对 ${cases.length} 个｜路径 ${cases.reduce((s, c) => s + c.routes.length, 0)} 条｜费率快照 sha256 ${baseline.tariff_snapshot_sha256.slice(0, 20)}…`);
console.log(`   文件 ${(fs.statSync(path.join(root, 'docs/regression-baseline-v2.json')).size / 1024).toFixed(0)} KB`);

// ---------- 校验 ----------
const ctx2 = makeCtx();
vm.runInContext(`CH = ${JSON.stringify(baseline.tariff_snapshot)};`, ctx2);
let checked = 0, failed = 0;
const probs = [];
for (const c of baseline.cases) {
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
console.log(`\n${failed ? '❌' : '✅'} 基线校验：${checked - failed}/${checked} 通过`);
probs.slice(0, 8).forEach((p) => console.log('   · ' + p));

// ---------- 渲染冒烟测试 ----------
console.log('\n=== 渲染冒烟测试 ===');
const c3 = makeCtx();
const checks = [
  ['renderCalc() 测算页', 'state.from="SC";state.to="SH";state.sel=0;state._res=solve(state, algoData());renderCalc();', 'v-calc',
    ['出发地', '目的地', '可选路线', '落地成本', '交易连接与区域计费', '完整明细', '逐段溯源', '口径位置', '送端省内段', '成本阈值',
     '条候选', '送端收益', 'tl-seg-card', 'rc-price', '在网架图上查看', '原文摘录', '调价历史']],
  ['方案切换 sel=1', 'state.sel=1;renderCalc();', 'v-calc', ['方案 #2', '交易连接与区域计费', '段入口功率', '段损耗电量']],
  ['renderMap() 内置拓扑图', "state.mapProvider='svg';renderMap();", 'v-map', ['内置拓扑图', '全网架', '不依赖任何外部地图服务', '拓扑图']],
  ['响应式结构（桌面双栏）', 'state.from="SC";state.to="SH";state._res=solve(state, algoData());renderCalc();', 'v-calc', ['class="topbar"', 'class="layout"', 'class="col-side"', 'class="col-main"']],
  ['renderLib() 通道页', "state.libQ='';state.libFilter='all';libTab='ch';renderLib();", 'v-lib', ['搜索通道名', 'libcard', '匹配', '容量制', '实际输送能力', '送出省输电价格']],
  ['费率库搜索命中', "state.libQ='锦苏';renderLib();", 'v-lib', ['锦苏', '匹配 1 条']],
  ['费率库筛选容量制', "state.libQ='';state.libFilter='capacity';renderLib();", 'v-lib', ['容量制', '辛洹', '云霄']],
  ['renderLib() 省级页', "libTab='pv';renderLib();", 'v-lib', ['输配电价', '待补']],
  ['renderLib() 断面页', "libTab='sec';renderLib();", 'v-lib', ['川渝断面', '真实可交易能力须由对应交易机构与调度机构确认']],
  ['renderMap() 腾讯底图', "state.mapProvider='qq';renderMap();", 'v-map', ['腾讯地图', '天地图', 'map-view']],
  ['renderMap() 天地图分支', "state.mapProvider='td';renderMap();", 'v-map', ['天地图密钥', 'cloudcenter.tianditu.gov.cn']],
];
for (const [name, call, target, expects] of checks) {
  try {
    vm.runInContext(call, c3);
    const htmlOut = c3.__dom[target] ? c3.__dom[target].innerHTML : '';
    const miss = expects.filter((e) => !htmlOut.includes(e));
    const hasKey = c3.__dom['fallback'] && c3.__dom['fallback'].innerHTML.length > 0;
    console.log(`  ${miss.length ? '❌' : '✅'} ${name}　输出 ${htmlOut.length} 字符${miss.length ? '　缺: ' + miss.join(',') : ''}${hasKey ? '　(底图降级已触发)' : ''}`);
  } catch (e) { console.log(`  ❌ ${name}　${e.message}`); }
}

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
