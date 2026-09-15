/* 成本计算：单段费用、单条路径的三口径计价与各项校验。
 *
 * 纯函数：所有外部数据经 env 传入，所有用户参数经 ctx 传入。
 *
 * env 契约（由 algo/solve.js 组装）：
 *   env.REGION_OF    省代码 → 区域电网名
 *   env.RG           区域电网名 → 电量电价（元/千瓦时）
 *   env.SEC          输电断面定义数组
 *   env.includeRegion 是否计入区域电网费
 *   env.pGen         送端出清价（仅用于枚举排序的近似权重）
 *   env.geo          { lngLatOf, provLngLat }
 *
 * ctx 契约（用户输入）：
 *   pGen pDst pNet fund lossBearer qty hours includeDstCost
 */

/** 区域电网输电费（元/兆瓦时）。
 *
 *  只对省间联络线段（e.regional=true，即经区域共用交流网络输送的段）计收，取到达省所在区域的
 *  电量电价；专项工程段不收。依据：
 *   - 发改价格〔2018〕1227号第五条：经专项工程交易的购电价格 = 市场交易价格 + 送出省输电价格
 *     + 专项工程输电价格及损耗 + 落地省省级电网输配电价 + 政府性基金及附加，其中没有区域电网费；
 *   - 发改价格规〔2025〕1490号附件3第二条、第十一条：区域电网输电价格是运营「区域共用输电网络」的
 *     价格，电量电费随区域电网实际交易结算电量向购电方收取。
 *  跨区联络线（如川陕、晋陕）取到达区域的价格是本工具的口径假设，办法本身未明确。
 *
 *  ⚠️ toCode 必须是「实际行进方向」的到达节点：联络线可双向通行，存储方向与行进方向可能相反。
 */
function regionFee(env, e, toCode){
  if(!env.includeRegion || !e.regional) return 0;
  const rt=env.REGION_OF[toCode];
  if(!rt) return 0;
  return (env.RG[rt]||0)*1000;             // 元/kWh → 元/MWh
}

/** 段的输电价（元/兆瓦时），按实际行进方向取值。
 *  联络线按送出省输电价格口径计价，反向行进时送端省变了，须取对侧省的送出省价格 tRev。 */
function tariffOf(e, fromCode){
  return (e.bidir && fromCode===e.to && e.tRev!=null) ? e.tRev : e.t;
}

/** 近似边权：只决定路径枚举的顺序，不参与最终计价。
 *  用线性近似把线损折成成本，避免用乘法项直接做最短路。 */
function approxW(env, e, fromCode, toCode){
  return tariffOf(e, fromCode)+(e.sendFee||0)+(e.loss||0)/100*env.pGen+regionFee(env, e, toCode);
}

/** 对一条路径做精确计价。
 *
 *  网损是乘法项：多段串联时送达系数 D = Π(1−ηᵢ)，因此不能把线损直接当边权累加。
 *  段前系数 = 1 / Π(该段及之后各段的通过率)：越靠送端的段，承担的电量与损耗越多。
 */
function evalPath(path, ctx, env){
  const edges=path.edges, nodes=path.nodes, n=edges.length;
  const suf=new Array(n+1); suf[n]=1;
  for(let i=n-1;i>=0;i--) suf[i]=suf[i+1]*(1-(edges[i].loss||0)/100);
  const D=suf[0], genQty=1/D, lossQty=genQty-1;
  const qty=ctx.qty, h=Math.max(ctx.hours,0.25);
  const toMW=q=>qty/h*q;
  const toMWh=q=>qty*q;

  let trans=0, regFee=0, sendTotal=0, dist=0, segLossMwh=0, vsCount=0;
  const vset=new Set(), tset=new Set(), rset=new Set([env.REGION_OF[nodes[0]]]), stset=new Set();
  const segs=edges.map((e,i)=>{
    const q=1/suf[i], qOut=1/suf[i+1];
    const t=tariffOf(e,nodes[i]);
    // 输电费的计量电量：
    //   「含输电环节线损」的专项工程价（incLoss）按落地端结算电量计——1490号附件4第九条
    //   输电价格 = 年均收入 ÷（设计输电量 ×（1−定价线损率）），第十八条按落地端结算电量确认，
    //   线损已折入单价，再按段前电量计会把线损放大两次；
    //   其余（不含线损的存量核定价、送出省输电价格口径）按段前电量计。
    const fee=t*(e.incLoss?qOut:q), rg=regionFee(env,e,nodes[i+1])*q, sf=(e.sendFee||0)*q;
    trans+=fee; regFee+=rg; sendTotal+=sf;
    const a=env.geo.lngLatOf(e,'from'), b=env.geo.lngLatOf(e,'to');
    const crow=havKm(a,b);
    const km=e.lenKm||crow;
    const lossMwh=toMWh(q-qOut);
    segLossMwh+=lossMwh; dist+=km;
    vset.add(e.kv); tset.add(e.type); rset.add(env.REGION_OF[nodes[i+1]]);
    if(e.stFrom) stset.add(e.stFrom); if(e.stTo) stset.add(e.stTo);
    if(e.type==='DC') vsCount++;
    return {
      e,t,q,qOut,fee,rg,sf,a:nodes[i],b:nodes[i+1],
      km, crow, kmEst:!e.lenKm,
      inMW:toMW(q), outMW:toMW(qOut), lossMW:toMW(q-qOut),
      inMWh:toMWh(q), outMWh:toMWh(qOut), lossMwh,
      lossCost:lossMwh*ctx.pGen,
      feeYuan:qty*fee, rgYuan:qty*rg,
      util:e.cap? toMW(q)/e.cap : null,
      headroom:e.cap? e.cap-toMW(q) : null,
    };
  });
  const g=ctx.lossBearer;
  // 可选口径：不计入受端省内费用（省网输配电价与政府性基金及附加），
  // 即只算到受端省界，用于与「送到省界」的口径对齐。
  const cNet=ctx.includeDstCost===false?0:ctx.pNet;
  const cFund=ctx.includeDstCost===false?0:ctx.fund;
  const cGen=ctx.pGen, cLossBuyer=cGen*g*lossQty, cSend=sendTotal, cTrans=trans, cReg=regFee;
  const landed=cGen+cLossBuyer+cSend+cTrans+cReg+cNet+cFund;
  const netLossTotal=cGen*lossQty;
  const channelOnly=cSend+cTrans;   // 口径二：过网费 = 送端省内段 + 跨省通道费，不含网损与省网费用
  const senderNet=ctx.pDst*D-(cSend+cTrans+cReg)*D-netLossTotal*(1-g)*D;
  const deliverMW=qty/h;
  const segLd=segs.map(s=>({name:s.e.n,mw:s.inMW,cap:s.e.cap,over:s.e.cap? s.inMW>s.e.cap : false}));
  const maxLoad=Math.max(...segLd.map(s=>s.cap?s.mw/s.cap:0));
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
  // 直线距离按实际行进方向取首段出发端与末段到达端
  const straight=havKm(sideOf(edges[0],nodes[0],env.geo), sideOf(edges[n-1],nodes[n],env.geo));
  const yuan={
    gen:ctx.pGen*qty,
    send:qty*sendTotal,
    trans:qty*trans,
    reg:qty*regFee,
    loss:ctx.pGen*lossMwh*g,
    net:cNet*qty,
    fund:cFund*qty,
  };
  yuan.total=yuan.gen+yuan.send+yuan.trans+yuan.reg+yuan.loss+yuan.net+yuan.fund;
  const tiers={gov:0,grid:0,region:0,est:0};
  edges.forEach(e=>{tiers[e.tier]=(tiers[e.tier]||0)+1;});
  const unverified=edges.filter(e=>e.tier!=='gov').length;

  return {nodes,edges,hops:n,D,genQty,lossQty,trans,regFee,segs,segLd,overSeg,maxLoad,secHits,secOver,feasible,
    detour:detourOf(nodes,edges,env.geo), landed, channelOnly, senderNet, yuan,
    qty, h, deliverMW, genMWh, lossMwh, segLossMwh,
    dist, straight, dcCount:vsCount, acCount:n-vsCount,
    kvList:[...vset].filter(Boolean), typeList:[...tset], regionList:[...rset].filter(Boolean),
    stationList:[...stset], tiers, unverified,
    comp:{gen:cGen,loss:cLossBuyer,send:cSend,trans:cTrans,reg:cReg,net:cNet,fund:cFund},
    capUnknown:edges.filter(e=>e.capBasis==='unknown').length,
    capEqUsed:edges.filter(e=>e.capEq!=null).length};
}
