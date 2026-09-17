/* 应用状态与本地持久化。UI 层专用；算法层不引用本文件的任何内容。 */
let state={
  from:'SC', to:'JS', qty:1000, hours:1,
  pGen:320, pDst:450, pNet:112, fund:26.6,
  lossBearer:1, K:6, maxHops:2, maxDetour:2.0, degrade:0.10, includeDstCost:true,
  sel:0, showBad:false, sortBy:'A', showAll:false,
  includeRegion:true,
  // REQ-401 容量电费测算器：capMode 'cap'=按容量(kVA) / 'demand'=按需量(kW)；capProv/capTier 为 null 时跟随受端省与默认档
  capMode:'cap', capValue:1000, capQty:12000, capProv:null, capTier:null,
  mustHave:[], compOpen:false,
  mapProvider:'svg', tiandituKey:''
};
let stored=null;
/* 应用内确认框：原生 confirm() 在安卓 WebView（壳未设 WebChromeClient）与 iOS WKWebView
   （未挂 WKUIDelegate）中都不显示、且恒按「取消」返回 false，故三端统一自绘。
   返回 Promise<boolean>；已有弹框未关闭时再次调用直接按「取消」结算，避免叠层。 */
let _cfmOpen=false;
function uiConfirm(title,msg,okText,cancelText){
  if(_cfmOpen) return Promise.resolve(false);
  _cfmOpen=true;
  return new Promise(res=>{
    const ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;z-index:4000;background:rgba(20,24,32,.45);display:flex;align-items:center;justify-content:center;padding:28px';
    ov.innerHTML=`<div role="dialog" aria-modal="true" style="background:#fff;border-radius:14px;max-width:320px;width:100%;padding:18px 16px 14px;box-shadow:0 12px 40px rgba(0,0,0,.22)">
      <div style="font-size:14.5px;font-weight:600;color:var(--ink);margin-bottom:8px">${esc(title)}</div>
      <div style="font-size:12.5px;color:var(--ink2);line-height:1.7;white-space:pre-line">${esc(msg)}</div>
      <div style="display:flex;gap:10px;margin-top:16px">
        <button class="btn ghost" data-r="0" style="flex:1">${esc(cancelText)}</button>
        <button class="btn" data-r="1" style="flex:1;font-size:14px;padding:10px">${esc(okText)}</button>
      </div></div>`;
    const done=ok=>{ _cfmOpen=false; ov.remove(); document.removeEventListener('keydown',onKey); res(ok); };
    const onKey=e=>{ if(e.key==='Escape') done(false); };
    ov.addEventListener('click',e=>{
      const b=e.target.closest('button[data-r]');
      if(b) done(b.dataset.r==='1');
      else if(e.target===ov) done(false);   // 点遮罩视为取消
    });
    document.addEventListener('keydown',onKey);
    document.body.appendChild(ov);
    ov.querySelector('button[data-r="1"]').focus();
  });
}
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
        else{
          // REQ-602：priceVersion 不一致必须由用户决定丢弃或暂留。确认框是异步的，
          // 先按保守口径暂留并置 _libStale（费率库会提示核对，等同原「取消」分支），
          // 用户选「丢弃」再回滚核定值并重算
          CH=s.ch; state._libStale=true;
          uiConfirm('费率本地修改版本不一致','本地费率修改基于旧版价格数据（priceVersion 不一致），继续使用可能算出过期结果。','丢弃本地修改','暂保留').then(ok=>{
            if(!ok) return;
            localStorage.removeItem(LS_LIB);
            CH=DATA.CH.map(c=>({...c})); state._libStale=false;
            state._res=solve(state, algoData()); renderCalc();
          });
        }
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
