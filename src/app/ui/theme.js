/* 主题工具：读取设计令牌（src/tokens.css）当前生效的实际值；外观主题的应用、切换与外观面板（文件后半）。
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

/* ================= 外观主题：风格 × 明暗 → <html data-theme> ================= */
/* 三套主题：clear（清晰浅色，默认）/ clear-dark（清晰深色）/ tech（科技·调度大屏，固定深色）。
   偏好存本机 LS_UI：{style:'clear'|'tech', mode:'system'|'light'|'dark'}。
   首帧的 data-theme 由 src/template.html <head> 内联脚本按同一规则先行设定（防闪白），这里负责启动后的同步与切换。 */
const UI_STYLES=[['clear','清晰'],['tech','科技']];
const UI_MODES=[['system','跟随系统'],['light','浅色'],['dark','深色']];
let uiPrefs=null;

/** 读取外观偏好；存储不可用或内容非法时回退默认（清晰 · 跟随系统） */
function loadUiPrefs(){
  const p={style:'clear',mode:'system'};
  try{
    const o=JSON.parse(localStorage.getItem(LS_UI)||'null');
    if(o&&typeof o==='object'){
      if(UI_STYLES.some(s=>s[0]===o.style)) p.style=o.style;
      if(UI_MODES.some(m=>m[0]===o.mode)) p.mode=o.mode;
    }
  }catch(e){ /* 存储不可用：静默用默认 */ }
  return p;
}
function systemPrefersDark(){
  try{ return !!(typeof window!=='undefined'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches); }catch(e){ return false; }
}
/** 偏好 → 主题 id（与 <head> 内联脚本同一规则：科技固定深色；清晰按明暗，跟随系统时看 prefers-color-scheme） */
function resolveTheme(p){
  if(p.style==='tech') return 'tech';
  return (p.mode==='dark'||(p.mode==='system'&&systemPrefersDark()))?'clear-dark':'clear';
}

/** 应用主题：设 data-theme → 同步浏览器 / 安卓壳的系统栏颜色 → 网架图页在场时重绘（地图 SDK 样式、
    data: URI 圆点、快照都在绘制时读令牌）→ 外观面板打开时刷新选中态。传入 prefs 时先保存到本机。 */
function applyTheme(prefs){
  if(prefs){ uiPrefs=prefs; try{ localStorage.setItem(LS_UI,JSON.stringify(prefs)); }catch(e){} }
  if(!uiPrefs) uiPrefs=loadUiPrefs();
  const th=resolveTheme(uiPrefs);
  const de=typeof document!=='undefined'&&document.documentElement;
  if(!de||!de.setAttribute) return th;   // 无 DOM 的测试环境
  const changed=de.getAttribute('data-theme')!==th;
  de.setAttribute('data-theme',th);
  syncSystemBars();
  if(changed){
    const mv=document.getElementById('v-map');
    if(mv&&!mv.hidden&&typeof renderMap==='function') renderMap();
  }
  renderAppearance();
  return th;
}
/** 系统明暗变化：只在「跟随系统」时跟随 */
function watchSystemTheme(){
  try{
    if(typeof window==='undefined'||!window.matchMedia) return;
    const mq=window.matchMedia('(prefers-color-scheme: dark)');
    const h=()=>{ if(uiPrefs&&uiPrefs.mode==='system') applyTheme(); };
    if(mq.addEventListener) mq.addEventListener('change',h); else if(mq.addListener) mq.addListener(h);
  }catch(e){ /* 老内核不支持：保持启动时的主题 */ }
}

/** 系统栏颜色 = 当前主题的 --system-bar（页头色的不透明版，#RRGGBB）。
    <meta name="theme-color">：浏览器地址栏 / PWA 状态栏；window.IPRouteShell：安卓壳的桥（Web / iOS 没有，忽略）。 */
function syncSystemBars(){
  const hex=String(tokenColor('--system-bar')).trim().toUpperCase();
  if(!/^#[0-9A-F]{6}$/.test(hex)) return;
  try{
    const meta=typeof document.querySelector==='function'&&document.querySelector('meta[name="theme-color"]');
    if(meta) meta.setAttribute('content',hex);
  }catch(e){}
  // 深底配浅色图标：按相对亮度判断（与 WCAG 同一公式）
  const ch=[1,3,5].map(i=>{ const v=parseInt(hex.slice(i,i+2),16)/255; return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4); });
  const lightIcons=(0.2126*ch[0]+0.7152*ch[1]+0.0722*ch[2])<0.4;
  try{
    const sh=typeof window!=='undefined'&&window.IPRouteShell;
    if(sh&&typeof sh.setSystemBars==='function') sh.setSystemBars(hex,lightIcons);
  }catch(e){ /* 壳侧异常不影响页面 */ }
}

/* ---------- 外观面板（复用参数弹层 .sheet 结构；手机从底部滑出，≥600px 从右侧滑出） ---------- */
let _appearanceOpen=false;
function renderAppearance(){
  const body=typeof document!=='undefined'&&document.getElementById&&document.getElementById('theme-body');
  if(!body||!uiPrefs) return;
  const tech=uiPrefs.style==='tech';
  const seg=(key,list,cur,dis)=>`<div class="seg" role="radiogroup" aria-label="${key==='style'?'风格':'明暗'}">${list.map(([v,t])=>
    `<button type="button" role="radio" aria-checked="${cur===v}" class="${cur===v?'on':''}"${dis?' disabled':''} data-ui-${key}="${v}" onclick="setUiPref('${key}','${v}')">${t}</button>`).join('')}</div>`;
  body.innerHTML=`<div class="psub">风格</div>${seg('style',UI_STYLES,uiPrefs.style,false)}
    <div class="psub">明暗</div>${seg('mode',UI_MODES,uiPrefs.mode,tech)}
    ${tech?'<p class="note" style="margin:0">科技风格固定为深色</p>':''}`;
}
function setUiPref(key,val){
  const p=Object.assign({},uiPrefs||loadUiPrefs());
  p[key]=val;
  applyTheme(p);
}
function openAppearance(){
  const el=document.getElementById('theme-sheet');
  if(!el||_appearanceOpen) return;
  if(!uiPrefs) uiPrefs=loadUiPrefs();
  _appearanceOpen=true;
  renderAppearance();
  el.classList.add('open'); el.setAttribute('aria-hidden','false');
  document.body.classList.add('sheet-open');
  // 与参数弹层同样压一条历史：安卓返回键 / 浏览器后退先关面板
  try{ history.pushState({themeSheet:1},''); }catch(e){}
  const x=document.getElementById('theme-close');
  if(x&&x.focus){ try{ x.focus({preventScroll:true}); }catch(e){} }
}
function closeAppearance(fromHistory){
  if(!_appearanceOpen) return;
  _appearanceOpen=false;
  const el=document.getElementById('theme-sheet');
  if(el){ el.classList.remove('open'); el.setAttribute('aria-hidden','true'); }
  document.body.classList.remove('sheet-open');
  if(!fromHistory){ try{ if(history.state&&history.state.themeSheet) history.back(); }catch(e){} }
  const b=document.getElementById('btn-theme');
  if(b&&b.focus){ try{ b.focus({preventScroll:true}); }catch(e){} }
}
