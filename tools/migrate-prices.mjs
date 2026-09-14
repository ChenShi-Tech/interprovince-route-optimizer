#!/usr/bin/env node
/**
 * 一次性迁移：把所有「固定价格数据」从 src/extra.json 与 docs/tariff.json
 * 抽取归并到 data/fixed-prices.json，作为全应用唯一的价格数据来源。
 *
 * 迁移后：
 *   data/fixed-prices.json  ← 所有价格数值（改这个文件即可）
 *   src/extra.json          ← 仅保留站点、断面、经纬度、容量、长度等非价格数据
 *   docs/tariff.json        ← 保留为采集档案（含原文摘录），不再被构建读取
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extraPath = path.join(root, 'src/extra.json');
const tariffPath = path.join(root, 'docs/tariff.json');
const extra = JSON.parse(fs.readFileSync(extraPath, 'utf8'));
const tariff = JSON.parse(fs.readFileSync(tariffPath, 'utf8'));

// ── 省级参数 ──
const 省级参数 = {};
for (const [code, p] of Object.entries(extra.provinces)) {
  省级参数[code] = {
    省: p.n,
    出清价: p.clear,
    受端省网输配电价: p.net,
    政府性基金及附加: p.fund === null ? null : p.fund,
    来源: p.netSrc,
  };
}

// ── 专项工程 ──
const 专项工程 = tariff.map((r) => ({
  名称: r.name,
  别名: r.alias || [],
  送端: r.from_province,
  受端: r.to_province,
  类型: r.type,
  电压等级: r.voltage,
  输电价: r.tariff_cny_per_mwh,
  原文价格表述: r.tariff_raw,
  线损率: r.loss_rate_pct,
  含线损: r.includes_transmission_loss,
  含税: r.tax_included,
  计费口径: r.billing_basis,
  状态: r.status,
  生效日期: r.effective_from,
  地址: r.source.url,
  文号: r.source.doc_number,
  文件标题: r.source.doc_title,
  颁发机构: r.source.issuer,
  发布日期: r.source.publish_date,
  原文摘录: r.source.excerpt,
  文档版本: r.source.doc_version || null,
  调价历史: r.tariff_history || [],
  可信度: r.confidence,
  备注: r.note || '',
  出处问题: r.source_issue || null,
}));

const out = {
  '_说明': '本文件是本应用所有固定价格数据的唯一来源。修改后运行 `node tools/build.mjs` 生效。',
  '_单位': '输电价 / 输配电价 / 基金及附加 / 出清价 一律为 元/兆瓦时；线损率为 %；送出省输电价格与区域电网输电价格为 元/千瓦时（与官方文件原文一致）。',
  '_核实': '全部数值已于 2026-09-14 逐条核实。专项工程 49 条数值经发改委原文比对全部正确（含原文摘录可溯源）；省级输配电价取自发改价格〔2026〕1077号附件1；政府性基金及附加取自各省落实通知。详见 docs/费率核实报告.md。',
  '_注意': [
    '内蒙古、河北、陕西、广东四省在官方电价表中存在多主体：内蒙古分蒙西/蒙东，河北分河北/冀北，陕西分榆林/非榆林，广东与深圳分列。本文件按主要电网主体取值，已在来源中注明。',
    '西藏的政府性基金及附加官方未列分项，取 null。应用在选定西藏为受端时会显式告警。',
    '云霄直流、辛洹线为单一容量电价工程，无电量电价，输电价取 null 属正确口径。',
    '7 条报备价（吉泉、昭沂、金永、中衡、坤渝、庆东、宝合）无发改委核价文件，系国家电网行文报备。',
  ],
  省级参数,
  送出省输电价格: extra.exportTariff,
  区域电网输电价格: extra.regionGrid,
  区域电网分区: extra.regionOf,
  专项工程,
};

fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data/fixed-prices.json'), JSON.stringify(out, null, 2) + '\n');

console.log('✅ 已生成 data/fixed-prices.json');
console.log(`   省级参数 ${Object.keys(省级参数).length} 条`);
console.log(`   专项工程 ${专项工程.length} 条`);
console.log(`   送出省输电价格 ${Object.keys(extra.exportTariff).filter((k) => !k.startsWith('_')).length} 条`);
console.log(`   区域电网输电价格 ${Object.keys(extra.regionGrid).filter((k) => !k.startsWith('_')).length} 条`);
console.log(`   文件大小 ${(fs.statSync(path.join(root, 'data/fixed-prices.json')).size / 1024).toFixed(1)} KB`);
