#!/usr/bin/env node
// Read archived official PDF tables independently of build.js (requires pdftotext).
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const prices=JSON.parse(fs.readFileSync(new URL('data/fixed-prices.json',root),'utf8'));
const pdf='docs/原始文件/S11-附件1-省级电网输配电价表.pdf';
const text=execFileSync('pdftotext',['-layout',fileURLToPath(new URL(pdf,root)),'-'],{encoding:'utf8'});
const pages=text.split('\f');
const provinces=[];
for(const [code,p] of Object.entries(prices.省级参数)){
 const title=({NM:'蒙西',SN:'陕西电网（不含榆林地区）',HE:'河北'})[code]||p.省;
 const page=pages.find(t=>t.slice(0,150).includes(title));
 if(!page){provinces.push({code,status:'separate_source',note:'附件1无该主体，须另行核对自治区原文'});continue;}
 const tariff=[...page.split('注：')[0].matchAll(/0\.\d{4}/g)].map(v=>Number(v[0])*1000).at(-1);
 const value=re=>{const m=page.match(re);return m?Number(m[1]):null;};
 const published={net:tariff,inLoss:value(/省内上网环节线损率为\s*([\d.]+)%/),export:(value(/外送电送出省输电价格为每千瓦时\s*([\d.]+)\s*元/)??(page.includes('0.03 元')?.03:null))*1000,exportLoss:value(/送省外上网环节\s*线损率为\s*([\d.]+)%/)??(page.includes('不计线损')?0:null)};
 const stored={net:p.受端省网输配电价,inLoss:p.省内上网环节线损率,export:prices.送出省输电价格[code]*1000,exportLoss:p.送省外上网环节线损率};
 const reviewFields=Object.keys(published).filter(k=>published[k]==null||!Number.isFinite(stored[k])||Math.abs(published[k]-stored[k])>1e-6);
 provinces.push({code,table:title,status:reviewFields.length?'review':'match',published,stored,reviewFields});
}
const projectPdf='docs/原始文件/S03-附件-跨省跨区专项工程输电价格.pdf';
const pt=execFileSync('pdftotext',['-layout',fileURLToPath(new URL(projectPdf,root)),'-'],{encoding:'utf8'});
const names={'龙政线':'龙政','葛南线':'葛南','宜华线':'宜华','向上工程':'复奉','宾金工程':'宾金','晋南荆工程':'长南荆','哈郑直流':'天中','宁东直流':'银东','溪广线':'溪广'};
const projects=[];
for(const m of pt.matchAll(/^\s*(\d+)\s+(\S+)\s+[\d.]+\s+([\d.]+)\s+([\d.]+)%/gm)){
 const name=names[m[2]]||m[2];
 const p=prices.专项工程.find(p=>p.名称.includes(name)||(p.别名||[]).some(a=>a.includes(name)));
 if(!p){projects.push({name:m[2],status:'unmatched'});continue;}
 const published={tariff:Number(m[3]),loss:Number(m[4])};
 const stored={tariff:p.输电价??p.容量电价?.容量电价,loss:p.线损率};
 const newer=!String(p.文号).includes('842');
 projects.push({name:m[2],matched:p.名称,published,stored,status:newer?'superseded_separate_document':Object.keys(published).every(k=>published[k]===stored[k])?'match':'review',document:p.文号});
}
const report={checkedAt:'2026-09-17',source:'https://www.ndrc.gov.cn/xxgk/zcfb/tz/202607/P020260710613207914509.pdf',sourceLocal:pdf,sha256:crypto.createHash('sha256').update(fs.readFileSync(new URL(pdf,root))).digest('hex'),method:'独立解析PDF：29个主体默认高压两部制电量价、注3/注4四参数；另核842附件历史工程表。不认证基金/用户适用性或历史价格现行性。',provinces,projects};
fs.writeFileSync(new URL('docs/price-primary-audit.json',root),JSON.stringify(report,null,2)+'\n');
const issues=[...provinces,...projects].filter(p=>p.status==='review'||p.status==='unmatched');
console.log(JSON.stringify({provinceTables:provinces.filter(p=>p.status==='match').length,projects:projects.length,issues},null,2));
if(issues.length)process.exitCode=1;
