/* 应用状态与本地持久化。UI 层专用；算法层不引用本文件的任何内容。 */
let state={
  from:'SC', to:'JS', qty:1000, hours:1,
  pGen:320, pDst:450, pNet:112, fund:26.6,
  lossBearer:1, K:6, maxHops:2, maxDetour:2.0, degrade:0.10, includeDstCost:true,
  sel:0, showBad:false, sortBy:'A', showAll:false,
  includeRegion:true,
  mustHave:[], compOpen:false,
  mapProvider:'svg', tiandituKey:''
};
let stored=null;
/* ================= 存储 ================= */
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
      Object.assign(state,s);
      state._stalePrice=!sameBuild;
    }
    const m=localStorage.getItem(LS_MAP); if(m) Object.assign(state,JSON.parse(m));
  }catch(e){}
}
function saveLib(){ try{localStorage.setItem(LS_LIB,JSON.stringify({ch:CH,pv:PRICE_VERSION,at:BUILD_TIME})); state._libStale=false; }catch(e){} }
function saveLast(){
  try{
    // tradableOnly（REQ-203）与 occPct（REQ-302）为会话内口径，按 PRD 不持久化
    const s=Object.assign({},state,{_bt:BUILD_TIME});
    delete s.tradableOnly; delete s.occPct;
    localStorage.setItem(LS_LAST,JSON.stringify(s));
  }catch(e){}
}
function saveMap(){ try{localStorage.setItem(LS_MAP,JSON.stringify({mapProvider:state.mapProvider,tiandituKey:state.tiandituKey}));}catch(e){} }
