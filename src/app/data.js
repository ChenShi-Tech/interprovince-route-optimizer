/* 数据装载与访问。
   DATA 由构建脚本注入（data/fixed-prices.json + src/extra.json 合并后的载荷）。
   同一份载荷也以 shared/app-data.json 提供给安卓端，两端结构完全一致。 */
const PV=DATA.PV, ST=DATA.ST, SEC=DATA.SEC, RG=DATA.RG;
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

/* 交给算法层的数据包。
   算法模块不直接引用上面的全局变量，而是由调用方把这份数据传进去，
   这样同一份算法代码可以原样给安卓端使用（见 docs/03-数据接口说明.md）。 */
function algoData(){
  // 省级线损率（1077号附件1 注3 / 注4）：exportLoss = 送省外上网环节线损率（卖方承担），inLoss = 省内上网环节线损率（受端用户承担）
  const LOSS_OF={};
  for(const k in PV) LOSS_OF[k]={ exportLoss: PV[k].exportLoss ?? null, inLoss: PV[k].inLoss ?? null };
  return {
    CH, PV, SEC,
    RG: DATA.RG,
    REGION_OF: DATA.RGOF || {},
    LOSS_OF,
    geo: { lngLatOf, provLngLat },
    name: N,
  };
}
