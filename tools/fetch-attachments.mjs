#!/usr/bin/env node
/**
 * 抓取各通知的 PDF 附件。
 * 价格表通常在附件里（正文只有「核定……输电价格」的表述），
 * 缺了附件就无法核对数值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/原始文件');

const JOBS = [
  { dir: 'https://www.ndrc.gov.cn/xxgk/zcfb/tz/201905/', file: 'W020190905514406056172.pdf',
    save: 'S03-附件-跨省跨区专项工程输电价格.pdf', note: '842号附件（已在库，重命名统一）' },
  { dir: 'https://www.ndrc.gov.cn/xxgk/zcfb/tz/202606/', file: 'P020260602591084142337.pdf',
    save: 'S10-附件-云霄直流输电权市场化交易.pdf', note: '734号附件' },
  { dir: 'https://www.ndrc.gov.cn/xxgk/zcfb/tz/202607/', file: 'P020260710613207914509.pdf',
    save: 'S11-附件1-省级电网输配电价表.pdf', note: '1077号附件1' },
  { dir: 'https://www.ndrc.gov.cn/xxgk/zcfb/tz/202607/', file: 'P020260710613208195785.pdf',
    save: 'S11-附件2-区域电网输电价格表.pdf', note: '1077号附件2' },
  { dir: 'https://www.ndrc.gov.cn/xxgk/zcfb/ghxwj/202511/', file: 'P020251127364890316760.pdf',
    save: 'S13-附件1.pdf', note: '1490号附件1' },
  { dir: 'https://www.ndrc.gov.cn/xxgk/zcfb/ghxwj/202511/', file: 'P020251127364890634572.pdf',
    save: 'S13-附件2.pdf', note: '1490号附件2' },
  { dir: 'https://www.ndrc.gov.cn/xxgk/zcfb/ghxwj/202511/', file: 'P020251127364890814190.pdf',
    save: 'S13-附件3.pdf', note: '1490号附件3' },
  { dir: 'https://www.ndrc.gov.cn/xxgk/zcfb/ghxwj/202511/', file: 'P020251127364890979771.pdf',
    save: 'S13-附件4.pdf', note: '1490号附件4' },
];

const strip = (b) => b.toString('latin1').replace(/[^\x20-\x7e\u00a0-\xff]/g, '');

console.log('抓取附件：\n');
let ok = 0, bad = 0;
for (const j of JOBS) {
  const url = j.dir + j.file;
  const tmp = '/tmp/_att.pdf';
  try {
    execSync(`curl -sL --max-time 60 -o ${tmp} "${url}"`, { stdio: 'pipe' });
    const buf = fs.readFileSync(tmp);
    const isPdf = buf.slice(0, 5).toString() === '%PDF-';
    if (!isPdf) { console.log(`  ❌ ${j.note} 非 PDF（${buf.length}B）`); bad++; continue; }
    const pages = (strip(buf).match(/\/Type\s*\/Page[^s]/g) || []).length;
    fs.writeFileSync(path.join(outDir, j.save), buf);
    console.log(`  ✅ ${j.note.padEnd(22)} ${(buf.length / 1024).toFixed(0).padStart(4)} KB  ${pages} 页  → ${j.save}`);
    ok++;
  } catch (e) {
    console.log(`  ❌ ${j.note} 失败：${e.message.slice(0, 60)}`); bad++;
  }
}
console.log(`\n成功 ${ok} 份，失败 ${bad} 份`);
