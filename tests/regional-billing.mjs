import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=await chromium.launch({channel:process.env.BROWSER||'chrome',headless:true});
try{
 for(const width of [390,1100,1440]){
  const page=await browser.newPage({viewport:{width,height:1000}});
  // 本用例验收内置拓扑与费用显示，不加载需要 WorkBuddy 注入代理地址的腾讯 SDK。
  await page.route('**/map.qq.com/**',route=>route.abort());
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.BASE_URL||'http://127.0.0.1:8734/');
  await page.selectOption('#i-from','XJ');await page.selectOption('#i-to','SH');
  await page.selectOption('#i-hops','3');await page.selectOption('#i-dstcost','0');
  // 选择截图中的确切路径，不依赖修复后的价格排名。
  await page.evaluate(()=>{
   const i=state._res.rows.findIndex(r=>r.nodes.join('>')==='XJ>AH>JS>SH');
   if(i<0)throw new Error('截图路径未找到');state.sel=i;renderCalc();
  });
  const big=await page.locator('.big').first().innerText();assert.match(big,/387\.0/);
  assert.match(await page.locator('#v-calc').innerText(),/区域网损费用待补：华东/);
  const cards=page.locator('.tl-seg-card');assert.equal(await cards.count(),3);
  for(const i of [1,2]){
   const text=await cards.nth(i).innerText();
   assert.match(text,/单独通道费\s*0\.0 元\/MWh/);
   assert.match(text,/计费线损率\s*0\.00%/);
   assert.match(text,/不收过境省外送费/);
  }
  const geometry=await page.evaluate(()=>({vw:document.documentElement.clientWidth,sw:document.documentElement.scrollWidth,cards:[...document.querySelectorAll('.tl-seg-card')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};})}));
  assert.ok(geometry.sw<=geometry.vw+1,JSON.stringify(geometry));
  assert.ok(geometry.cards.every(r=>r.width>0 && r.left>=0 && r.right<=width+1),JSON.stringify(geometry));
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'导出报告',exact:true}).click();
  const file=await download;
  const report=fs.readFileSync(await file.path(),'utf8');
  assert.match(report,/387\.0/);assert.match(report,/计费线损率 0\.00%/);assert.match(report,/不收过境省外送费/);
  assert.match(report,/区域网损费用待补：华东/);
  await page.evaluate(()=>{state.mapProvider='svg';go('map');});
  const mapText=await page.locator('#v-map').innerText();
  assert.match(mapText,/计费线损 0\.00%（物理估算 0\.90%）/);
  await page.evaluate(()=>go('calc'));
  assert.deepEqual(errors,[]);
  const out=process.env.SCREENSHOT_DIR||'/tmp/iproute-regional-fix';fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:path.join(out,`regional-billing-${width}.png`),fullPage:true});
  console.log(`✅ ${width}px：省界价 387.0、两接口零收费/零计费损耗、导出报告和布局通过`);
  await page.close();
 }
}finally{await browser.close();}
