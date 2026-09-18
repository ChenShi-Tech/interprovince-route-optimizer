#!/usr/bin/env node
/** 费率库内部审计：逐条检查单位换算、数值合理性、来源可追溯性。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tariff = JSON.parse(fs.readFileSync(path.join(root, 'docs/tariff.json'), 'utf8'));
const extra = JSON.parse(fs.readFileSync(path.join(root, 'src/extra.json'), 'utf8'));
const prices = JSON.parse(fs.readFileSync(path.join(root, 'data/fixed-prices.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const issues = [];
const warn = [];

console.log('══════ 一、跨省跨区专项工程：单位换算与数值合理性 ══════\n');

// 从 tariff_raw 反解出 元/MWh，与存库值比对
function rawToMwh(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\s/g, '');
  let m;
  if ((m = s.match(/([\d.]+)分\/千瓦时/))) return +m[1] * 10;
  if ((m = s.match(/([\d.]+)元\/千瓦时/))) return +m[1] * 1000;
  if ((m = s.match(/([\d.]+)元\/千千瓦时/))) return +m[1];
  if ((m = s.match(/([\d.]+)元\/兆瓦时/))) return +m[1];
  return null;
}

let convOK = 0, convBad = 0, convCapacity = 0, convNA = 0;
console.log('  工程名'.padEnd(26) + '存库值'.padStart(10) + '原文换算'.padStart(12) + '  线损   判定');
console.log('  ' + '─'.repeat(72));
for (const r of tariff) {
  const calc = rawToMwh(r.tariff_raw);
  const stored = r.tariff_cny_per_mwh;
  let verdict;
  // 存库 null = 容量制工程（辛洹、云霄）：库内不取电量电价（另有容量电费/边际价口径），
  // 原文里即便出现「X分/千瓦时」也只适用于特定交易范围，不能判为换算偏差。
  if (stored == null) { verdict = '— 容量制工程（库内不用电量电价）'; convCapacity++; }
  else if (calc == null) { verdict = '原文格式未识别'; convNA++; }
  else if (Math.abs(calc - stored) < 0.05) { verdict = '✅ 一致'; convOK++; }
  else { verdict = `❌ 偏差 ${(stored - calc).toFixed(2)}`; convBad++; issues.push(`${r.name}: 存库 ${stored} vs 原文换算 ${calc}（${r.tariff_raw}）`); }

  console.log('  ' + r.name.slice(0, 24).padEnd(24)
    + String(stored == null ? '—' : stored).padStart(10) + String(calc == null ? '—' : calc.toFixed(1)).padStart(12)
    + '  ' + String(r.loss_rate_pct).padStart(5) + '%  ' + verdict);

  // 线损合理性
  if (r.loss_rate_pct != null && (r.loss_rate_pct <= 0 || r.loss_rate_pct > 16)) {
    warn.push(`${r.name}: 线损率 ${r.loss_rate_pct}% 超出常见区间 0-16%`);
  }
  // 文号与 tier
  const isGov = r.source.doc_number && /发改/.test(r.source.doc_number);
  if (!isGov && !/报备|复函/.test(r.note || '')) {
    warn.push(`${r.name}: 无发改委文号，但 note 未说明为报备价或复函`);
  }
}
console.log(`\n  换算一致 ${convOK} 条｜不一致 ${convBad} 条｜容量制不适用 ${convCapacity} 条｜无法识别 ${convNA} 条`);

console.log('\n══════ 二、省级电网输配电价：逐省核对来源 ══════\n');
const pv = extra.provinces;
let real = 0, est = 0;
console.log('  省份   220kV+ 元/MWh   基金 元/MWh   来源');
console.log('  ' + '─'.repeat(78));
Object.entries(pv).forEach(([k, v]) => {
  const isEst = /^估/.test(v.netSrc || '') || /待补/.test(v.netSrc || '');
  if (isEst) est++; else real++;
  console.log('  ' + v.n.padEnd(6) + String(v.net).padStart(9) + String(v.fund).padStart(13)
    + '   ' + (isEst ? '⚠ ' : '✅ ') + String(v.netSrc).slice(0, 46));
});
console.log(`\n  有据可依 ${real} 省｜仅估算 ${est} 省`);

console.log('\n══════ 三、政府性基金及附加：各省标准是否一致 ══════\n');
const fundGroups = {};
Object.entries(pv).forEach(([k, v]) => { (fundGroups[v.fund] ||= []).push(v.n); });
Object.entries(fundGroups).sort((a, b) => b[1].length - a[1].length).forEach(([f, names]) => {
  console.log(`  ${String(f).padStart(5)} 元/MWh  ${names.length} 省：${names.join('、')}`);
});
console.log('\n  说明：政府性基金及附加各省不同，取值应逐省核对而非统一。');
const uniform = Object.values(pv).filter(v => v.fund === 26.6).length;
if (uniform > 5) warn.push(`政府性基金及附加有 ${uniform} 省统一取 26.6 元/MWh，疑为估值而非逐省核定值`);

console.log('\n══════ 四、区域电网输电价格（电量电价） ══════\n');
Object.entries(extra.regionGrid || {}).forEach(([k, v]) => {
  if (k.startsWith('_')) return;
  console.log(`  ${k.padEnd(4)} ${v} 元/kWh = ${(v * 1000).toFixed(1)} 元/MWh`);
});

console.log('\n══════ 五、送出省输电价格 ══════\n');
Object.entries(extra.exportTariff || {}).forEach(([k, v]) => {
  if (k.startsWith('_')) return;
  console.log(`  ${k.padEnd(6)} ${v} 元/kWh = ${(v * 1000).toFixed(1)} 元/MWh`);
});

console.log('\n══════ 六、容量与线路长度覆盖 ══════\n');
// 容量与长度已并入 data/fixed-prices.json 的「专项工程」（唯一价格/数据源）；
// 旧版的 extra.capacities / extra.lengths 键早已不存在，读它会直接 TypeError（M27）。
const projects = prices.专项工程 || [];
const withCap = projects.filter((r) => r.额定容量 != null || r.实际输送能力 != null);
const withLen = projects.filter((r) => r.线路长度 != null);
console.log(`  专项工程 ${projects.length} 条：有容量 ${withCap.length} 条｜有线路长度 ${withLen.length} 条`);
console.log(`  构建产物中容量为 null 的通道：${(html.match(/"cap":null/g) || []).length} 条`);
const noCapSrc = withCap.filter((r) => !r.容量来源);
if (noCapSrc.length) {
  warn.push(`${noCapSrc.length} 条专项工程有容量但未登记「容量来源」：`
    + noCapSrc.slice(0, 5).map((r) => r.名称).join('、') + (noCapSrc.length > 5 ? ' 等' : ''));
}

console.log('\n══════ 七、发现的问题汇总 ══════\n');
if (!issues.length) console.log('  ✅ 未发现单位换算不一致');
else issues.forEach(s => console.log('  ❌ ' + s));
if (warn.length) { console.log('\n  需注意：'); warn.forEach(s => console.log('  ⚠ ' + s)); }
// 硬性问题（单位换算不一致）非 0 即失败，供 release.mjs 作为发版前置门禁；提示项不阻断发版。
console.log(`\n审计结论：硬性问题 ${issues.length} 项，提示 ${warn.length} 项。`);
process.exit(issues.length ? 1 : 0);
