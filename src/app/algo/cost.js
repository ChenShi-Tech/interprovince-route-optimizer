/* 中长期交付成本模型，纯函数。以合同报价边界和公开价格为输入。
 * 送出省费仅在起点且报价未含时计一次，区域共用接口不独立收费/逐段计损。
 * 独立工程费用按出口电量折算（1490号附件4第十八条）；通过率连乘。
 * S14现货规则4.3.1仅用于交叉验证数学折算，不把其结算条款套用于中长期。
 * 区域电量价取1077号附件2（不含网损，容量分摊不另加）。区域适用范围待合同确认。
 * ctx.sourceQuote: plant/export；originLossMode: included/separate。
 * env.buyerRegionRequired: 公告是否要求专项工程落地后仍计受端区域。
 */

/** 某省所在区域电网的电量电价（元/兆瓦时）；区域无核定价（南方）时为 0。 */
function regionRate(env, code){
  const rt=env.REGION_OF[code];
  return rt ? (env.RG[rt]||0)*1000 : 0;   // 元/kWh → 元/MWh
}

/** 段的输电价（元/兆瓦时），按实际行进方向取值。
 *  专项工程的核定价与方向无关；联络线按送出省输电价格口径计价，反向行进时送端省变了，取对侧省的 tRev。 */
function tariffOf(e, fromCode){
  return (e.bidir && fromCode===e.to && e.tRev!=null) ? e.tRev : e.t;
}

/** 交易起点的送出省价格（元/兆瓦时），只在路径首段计一次。
 *  regional 通道的 t/tRev 是送出省参考价，不是该接口的独立输电价。
 *  双向专项工程反向行进时取 sendFeeRev。 */
function sendFeeOf(e, fromCode){
  if(e.regional) return tariffOf(e, fromCode);
  return (e.bidir && fromCode===e.to && e.sendFeeRev!=null) ? e.sendFeeRev : (e.sendFee||0);
}

/** 区域共用交流网的接口是路径抽象，不把估算线损逐条计入交易报价。
 *  专项工程及背靠背直流仍按自身口径计费；物理链始终保留原线损供容量估算。 */
function billingLossOf(env, e){
  const region=env.REGION_OF[e.from];
  const pooled=e.regional && e.type==='AC' && region && region===env.REGION_OF[e.to];
  return (e.incLoss || pooled)?0:(e.loss||0);
}

/** 近似边权：只决定路径枚举的顺序，不参与最终计价。
 *  用线性近似把线损折成成本，避免用乘法项直接做最短路。
 *  送出省价格只在起点计入；区域费需按整条路径去重，留给精确计价。 */
function approxW(env, e, fromCode, toCode){
  const rho = billingLossOf(env,e);
  return (e.regional?0:tariffOf(e, fromCode))
    +(fromCode===env.source && env.sourceQuote!=='export'?(env.srcSendFee ?? sendFeeOf(e, fromCode)):0)+rho/100*env.pGen;
}

/** 对一条路径做精确计价。
 *
 *  两条系数链：
 *    物理链 sufP —— 用全部段已录入线损率（含估算），算功率、容量占用与物理损耗电量；
 *    计费链 sufT —— 「含输电环节线损」的段（incLoss）线损按 0 计（含损价格不重复计损），区域共用交流接口也按 0 计，其余段按已录入线损率。
 *  段前系数 = 1 / Π(该段及之后各段的通过率)，段后系数 = 1 / Π(之后各段的通过率)。
 *  每段输电费按「段后」电量计（按出口计量约定），送出省段按其出口电量（= 本段入口电量）计。
 */
function evalPath(path, ctx, env){
  const edges=path.edges, nodes=path.nodes, n=edges.length;
  const buyerRegion=env.REGION_OF[nodes[n]];
  const LOSS=env.LOSS_OF||{};
  const regionExit=new Map();
  if(env.includeRegion) edges.forEach((e,i)=>{
    const region=env.REGION_OF[nodes[i+1]];
    if(e.regional && region) regionExit.set(region,i);
  });
  if(env.includeRegion && buyerRegion && env.buyerRegionRequired!==false) regionExit.set(buyerRegion,n-1);
  // 一个区域收费单元一个网损环节；绝不把区域损耗复制到每个交流接口。
  const regionItems=[...regionExit].map(([region,index])=>{
    const source=(env.RLOSS||{})[region]||{};
    const mode=ctx.regionLossMode||'exclude';
    const raw=mode==='historical'?source.historicalPct
      :mode==='custom'?(ctx.regionLossRates||{})[region]
      :mode==='verified'?source.currentPct:null;
    const known=raw!=null && Number.isFinite(raw) && raw>=0 && raw<100;
    return {region,index,rate:(env.RG[region]||0)*1000,pct:known?raw:0,
      status:known?(mode==='verified'?'verified':mode):'missing',source};
  });
  const after=Array(n).fill(1);
  regionItems.forEach(r=>{after[r.index]*=1-r.pct/100;});
  const sufP=new Array(n+1), sufT=new Array(n+1); sufP[n]=1; sufT[n]=1;
  for(let i=n-1;i>=0;i--){
    sufP[i]=sufP[i+1]*(1-(edges[i].loss||0)/100);
    sufT[i]=sufT[i+1]*after[i]*(1-billingLossOf(env,edges[i])/100);
  }
  const D=sufT[0], genQty=1/D, lossQty=genQty-1;
  const Dphys=sufP[0];
  const qty=ctx.qty, h=ctx.hours;
  // qty 始终是买方省间节点交付电量；到户价另以 consumerQty 作为金额基数。
  const toMW=q=>qty/h*q;
  const toMWh=q=>qty*q;
  regionItems.forEach(r=>{
    r.qOut=1/sufT[r.index+1]; r.qIn=r.qOut/(1-r.pct/100);
    r.fee=r.rate*r.qOut; r.lossMwh=qty*(r.qIn-r.qOut);
  });

  let trans=0, regTransit=0, sendTotal=0, dist=0, segLossMwh=0, vsCount=0;
  // REQ-302：中长期占用——容量校验按 cap×(1−占用比例) 扣减（默认 0，不持久化）
  const occFactor=1-(ctx.occPct||0)/100;
  const vset=new Set(), tset=new Set(), rset=new Set([env.REGION_OF[nodes[0]]]), stset=new Set();
  const segs=edges.map((e,i)=>{
    const q=1/sufT[i], qOut=1/(sufT[i+1]*after[i]);        // 计费链
    const qP=1/sufP[i], qOutP=1/sufP[i+1];      // 物理链
    const t=e.regional?0:tariffOf(e,nodes[i]);
    // 送端电站专属送出价（1077号附件1 川滇等表注4 对特定电站 / 额度另定）：用户选定时覆盖通用送出价
    const sf0=i===0 && ctx.sourceQuote!=='export'?(ctx.srcSendFee ?? sendFeeOf(e,nodes[i])):0;
    const fee=t*qOut;                           // S14 4.3.1：输电价 × 段后电量
    const sf=sf0*q;                             // 送出省段：出口电量 = 本段入口电量
    const rg=regionItems.filter(r=>r.index===i && r.region!==buyerRegion).reduce((a,r)=>a+r.fee,0);
    trans+=fee; regTransit+=rg; sendTotal+=sf;
    const a=env.geo.lngLatOf(e,'from'), b=env.geo.lngLatOf(e,'to');
    const crow=havKm(a,b);
    const km=e.lenKm||crow;
    const lossMwh=toMWh(qP-qOutP);
    segLossMwh+=lossMwh; dist+=km;
    vset.add(e.kv); tset.add(e.type); rset.add(env.REGION_OF[nodes[i+1]]);
    if(e.stFrom) stset.add(e.stFrom); if(e.stTo) stset.add(e.stTo);
    if(e.type==='DC') vsCount++;
    return {
      e,t,sf0,q,qOut,qP,qOutP,fee,rg,sf,a:nodes[i],b:nodes[i+1],
      billLossPct:billingLossOf(env,e),
      km, crow, kmEst:!e.lenKm,
      inMW:toMW(qP), outMW:toMW(qOutP), lossMW:toMW(qP-qOutP),
      inMWh:toMWh(qP), outMWh:toMWh(qOutP), lossMwh,
      billLossMwh:toMWh(q-qOut),
      lossCost:toMWh(q-qOut)*ctx.pGen,
      feeYuan:qty*fee, rgYuan:qty*rg, sfYuan:qty*sf,
      util:e.cap? toMW(qP)/(e.cap*occFactor) : null,
      headroom:e.cap? e.cap*occFactor-toMW(qP) : null,
    };
  });
  const regBuyer = regionItems.filter(r=>r.region===buyerRegion).reduce((a,r)=>a+r.fee,0);   // 买方区域电量电价 × 交付电量
  const regFee = regTransit + regBuyer;
  const regionLossMissing=regionItems.filter(r=>r.status==='missing').map(r=>r.region);
  const g=ctx.lossBearer;
  const cGen=ctx.pGen, cLossBuyer=cGen*g*lossQty, cSend=sendTotal, cTrans=trans, cReg=regFee;
  const exportLossPct=ctx.srcExportLossPct ?? (LOSS[nodes[0]]||{}).exportLoss;
  const exportLossQty=exportLossPct!=null ? genQty*(exportLossPct/100)/(1-exportLossPct/100) : 0;
  const cExportLoss=cGen*exportLossQty;
  const originSeparate=ctx.sourceQuote!=='export' && ctx.originLossMode==='separate';
  const cOriginLoss=originSeparate?cExportLoss:0;
  const border=cGen+cLossBuyer+cSend+cTrans+cReg+cOriginLoss;
  // 受端省内费用：省网输配电价、基金附加、上网环节线损费用（1077号附件1 注3，在输配电价外单列）。
  // 上网环节线损：用户拿到 1 MWh 需从省界买入 1/(1−ρ) MWh，费用 = 省界价 × ρ/(1−ρ)。
  const dst=ctx.includeDstCost!==false;
  // 受端电网主体可选（河北/冀北、蒙西/蒙东、陕西/榆林、深圳等分表，注3 线损率随主体不同）：给出时覆盖省默认值
  const inLossPct=ctx.dstInLossPct ?? (LOSS[nodes[n]]||{}).inLoss;
  const cInLoss=(dst && inLossPct!=null) ? border*(inLossPct/100)/(1-inLossPct/100) : 0;
  const cNet=dst?ctx.pNet:0;
  const cFund=dst?ctx.fund:0;
  // 到户扩展的两项用户侧费用（元/到户MWh，缺省 0）：两部制容（需）量电费按用户负荷假设分摊、系统运行费手填
  const cCap=dst?(ctx.dstCapFee||0):0;
  const cSysOp=dst?(ctx.dstSysOpFee||0):0;
  const landed=border+cInLoss+cNet+cFund+cCap+cSysOp;
  const consumerQty=dst && inLossPct!=null ? qty*(1-inLossPct/100) : qty;
  const amountQty=dst?consumerQty:qty;
  const channelOnly=cSend+cTrans;   // 口径二：过网费 = 送端省内段 + 跨省通道费，不含网损、区域电网费与省网费用
  // 以同一费用约定反求送端报价；不是现货边际价，也不是卖方利润。未给受端目标交付价时为 null。
  const quoteFactor=1+g*lossQty+(originSeparate?exportLossQty:0);
  const maxSourceQuote=ctx.pDst==null ? null : (ctx.pDst-cSend-cTrans-cReg)/quoteFactor;
  const senderNet=maxSourceQuote; // 保留旧字段名供排序/端侧兼容，新语义见数据契约。
  const deliverMW=qty/h;
  const segLd=segs.map(s=>({name:s.e.n,mw:s.inMW,cap:s.e.cap,effCap:s.e.cap?s.e.cap*occFactor:null,over:s.e.cap? s.inMW>s.e.cap*occFactor : false}));
  const maxLoad=Math.max(...segLd.map(s=>s.cap&&occFactor?s.mw/(s.cap*occFactor):0));
  const overSeg=segLd.filter(s=>s.over);
  // 断面校验：同一断面内各段入口功率之和与该断面限额比对
  const secHits=[];
  for(const sec of env.SEC){
    if(!sec.edges||!sec.edges.length) continue;
    const inSec=segs.filter(s=>sec.edges.some(k=>s.e.n.includes(k)||(s.e.fn||'').includes(k)));
    if(!inSec.length) continue;
    const tot=inSec.reduce((a,s)=>a+s.inMW,0);
    secHits.push({sec, mw:tot, over:tot>sec.limit, util:tot/sec.limit,
      members:inSec.map(s=>s.e.n)});
  }
  const secOver=secHits.filter(h=>h.over);
  const feasible=!overSeg.length && !secOver.length;

  const genMWh=toMWh(genQty), lossMwh=toMWh(lossQty);
  const genMWhPhys=toMWh(1/Dphys), lossMwhPhys=toMWh(1/Dphys-1);
  // 直线距离按实际行进方向取首段出发端与末段到达端
  const straight=havKm(sideOf(edges[0],nodes[0],env.geo), sideOf(edges[n-1],nodes[n],env.geo));
  const yuan={
    gen:cGen*amountQty, send:cSend*amountQty, trans:cTrans*amountQty,
    reg:cReg*amountQty, loss:cLossBuyer*amountQty,
    inLoss:cInLoss*amountQty, net:cNet*amountQty, fund:cFund*amountQty, originLoss:cOriginLoss*amountQty,
    cap:cCap*amountQty, sysOp:cSysOp*amountQty,
  };
  yuan.total=yuan.gen+yuan.send+yuan.trans+yuan.reg+yuan.loss+yuan.inLoss+yuan.net+yuan.fund+yuan.originLoss+yuan.cap+yuan.sysOp;
  const tiers={gov:0,grid:0,region:0,est:0};
  edges.forEach(e=>{tiers[e.tier]=(tiers[e.tier]||0)+1;});
  const unverified=edges.filter(e=>e.tier!=='gov').length;

  return {nodes,edges,hops:n,D,Dphys,genQty,lossQty,trans,regFee,regBuyer,regTransit,segs,segLd,overSeg,maxLoad,secHits,secOver,feasible,
    detour:detourOf(nodes,edges,env.geo), landed, border, channelOnly, senderNet, yuan,
    qty, h, consumerQty, amountQty, deliverMW, genMWh, lossMwh, genMWhPhys, lossMwhPhys, segLossMwh,
    inLossPct, exportLossPct, cExportLoss, exportLossQty, cOriginLoss, maxSourceQuote, quoteFactor,
    dist, straight, dcCount:vsCount, acCount:n-vsCount,
    kvList:[...vset].filter(Boolean), typeList:[...tset], regionList:[...rset].filter(Boolean),
    stationList:[...stset], tiers, unverified, buyerRegion, regionLossMissing, regionItems,
    priceComplete:regionItems.every(r=>r.status==='verified'),
    capacityStatus:overSeg.length || secOver.length ? 'exceeded' : 'unconfirmed',
    comp:{gen:cGen,loss:cLossBuyer,send:cSend,trans:cTrans,reg:cReg,inLoss:cInLoss,net:cNet,fund:cFund,originLoss:cOriginLoss,cap:cCap,sysOp:cSysOp},
    capUnknown:edges.filter(e=>e.cap==null || e.capBasis==='unknown' || e.capBasis==='estimate').length,
    capEqUsed:edges.filter(e=>e.capEq!=null).length};
}
