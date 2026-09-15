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
 *  ⚠️ 必须传入「实际行进方向」的起止节点，不能用边对象的 from/to ——
 *  对向通行的边，其存储方向与行进方向相反，用 from/to 会收错区域。
 *  曾因此在「湖北→山西」（长南荆存为山西→湖北）上错收华中 25.6 而非华北 10.8。
 */
function regionFee(env, fromCode, toCode){
  if(!env.includeRegion) return 0;
  const rf=env.REGION_OF[fromCode], rt=env.REGION_OF[toCode];
  if(!rf||!rt||rf===rt) return 0;          // 同区域内的省间交易不收区域电网费
  return (env.RG[rt]||0)*1000;             // 元/kWh → 元/MWh，取到达区域的价格
}

/** 近似边权：只决定路径枚举的顺序，不参与最终计价。
 *  用线性近似把线损折成成本，避免用乘法项直接做最短路。 */
function approxW(env, e, fromCode, toCode){
  return e.t+(e.loss||0)/100*env.pGen+regionFee(env, fromCode, toCode);
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
  const vset=new Set(), tset=new Set(), rset=new Set(), stset=new Set();
  const segs=edges.map((e,i)=>{
    const q=1/suf[i], qOut=1/suf[i+1];
    const fee=e.t*q, rg=regionFee(env,nodes[i],nodes[i+1])*q, sf=(e.sendFee||0)*q;
    trans+=fee; regFee+=rg; sendTotal+=sf;
    const a=env.geo.lngLatOf(e,'from'), b=env.geo.lngLatOf(e,'to');
    const crow=havKm(a,b);
    const km=e.lenKm||crow;
    const lossMwh=toMWh(q-qOut);
    segLossMwh+=lossMwh; dist+=km;
    vset.add(e.kv); tset.add(e.type); rset.add(env.REGION_OF[e.to]);
    if(e.stFrom) stset.add(e.stFrom); if(e.stTo) stset.add(e.stTo);
    if(e.type==='DC') vsCount++;
    return {
      e,q,qOut,fee,rg,sf,a:nodes[i],b:nodes[i+1],
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
  const straight=havKm(env.geo.lngLatOf(edges[0],'from'), env.geo.lngLatOf(edges[n-1],'to'));
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
