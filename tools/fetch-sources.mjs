#!/usr/bin/env node
/**
 * 归档一手来源文件。
 *
 * 目的：费率数据的可核性依赖原文，而政府网站改版会导致链接失效。
 * 把 sources.md 引用的 S1~S13 抓取下来存入 docs/原始文件/，并生成索引。
 *
 * 用法：node tools/fetch-sources.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/原始文件');
fs.mkdirSync(outDir, { recursive: true });

// 与 docs/sources.md 的来源表一一对应
const SOURCES = [
  { id: 'S01', doc: '发改价格〔2018〕1227号', name: '关于核定部分跨省跨区专项工程输电价格有关问题的通知',
    urls: ['https://www.gov.cn/zhengce/zhengceku/2019-09/29/content_5435052.htm',
           'https://zfxxgk.ndrc.gov.cn/web/iteminfo.jsp?id=15527'],
    must: ['1227'] },
  { id: 'S02', doc: '发改价格〔2018〕684号', name: '关于核定酒泉—湖南、宁东—绍兴±800千伏特高压直流工程输电价格的通知',
    urls: ['https://zfxxgk.ndrc.gov.cn/web/iteminfo.jsp?id=14254'], must: ['684'] },
  { id: 'S03', doc: '发改价格〔2019〕842号', name: '关于降低一般工商业电价的通知（附件：跨省跨区专项工程输电价格）',
    urls: ['https://www.ndrc.gov.cn/xxgk/zcfb/tz/201905/t20190515_962447.html'], must: ['842'], havePdf: true },
  { id: 'S04', doc: '发改价格〔2021〕103号', name: '关于核定山西盂县电厂500千伏送出工程临时输电价格的通知',
    urls: ['https://www.ndrc.gov.cn/xxgk/zcfb/tz/202102/t20210201_1266593.html'], must: ['盂县'] },
  { id: 'S05', doc: '发改办价格〔2021〕958号', name: '关于陕北~湖北、雅中~江西特高压直流工程临时输电价格的通知',
    urls: ['https://www.ndrc.gov.cn/xwdt/tzgg/202112/t20211209_1307306.html'], must: ['雅中'] },
  { id: 'S06', doc: '发改价格〔2022〕558号', name: '关于核定宁绍、酒湖、锡泰特高压直流工程输电价格的通知',
    urls: ['https://www.ndrc.gov.cn/xwdt/tzgg/202204/t20220412_1321939.html'], must: ['锡泰'] },
  { id: 'S07', doc: '发改价格〔2022〕1604号', name: '关于闽粤联网工程临时价格的通知',
    urls: ['https://www.ndrc.gov.cn/xwdt/tzgg/202211/t20221102_1340733.html'], must: ['闽粤'] },
  { id: 'S08', doc: '发改价格〔2022〕1777号', name: '关于核定雁淮、扎青特高压直流工程输电价格的通知',
    urls: ['https://www.ndrc.gov.cn/xwdt/tzgg/202212/t20221206_1343328.html'], must: ['雁淮'] },
  { id: 'S09', doc: '发改价格〔2023〕404号', name: '关于白鹤滩~江苏、白鹤滩~浙江特高压直流工程和白鹤滩水电站配套送出工程临时输电价格的通知',
    urls: ['https://www.ndrc.gov.cn/xwdt/tzgg/202305/t20230515_1355752.html'], must: ['白鹤滩'] },
  { id: 'S10', doc: '发改体改〔2026〕734号', name: '关于在云霄直流开展输电权市场化交易的通知',
    urls: ['https://www.ndrc.gov.cn/xxgk/zcfb/tz/202606/t20260602_1405666.html'], must: ['云霄'] },
  { id: 'S11', doc: '发改价格〔2026〕1077号', name: '关于第四监管周期省级电网输配电价、区域电网输电价格及有关事项的通知',
    urls: ['https://www.ndrc.gov.cn/xxgk/zcfb/tz/202607/t20260710_1406431.html'], must: ['1077'] },
  { id: 'S12', doc: '发改价格规〔2021〕1455号', name: '跨省跨区专项工程输电价格定价办法',
    urls: ['https://www.gov.cn/gongbao/content/2022/content_5667310.htm'], must: ['1455'] },
  { id: 'S13', doc: '发改价格规〔2025〕1490号', name: '关于印发输配电定价成本监审办法等四个办法的通知',
    urls: ['https://www.ndrc.gov.cn/xxgk/zcfb/ghxwj/202511/t20251127_1401964_ext.html'], must: ['1490'] },
];

const clean = (s) => s.replace(/〔|〕/g, (m) => (m === '〔' ? '-' : ''));

const results = [];
for (const s of SOURCES) {
  const base = `${s.id}-${s.doc.replace(/[〔〕]/g, (m) => (m === '〔' ? '(' : ')')).replace(/[\/\\:*?"<>|]/g, '_')}`;
  let done = false;
  for (const url of s.urls) {
    if (done) break;
    const tmp = '/tmp/_fetch.bin';
    let code = '000', bytes = 0;
    try {
      const { execSync } = await import('node:child_process');
      execSync(`curl -sL --max-time 45 -o ${tmp} "${url}"`, { stdio: 'pipe' });
      const buf = fs.readFileSync(tmp);
      bytes = buf.length;
      const head = buf.slice(0, 400).toString('utf8');
      code = /<html|<!DOCTYPE/i.test(head) ? '200' : (buf.slice(0, 5).toString() === '%PDF-' ? '200/PDF' : '?');
      const text = buf.toString('utf8');
      const hit = s.must.every((m) => text.includes(m));
      if (!hit) { results.push({ ...s, url, status: `内容不符（未含 ${s.must.join('/')}）`, bytes }); continue; }
      const ext = buf.slice(0, 5).toString() === '%PDF-' ? 'pdf' : 'html';
      const file = `${base}.${ext}`;
      fs.writeFileSync(path.join(outDir, file), buf);
      results.push({ ...s, url, status: 'ok', bytes, file });
      done = true;
    } catch (e) {
      results.push({ ...s, url, status: '抓取失败：' + e.message.slice(0, 60), bytes });
    }
  }
  if (!done) { /* 失败已记录 */ }
}

console.log('归档结果：\n');
let okc = 0, failc = 0;
for (const r of results) {
  const mark = r.status === 'ok' ? '✅' : '❌';
  if (r.status === 'ok') okc++; else failc++;
  console.log(`  ${mark} ${r.id}  ${r.doc.padEnd(24)} ${(r.bytes / 1024).toFixed(0).padStart(4)} KB  ${r.status === 'ok' ? path.basename(r.file) : r.status}`);
}
console.log(`\n成功 ${okc} 份，失败 ${failc} 份`);
