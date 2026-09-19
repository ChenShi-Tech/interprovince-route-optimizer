/* 应用状态与本地持久化。UI 层专用；算法层不引用本文件的任何内容。 */
/* 参数面板里各项的默认值：初始状态与「恢复默认」共用；与之不同的项会在主卡口径摘要里标色计数。
   送端省内网损默认另计、区域网损默认计入第三周期参考值（2026-09-17）：长三角跨省中长期实施细则（2026）第三十六条
   规定落地侧价格含「送出省外送输电价格（含送出省外送输电网损）」与华东跨省输电网损，而 1077号附件1 注4 的送出价
   不含线损、线损率单列。区域网损率仍是历史参考值，结果页保留待核实提示。 */
const PARAM_DEFAULTS={
  includeDstCost:false, sourceQuote:'plant', originLossMode:'separate',
  includeRegion:true, regionChargeMode:'network', regionLossMode:'historical',
  lossBearer:1, tradableOnly:false, occPct:0,
  // 受端到户（费用边界=到户已列费用时生效）：电网主体 / 电压档别为 null 时取该省默认主体、最高电压档；
  // 默认两部制 + 最高电压档即原 220kV 及以上两部制电量电价，旧口径不变
  dstEntity:null, dstTier:null, dstBilling:'twopart', dstCapMode:'none', dstLoadFactor:null, dstSysOpFee:null,
  // 受端用户口径：'single'=单一用户（旧口径）/ 'mix'=用户组合（按电量加权）。
  // dstMix 每项 {tier:档别名, billing:'single'|'twopart', share:电量占比%, lf:负荷率%|null}；
  // 换受端省 / 换主体 / 恢复默认会重置回单一用户并清空（重置时必须给新数组，见 calc.js resetParams 的坑）
  dstMode:'single', dstMix:[],
  srcStation:null,   // 送端电站专属送出价条目（1077号附件1 注4），null = 通用送出价
};
const PARAM_DEFAULTS_VER=2;   // 默认值口径版本：旧存档里自动存下的网损选项按新默认重置一次
let state={
  from:'SC', to:'JS', qty:1000, hours:1,
  pGen:320, pNet:112, fund:26.6,
  // 路径范围不再开放给用户：跳数取算法上限 MAX_HOPS（algo/solve.js），绕行不限，按价格从低到高排序
  maxHops:10, maxDetour:null, degrade:0.10,
  marketMode:'mlt',
  pGenManual:false,
  sel:0, showBad:false, sortBy:'A', showAll:false,
  ...PARAM_DEFAULTS, regionLossRates:{},
  // dstMix 显式给新数组：上面的展开会让 state.dstMix 与 PARAM_DEFAULTS.dstMix 同引用，
  // 之后任何 push 都会污染默认值（calc.js resetParams 同理）
  dstMix:[],
  tradeDate:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),
  // REQ-401 容量电费测算器：capMode 'cap'=按容量(kVA) / 'demand'=按需量(kW)；capProv/capTier 为 null 时跟随受端省与默认档
  capMode:'cap', capValue:1000, capQty:12000, capProv:null, capTier:null,
  mustHave:[],
  mapProvider:'svg', tiandituKey:'', mapNet:'dim',   // mapNet：全网架层显示模式 'dim'=弱化显示 / 'off'=隐藏（spec: grid-map 分层）
  // 批��� B（grid-map P1）会话内视图状态，不入档（saveLast 剥离）：mapSec=断面高亮选择、mapQ=搜索词、mapFocusLL=搜索聚焦包围盒（度）、mapRegion=按区域着色
  mapSec:null, mapQ:'', mapFocusLL:null, mapRegion:false,
  // change: grid-map-device-fixes（D2）：mapView=拓扑图用户视野 {x,y,w,h}（会话内不入档，选中方案/参数变化复位）；
  // tdDegradeNote=天地图探针失败自动降级的一次性红字说明（成功应用有效密钥后清除，不入档）
  mapView:null, tdDegradeNote:null
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
    ov.style.cssText='position:fixed;inset:0;z-index:4000;background:var(--scrim-dialog);display:flex;align-items:center;justify-content:center;padding:28px';
    ov.innerHTML=`<div role="dialog" aria-modal="true" style="background:var(--card);border-radius:var(--radius-dialog);max-width:320px;width:100%;padding:18px 16px 14px;box-shadow:var(--shadow-dialog)">
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
        else{
          // REQ-602：priceVersion 不一致必须由用户决定丢弃或暂留。确认框是异步的，
          // 先按保守口径暂留并置 _libStale（费率库会提示核对，等同原「取消」分支），
          // 用户选「丢弃」再回滚核定值并重算
          CH=s.ch; state._libStale=true;
          uiConfirm('费率本地修改版本不一致','本地费率修改基于旧版价格数据（priceVersion 不一致），继续使用可能算出过期结果。','丢弃本地修改','暂保留').then(ok=>{
            if(!ok) return;
            localStorage.removeItem(LS_LIB);
            CH=DATA.CH.map(c=>({...c})); state._libStale=false;
            state._res=solveState(); renderCalc();
          });
        }
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
      // 已下线的输入（受端目标交付价、跳数/绕行、排序口径、交付日期）不从旧存档恢复，一律取固定口径
      for(const k of ['pDst','pDstManual','maxHops','maxDetour','sortBy','tradeDate']) delete s[k];
      // 旧版存档会把当时的默认网损选项一并存下，无法区分是否手选；默认口径版本变化时按新默认重置这两项
      if(s._pdv!==PARAM_DEFAULTS_VER){ delete s.originLossMode; delete s.regionLossMode; }
      delete s._pdv;
      Object.assign(state,s);
      state._stalePrice=!sameBuild;
      // FR-1 边界：FR-1 之前的旧存档没有上限钳制，恢复时统一钳一次，
      // 保证"杀进程重开后输入为合法值"对历史存档同样成立（PRD AC3）
      state.pGen=sanNum(state.pGen,NUM_LIMITS.quote);
      state.pNet=sanNum(state.pNet,NUM_LIMITS.quote);
      state.fund=sanNum(state.fund,NUM_LIMITS.quote);
      state.qty=sanNum(state.qty,NUM_LIMITS.qty); if(!(state.qty>0)) state.qty=NUM_LIMITS.qty.fallback;
      state.hours=sanNum(state.hours,NUM_LIMITS.hours); if(!(state.hours>0)) state.hours=NUM_LIMITS.hours.fallback;
      state.capValue=sanNum(state.capValue,NUM_LIMITS.capacity); if(!(state.capValue>0)) state.capValue=0;
      state.capQty=sanNum(state.capQty,NUM_LIMITS.annualQty); if(!(state.capQty>0)) state.capQty=0;
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
    const s=Object.assign({},state,{_bt:BUILD_TIME,_pdv:PARAM_DEFAULTS_VER});
    delete s.tradableOnly; delete s.occPct; delete s.tradeDate;
    delete s._res; delete s._ai; delete s._libStale; delete s._stalePrice;
    delete s.mapSec; delete s.mapQ; delete s.mapFocusLL; delete s.mapRegion;   // 会话内视图状态不入档
    delete s.mapView; delete s.tdDegradeNote;   // change: grid-map-device-fixes：触摸视野与降级说明同为会话内状态
    localStorage.setItem(LS_LAST,JSON.stringify(s));
  }catch(e){ _storageBroken=true; }
}
function saveMap(){ try{localStorage.setItem(LS_MAP,JSON.stringify({mapProvider:state.mapProvider,tiandituKey:state.tiandituKey,mapNet:state.mapNet}));}catch(e){ _storageBroken=true; } }
