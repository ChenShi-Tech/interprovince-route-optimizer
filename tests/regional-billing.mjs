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
  const select=()=>page.evaluate(()=>{
   const i=state._res.rows.findIndex(r=>r.nodes.join('>')==='XJ>AH>JS>SH');
   if(i<0)throw new Error('截图路径未找到');state.sel=i;renderCalc();
  });
  await select();
  const big=await page.locator('.big').first().innerText();assert.match(big,/387\.0/);
  assert.match(await page.locator('#v-calc').innerText(),/区域网损尚未计入：华东/);
  const network=page.locator('.region-network[data-region="华东"]');
  assert.equal(await network.count(),1);
  assert.match(await network.innerText(),/参考接口：皖苏联络线、苏沪联络线/);
  assert.match(await network.innerText(),/全路径合并计 1 次/);
  assert.match(await network.innerText(),/区域网损\s*未计入（缺项）/);
  assert.match(await network.innerText(),/区域电量价\s*9\.20 元\/MWh/);
  assert.equal(await page.locator('.region-charge').count(),1);
  assert.equal(await page.locator('.tl>.tl-node').count(),3); // 新疆、安徽、上海；江苏在区域网络内。
  assert.equal(await page.locator('.region-interfaces').evaluate(e=>e.open),false);
  assert.equal(await page.locator('.tl-seg-card:visible').count(),1); // 吉泉仍独立展示。
  assert.match(await page.locator('.route-explainer').innerText(),/不代表指定的物理送电路线/);
  const out=process.env.SCREENSHOT_DIR||'/tmp/iproute-region-display';fs.mkdirSync(out,{recursive:true});
  await page.locator('.route-timeline').screenshot({path:path.join(out,`regional-billing-${width}.png`)});
  await page.locator('.region-interfaces>summary').focus();
  await page.keyboard.press('Enter');
  const cards=page.locator('.tl-seg-card');assert.equal(await cards.count(),3);
  for(const i of [1,2]){
   const text=await cards.nth(i).innerText();
   assert.match(text,/单独通道费\s*0\.0 元\/MWh/);
   assert.match(text,/计费线损率\s*0\.00%/);
   assert.match(text,/不收过境省外送费/);
  }
  const geometry=await page.evaluate(()=>({vw:document.documentElement.clientWidth,sw:document.documentElement.scrollWidth,cards:[...document.querySelectorAll('.tl-seg-card,.region-network,.region-charge')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};})}));
  assert.ok(geometry.sw<=geometry.vw+1,JSON.stringify(geometry));
  assert.ok(geometry.cards.every(r=>r.width>0 && r.left>=0 && r.right<=width+1),JSON.stringify(geometry));
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'导出报告',exact:true}).click();
  const file=await download;
  const report=fs.readFileSync(await file.path(),'utf8');
  assert.match(report,/387\.0/);assert.match(report,/计费线损率 0\.00%/);assert.match(report,/不收过境省外送费/);
  assert.match(report,/区域网损尚未计入：华东/);
  await page.selectOption('#i-regionloss','historical');await select();
  assert.match(await network.innerText(),/1\.59%/);
  assert.match(await network.innerText(),/第三监管周期参考值/);
  assert.equal(await page.locator('.region-interfaces').evaluate(e=>e.open),true); // 重算不丢展开态。
  assert.match(await page.locator('.big').innerText(),/393\.2/);
  await page.selectOption('#i-regionloss','custom');await select();
  assert.match(await network.innerText(),/未计入（缺项）/);
  await page.locator('#i-rloss-华东').fill('0');await page.locator('#i-rloss-华东').press('Tab');await select();
  assert.match(await network.innerText(),/区域网损\s*0\.00%/);
  assert.match(await network.innerText(),/用户手填假设/);
  await page.selectOption('#i-region','0');await select();
  assert.match(await network.innerText(),/本情景未计入/);
  assert.doesNotMatch(await network.innerText(),/全路径合并计 1 次/);
  assert.match(await network.innerText(),/折合节点交付费用\s*—/);
  await page.selectOption('#i-region','1');await page.selectOption('#i-regionloss','exclude');await select();
  await page.evaluate(()=>{state.mapProvider='svg';go('map');});
  const mapText=await page.locator('#v-map').innerText();
  assert.match(mapText,/计费线损 0\.00%（物理估算 0\.90%）/);
  await page.evaluate(()=>go('calc'));
  assert.deepEqual(errors,[]);
  console.log(`✅ ${width}px：区域归集、折叠接口、网损情景与开关、费用不变、导出与布局通过`);
  await page.close();
 }
 // 用实际通道数据检查全国归属及展示边界，避免将独立交流工程或背靠背合并为免费接口。
 const page=await browser.newPage();
 await page.route('**/map.qq.com/**',route=>route.abort());
 await page.goto(process.env.BASE_URL||'http://127.0.0.1:8734/');
 const coverage=await page.evaluate(()=>{
  const assert=(v,message)=>{if(!v)throw Error(message);};
  const input={...state,includeDstCost:false,includeRegion:true,regionChargeMode:'network',regionLossMode:'exclude',maxHops:6,maxDetour:99,showBad:true,tradeDate:'2026-10-01',mustHave:[]};
  const render=(nodes,names,patch={})=>{
   const result=solve({...input,from:nodes[0],to:nodes.at(-1),...patch},{...algoData(),CH:CH.filter(e=>names.includes(e.n))});
   const r=result.rows?.find(r=>r.nodes.join('>')===nodes.join('>')&&r.edges.length===names.length);
   assert(r,'未找到测试路径 '+nodes.join('>')+' '+result.err);
   const before=JSON.stringify(r),doc=new DOMParser().parseFromString(renderRouteTimeline(r),'text/html');
   assert(JSON.stringify(r)===before,'展示不得修改计价结果');
   return {r,doc};
  };
  let paths=0;const regions=new Set();
  for(const e of CH){
   for(const nodes of [[e.from,e.to],...(e.bidir?[[e.to,e.from]]:[])]){
    const {doc}=render(nodes,[e.n]);
    const pooled=e.regional&&e.type==='AC'&&REGION_OF[e.from]&&REGION_OF[e.from]===REGION_OF[e.to];
    assert(doc.querySelectorAll('.region-seg').length===(pooled?1:0),e.n+' 归类错误');
    if(pooled){
     regions.add(REGION_OF[e.from]);
     assert(doc.querySelector('.region-connection>span').textContent.startsWith(N(nodes[0])),e.n+' 反向接入错误');
    }else assert(doc.querySelectorAll('.tl>.tl-seg>.tl-seg-card').length===1,e.n+' 独立工程必须保留');
    paths++;
   }
  }
  const repeated=render(['SC','CQ','HB','HN'],['川渝联络线','渝鄂联络线','鄂湘联络线'],{regionLossMode:'historical'});
  assert(repeated.doc.querySelectorAll('.region-seg').length===2,'背靠背应分隔两个交流区块');
  assert(repeated.doc.querySelectorAll('.region-charge').length===1,'同一区域分散区块仍只计一次');
  assert(repeated.doc.querySelector('a[href="#region-charge-华中"]'),'重复区域应指向同一计费卡');
  assert(repeated.doc.querySelector('.region-charge').textContent.includes(fmt(repeated.r.regionItems[0].fee,2)),'须使用求解器折合费用，不能直接使用原始费率');
  const south=render(['GX','GD'],['两广联络线']);
  assert(south.doc.querySelector('.region-charge').textContent.includes('区域电量价缺项'),'缺失区域价不得显示为已核定零价');
  const direct=render(['SC','SN'],['德宝直流'],{regionChargeMode:'buyer'});
  assert(direct.doc.querySelectorAll('.region-seg').length===0,'专项直流不可合并');
  assert(direct.doc.querySelector('.region-settlement').textContent.includes('西北'),'没有共用交流区块的区域费仍应显示');
  const reverse=render(['SH','JS','AH'],['苏沪联络线','皖苏联络线']);
  assert(reverse.doc.querySelectorAll('.region-seg').length===1,'反向连续接口应合并');
  assert(reverse.doc.querySelector('.region-connection').textContent.includes('上海区域接入'),'反向区域起点');
  const exceeded=render(['AH','JS','SH'],['皖苏联络线','苏沪联络线'],{qty:10000});
  assert(exceeded.doc.querySelector('.region-capacity.exceeded'),'折叠后仍须显示超容提示');
  return {paths,regions:[...regions]};
 });
 console.log(`✅ 全国显示边界：${coverage.paths} 个正反向工程/接口，${coverage.regions.join('、')}，重复区域、缺项、独立区域费、容量告警`);
 await page.close();
}finally{await browser.close();}
