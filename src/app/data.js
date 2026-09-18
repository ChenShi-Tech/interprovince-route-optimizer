/* 数据装载与访问。
   DATA 由构建脚本注入（data/fixed-prices.json + src/extra.json 合并后的载荷）。
   同一份载荷也以 shared/app-data.json 提供给安卓端，两端结构完全一致。 */
const PV=DATA.PV, ST=DATA.ST, SEC=DATA.SEC, RG=DATA.RG;
const CAP=DATA.CAP||{};   // REQ-401 两部制容（需）量电价（月单价，分电压档）
let CH=DATA.CH.map(c=>({...c}));

const REGION_OF=DATA.RGOF||{};   // 区域归属由 data/fixed-prices.json 提供
const N=k=>PV[k]?PV[k].n:k;
function stName(id){ return id&&ST[id]?ST[id].n:null; }
function stAddr(id){ return id&&ST[id]?ST[id].a:null; }
function stLngLat(id){ return id&&ST[id]?[ST[id].lng,ST[id].lat]:null; }
function provLngLat(p){ return PV[p]?[PV[p].lng,PV[p].lat]:null; }
function lngLatOf(ch,side){
  const s = side==='from'?ch.stFrom:ch.stTo;
  const c = side==='from'?ch.from:ch.to;
  return (s&&ST[s]) ? [ST[s].lng,ST[s].lat] : provLngLat(c);
}

/* LOSS_OF（省级上网环节线损率）是算法层计价必需的契约字段（app-data v6 起随 DATA 一起下发）。
   消费方 fail-closed（H3）：字段缺失或与 PV 不一致时，绝不能静默按 0 计省内网损，而是
     · 一律以 PV 派生值为准（PV 是唯一数据源，保证即使产物被截断也按正确值计价）；
     · 同时把「披露字段缺失/不一致」写成显式提示，追加到相关省的 scopeNote，
       随 pricingIssues 进入结果页「适用条件与缺项」与导出报告。
   端侧（安卓/iOS）必须做同样检查后显式提示，见 docs/03-数据接口说明.md。 */
const DATA_CONTRACT_ISSUES=[];
const LOSS_ISSUE_OF={};
const LOSS_OF=(function(){
  const derived={};
  for(const k in PV) derived[k]={ exportLoss: PV[k].exportLoss ?? null, inLoss: PV[k].inLoss ?? null };
  const src=DATA.LOSS_OF;
  const add=(k,msg)=>{ DATA_CONTRACT_ISSUES.push(msg+(k?`（${k}）`:'')); (LOSS_ISSUE_OF[k]||(LOSS_ISSUE_OF[k]=[])).push(msg); };
  if(!src || typeof src!=='object'){
    for(const k in derived) add(k,'数据契约缺项：LOSS_OF 字段缺失，省级上网环节线损率已按 PV 派生值计价；端侧须补齐该字段，不得按 0 计。');
  }else{
    for(const k in derived){
      const a=src[k], b=derived[k];
      if(!a || typeof a!=='object') add(k,'数据契约缺项：LOSS_OF 缺 '+k+'，已按 PV 派生值计价。');
      else if((a.exportLoss ?? null)!==b.exportLoss || (a.inLoss ?? null)!==b.inLoss)
        add(k,'数据契约告警：LOSS_OF.'+k+' 与 PV 不一致，已按 PV 派生值计价。');
    }
    for(const k in src) if(!(k in derived)) DATA_CONTRACT_ISSUES.push('数据契约异常：LOSS_OF 含未知省份 '+k+'，已忽略。');
  }
  return derived;
})();
if(DATA_CONTRACT_ISSUES.length) console.warn('数据契约检查：'+DATA_CONTRACT_ISSUES.join('；'));

/* 交给算法层的数据包。
   算法模块不直接引用上面的全局变量，而是由调用方把这份数据传进去，
   这样同一份算法代码可以原样给安卓端使用（见 docs/03-数据接口说明.md）。 */
function algoData(){
  // 契约检查发现缺项时，把提示挂到受影响省的 scopeNote 上——pricingIssues 会原样带出，
  // 结果页与导出报告都能看到，避免「缺字段 → 静默按 0 计」（fail-closed）。
  const pvOut=DATA_CONTRACT_ISSUES.length
    ? Object.fromEntries(Object.entries(PV).map(([k,p])=>[k, LOSS_ISSUE_OF[k]
        ? {...p, scopeNote:[p.scopeNote,LOSS_ISSUE_OF[k].join('；')].filter(Boolean).join('　')} : p]))
    : PV;
  return {
    CH, PV: pvOut, SEC,
    RG: DATA.RG,
    REGION_OF: DATA.RGOF || {},
    // 省级线损率（1077号附件1 注3 / 注4）：exportLoss = 送省外上网环节线损率（卖方承担），inLoss = 省内上网环节线损率（受端用户承担）
    LOSS_OF,
    RLOSS: DATA.RLOSS || {}, VALIDITY: DATA.VALIDITY || {},
    geo: { lngLatOf, provLngLat },
    name: N,
  };
}
