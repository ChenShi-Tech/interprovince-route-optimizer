/* 视图切换、全局事件绑定与启动。 */
/* ================= 视图 ================= */
function go(t){
  ['calc','map','lib'].forEach(x=>{ document.getElementById('v-'+x).hidden=(x!==t);
    document.getElementById('t-'+x).classList.toggle('on',x===t); });
  if(t==='lib') renderLib(); if(t==='map') renderMap(); if(t==='calc') renderCalc();
  window.scrollTo({top:0});
}
document.addEventListener('change',e=>{
  const id=e.target.id;
  if(id==='i-mapnet'){ state.mapNet=e.target.checked?'dim':'off'; saveMap(); renderMap(); return; }  // spec: grid-map 全网架开关
  if(id==='i-from'||id==='i-to'){
    const isFrom=(id==='i-from');
    if(isFrom) state.from=e.target.value; else state.to=e.target.value;
    readInputs();                                   // 先读其余输入框的当前值
    // 电网主体、电压档与电站专属送出价都是省份相关的，换省后回到该省默认
    if(isFrom) state.srcStation=null; else { state.dstEntity=null; state.dstTier=null; }
    if(isFrom) applyFromProv(); else applyToProv(); // 再用该端的核定值覆盖受影响的项
    state.sel=0; saveLast(); state._res=solveState(); renderCalc();
    return;
  }
  if(id==='i-chan'){ state.mustHave=e.target.value?[e.target.value]:[]; state.sel=0; doSolve(); return; }
  // 受端到户：主体 / 档别 / 计价方式决定输配电价，先读其余输入再用所选档核定值覆盖 pNet（手改值随之重置）
  if(['i-dstentity','i-dsttier','i-dstbilling'].indexOf(id)>=0){
    readInputs();
    // 换主体等同重新核准：清手改标记，避免把上一主体的手填电价带进新主体
    // （广东↔深圳同属一省，applyToProv 的换省判定不触发，旧值会被当成深圳的手填值继续参与计算）
    if(id==='i-dstentity'){ state.dstEntity=e.target.value; state.dstTier=null; state.pNetManual=false; }
    if(id==='i-dsttier') state.dstTier=e.target.value;
    if(id==='i-dstbilling') state.dstBilling=e.target.value;
    const vt=dstTariff(); state.dstBilling=vt.billing;
    // 新主体不能自动带入（深圳：结构特殊）时不写值，交给 solveState() 里的 syncDstAuto 置空 → 界面提示「缺项须手填」
    if(vt.net!=null) state.pNet=vt.net;
    state.sel=0; state._res=solveState(); saveLast(); renderCalc();
    return;
  }
  if(id==='i-dstcapmode') state.dstCapMode=e.target.value;
  if(id==='i-srcstation') state.srcStation=e.target.value===''?null:e.target.value;
  if(id==='i-pgen') state.pGenManual=true;
  if(id.startsWith('i-rloss-')){ state.sel=0; doSolve(); return; }
  if(['i-qty','i-hours','i-degrade','i-pgen','i-pnet','i-fund','i-dstcapmode','i-dstlf','i-dstsysop','i-srcstation','i-bearer','i-region','i-dstcost','i-tradable','i-zyocc','i-regionloss','i-sourcequote','i-originloss','i-regioncharge'].indexOf(id)>=0){
    if(id==='i-degrade') state.degrade=+e.target.value;
    state.sel=0; doSolve();
    return;
  }
  // REQ-401 容量电费测算器：独立重算，不触发路径求解
  if(['i-capprov','i-captier','i-capval','i-capqty'].indexOf(id)>=0){
    if(id==='i-capprov'){ state.capProv=e.target.value; state.capTier=null; }
    if(id==='i-captier') state.capTier=e.target.value;
    if(id==='i-capval'||id==='i-capqty'){
      // FR-1：容量/需量 ≤ 1e6 kVA(kW)、年用电量 ≤ 1e7 MWh，超上限钳制 + 红框红字；
      // 0/负数回落 0 沿用旧口径
      const lim=id==='i-capval'?NUM_LIMITS.capacity:NUM_LIMITS.annualQty;
      let v=sanNum(e.target.value,lim);
      if(!(v>0)) v=0;
      clampRegister(e.target,e.target.value,lim);
      if(id==='i-capval') state.capValue=v; else state.capQty=v;
    }
    saveLast(); renderCalc();
  }
});
// 参数面板：Esc 关闭；后退（含安卓返回键）先关闭面板
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeParams(); });
if(typeof window.addEventListener==='function') window.addEventListener('popstate',()=>closeParams(true));
loadStored();
aiLoad();          // 智能推荐的服务商 / 密钥 / 上次输入（独立存储，不随 state 持久化）
applyDeepLink();   // 批次 A·状态深链：hash 携带的 from/to/sel 优先于 LS_LAST（只覆盖这三个输入态）
if(!Object.keys(PV).includes(state.from)) state.from='SC';
if(!Object.keys(PV).includes(state.to)) state.to='JS';
applyBothProv();   // 启动时一律按核定值预填
state._res=solveState();
if(state._res&&state._res.rows&&state.sel>=state._res.rows.length) state.sel=0;   // 深链越界 sel 收敛到合法范围
renderCalc();

/* ---------- 批次 A·状态深链（change: grid-map-p1-and-ux-fixes）----------
   #from=SC&to=JS&sel=2 —— 用 hash 而非 query：file://（APK）与托管环境均可用，不发起网络请求。
   只恢复 from/to/sel 三个输入态（spec：不得覆盖输入偏好以外的持久化数据）；
   参数缺失或非法时按默认状态打开，不报错。恢复后清掉 hash，刷新/后退不重复解释。 */
function applyDeepLink(){
  try{
    if(typeof location==='undefined'||!location.hash||location.hash.length<2) return;
    const p={};
    location.hash.slice(1).split('&').forEach(kv=>{
      const i=kv.indexOf('=');
      if(i>0) p[kv.slice(0,i)]=decodeURIComponent(kv.slice(i+1));
    });
    const pv=Object.keys(PV);
    if(p.from&&pv.includes(p.from)) state.from=p.from;
    if(p.to&&pv.includes(p.to)&&p.to!==state.from) state.to=p.to;
    if(p.sel&&/^\d+$/.test(p.sel)) state.sel=+p.sel;
    try{ history.replaceState(null,'',location.pathname+location.search); }catch(e){}
  }catch(e){}
}

/* ---------- FR-3（PRD-体验问题修复）：新手导览与帮助入口 ----------
   「安装后本机第一次运行」= LS_GUIDE 不存在（结束进程重开不重弹，清应用数据才重置）。
   任意步骤可一键跳过，走完与跳过同等写键；卡片无遮罩、不阻塞测算主流程（验收 AC3）。 */
const GUIDE_STEPS=[
  {t:'三个页签，各管一件事',b:'<b>测算</b>：选起止省跑路径比选，逐层拆解费用；<br><b>网架图</b>：在地图上看路线走向与通道；<br><b>费率库</b>：查全部价格参数与原文出处。'},
  {t:'最短测算路径',b:'选好<b>出发地 / 目的地</b>即自动出结果。顶部可按<b>通道</b>筛选，点路线卡片切换方案，费用口径在「参数」面板里调。'},
  {t:'算一笔容量电费',b:'测算页底部的<b>「容量电费测算」</b>折叠卡是独立小工具：输入容量（kVA）或需量（kW）与年用电量，即得年费用与度电分摊。'},
  {t:'底图与密钥',b:'网架图默认<b>内置拓扑图</b>，离线可用；想用天地图底图，在「网架图 → 天地图」粘贴你自己的密钥（tk），仅存本机、代码不内置任何密钥。'},
];
let _guideStep=0;
function guideStart(){
  _guideStep=0;
  let ov=document.getElementById('guide-box');
  if(!ov){
    ov=document.createElement('div'); ov.id='guide-box';
    // 全视口容器 + pointer-events:none：卡片可点、页面其余区域照常可操作（AC3 不阻塞），
    // 容器自身有几何尺寸，自动化可见性判定也不会误判为隐藏
    ov.style.cssText='position:fixed;inset:0;z-index:3200;pointer-events:none';
    document.body.appendChild(ov);
  }
  guideRender();
}
function guideRender(){
  const ov=document.getElementById('guide-box'); if(!ov) return;
  const st=GUIDE_STEPS[_guideStep], last=_guideStep===GUIDE_STEPS.length-1;
  ov.innerHTML=`<div role="dialog" aria-label="新手导览" style="pointer-events:auto;position:absolute;left:10px;right:10px;bottom:calc(70px + env(safe-area-inset-bottom));max-width:460px;margin:0 auto;background:var(--card);border:.5px solid var(--line);border-radius:var(--radius-dialog);box-shadow:var(--shadow-guide);padding:14px 15px 12px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <b style="font-size:13.5px">${esc(st.t)}</b>
      <span style="margin-left:auto;font-size:10.5px;color:var(--ink3);white-space:nowrap">${_guideStep+1} / ${GUIDE_STEPS.length}</span>
    </div>
    <div style="font-size:12.5px;color:var(--ink2);line-height:1.75">${st.b}</div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn ghost" style="width:auto;padding:8px 14px;font-size:12px" onclick="guideDone()">跳过导览</button>
      <button class="btn" style="width:auto;flex:1;padding:8px;font-size:13px" onclick="guideNext()">${last?'完成':'下一步'}</button>
    </div>
  </div>`;
}
function guideNext(){
  if(_guideStep>=GUIDE_STEPS.length-1){ guideDone(); return; }
  _guideStep++; guideRender();
}
function guideDone(){
  try{ localStorage.setItem(LS_GUIDE,'1'); }catch(e){}
  const ov=document.getElementById('guide-box'); if(ov) ov.remove();
}
/* 首启判定与触发：延后一拍，让首页先完成首绘再弹 */
try{ if(!localStorage.getItem(LS_GUIDE)) setTimeout(guideStart,400); }catch(e){}
