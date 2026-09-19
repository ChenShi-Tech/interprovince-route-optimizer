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

/* ---- 到户辅助纯函数（可选，不属于 solve() 输入契约；界面与原生端均可按需复用）---- */

/** 两部制容（需）量电费按负荷假设折成元/MWh：月单价 × 12 ÷（8.76 × 负荷率）。
 *  tier 是 1077号附件1 的档位对象（月单价取 容量电价/需量电价 之一），capMode: 'none'|'demand'|'capacity'。
 *  返回 null 仅表示该档没有对应月单价（原表空白，界面显示「—」），与 0（不计入口径 / 负荷率未填）区分；
 *  ui/calc.js 的 dstCapFee() 包装本函数并把 null 归一为 0，保持历史行为不变。 */
function dstCapFeeOf(tier, capMode, loadFactorPct){
  if(!tier || !capMode || capMode==='none') return 0;
  const price=capMode==='capacity'?tier.容量电价:tier.需量电价;
  if(price==null) return null;
  const lf=+loadFactorPct;
  if(!(lf>0&&lf<=100)) return 0;
  return price*12/(8.76*lf/100);
}

/** 到户价分档对照表：主体 ent 全部「电压档 × 计价方式」组合，原表空白（null）的格子不列。
 *  行序按数据顺序（低电压→高电压），每档先单一制后两部制。
 *  curNet/curCap 是当前方案的受端输配电价与容（需）量单价（与 landed 同口径，受端电价已含线损的
 *  主体经 applyDstQtyLoss 改写后同样成立）。到户价(行) = landed − curNet − curCap + 该行输配电价 + 该行容需量折算；
 *  因此当输配电价未手改时，与当前所选档同行的 landed 与 r.landed 之差为 0（纯展示变换，不影响排序）。
 *  单一制行不计容（需）量，cap 恒为 0；两部制行经 dstCapFeeOf 折算，无月单价时为 null。 */
function dstTierTable(ent, landed, curNet, curCap, capMode, loadFactorPct){
  const rows=[];
  if(!ent || !Array.isArray(ent.档位)) return rows;
  const base=+landed-+(curNet||0)-+(curCap||0);
  for(const t of ent.档位){
    for(const billing of ['single','twopart']){
      const net=t[billing==='single'?'单一制':'两部制'];
      if(net==null) continue;
      const cap=billing==='twopart'?dstCapFeeOf(t, capMode, loadFactorPct):0;
      rows.push({档别:t.档别, billing, net, cap, landed:base+net+(cap||0)});
    }
  }
  return rows;
}

/** 受端用户组合（售电公司 / 电网代理购电 / 多受电点，中长期规则第四条、第十二条）：按电量占比加权。
 *  rows 每项 {tier:档别名, billing:'single'|'twopart', share:电量占比百分数, lf:该行负荷率百分数|null}，
 *  capMode 是全局容（需）量口径（'none'|'demand'|'capacity'）。纯校验＋纯加权，界面只负责展示。
 *  校验（任一不满足 ok:false，err 具体到行）：至少一行；档别在主体价表内；计价方式该档有价；
 *  每行占比 (0,100]；同一「档 × 计价方式」不重复；合计＝100（±0.01，不自动按比例缩放）。
 *  两部制行在口径非「不计入」但负荷率未填：不算校验失败，该行容需量按 0 计，missingLf 计数供界面提示；
 *  该档没有对应月单价（dstCapFeeOf 为 null）同样按 0 计，计入 nullPrice。
 *  加权是线性的：把返回的 net/cap 当作 solve() 的 pNet/dstCapFee，与逐户分别计算再加权完全相等。
 *  hasTwoPart 供调用方决定 dstBilling；本函数不读写 solve() 的任何输入。 */
function dstMixTariff(ent, rows, capMode){
  if(!Array.isArray(rows) || !rows.length) return {ok:false, err:'用户组合至少要有一行电压档'};
  const tiers=ent && Array.isArray(ent.档位) ? ent.档位 : [];
  const seen=new Set(), out=[];
  let share=0, hasTwoPart=false, missingLf=0, nullPrice=0;
  for(let i=0;i<rows.length;i++){
    const raw=rows[i]||{}, billing=raw.billing==='single'?'single':'twopart';
    const tier=tiers.find(t=>t.档别===raw.tier);
    if(!tier) return {ok:false, err:`用户组合第 ${i+1} 行：电压档${raw.tier==null||raw.tier===''?'未选':'「'+raw.tier+'」'}不在当前电网主体的价表中（数据可能已更新），请重新选择`};
    if(tier[billing==='single'?'单一制':'两部制']==null)
      return {ok:false, err:`用户组合第 ${i+1} 行：${tier.档别}没有${billing==='single'?'单一制':'两部制'}价格`};
    const sh=+raw.share;
    if(!Number.isFinite(sh) || sh<=0 || sh>100)
      return {ok:false, err:`用户组合第 ${i+1} 行：电量占比须为大于 0、不超过 100 的数`};
    const key=tier.档别+'|'+billing;
    if(seen.has(key)) return {ok:false, err:`用户组合第 ${i+1} 行：${tier.档别} ${billing==='single'?'单一制':'两部制'} 重复出现，同一档同一计价方式只能有一行`};
    seen.add(key);
    const net=tier[billing==='single'?'单一制':'两部制'];
    let cap=0, lf=null;
    if(billing==='twopart'){
      hasTwoPart=true;
      if(capMode && capMode!=='none'){
        lf=+raw.lf;
        if(!(lf>0 && lf<=100)){ lf=null; missingLf++; }
        else{ const c=dstCapFeeOf(tier, capMode, lf); if(c==null) nullPrice++; else cap=c; }
      }
    }
    out.push({档别:tier.档别, billing, share:sh, net, cap, lf});
    share+=sh;
  }
  if(Math.abs(share-100)>0.01)
    return {ok:false, err:`用户组合的电量占比合计须为 100%（当前 ${Math.round(share*10)/10}%），请把各档占比配平，工具不会自动按比例缩放`, rows:out};
  return {
    ok:true,
    net:out.reduce((a,x)=>a+x.share/100*x.net,0),
    cap:out.reduce((a,x)=>a+x.share/100*x.cap,0),
    hasTwoPart, missingLf, nullPrice, rows:out,
  };
}
