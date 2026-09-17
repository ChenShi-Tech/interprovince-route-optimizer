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
    if(id==='i-dstentity'){ state.dstEntity=e.target.value; state.dstTier=null; }
    if(id==='i-dsttier') state.dstTier=e.target.value;
    if(id==='i-dstbilling') state.dstBilling=e.target.value;
    const vt=dstTariff(); state.dstBilling=vt.billing;
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
    if(id==='i-capval'){ const v=parseFloat(e.target.value); state.capValue=v>0?v:0; }
    if(id==='i-capqty'){ const v=parseFloat(e.target.value); state.capQty=v>0?v:0; }
    saveLast(); renderCalc();
  }
});
// 参数面板：Esc 关闭；后退（含安卓返回键）先关闭面板
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeParams(); });
if(typeof window.addEventListener==='function') window.addEventListener('popstate',()=>closeParams(true));
loadStored();
aiLoad();          // 智能推荐的服务商 / 密钥 / 上次输入（独立存储，不随 state 持久化）
if(!Object.keys(PV).includes(state.from)) state.from='SC';
if(!Object.keys(PV).includes(state.to)) state.to='JS';
applyBothProv();   // 启动时一律按核定值预填
state._res=solveState();
renderCalc();
