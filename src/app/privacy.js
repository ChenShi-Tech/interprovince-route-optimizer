/* 隐私政策同意弹窗（上架合规 #1）。
   硬要求：① 同意前零网络请求——本模块自身无任何网络行为，地图 SDK 的拉起由 go('map') 闸门
   （boot.js）与代理环境启动加载（ui/map.js）两处用 privacyStatus() 把守；
   ② 网架页入口同意前「不可达」（非隐藏）：go('map') 未同意直接返回，视图永不渲染；
   ③ 「暂不同意」不写任何键——每次冷启动重问、网架页始终不可达（不实现「记住拒绝」）；
   ④ 同意态存 localStorage（键 LS_PRIVACY，JSON {v,at}，v 供未来政策版本升级重签）。
   纯函数式模块：无顶层执行；boot.js 在启动序列最前面调 privacyEnsure()。
   样式一律 var(--令牌)（tools/test-design-tokens.mjs 守卫），DOM 动态创建（template.html 不动）。
   遮罩点击不关闭（与 uiConfirm 相反）——同意必须显式点击「同意并继续」。
   注意：vm 系测试脚本（tools/test-*.mjs）用内存 mock DOM 跑本模块，DOM 操作全部包在 try 里。 */
function privacyStatus(){
  try{
    const raw=localStorage.getItem(LS_PRIVACY);
    if(!raw) return null;
    const s=JSON.parse(raw);
    if(!s||s.v!==1||!s.at) return null;   // 版本不符（未来政策升级）按未同意处理
    return { consented:true, version:s.v };
  }catch(e){ return null; }
}
let _privOpen=false;
function _privacyRemove(){
  const ov=document.getElementById('privacy-box'); if(ov) ov.remove();
  document.removeEventListener('keydown',_privacyOnKey);
}
function privacyDecline(){
  _privOpen=false;
  _privacyRemove();   // 不写任何键：下次冷启动重问，网架页保持不可达
}
function _privacyOnKey(e){ if(e.key==='Escape') privacyDecline(); }   // Esc 等同「暂不同意」
function privacyConsent(){
  try{ localStorage.setItem(LS_PRIVACY,JSON.stringify({v:1,at:new Date().toISOString()})); }catch(e){}
  _privOpen=false;
  _privacyRemove();
  // 已拍板：同意后当次补导览——guide 键缺席则延时触发，保持原首启体验（boot.js 的调度已带同意条件，这里是同意前被拦下的兜底）
  try{ if(!localStorage.getItem(LS_GUIDE)) setTimeout(guideStart,400); }catch(e){}
}
/* 未同意 ⇒ 渲染弹窗并返回 false；已同意 ⇒ 返回 true。
   弹窗已开着时再次调用不叠层，直接返回 false。 */
function privacyEnsure(){
  if(privacyStatus()) return true;
  if(_privOpen) return false;
  try{
    const ov=document.createElement('div');
    ov.id='privacy-box';
    ov.style.cssText='position:fixed;inset:0;z-index:4100;background:var(--scrim-dialog);display:flex;align-items:center;justify-content:center;padding:28px';
    ov.innerHTML='<div role="dialog" aria-modal="true" aria-label="隐私政策同意" style="background:var(--card);border-radius:var(--radius-dialog);max-width:340px;width:100%;max-height:80vh;overflow:auto;padding:18px 16px 14px;box-shadow:var(--shadow-dialog)">'
      +'<div style="font-size:14.5px;font-weight:600;color:var(--ink);margin-bottom:8px">隐私政策与用户协议</div>'
      +'<div style="font-size:12.5px;color:var(--ink2);line-height:1.7">【隐私政策文本待定稿 —— #2 批回填】</div>'
      +'<div style="display:flex;gap:10px;margin-top:16px">'
      +'<button class="btn ghost" onclick="privacyDecline()" style="flex:1">暂不同意</button>'
      +'<button class="btn" onclick="privacyConsent()" style="flex:1;font-size:14px;padding:10px">同意并继续</button>'
      +'</div></div>';
    ov.addEventListener('click',e=>{ if(!e.target.closest('[role="dialog"]')) return; });   // 点遮罩不关闭（与 uiConfirm 相反）
    document.addEventListener('keydown',_privacyOnKey);
    document.body.appendChild(ov);
    _privOpen=true;
  }catch(e){ _privOpen=false; }
  return false;
}
