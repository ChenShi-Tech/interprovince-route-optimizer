/* 主题工具：读取设计令牌（src/tokens.css）当前生效的实际值。
   界面样式与模板字符串一律直接写 var(--x)，主题切换时浏览器自动重算，不需要本文件。
   只有「不认 CSS 变量、必须拿到真实颜色字符串」的地方才用这里：
     腾讯地图 / 天地图的样式对象、data: URI 里的 SVG、canvas 绘制、脱离页面的 SVG 快照。
   这些调用都发生在绘制时（不在脚本求值时预先算好），切换主题后重绘即可跟随。
   只属于界面层：算法层 src/app/algo/* 不得引用（tools/test-modules.mjs 纯度守卫）。 */

/** tokenColor('--map-route') → '#185FA5'（按 <html> 上当前生效的主题取值）。
    也接受 'var(--x)' 形式。取不到（无 DOM 的测试环境、令牌未定义）时返回 fallback（缺省为空串）。 */
function tokenColor(name,fallback){
  const raw=String(name==null?'':name).trim();
  const m=/^var\(\s*(--[\w-]+)\s*\)$/.exec(raw);
  const key=m?m[1]:raw;
  try{
    if(key.startsWith('--')&&typeof getComputedStyle==='function'&&typeof document!=='undefined'&&document.documentElement){
      const v=getComputedStyle(document.documentElement).getPropertyValue(key).trim();
      if(v) return v;
    }
  }catch(e){ /* 取值失败按缺省处理 */ }
  return fallback!=null?fallback:'';
}

/** 让一段 SVG 脱离页面后仍能解析 var()：把它引用到的令牌以当前实际值写到根元素的 style 上
    （自定义属性会被子元素继承）。用于拓扑图快照导出——序列化成独立图片后页面样式表不再生效。
    直接修改传入的元素，调用方应传克隆体。 */
function inlineTokenVars(svgEl){
  const names=new Set();
  const collect=el=>{
    const st=el.getAttribute&&el.getAttribute('style');
    if(st) for(const m of st.matchAll(/var\(\s*(--[\w-]+)/g)) names.add(m[1]);
    for(const c of el.children||[]) collect(c);
  };
  collect(svgEl);
  names.forEach(n=>{ const v=tokenColor(n); if(v) svgEl.style.setProperty(n,v); });
  return svgEl;
}
