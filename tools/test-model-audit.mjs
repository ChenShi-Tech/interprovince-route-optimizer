#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const html=fs.readFileSync(new URL('index.html',root),'utf8');
const code=html.slice(html.lastIndexOf('<script>')+8,html.lastIndexOf('</script>')).split('/* ===== src/app/boot.js ===== */')[0];
const c=vm.createContext({console,localStorage:{getItem:()=>null}});vm.runInContext(code,c);
const {solve,evalPath,enumPaths,data,state}=vm.runInContext('({solve,evalPath,enumPaths,data:algoData(),state})',c);
let checks=0;
const ok=(v,m)=>{assert.ok(v,m);checks++;};
const near=(a,b,m)=>ok(Number.isFinite(a)&&Math.abs(a-b)<1e-7,`${m}: ${a} vs ${b}`);
const input={...state,from:'XJ',to:'SH',pGen:240,pDst:460,pNet:85.1,fund:29.115,qty:1000,hours:1,maxHops:3,maxDetour:9,includeDstCost:false,showBad:true,tradeDate:'2026-09-17'};
const exact=res=>res.rows.find(r=>r.edges.map(e=>e.n).join(',')==='吉泉直流,皖苏联络线,苏沪联络线');
const base=exact(solve(input,data)),hist=exact(solve({...input,regionLossMode:'historical'},data));
const B=(240+34.3)/.93+82.9+9.2;
ok(state.marketMode==='mlt'&&state.includeDstCost===false,'默认中长期省间节点交付');
ok(!!solve({...input,marketMode:'spot'},data).err,'现货入口尚未实现，不借中长期计算冒充');
const H=((240+34.3)/.93+82.9)/.9841+9.2;
near(base.border,B,'无区域损耗手算');near(hist.border,H,'含华东1.59%手算');
near(hist.D,.93*.9841,'区域损耗与吉泉通过率相乘一次');
near(hist.segs[0].fee,82.9/.9841,'区域网损影响吉泉落地计费电量');
near(hist.comp.send,34.3/(.93*.9841),'起点费用电量同步折算');
near(hist.regFee,9.2,'华东电量价不再被自身损耗放大');
near(hist.regionItems.reduce((v,r)=>v+r.lossMwh,0)+hist.segs.reduce((v,s)=>v+s.billLossMwh,0),hist.genMWh-hist.qty,'计费链电量守恒含区域环节');
ok(hist.priceComplete===false&&hist.pricingIssues.some(s=>s.includes('第三监管周期')),'历史不能被标为当前可结算');
const custom=exact(solve({...input,regionLossMode:'custom',regionLossRates:{华东:2}},data));
near(custom.border,((240+34.3)/.93+82.9)/.98+9.2,'自定义情景');
for(const sourceQuote of ['plant','export'])for(const originLossMode of ['included','separate'])for(const lossBearer of [0,.5,1]){
 const params={...input,sourceQuote,originLossMode,lossBearer,regionLossMode:'historical'};
 const q=exact(solve(params,data));
 near(exact(solve({...params,pGen:q.maxSourceQuote},data)).border,input.pDst,'中长期同边界反推送端报价闭合');
 if(sourceQuote==='export'){near(q.comp.send,0,'关口报价不再加送出省费');near(q.comp.originLoss,0,'关口报价不再加省内网损');}
}
const separate=exact(solve({...input,originLossMode:'separate'},data));
near(separate.border-B,240/.93*(data.PV.XJ.exportLoss/100)/(1-data.PV.XJ.exportLoss/100),'送端省内网损另计手算');
const directInput={...input,to:'AH',maxHops:1};
const direct=solve(directInput,data).rows[0],withBuyer=solve({...directInput,regionChargeMode:'buyer'},data).rows[0];
near(direct.regFee,0,'中长期直流直接落地不强套现货统一受端区域费');
near(withBuyer.regFee-direct.regFee,9.2,'交易公告要求时受端区域另计一次');
// 长三角2026中长期细则第36条的独立正反算：区域内纯交流路径。
const eastInput={...input,from:'AH',to:'SH',pGen:330,maxHops:2,regionLossMode:'historical'};
const east=solve(eastInput,data).rows.find(r=>r.edges.every(e=>e.regional&&e.type==='AC'));
near(east.border,(330+30)/.9841+9.2,'长三角第36条：区域出口价');
near(east.maxSourceQuote,(input.pDst-9.2)*.9841-30,'长三角第36条：上网报价反算');
const zero=exact(solve({...input,regionLossMode:'custom',regionLossRates:{华东:0}},data));
near(zero.border,B,'明确填0与基准数值相同');ok(zero.regionItems[0].status==='custom','明确0仍保留假设身份');
const missing=exact(solve({...input,regionLossMode:'custom',regionLossRates:{}},data));ok(missing.regionLossMissing.includes('华东'),'空值不伪装核定0');
const dst=exact(solve({...input,includeDstCost:true,regionLossMode:'historical'},data));
near(dst.consumerQty,1000*.9739,'省内交付电量口径');
near(dst.landed,H/.9739+85.1+29.115,'到户每MWh价格');
near(dst.yuan.total,H*1000+(85.1+29.115)*1000*.9739,'到户总金额独立手算');
near(dst.yuan.total/dst.consumerQty,dst.landed,'到户金额基数闭合');
// Independent reverse formula from rule 4.3.1: multiply prefix pass rates, then inverse.
for(const r of [base,hist,custom]){
 const stages=[{t:34.3,r:0},{t:82.9,r:.07},{t:9.2,r:r.regionItems[0].pct/100}];
 let d=1,priceCoe=0;for(const s of stages){d*=1-s.r;priceCoe+=s.t*d;}
 near(r.border*d-priceCoe,240,'正反折算闭合');
}
// Invalid API input must fail deterministically (negative spot prices remain legal as a scenario).
for(const patch of [{qty:0},{hours:0},{hours:.1},{pGen:NaN},{pDst:Infinity},{lossBearer:2},{maxHops:1.5},{occPct:100},{tradeDate:'2026-02-30'},{regionLossMode:'custom',regionLossRates:{华东:100}},{regionLossMode:'custom',regionLossRates:{华东:-1}}])ok(!!solve({...input,...patch},data).err,'非法输入拦截 '+JSON.stringify(patch));
const neg=exact(solve({...input,pGen:-1000},data));ok(Number.isFinite(neg.landed),'负电价测算不被拒绝');
ok(!!solve({...input,tradeDate:'2026-07-31'},data).err,'当前价库不能伪装历史费率');
ok(!!solve({...input,from:'QH',to:'XZ',includeDstCost:true,pNet:282.4,fund:0},data).err,'西藏未来费率不提前用');
ok(!solve({...input,from:'QH',to:'XZ',includeDstCost:true,pNet:282.4,fund:0,tradeDate:'2026-10-01'},data).err,'西藏适用日起允许缺项测算');
for(const loss of [100,-1,Infinity])ok(!!solve(input,{...data,CH:[{...data.CH[0],loss}]}).err,'坏数据损耗拦截');
// Exactly cap complete paths is not truncation.
const adj={A:[{to:'B',e:{id:'x'}}],B:[]};ok(!enumPaths(adj,'A','B',1,1,()=>0).hitCap,'恰好上限不误报截断');
const twice={A:[...adj.A,{to:'B',e:{id:'y'}}],B:[]};ok(enumPaths(twice,'A','B',1,1,()=>0).hitCap,'存在多一条时才截断');
// Inserting a zero-fee interface in an existing regional block must not change the invoice.
const path={nodes:['XJ','AH','SH'],edges:[base.edges[0],{...base.edges[1],to:'SH'}]};
const collapsed=evalPath(path,{...input,regionLossMode:'historical'},{...data,includeRegion:true,source:'XJ'});
near(collapsed.border,H,'区域接口拆合不改变区域费/区域损耗');
// All nationwide pairs, both scenarios: conservation, comparisons and classification.
let pairs=0,routes=0;
for(const from of Object.keys(data.PV))for(const to of Object.keys(data.PV)){
 if(from===to)continue;pairs++;
 const R=solve({...input,from,to,maxHops:6,maxDetour:4,regionLossMode:'historical'},data);
 if(R.err)continue;
 for(const r of R.rows){routes++;
  near(Object.values(r.comp).reduce((a,b)=>a+b,0),r.landed,'全国费用项闭合');
  near(r.yuan.total/r.amountQty,r.landed,'全国金额基数');
  near(r.segs.reduce((a,s)=>a+s.billLossMwh,0)+r.regionItems.reduce((a,s)=>a+s.lossMwh,0),r.genMWh-r.qty,'全国计费电量');
  ok(new Set(r.regionItems.map(x=>x.region)).size===r.regionItems.length,'区域不重复计费');
  ok(r.capacityStatus!=='confirmed','参考容量不伪装已安全校核');
  ok(r.regionScenarios.length===2,'同路径比较完整');
 }
}
console.log(`✅ 全模型独立核验 ${checks} 项；${pairs} 省对、${routes} 路径；新疆→上海 ${B.toFixed(4)} / ${H.toFixed(4)} 元/MWh`);
