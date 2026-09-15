/* 应用状态与本地持久化。UI 层专用；算法层不引用本文件的任何内容。 */
let state={
  from:'SC', to:'JS', qty:1000, hours:1,
  pGen:320, pDst:450, pNet:112, fund:26.6,
  lossBearer:1, K:6, maxHops:2, maxDetour:2.0, degrade:0.10, includeDstCost:true,
  sel:0, showBad:false, sortBy:'A', showAll:false,
  includeRegion:true,
  mapProvider:'svg', tiandituKey:''
};
let stored=null;
/* ================= 存储 ================= */
function loadStored(){
  try{
    const a=localStorage.getItem(LS_LIB);
    if(a){ const s=JSON.parse(a); if(s.ch&&s.ch.length===CH.length) CH=s.ch; }
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
function saveLib(){ try{localStorage.setItem(LS_LIB,JSON.stringify({ch:CH,at:BUILD_TIME}));}catch(e){} }
function saveLast(){ try{localStorage.setItem(LS_LAST,JSON.stringify(Object.assign({},state,{_bt:BUILD_TIME})));}catch(e){} }
function saveMap(){ try{localStorage.setItem(LS_MAP,JSON.stringify({mapProvider:state.mapProvider,tiandituKey:state.tiandituKey}));}catch(e){} }
