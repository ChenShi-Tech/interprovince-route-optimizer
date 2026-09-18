#!/usr/bin/env node
/**
 * 走廊几何采集辅助（批次 B / design D4+D11，change: grid-map-p1-and-ux-fixes）。
 *
 * 数据流：候选池 tools/corridor-candidates.json（人工整理）
 *         → 逐条对照公开资料【人工审核】
 *         → 写入 src/extra.json 的 corridors 数组
 *         → node tools/build.mjs 兜底校验（缺来源/坐标非法即 build 失败）。
 *
 * 条目同构：{ id: 通道id, wp: [[lng,lat],...], src: 来源说明, url?: 链接 }
 *   - wp 为走廊中间点（WGS-84 两位小数），不含起止站；示意级精度，站址约束口径不变
 *   - status:'pending' 的条目视为待采集，校验时跳过
 *
 * 用法：
 *   node tools/corridor-collect.mjs check    校验 extra.json 已入库条目（CI/提交前自检）
 *   node tools/corridor-collect.mjs draft    校验候选池并报告待合并条目
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'shared/app-data.json'), 'utf8'));
const extra = JSON.parse(fs.readFileSync(path.join(root, 'src/extra.json'), 'utf8'));
const ids = new Set(data.CH.map(c => c.id));

function validate(list, label) {
  let bad = 0, pending = 0;
  for (const e of list) {
    if (e.status === 'pending') { pending++; console.log(`  ⏳ [${label}] ${e.id} 待采集`); continue; }
    if (!ids.has(e.id)) { bad++; console.log(`  ❌ [${label}] ${e.id} 通道 id 不存在`); continue; }
    if (!Array.isArray(e.wp) || !e.wp.length) { bad++; console.log(`  ❌ [${label}] ${e.id} 缺 wp（至少 1 个中间点）`); continue; }
    const badPt = e.wp.find(p => !Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90);
    if (badPt) { bad++; console.log(`  ❌ [${label}] ${e.id} 非法坐标 ${JSON.stringify(badPt)}`); continue; }
    if (!e.src || !String(e.src).trim()) { bad++; console.log(`  ❌ [${label}] ${e.id} 缺 src 来源字段（spec: 先审后上）`); continue; }
    console.log(`  ✅ [${label}] ${e.id}（${e.wp.length} 中间点）· ${String(e.src).slice(0, 36)}`);
  }
  return { bad, pending };
}

const mode = process.argv[2] || 'check';
if (mode === 'check') {
  const list = extra.corridors || [];
  console.log(`extra.json corridors 已入库：${list.length} 条`);
  const { bad } = validate(list, '已入库');
  console.log(bad ? `\n❌ ${bad} 条不合格` : '\n✅ 已入库条目全部合格');
  process.exit(bad ? 1 : 0);
} else if (mode === 'draft') {
  const cand = JSON.parse(fs.readFileSync(path.join(root, 'tools/corridor-candidates.json'), 'utf8'));
  const list = cand.candidates || [];
  console.log(`候选池：${list.length} 条`);
  const { bad, pending } = validate(list, '候选');
  const have = new Set((extra.corridors || []).map(e => e.id));
  const ready = list.filter(e => e.status !== 'pending' && !have.has(e.id));
  console.log(`\n审核通过且未入库：${ready.length} 条；待采集：${pending} 条；不合格：${bad} 条`);
  if (ready.length) {
    console.log('\n将以下条目人工誊入 src/extra.json 的 corridors 数组（或确认后由脚本合并）：');
    for (const e of ready) console.log(`  ${JSON.stringify(e)}`);
  }
  process.exit(bad ? 1 : 0);
} else {
  console.log('用法：node tools/corridor-collect.mjs check|draft');
  process.exit(2);
}
