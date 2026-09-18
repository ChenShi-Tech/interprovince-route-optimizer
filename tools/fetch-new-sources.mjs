#!/usr/bin/env node
/**
 * 归档本轮新增的费率来源原件到 docs/原始文件/（纪律：来源可离线回溯）。
 *   2026-09-17 新增：
 *     S32 发改价格〔2019〕575号  滇西北送广东专项工程输电价格
 *     S33 发改价格〔2020〕1930号 昆柳龙直流工程及配套交流工程临时输电价格
 *     S34 海南电网代理购电工商业用户电价表（2026年8月）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'docs/原始文件');

const targets = [
  ['S32-发改价格(2019)575号-滇西北送广东输电价格.html',
    'https://www.ndrc.gov.cn/xxgk/zcfb/tz/201904/t20190402_962415.html'],
  ['S33-发改价格(2020)1930号-昆柳龙临时输电价格.html',
    'https://www.ndrc.gov.cn/xxgk/zcfb/tz/202012/t20201231_1261309.html'],
  ['S34-海南电网代理购电价格表(2026年8月).html',
    'https://energydc.cn/policy/hainan/2026-07/feff3e15-8bdb-11f1-b774-1a4b378581f8'],
];

let ok = 0;
for (const [name, url] of targets) {
  const out = path.join(dir, name);
  if (fs.existsSync(out)) { console.log('已存在，跳过', name); ok++; continue; }
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) { console.log('❌', r.status, name); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(out, buf);
    console.log('✅', name, (buf.length / 1024).toFixed(0) + ' KB');
    ok++;
  } catch (e) {
    console.log('❌', name, e.message);
  }
}
console.log(`\n归档 ${ok}/${targets.length}`);
