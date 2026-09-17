#!/usr/bin/env node
// 独立手算 + 全网费用不变量；可选参数为修复前的 HTML，生成影响审计。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function engine(file){
  const html=fs.readFileSync(file,'utf8');
  const code=html.slice(html.lastIndexOf('<script>')+8,html.lastIndexOf('</script>'));
  const c=vm.createContext({console,localStorage:{getItem:()=>null}});
  vm.runInContext(code.split('/* ===== src/app/boot.js ===== */')[0],c);
  return vm.runInContext('({solve,evalPath,approxW,algoData,data:algoData(),state})',c);
}
const app=engine(path.join(root,'index.html'));
const before=process.argv[2]?engine(path.resolve(process.argv[2])):null;
const {data}=app;
let checks=0;
const near=(a,b,label)=>{assert.ok(Math.abs(a-b)<1e-8,`${label}: ${a} ≠ ${b}`);checks++;};
const yes=(v,label)=>{assert.ok(v,label);checks++;};
const env={...data,includeRegion:true,pGen:240,source:'XJ'};
const ctx={pGen:240,pDst:460,pNet:0,fund:0,lossBearer:1,qty:1000,hours:1,includeDstCost:false};
const edge=name=>data.CH.find(e=>e.n===name);
const xjPath={nodes:['XJ','AH','JS','SH'],edges:['吉泉直流','皖苏联络线','苏沪联络线'].map(edge)};
const xj=app.evalPath(xjPath,ctx,env);
// 手算常数独立于算法输出：吉泉 82.9、新疆送出 34.3，损耗 7%/0.9%/0.5%。
const d=.93, physicalD=.93*.991*.995;
const expected=240/d+34.3/d+82.9+9.2;
near(xj.border,expected,'新疆→上海省界价');
near(xj.comp.trans,82.9,'只计吉泉独立通道费');
near(xj.comp.send,34.3/d,'只计新疆送出省费用');
near(xj.comp.reg,9.2,'华东区域费一次');
yes(xj.regionLossMissing.length===1 && xj.regionLossMissing[0]==='华东','区域网损未核实时返回缺项，不冒充已知零');
near(xj.genMWhPhys,1000/physicalD,'物理送端估算电量');
near(xj.genMWh,1000/d,'计费送端电量仅补吉泉损耗');
yes(xj.segs.slice(1).every(s=>s.billLossPct===0 && s.billLossMwh===0),'华东内部计费损耗为零');
near(xj.segs.at(-1).outMW,1000,'上海实收功率');
yes(xj.segs.slice(1).every(s=>s.t===0 && s.fee===0 && s.sf===0),'两条过境接口无独立费用');
const noRegion=app.evalPath(xjPath,ctx,{...env,includeRegion:false});
near(xj.border-noRegion.border,9.2,'关闭区域费不重新启用接口费');
near(noRegion.Dphys,xj.Dphys,'区域费开关不影响物理损耗');
yes(noRegion.regionLossMissing.length===0,'排除区域费用后不声明已计区域费的网损缺项');
const full=app.evalPath(xjPath,{...ctx,includeDstCost:true,pNet:80,fund:20},env);
near(full.landed,xj.border/(1-data.LOSS_OF.SH.inLoss/100)+100,'完整落地价同步修正');
near(full.channelOnly,xj.channelOnly,'受端费用不影响过网费');
near(full.senderNet,xj.senderNet,'受端费用不影响卖方净收益');
for(const [a,b] of [['SC','CQ'],['CQ','SC']]){
  const e=edge('川渝联络线'),r=app.evalPath({nodes:[a,b],edges:[e]},ctx,env);
  near(r.comp.trans,0,'区域接口不作独立工程收费');
  near(r.segs[0].sf0,a===e.from?e.t:e.tRev,`${a}真实送出省价格及方向`);
}
// 合成同一区域内新增零损耗接口：只增加物理跳数，不改变交易费用。
const link=(from,to)=>({...edge('皖苏联络线'),from,to,loss:0,sendFee:0,t:30,tRev:30});
const geo={lngLatOf:()=>[100,30],provLngLat:()=>[100,30]};
const synthetic={...env,geo,REGION_OF:{A:'华东',B:'华东',C:'华东',D:'华中',E:'华东'},SEC:[],LOSS_OF:{}};
const direct=app.evalPath({nodes:['A','C'],edges:[link('A','C')]},ctx,synthetic);
const split=app.evalPath({nodes:['A','B','C'],edges:[link('A','B'),link('B','C')]},ctx,synthetic);
near(direct.border,split.border,'区域内拆分接口费用不变');
near(split.comp.send,30,'区域内纯联络线路径送出省费仅一次');
// 同一过境区域有多个接口，含再次进入该区域；都只计一个区域收费单元。
const bridge={...edge('吉泉直流'),from:'C',to:'D',loss:0,t:12,sendFee:50};
const transit=app.evalPath({nodes:['A','B','C','D'],edges:[link('A','B'),link('B','C'),bridge]},ctx,synthetic);
near(transit.comp.reg,9.2+25.6,'同一过境区域多接口不叠加');
near(transit.comp.send,30,'后续专项工程不重复收送出省价');
near(transit.comp.trans,12,'后续专项工程独立输电价保留');
const reentry=app.evalPath({nodes:['A','B','D','E','C'],edges:[link('A','B'),{...bridge,from:'B'},link('D','E'),link('E','C')]},ctx,{...synthetic,REGION_OF:{...synthetic.REGION_OF,C:'东北'}});
near(reentry.comp.reg,9.2+16.4,'重复进入区域仍只计一次');
near(app.approxW({...env,source:'XJ'},xjPath.edges[1],'AH','JS'),0,'过境共用交流接口排序权重无额外费用或计费损耗');
const backToBack=edge('渝鄂联络线');
near(app.evalPath({nodes:['CQ','HB'],edges:[backToBack]},ctx,env).D,1-backToBack.loss/100,'背靠背直流不误免计费损耗');

const audit={scope:{provinces:Object.keys(data.PV).length,pairs:0,routeEvaluations:0,profiles:[{maxHops:3,maxDetour:2},{maxHops:6,maxDetour:4}]},affectedPairs:0,affectedRoutes:0,regionalInterfaceOvercharge:0,repeatedSenderFee:0,repeatedTransitRegion:0,physicalComparisons:0,examples:[],screenshot:{old:null,new:xj.border,reduction:null,physicalLossMWh:xj.lossMwhPhys}};
const seenAffected=new Set(),seenRoutes=new Set();
for(const profile of audit.scope.profiles){
  for(const from of Object.keys(data.PV)) for(const to of Object.keys(data.PV)){
    if(from===to)continue;
    audit.scope.pairs++;
    const input={...app.state,...profile,regionChargeMode:'buyer',from,to,pGen:data.PV[from].clear,pDst:data.PV[to].clear,pNet:data.PV[to].net,fund:data.PV[to].fund,qty:1000,hours:1,includeRegion:true,includeDstCost:false,showAll:true,showBad:true,mustHave:[],tradableOnly:false,occPct:0};
    const res=app.solve(input,data);
    if(res.err)continue;
    for(const r of res.rows){
      audit.scope.routeEvaluations++;
      yes(r.segs.filter(s=>s.sf!==0).length<=1,'全网送出省费至多一次');
      yes(r.segs.every(s=>!s.e.regional || s.fee===0),'全网区域接口不作专项工程收费');
      const regions=r.segs.filter(s=>s.rg!==0).map(s=>data.REGION_OF[s.b]);
      yes(new Set(regions).size===regions.length && !regions.includes(data.REGION_OF[to]),'全网区域费去重');
      near(r.regBuyer,(data.RG[data.REGION_OF[to]]||0)*1000,'全网买方区域价');
      near(r.comp.trans,r.segs.filter(s=>!s.e.regional).reduce((v,s)=>v+(s.e.bidir && s.a===s.e.to && s.e.tRev!=null?s.e.tRev:s.e.t)*s.qOut,0),'全网独立工程输电费保留');
      for(const s of r.segs){
        const pooled=s.e.regional && s.e.type==='AC' && data.REGION_OF[s.a] && data.REGION_OF[s.a]===data.REGION_OF[s.b];
        if(pooled)near(s.billLossMwh,0,'全网区域共用交流接口计费网损为零');
        else near(s.billLossPct,s.e.incLoss?0:(s.e.loss||0),'专项工程及背靠背计费损耗保留');
      }
      near(Object.values(r.comp).reduce((a,b)=>a+b,0),r.landed,'费用分项闭合');
      near(r.yuan.total/r.qty,r.landed,'金额与单价闭合');
      near(r.segs.reduce((s,e)=>s+e.lossMwh,0),r.genMWhPhys-r.qty,'物理电量守恒');
      if(before){
        const old=before.evalPath({nodes:r.nodes,edges:r.edges},{...input}, {...before.data,includeRegion:true,pGen:input.pGen});
        for(const key of ['Dphys','dist','maxLoad','genMWhPhys','lossMwhPhys'])near(r[key],old[key],`物理指标不变 ${key}`);
        yes(r.feasible===old.feasible && JSON.stringify(r.segLd)===JSON.stringify(old.segLd) && JSON.stringify(r.secHits)===JSON.stringify(old.secHits),'容量及断面校验不变');
        audit.physicalComparisons++;
        const key=r.nodes.join('>')+':'+r.edges.map(e=>e.id).join(',');
        if(!seenRoutes.has(key) && Math.abs(old.border-r.border)>1e-8){
          seenRoutes.add(key);seenAffected.add(from+'>'+to);audit.affectedRoutes++;
          if(old.segs.some((s,i)=>i>0 && s.e.regional && s.fee>0))audit.regionalInterfaceOvercharge++;
          if(old.segs.some((s,i)=>i>0 && !s.e.regional && s.sf>0))audit.repeatedSenderFee++;
          const oldRegions=old.segs.filter(s=>s.rg>0).map(s=>data.REGION_OF[s.b]);
          if(new Set(oldRegions).size<oldRegions.length)audit.repeatedTransitRegion++;
          if(audit.examples.length<20)audit.examples.push({path:r.nodes.map(k=>data.PV[k].n).join('→'),before:old.border,after:r.border,reduction:old.border-r.border});
        }
      }
    }
    for(const [rows,key,dir] of [[res.byA,'landed',1],[res.byB,'channelOnly',1],[res.byC,'senderNet',-1]])yes(rows.every((r,i)=>!i || dir*(r[key]-rows[i-1][key])>=-1e-8),'三种口径按修正金额排序');
  }
}
audit.affectedPairs=seenAffected.size;
if(before){
  const old=before.evalPath(xjPath,ctx,{...before.data,includeRegion:true,pGen:240});
  audit.screenshot.old=old.border;audit.screenshot.reduction=old.border-xj.border;
  fs.writeFileSync(path.join(root,'docs/regional-billing-audit.json'),JSON.stringify(audit,null,2)+'\n');
  console.log(JSON.stringify(audit,null,2));
}
console.log(`✅ ${checks} 项通过；${audit.scope.provinces} 省、${audit.scope.pairs} 组省对/参数、${audit.scope.routeEvaluations} 条路径计算；新疆→上海 ${xj.border.toFixed(4)} 元/MWh`);
