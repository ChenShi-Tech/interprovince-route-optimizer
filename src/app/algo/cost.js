/* 成本计算：单段费用、单条路径的三口径计价与各项校验。
 *
 * 纯函数：所有外部数据经 env 传入，所有用户参数经 ctx 传入。
 *
 * 计价依据（原件见 docs/原始文件，编号为 S 号）：
 *   - S14《省间电力现货交易规则》(2026-04) 4.3.1：买方价格向卖方节点折算
 *       折算价 = 买方报价 × Π(1−ρ_r) − Σ_m [ Pt_m × Π_{r≤m}(1−ρ_r) ]
 *     换算到每交付 1 MWh：每段输电费 = 该段输电价 × 该段「段后」电量系数；买方为送端电量 1/Π(1−ρ) 付费。
 *   - S14 3.3.2：输电价格已包含网损的段，不再另行收取网损 → 该段在计费链里线损率按 0 计；本工具另按交易测算约定将区域共用交流接口的计费损耗设为 0。
 *   - S14 3.4.2(a)、7.3(c)：经营主体购电时统一计入买方节点所在区域电网的输电价格；
 *     S15 发改价格规〔2020〕1441号 第二条：通过区域电网共用网络交易的用户，购电价格应包括区域电网电量电价及损耗。
 *   - S01 发改价格〔2018〕1227号 第五条：购电价格 = 市场价 + 送出省输电价格 + 专项工程输电价格及损耗 + 落地省输配电价 + 基金附加。
 *   - S11 发改价格〔2026〕1077号 附件1 各省表注3：上网环节线损费用在输配电价外单列（受端省内）；
 *     注4：外送电送出省输电价格与送省外上网环节线损率（送端省内）。
 *   - S14 7.3(a)：卖方按交易电量承担送端省内系统运行费及线损费用 → 送端省内线损计入口径三（卖方），不计入买方落地价。
 *
 * env 契约（由 algo/solve.js 组装）：
 *   env.REGION_OF    省代码 → 区域电网名
 *   env.RG           区域电网名 → 电量电价（元/千瓦时）
 *   env.LOSS_OF      省代码 → { exportLoss, inLoss }（%，可为 null）
 *   env.SEC          输电断面定义数组
 *   env.includeRegion 是否计入区域电网费
 *   env.source       交易起点省代码（近似权重只在起点收送出省费）
 *   env.pGen         送端出清价（仅用于枚举排序的近似权重）
 *   env.geo          { lngLatOf, provLngLat }
 *
 * ctx 契约（用户输入）：
 *   pGen pDst pNet fund lossBearer qty hours includeDstCost
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
    +(fromCode===env.source?sendFeeOf(e, fromCode):0)+rho/100*env.pGen;
}

/** 对一条路径做精确计价。
 *
 *  两条系数链：
 *    物理链 sufP —— 用全部段的实际线损率，算功率、容量占用与物理损耗电量；
 *    计费链 sufT —— 「含输电环节线损」的段（incLoss）线损按 0 计（S14 3.3.2 不再另行收取），区域共用交流接口也按 0 计，其余段按已录入线损率。
 *  段前系数 = 1 / Π(该段及之后各段的通过率)，段后系数 = 1 / Π(之后各段的通过率)。
 *  每段输电费按「段后」电量计（S14 4.3.1），送出省段按其出口电量（= 本段入口电量）计。
 */
function evalPath(path, ctx, env){
  const edges=path.edges, nodes=path.nodes, n=edges.length;
  const sufP=new Array(n+1), sufT=new Array(n+1); sufP[n]=1; sufT[n]=1;
  for(let i=n-1;i>=0;i--){
    const l=(edges[i].loss||0)/100;
    sufP[i]=sufP[i+1]*(1-l);
    sufT[i]=sufT[i+1]*(1-billingLossOf(env,edges[i])/100);
  }
  const D=sufT[0], genQty=1/D, lossQty=genQty-1;   // 计费口径：买方为送端电量 1/D 付费
  const Dphys=sufP[0];
  const qty=ctx.qty, h=Math.max(ctx.hours,0.25);
  const toMW=q=>qty/h*q;
  const toMWh=q=>qty*q;
  const buyerRegion=env.REGION_OF[nodes[n]];
  const LOSS=env.LOSS_OF||{};
  // 区域共用网络按区域归集，不能把每个省间接口当成一个收费单元。
  // 买方区域在路径层面计一次；其它区域计在该区域最后一个共用网络接口的出口。
  const regionExit=new Map();
  if(env.includeRegion) edges.forEach((e,i)=>{
    const region=env.REGION_OF[nodes[i+1]];
    if(e.regional && region && region!==buyerRegion) regionExit.set(region,i);
  });

  let trans=0, regTransit=0, sendTotal=0, dist=0, segLossMwh=0, vsCount=0;
  // REQ-302：中长期占用——容量校验按 cap×(1−占用比例) 扣减（默认 0，不持久化）
  const occFactor=1-(ctx.occPct||0)/100;
  const vset=new Set(), tset=new Set(), rset=new Set([env.REGION_OF[nodes[0]]]), stset=new Set();
  const segs=edges.map((e,i)=>{
    const q=1/sufT[i], qOut=1/sufT[i+1];        // 计费链
    const qP=1/sufP[i], qOutP=1/sufP[i+1];      // 物理链
    const t=e.regional?0:tariffOf(e,nodes[i]);
    const sf0=i===0?sendFeeOf(e,nodes[i]):0;
    const fee=t*qOut;                           // S14 4.3.1：输电价 × 段后电量
    const sf=sf0*q;                             // 送出省段：出口电量 = 本段入口电量
    const rg=regionExit.get(env.REGION_OF[nodes[i+1]])===i ? regionRate(env,nodes[i+1])*qOut : 0;
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
  const regBuyer = env.includeRegion ? regionRate(env, nodes[n]) : 0;   // 买方区域电量电价 × 交付电量
  const regFee = regTransit + regBuyer;
  // S11 附件2 注1：区域电量电价不含线损。当前尚未核实适用于本期交易的区域网损率，
  // 必须随结果返回缺项；接口计费损耗为 0 不代表区域网损费用为 0。
  const regionLossMissing=[...new Set([
    ...(regBuyer>0?[buyerRegion]:[]),
    ...segs.filter(s=>s.rg>0).map(s=>env.REGION_OF[s.b]),
  ])];
  const g=ctx.lossBearer;
  const cGen=ctx.pGen, cLossBuyer=cGen*g*lossQty, cSend=sendTotal, cTrans=trans, cReg=regFee;
  const border=cGen+cLossBuyer+cSend+cTrans+cReg;                 // 送到受端省界的价格
  // 受端省内费用：省网输配电价、基金附加、上网环节线损费用（1077号附件1 注3，在输配电价外单列）。
  // 上网环节线损：用户拿到 1 MWh 需从省界买入 1/(1−ρ) MWh，费用 = 省界价 × ρ/(1−ρ)。
  const dst=ctx.includeDstCost!==false;
  const inLossPct=(LOSS[nodes[n]]||{}).inLoss;
  const cInLoss=(dst && inLossPct!=null) ? border*(inLossPct/100)/(1-inLossPct/100) : 0;
  const cNet=dst?ctx.pNet:0;
  const cFund=dst?ctx.fund:0;
  const landed=border+cInLoss+cNet+cFund;
  const netLossTotal=cGen*lossQty;
  const channelOnly=cSend+cTrans;   // 口径二：过网费 = 送端省内段 + 跨省通道费，不含网损、区域电网费与省网费用
  // 送端省内线损（1077号附件1 注4 送省外上网环节线损率）由卖方承担（S14 7.3(a)）：每交付 1 MWh 卖方多发 q0·ρx/(1−ρx)
  const exportLossPct=(LOSS[nodes[0]]||{}).exportLoss;
  const exportLossQty=exportLossPct!=null ? (1/sufT[0])*(exportLossPct/100)/(1-exportLossPct/100) : 0;
  const cExportLoss=cGen*exportLossQty;
  const senderNet=ctx.pDst*D-(cSend+cTrans+cReg)*D-netLossTotal*(1-g)*D-cExportLoss*D;
  const deliverMW=qty/h;
  const segLd=segs.map(s=>({name:s.e.n,mw:s.inMW,cap:s.e.cap,effCap:s.e.cap?s.e.cap*occFactor:null,over:s.e.cap? s.inMW>s.e.cap*occFactor : false}));
  const maxLoad=Math.max(...segLd.map(s=>s.cap&&occFactor?s.mw/(s.cap*occFactor):0));
  const overSeg=segLd.filter(s=>s.over);
  // 断面校验：同一断面内各段入口功率之和与该断面限额比对
  const secHits=[];
  for(const sec of env.SEC){
    if(!sec.edges||!sec.edges.length) continue;
    const inSec=segs.filter(s=>sec.edges.some(k=>s.e.n.includes(k)||s.e.fn.includes(k)));
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
    gen:ctx.pGen*qty,
    send:qty*sendTotal,
    trans:qty*trans,
    reg:qty*regFee,
    loss:ctx.pGen*lossMwh*g,
    inLoss:cInLoss*qty,
    net:cNet*qty,
    fund:cFund*qty,
  };
  yuan.total=yuan.gen+yuan.send+yuan.trans+yuan.reg+yuan.loss+yuan.inLoss+yuan.net+yuan.fund;
  const tiers={gov:0,grid:0,region:0,est:0};
  edges.forEach(e=>{tiers[e.tier]=(tiers[e.tier]||0)+1;});
  const unverified=edges.filter(e=>e.tier!=='gov').length;

  return {nodes,edges,hops:n,D,Dphys,genQty,lossQty,trans,regFee,regBuyer,regTransit,segs,segLd,overSeg,maxLoad,secHits,secOver,feasible,
    detour:detourOf(nodes,edges,env.geo), landed, border, channelOnly, senderNet, yuan,
    qty, h, deliverMW, genMWh, lossMwh, genMWhPhys, lossMwhPhys, segLossMwh,
    inLossPct, exportLossPct, cExportLoss, exportLossQty,
    dist, straight, dcCount:vsCount, acCount:n-vsCount,
    kvList:[...vset].filter(Boolean), typeList:[...tset], regionList:[...rset].filter(Boolean),
    stationList:[...stset], tiers, unverified, buyerRegion, regionLossMissing,
    comp:{gen:cGen,loss:cLossBuyer,send:cSend,trans:cTrans,reg:cReg,inLoss:cInLoss,net:cNet,fund:cFund},
    capUnknown:edges.filter(e=>e.capBasis==='unknown').length,
    capEqUsed:edges.filter(e=>e.capEq!=null).length};
}
