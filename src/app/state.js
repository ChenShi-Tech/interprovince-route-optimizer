/* 应用状态与本地持久化。UI 层专用；算法层不引用本文件的任何内容。 */
let state={
  from:'SC', to:'JS', qty:1000, hours:1,
  pGen:320, pDst:450, pNet:112, fund:26.6,
  lossBearer:1, maxHops:2, maxDetour:2.0, degrade:0.10, includeDstCost:false,
  marketMode:'mlt', sourceQuote:'plant', originLossMode:'included', regionChargeMode:'network',
  pGenManual:false, pDstManual:false,
  sel:0, showBad:false, sortBy:'A', showAll:false,
  includeRegion:true, regionLossMode:'exclude', regionLossRates:{},
  tradeDate:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),
  // REQ-401 容量电费测算器：capMode 'cap'=按容量(kVA) / 'demand'=按需量(kW)；capProv/capTier 为 null 时跟随受端省与默认档
  capMode:'cap', capValue:1000, capQty:12000, capProv:null, capTier:null,
  mustHave:[],
  mapProvider:'svg', tiandituKey:''
};
let stored=null;
/* ================= 存储 ================= */
/* 存储故障可见化（spec: local-persistence）：写入失败（配额满/隐私模式）只置一次性标记，
   由测算页渲染一条常驻提示，会话内不重复弹。渲染路径内禁止任何 setItem 调用（防循环）。 */
let _storageBroken=false;
function loadStored(){
  try{
    const a=localStorage.getItem(LS_LIB);
    if(a){
      const s=JSON.parse(a);
      // REQ-602：本地价格覆盖必须与当前价格数据同版本（priceVersion），
      // 否则由用户决定丢弃或暂留——静默使用旧覆盖会算出过期结果
      if(s.ch&&s.ch.length===CH.length){
        if(s.pv&&s.pv===PRICE_VERSION){ CH=s.ch; }
        else if(confirm('本地费率修改基于旧版价格数据（priceVersion 不一致），继续使用可能算出过期结果。\n\n「确定」丢弃本地修改，恢复当前核定值；「取消」暂保留（费率库会提示核对）。')){
          localStorage.removeItem(LS_LIB);
        } else { CH=s.ch; state._libStale=true; }
      }
    }
    const b=localStorage.getItem(LS_LAST);
    if(b){
      const s=JSON.parse(b);
      const sameBuild=(s._bt===BUILD_TIME);   // 价格数据版本变化时丢弃过期的本地价格改动
      delete s._bt;
      // 旧版现货界面存档迁移到中长期节点交付口径，保留用户价格。
      if(!s.marketMode){ s.marketMode='mlt'; s.includeDstCost=false; s.regionChargeMode='network'; }
      if(Number.isFinite(s.pGen)) s.pGenManual=true;
      if(Number.isFinite(s.pDst)) s.pDstManual=true;
      Object.assign(state,s);
      state._stalePrice=!sameBuild;
    }
    const m=localStorage.getItem(LS_MAP); if(m) Object.assign(state,JSON.parse(m));
  }catch(e){}
}
function saveLib(){ try{localStorage.setItem(LS_LIB,JSON.stringify({ch:CH,pv:PRICE_VERSION,at:BUILD_TIME})); state._libStale=false; }catch(e){ _storageBroken=true; } }
function saveLast(){
  try{
    // tradableOnly（REQ-203）与 occPct（REQ-302）为会话内口径，按 PRD 不持久化；
    // 运行时产物同样不入档：_res 含 rows+byA/byB/byC 四份引用（JSON 序列化不去重，
    // 最坏省对达 12MB，撞穿 localStorage 配额后所有持久化会静默失效），_ai 挂着同一份
    // 结果，_libStale/_stalePrice 是会话内标志。启动时 boot 无条件重算 _res，剥离无消费方。
    const s=Object.assign({},state,{_bt:BUILD_TIME});
    delete s.tradableOnly; delete s.occPct;
    delete s._res; delete s._ai; delete s._libStale; delete s._stalePrice;
    localStorage.setItem(LS_LAST,JSON.stringify(s));
  }catch(e){ _storageBroken=true; }
}
function saveMap(){ try{localStorage.setItem(LS_MAP,JSON.stringify({mapProvider:state.mapProvider,tiandituKey:state.tiandituKey}));}catch(e){ _storageBroken=true; } }
