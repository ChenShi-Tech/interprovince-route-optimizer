#!/usr/bin/env node
/**
 * 把本轮核实得到的容量与计价方式写入 data/fixed-prices.json，
 * 并把容量/长度字段从 src/extra.json 迁出，使价格与容量数据集中在一个文件。
 *
 * 数据来源见 docs/改进计划.md §2。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fpPath = path.join(root, 'data/fixed-prices.json');
const exPath = path.join(root, 'src/extra.json');
const fp = JSON.parse(fs.readFileSync(fpPath, 'utf8'));
const ex = JSON.parse(fs.readFileSync(exPath, 'utf8'));

// 实际输送能力：核对过的最新公开数据，不沿用单一报告
const CAP = {
  锦苏: [7200, 'cap', '丰水期满功率运行（国网四川）'],
  复奉: [6400, 'cap', '满负荷运行（人民网）'],
  向上工程: [6400, 'cap', '满负荷运行（人民网）'],
  宾金: [8000, 'cap', '曾 8400 过负荷（国网四川）'],
  雅湖: [4600, 'cap', '2021 年大负荷值（国网江西电力）'],
  雅中: [4600, 'cap', '2021 年大负荷值（国网江西电力）'],
  建苏: [8000, 'cap', '分期投产已建成（中新网）'],
  '白鹤滩~江苏': [8000, 'cap', '分期投产已建成（中新网）'],
  金塘: [8000, 'cap', '满功率（新华社）'],
  '白鹤滩~浙江': [8000, 'cap', '满功率（新华社）'],
  灵绍: [6400, 'cap', '稳定极限（西安交大—世行 2018）'],
  祁韶: [4000, 'cap', '换相失败致风机端暂态压升（西安交大—世行 2018）'],
  酒湖: [4000, 'cap', '同上'],
  青豫: [null, 'unknown', '未获取 MW 值；夜间仅额定 10%、年利用 2000h vs 设计 4500h'],
  吉泉: [11000, 'cap', '连续 4 年最大功率（国网安徽）'],
  天中: [5400, 'cap', '受端电网接纳能力制约（西安交大—世行 2018）'],
  陕武: [5499, 'cap', '2026-06-02 峰值（湖北日报）'],
  '甘肃—浙江': [null, 'unknown', '2027 年投运，尚未投产'],
  庆东: [8000, 'cap', '2026-01-14 首次满功率（央广网）'],
  陇东: [8000, 'cap', '2026-01-14 首次满功率（央广网）'],
  中衡: [8000, 'cap', '2025-10 双极投产后（新华网）'],
  '宁夏—湖南': [8000, 'cap', '2025-10 双极投产后（新华网）'],
  金永: [4000, 'cap', '2025-09 具备 4000（新华网湖北）'],
  金上: [4000, 'cap', '2025-09 具备 4000（新华网湖北）'],
  坤渝: [6000, 'cap', '目前最大输送能力（兵团广电）'],
  '哈密—重庆': [6000, 'cap', '目前最大输送能力（兵团广电）'],
  宝合: [null, 'unknown', '2026-06-30 投运，实际值未获取'],
  锡泰: [8300, 'cap', '2026-03 新高（江苏省人民政府）'],
  昭沂: [5300, 'cap', '2021 年最大送受电（中国发展网）；2018 年为 4500'],
  扎青: [null, 'unknown', '配套电源未明确；2019 年受端仅组织约 5000'],
  鲁固: [null, 'unknown', '配套电源未明确'],
  雁淮: [8000, 'cap', '2022-07-14 首次满载'],
  云广: [null, 'unknown', '未获取'],
  昆柳龙: [8000, 'cap', '多次满负荷（人民网）'],
  高肇: [null, 'unknown', '未获取'],
  兴安: [3000, 'cap', '利用率常年南网第一（南方电网报）'],
  银东: [4000, 'cap', '负荷率 > 80%'],
  宁东: [4000, 'cap', '负荷率 > 80%'],
};

// 单一容量电价制工程（全量排查后确认仅此两条）
const CAPACITY_PRICE = {
  辛洹: { 容量电价: 40.0, 单位: '元/千瓦·年', 核价文号: '发改价格〔2018〕1227号' },
  云霄: { 容量电价: 115.0, 单位: '元/千瓦·年', 核价文号: '发改价格〔2022〕1604号' },
};

const findCap = (name) => {
  for (const [k, v] of Object.entries(CAP)) if (name.includes(k)) return v;
  return null;
};
const findLen = (name) => {
  for (const [k, v] of Object.entries(ex.lengths || {})) {
    if (k.startsWith('_')) continue;
    if (name.includes(k)) return v;
  }
  return null;
};
const findRated = (name) => {
  for (const [k, v] of Object.entries(ex.capacities || {})) {
    if (k.startsWith('_')) continue;
    if (name.includes(k)) return v;
  }
  return null;
};

let capHit = 0, capMiss = 0, cpCount = 0;
for (const r of fp.专项工程) {
  r.额定容量 = findRated(r.名称);
  r.线路长度 = findLen(r.名称);
  const c = findCap(r.名称);
  if (c) {
    r.实际输送能力 = c[0];
    r.容量口径 = c[1];
    r.容量来源 = c[2];
    if (c[0] != null) capHit++;
  } else {
    r.实际输送能力 = null;
    r.容量口径 = 'unknown';
    r.容量来源 = '未核实';
    capMiss++;
  }
  const cp = Object.entries(CAPACITY_PRICE).find(([k]) => r.名称.includes(k));
  if (cp) {
    r.计价方式 = 'capacity';
    r.容量电价 = cp[1];
    cpCount++;
  } else {
    r.计价方式 = 'energy';
  }
}

fp._容量说明 = [
  '「实际输送能力」为经核对的公开披露值，随运行方式与配套电源进度变化，非 ATC。',
  '「容量口径」：cap = 输送能力/最大输送功率；rated = 仅有额定容量；unknown = 未获取。',
  'ATC（可用输电能力，扣预留裕度后的商业可用值）公开渠道无法获取，全部通道均无该值。',
  '容量校验优先使用「实际输送能力」，缺失时回退「额定容量」并在界面标注结果偏乐观。',
  '「计价方式」：energy = 单一电量电价制；capacity = 单一容量电价制（边际输电成本不按电量计）。',
];

fs.writeFileSync(fpPath, JSON.stringify(fp, null, 2) + '\n');

// 从 extra.json 迁出容量与长度（已并入 fixed-prices.json）
const moved = {};
for (const k of ['capacities', 'lengths']) { moved[k] = ex[k]; delete ex[k]; }
ex._说明 = '本文件仅存非价格数据：站点、断面、经纬度、区域归属。价格、容量、线路长度见 data/fixed-prices.json。';
fs.writeFileSync(exPath, JSON.stringify(ex, null, 2) + '\n');

console.log('✅ 容量与计价方式已写入 data/fixed-prices.json');
console.log(`   实际输送能力：命中 ${capHit} 条，未核实 ${capMiss} 条`);
console.log(`   单一容量电价制工程：${cpCount} 条`);
console.log(`   容量/长度字段已从 src/extra.json 迁出并删除（capacities ${Object.keys(moved.capacities || {}).length} 项、lengths ${Object.keys(moved.lengths || {}).length} 项）`);
