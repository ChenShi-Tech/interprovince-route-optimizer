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
    if(isFrom) applyFromProv(); else applyToProv(); // 再用该端的核定值覆盖受影响的项
    state.sel=0; saveLast(); state._res=solve(state, algoData()); renderCalc();
    return;
  }
  if(['i-qty','i-hours','i-hops','i-detour','i-degrade','i-pgen','i-pdst','i-pnet','i-fund','i-bearer','i-region','i-dstcost'].indexOf(id)>=0){
    if(id==='i-degrade') state.degrade=+e.target.value;
    state.sel=0; doSolve();
  }
});
loadStored();
aiLoad();          // 智能推荐的服务商 / 密钥 / 上次输入（独立存储，不随 state 持久化）
if(!Object.keys(PV).includes(state.from)) state.from='SC';
if(!Object.keys(PV).includes(state.to)) state.to='JS';
applyBothProv();   // 启动时一律按核定值预填
state._res=solve(state, algoData());
renderCalc();
