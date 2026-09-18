import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const width of [390,1100,1440]){
  const page=await browser.newPage({viewport:{width,height:1000}});
  await page.route('**/map.qq.com/**',r=>r.abort());
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.BASE_URL||'http://127.0.0.1:8736');
  assert.equal(await page.locator('#i-dstcost').inputValue(),'0');
  assert.ok(await page.getByRole('button',{name:'省间现货 · 待拓展'}).isDisabled());
  await page.selectOption('#i-from','XJ');await page.selectOption('#i-to','SH');
  await page.selectOption('#i-hops','3');await page.selectOption('#i-dstcost','0');
  const select=()=>page.evaluate(()=>{const i=state._res.rows.findIndex(r=>r.edges.map(e=>e.n).join(',')==='吉泉直流,皖苏联络线,苏沪联络线');if(i<0)throw Error('missing path');state.sel=i;renderCalc();});
  await select();assert.match(await page.locator('#region-comparison').innerText(),/393\.15/);
  await page.selectOption('#i-regionloss','historical');await select();
  assert.match(await page.locator('.big').innerText(),/393\.2/);
  assert.match(await page.locator('#v-calc').innerText(),/第四周期继续适用性未核实/);
  await page.selectOption('#i-regionloss','custom');await page.locator('#i-rloss-华东').fill('2');await page.locator('#i-rloss-华东').press('Tab');await select();
  const result=await page.evaluate(()=>state._res.rows[state.sel].border);assert.ok(Math.abs(result-(((240+34.3)/.93+82.9)/.98+9.2))<1e-8);
  await page.locator('#i-rloss-华东').fill('100');await page.locator('#i-rloss-华东').press('Tab');assert.match(await page.locator('#v-calc').innerText(),/网损率须为/);
  await page.locator('#i-rloss-华东').fill('1.59');await page.locator('#i-rloss-华东').press('Tab');await select();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出报告',exact:true}).click();const d=await download;
  const report=fs.readFileSync(await d.path(),'utf8');assert.match(report,/393\.1511/);assert.match(report,/用户输入假设/);assert.match(report,/华东财务/);
  await page.selectOption('#i-regionloss','historical');await select();
  await page.selectOption('#i-sourcequote','export');await select();
  assert.ok(Math.abs(await page.evaluate(()=>state._res.rows[state.sel].border)-(240/.93+82.9)/.9841-9.2)<1e-8);
  assert.ok(await page.locator('#i-originloss').isDisabled());
  await page.selectOption('#i-sourcequote','plant');await page.selectOption('#i-originloss','separate');await select();
  assert.ok(await page.evaluate(()=>state._res.rows[state.sel].comp.originLoss>0));
  await page.selectOption('#i-originloss','included');await select();
  const sw=await page.evaluate(()=>document.documentElement.scrollWidth);assert.ok(sw<=width+1,`overflow ${sw}/${width}`);
  await page.screenshot({path:`/tmp/iproute-model-audit/model-${width}.png`,fullPage:true});
  assert.deepEqual(errors,[]);
  await page.locator('#i-pgen').fill('375');await page.locator('#i-pgen').press('Tab');
  await page.locator('#i-pdst').fill('560');await page.locator('#i-pdst').press('Tab');
  await page.selectOption('#i-from','SC');await page.selectOption('#i-to','JS');
  assert.equal(await page.locator('#i-pgen').inputValue(),'375');assert.equal(await page.locator('#i-pdst').inputValue(),'560');
  await page.reload();assert.equal(await page.locator('#i-pgen').inputValue(),'375');assert.equal(await page.locator('#i-pdst').inputValue(),'560');
  // Negative price still leaves at least the cheapest route visible.
  await page.locator('#i-pgen').fill('-1000');await page.locator('#i-pgen').press('Tab');assert.ok(await page.locator('.rc').count()>0);
  // Date control catches unimplemented historical tariffs.
  await page.locator('#i-date').fill('2026-07-31');await page.locator('#i-date').press('Tab');assert.match(await page.locator('#v-calc').innerText(),/尚未收录此前完整历史费率/);
  await page.close();console.log(`✅ ${width}px：双情景、手填值、非法损耗、负价、日期、导出与布局`);
 }
}finally{await browser.close();}
