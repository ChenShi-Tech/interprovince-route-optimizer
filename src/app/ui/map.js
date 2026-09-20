/* 网架图：内置 SVG 拓扑图 + 腾讯地图 + 天地图（均为白名单底图）。 */
/* ================= 地图 ================= */
let map=null,mapReady=false,polyLayer=null,mkLayer=null,lbLayer=null;
let tdMap=null,tdReady=false,tdLayer=null;

/* 地图圆点图标：data: URI 里的 SVG 不认 CSS 变量，绘制时按当前主题把令牌解析成实际颜色再拼。
   c 为令牌名（'--map-route'）或 'var(--x)'（区域调色板）。 */
const dotSvg=c=>`data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14'%3E%3Ccircle cx='7' cy='7' r='4.5' fill='${encodeURIComponent(tokenColor(c))}' stroke='${encodeURIComponent(tokenColor('--map-casing'))}' stroke-width='1.5'/%3E%3C/svg%3E`;
const mapDots=()=>({hot:dotSvg('--map-route'),on:dotSvg('--map-end'),base:dotSvg('--map-dot-base')});

/* ---------- 批次 B（grid-map P1）共用辅助 ---------- */
/* 通道折线点列：[起点,...走廊中间点,终点]，proj 为投影函数；起止缺坐标返回 null。
   无走廊 waypoints 的通道自然退化为两点直线（spec: grid-map 走廊）。 */
function chanPts(c,proj){
  const a=lngLatOf(c,'from'), b=lngLatOf(c,'to');
  if(!a||!b) return null;
  const wp=Array.isArray(c.waypoints)?c.waypoints:[];
  return [a,...wp,b].map(p=>proj(p[0],p[1]));
}
const ptsAttr=ps=>ps.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
/* 断面成员通道 id：SEC.edges 存通道名，按名映射到 CH（与费率库断面分区同源）；
   未映射到的成员自然不亮，浮层文案提示（spec: 断面上图，不虚构地理边界）。 */
function secMemberIds(secId){
  const s=SEC.find(x=>x.id===secId);
  if(!s||!Array.isArray(s.edges)||!s.edges.length) return [];
  const names=new Set(s.edges);
  return CH.filter(c=>names.has(c.n)).map(c=>c.id);
}

function visibleChannels(){
  /* change: grid-map-single-route-and-fixes：图上只画选中方案——不再产出其它候选（alt）层，
     全网架层随「显示全网架」开关一并移除。三种底图共用本口径。 */
  const r=state._res&&state._res.rows;
  const hot=new Set(), nodes=new Set(), routeNodes=new Set();
  if(r&&r.length){
    const sel=Math.min(state.sel,r.length-1);
    r[sel].edges.forEach(e=>hot.add(e.id));
    r[sel].nodes.forEach(k=>{nodes.add(k);routeNodes.add(k);});
  }
  return {list:CH, hot, nodes, routeNodes, sel:r?Math.min(state.sel,r.length-1):-1};
}

function initMap(){
  if(mapReady) return true;
  if(typeof TMap==='undefined') return false;
  try{
    map=new TMap.Map('map-view',{center:new TMap.LatLng(34,108),zoom:4});
    // 腾讯地图样式对象只认真实颜色字符串：初始化时按当前主题解析令牌（renderMap 每次重建地图，换主题后重绘即跟随）
    const C=k=>tokenColor(k), D=mapDots();
    polyLayer=new TMap.MultiPolyline({map,styles:{
      hot:new TMap.PolylineStyle({color:C('--map-route'),width:6,borderWidth:2,borderColor:C('--map-casing'),lineCap:'round'})},geometries:[]});
    mkLayer=new TMap.MultiMarker({map,styles:{
      hot:new TMap.MarkerStyle({width:16,height:16,anchor:{x:8,y:8},src:D.hot}),
      on:new TMap.MarkerStyle({width:18,height:18,anchor:{x:9,y:9},src:D.on}),
      base:new TMap.MarkerStyle({width:9,height:9,anchor:{x:4.5,y:4.5},src:D.base})},geometries:[]});
    lbLayer=new TMap.MultiLabel({map,styles:{
      hot:new TMap.LabelStyle({color:C('--map-label-on'),size:12,offset:{x:0,y:-15},alignment:'center'}),
      st:new TMap.LabelStyle({color:C('--map-end'),size:11,offset:{x:0,y:-14},alignment:'center'}),
      seq:new TMap.LabelStyle({color:C('--on-fill'),size:11,offset:{x:0,y:0},alignment:'center',backgroundColor:C('--map-route'),padding:'2px 5px',borderRadius:9}),
      base:new TMap.LabelStyle({color:C('--map-label'),size:10,offset:{x:0,y:-11},alignment:'center'})},geometries:[]});
    mapReady=true; return true;
  }catch(e){ return false; }
}

function drawMapQQ(){
  if(!initMap()) return false;   // SDK 由 renderMap 的 loadTMap 先行加载（M17 机制），此处只做容器初始化
  const v=visibleChannels();
  const polys=[],mks=[],lbs=[],seen=new Set();
  // 选中方案通道（change: grid-map-single-route-and-fixes：其它候选/全网架层已移除）
  v.list.forEach(c=>{
    if(!v.hot.has(c.id)) return;
    const a=lngLatOf(c,'from'), b=lngLatOf(c,'to'); if(!a||!b) return;
    const wp=Array.isArray(c.waypoints)?c.waypoints:[];
    polys.push({id:c.id,styleId:'hot',paths:[a,...wp,b].map(p=>new TMap.LatLng(p[1],p[0]))});
  });
  // 站点：仅选中方案经过的站点打点并标注名称
  const r=state._res&&state._res.rows;
  if(r&&v.sel>=0){
    r[v.sel].segs.forEach((s,si)=>{
      [['from',s.e.stFrom],['to',s.e.stTo]].forEach(([side,st])=>{
        if(!st||!ST[st]||seen.has(st)) return; seen.add(st);
        const p=ST[st];
        mks.push({id:'m'+st,styleId:'hot',position:new TMap.LatLng(p.lat,p.lng)});
        lbs.push({id:'l'+st,styleId:'st',position:new TMap.LatLng(p.lat,p.lng),text:p.n});
      });
      const a=lngLatOf(s.e,'from'), b=lngLatOf(s.e,'to');
      if(a&&b) lbs.push({id:'seq'+si,styleId:'seq',
        position:new TMap.LatLng((a[1]+b[1])/2,(a[0]+b[0])/2),text:String(si+1)});
    });
  }
  // 省份节点
  Object.keys(PV).forEach(k=>{
    const ll=provLngLat(k); if(!ll) return;
    const isEnd=r&&v.sel>=0&&(k===r[v.sel].nodes[0]||k===r[v.sel].nodes[r[v.sel].nodes.length-1]);
    const onRoute=v.routeNodes.has(k);
    if(seen.has(k+'_p')) return; seen.add(k+'_p');
    mks.push({id:'mp'+k,styleId:isEnd?'on':(onRoute?'hot':'base'),position:new TMap.LatLng(ll[1],ll[0])});
    lbs.push({id:'lp'+k,styleId:onRoute?'hot':'base',position:new TMap.LatLng(ll[1],ll[0]),text:N(k)});
  });
  polyLayer.setGeometries(polys); mkLayer.setGeometries(mks); lbLayer.setGeometries(lbs);
  // 视野适配（design D4）：仅用 setCenter/setZoom 基础 API；搜索聚焦优先（批次 B）
  const bb=state.mapFocusLL||mapFocusBB(state._res&&state._res.rows?state._res.rows[Math.min(v.sel,state._res.rows.length-1)]:null);
  if(bb){
    const box=document.getElementById('map-view');
    try{ map.setCenter(new TMap.LatLng((bb.y0+bb.y1)/2,(bb.x0+bb.x1)/2)); map.setZoom(fitZoom(bb,(box&&box.clientWidth)||360,(box&&box.clientHeight)||320)); }catch(e){}
  }
  return true;
}

/* tdTried：同一密钥只自动尝试一次，失败后不再自动重发（每次渲染都重发会形成请求风暴，
   触发天地图 CloudWAF 风控临时拦截）；点「应用密钥」或换密钥才重新尝试。
   tdQueue/tdAttempt：同一密钥下载期间的重复调用挂到同一轮询上等结果，不再直接判失败；
   一轮尝试只回放它自己的回调，旧一轮（换过密钥）的结果丢弃。回调是否采用结果由调用方
   用代际判定决定（M16）——5 秒轮询窗口内切换底图后，迟到的回调不得再 new T.Map 覆盖新容器。 */
let tdTried='', tdAttempted=false, tdFailKind='server', tdCooldownUntil=0;
let tdAttempt=0, tdLoading=false;
const tdQueue=[];
/* tkMsgGen：#tk-msg 消息代数戳。探针/诊断的结论是异步回写的，若用户在此期间产生新消息
  （如空输入应用的「已保留密钥」常驻提示），迟到的旧结论会把新提示盖掉——每次 tkMsg/显式
  写入使代数 +1，在途回写发现代数不符即放弃（元素身份检查仍保留，防跨重绘污染）。 */
let tkMsgGen=0;
/* 服务端风控（CloudWAF）的封禁会因继续请求而延长：判定为服务端拦截后本地静默 10 分钟，
   冷却期内点「应用密钥」不再发请求，只提示剩余等待；更换密钥或刷新页面可立即重试一次。 */
const TD_COOLDOWN_MS=10*60*1000;
/* 天地图 4.0 的主脚本只同步注册核心类，叠加物类是随后异步注册的——实测 onload 触发时
   T.Map/T.Marker/T.Polyline 已就绪，但 **T.Label 仍为 undefined，约 200ms 后才注册**。
   只判断 T.Map 就会立刻开始绘制，撞上「T.Label is not a constructor」被 catch 吞掉，
   界面误报成「天地图 API 兼容性问题」而降级（2026-09-16 实测的真实故障）。
   因此必须等绘制用到的类齐备。T.Label 现已不再用于绘制（省名/站点名标注已移除），
   但仍保留在清单里作为保守的就绪门槛，不放宽实测得出的时序约束。 */
const TD_REQUIRED=['Map','LngLat','Point','Icon','Marker','Polyline','Label'];
const TD_WAIT_MS=5000, TD_POLL_MS=100;
/* tkVis：密钥输入框的可见性状态（默认掩码）。切换只改 DOM 的 type/图标，不走 renderMap——
   整卡重渲染会打断输入焦点；renderMap 重绘时按 tkVis 恢复上次选择的可见性。 */
let tkVis=false;
const SVG_EYE='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const SVG_EYE_OFF='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
function toggleTkVis(){
  tkVis=!tkVis;
  const inp=document.getElementById('i-tk'), btn=document.querySelector('.tk-eye');
  if(inp) inp.type=tkVis?'text':'password';
  if(btn){ btn.innerHTML=tkVis?SVG_EYE_OFF:SVG_EYE; btn.setAttribute('aria-label',tkVis?'隐藏密钥':'显示密钥'); btn.title=btn.getAttribute('aria-label'); }
}
function tdApiReady(){
  if(typeof T==='undefined') return false;
  if(!TD_REQUIRED.every(k=>typeof T[k]==='function')) return false;
  /* 瓦片协议钉为 https：SDK 源码（api?v=4.0）中 T.Protocol 只认 "https:" 页面，
     file://（真机 APK）下 T.Protocol.value 退化为 "http://"，而瓦片 URL 在每次请求时
     动态读取该值拼接——targetSdk 34 默认禁止明文 HTTP，瓦片会全部失败且叠加物
     （线路/圆点）正常，肉眼难辨。这里在就绪后统一钉为 https，与 API 脚本同一通道。
     T.Protocol 为 SDK 内部对象，未来版本若缺失则守卫跳过，行为与旧版一致。 */
  try{ if(T.Protocol&&T.Protocol.value==='http://') T.Protocol.value='https://'; }catch(e){}
  return true;
}
function tdFlush(ok,why){
  const q=tdQueue.splice(0,tdQueue.length);
  q.forEach(cb=>{ try{ cb(ok,why); }catch(e){} });
}
function loadTianditu(cb){
  tdAttempted=false;
  /* 密钥门槛前置（grid-map-device-fixes D4，推翻 PRD D-2 的「保留容器」口径）：天地图 api
     端点对无效 tk 仍下发 SDK，SDK 一旦在本页常驻，旧实现的 tdApiReady 短路会在无密钥时
     照样报「就绪」，叠加物画在灰底上形成无底图假地图。现在无密钥一律不画——不管 SDK
     是否已在内存里；填入密钥后 SDK 常驻的短路路径照常生效。 */
  if(!state.tiandituKey) return cb(false,'empty');
  if(tdReady) return cb(true);
  if(tdApiReady()){ tdReady=true; return cb(true); }
  const src='https://api.tianditu.gov.cn/api?v=4.0&tk='+encodeURIComponent(state.tiandituKey);
  if(tdTried===src){
    if(tdLoading){ if(cb) tdQueue.push(cb); return; }   // 同一密钥正在下载：等这一轮结果，别急着降级
    return cb(false);                                   // 该密钥此前已试过并失败：沿用「只自动尝试一次」
  }
  tdTried=src; tdAttempted=true; tdLoading=true;
  const myId=++tdAttempt;                               // 本次尝试的代次：换密钥后旧一轮的结果作废
  const done=(ok,why)=>{
    if(myId!==tdAttempt) return;
    tdLoading=false; tdFlush(ok,why);
  };
  if(cb) tdQueue.push(cb);
  const s=document.createElement('script');
  s.src=src;
  // script 元素的 load 事件在脚本解析失败时也会触发，必须确认所需类真正可用才算成功。
  // onload 时叠加物类可能尚未注册，故轮询等待而非一次判定（见上方 TD_REQUIRED 说明）；
  // 超时单独回一句 why='incomplete'，避免被误诊成网络或风控问题。
  let waited=0;
  const poll=()=>{
    if(tdApiReady()){ tdReady=true; return done(true); }
    waited+=TD_POLL_MS;
    if(waited>=TD_WAIT_MS){ tdReady=false; return done(false,'incomplete'); }
    setTimeout(poll,TD_POLL_MS);
  };
  s.onload=poll;
  s.onerror=()=>done(false);
  document.head.appendChild(s);
}
/* 腾讯地图 SDK 加载已由 loadTMap（M17：__WB_TMAP_PROXY__ 判据 + head #tmap-sdk data-src 惰性注入）承接，
   旧 loadQQSdk 直连注入实现已废弃删除。 */
/* 地图视野适配（design D4）：按选中方案节点包围盒估算中心与缩放级，用各 SDK 已在用的
   基础 API（centerAndZoom / setCenter+setZoom）实现，不引入未核实的 fitBounds 类 API；
   估算含纬度余弦校正，缩放夹取安全区间并整体 try/catch——失败保持原视野，不阻断绘制。 */
function mapFocusBB(row){
  let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;
  ((row&&row.segs)||[]).forEach(s=>{
    [lngLatOf(s.e,'from'),lngLatOf(s.e,'to')].forEach(p=>{
      if(p){ x0=Math.min(x0,p[0]); x1=Math.max(x1,p[0]); y0=Math.min(y0,p[1]); y1=Math.max(y1,p[1]); }
    });
  });
  return (x1>x0||y1>y0)?{x0,x1,y0,y1}:null;
}
function fitZoom(bb,wPx,hPx){
  const kx=Math.cos(((bb.y0+bb.y1)/2)*Math.PI/180);
  const z=Math.min(
    Math.log2((wPx*360)/(((bb.x1-bb.x0)*kx)||1e-4)/256),
    Math.log2((hPx*360)/((bb.y1-bb.y0)||1e-4)/256)
  )-1.2;
  return Math.max(3.5,Math.min(12,z));
}
function drawMapTD(){
  if(!tdReady) return false;
  if(!state.tiandituKey) return false;   // grid-map-device-fixes D4：密钥门槛——SDK 常驻也不得无密钥绘制叠加物
  try{
    if(!tdMap){ tdMap=new T.Map('map-view'); tdMap.centerAndZoom(new T.LngLat(108,34),5); }
    tdMap.clearOverLays();
    const v=visibleChannels(), seen=new Set();
    const C=k=>tokenColor(k), D=mapDots();   // 天地图样式只认真实颜色：按当前主题解析令牌
    /* 断面高亮垫层（spec: grid-map 断面，与拓扑图同色同语义）；真机 C3 复核：
       选中方案成员改画更宽外圈、非成员垫层提对比度——与 topoSVG 同口径 */
    if(state.mapSec){
      const mem=new Set(secMemberIds(state.mapSec));
      v.list.forEach(c=>{
        if(!mem.has(c.id)) return;
        const ps=chanPts(c,(lng,lat)=>[lng,lat]);
        const hot=v.hot.has(c.id);
        if(ps) tdMap.addOverLay(new T.Polyline(ps.map(p=>new T.LngLat(p[0],p[1])),{color:C('--map-section'),weight:hot?11:7,opacity:hot?0.55:0.45}));
      });
    }
    // 选中方案连线（走廊 waypoints 折线化）；其它候选/全网架不再上图（change: grid-map-single-route-and-fixes）
    v.list.forEach(c=>{
      if(!v.hot.has(c.id)) return;
      const ps=chanPts(c,(lng,lat)=>[lng,lat]);
      if(!ps) return;
      const ln=new T.Polyline(ps.map(p=>new T.LngLat(p[0],p[1])),{color:C('--map-route'),weight:6,opacity:0.9});
      try{ ln.addEventListener('click',()=>toggleChan(c.id)); }catch(e){}  // 事件 API 真机核实，失败仅失去点击
      tdMap.addOverLay(ln);
    });
    const r=state._res&&state._res.rows;
    if(r&&v.sel>=0){
      r[v.sel].segs.forEach((s,si)=>{
        [s.e.stFrom,s.e.stTo].forEach(st=>{
          if(!st||!ST[st]||seen.has(st)) return; seen.add(st);
          const p=ST[st];
          const mk=new T.Marker(new T.LngLat(p.lng,p.lat),{icon:new T.Icon({iconUrl:D.hot,iconSize:new T.Point(14,14)})});
          try{ mk.addEventListener('click',()=>stationPop(st)); }catch(e){}
          tdMap.addOverLay(mk);
        });
        // 段名标注：与拓扑图同源清单（routeLabelList），仅标选中方案
        const a=lngLatOf(s.e,'from'), b=lngLatOf(s.e,'to');
        if(a&&b){
          try{ tdMap.addOverLay(new T.Label({text:s.e.n,position:new T.LngLat((a[0]+b[0])/2,(a[1]+b[1])/2),offset:new T.Point(0,-16)})); }catch(e){}
        }
      });
    }
    // 省份节点：区域着色开启时，非途经省份按区域电网着色（途经/端点保持选中语义优先，批次 B 增补）
    const tdRPal=state.mapRegion?regionPalette(DATA.RGOF):null;
    Object.keys(PV).forEach(k=>{
      const ll=provLngLat(k); if(!ll||seen.has(k)) return; seen.add(k);
      const onRoute=v.routeNodes.has(k);
      const regColor=(tdRPal&&REGION_OF[k]&&!onRoute)?tdRPal[REGION_OF[k]]:null;
      const iconUrl=onRoute?D.hot:(regColor?dotSvg(regColor):D.base);
      const size=onRoute?14:(regColor?11:9);
      tdMap.addOverLay(new T.Marker(new T.LngLat(ll[0],ll[1]),{icon:new T.Icon({iconUrl,iconSize:new T.Point(size,size)})}));
    });
    /* 站点热区兜底（真机 B3 复核）：T.Marker 图标仅 14px 且事件 API 在部分真机不派发
       （map.js:241 的预留风险被实测坐实）。地图级 click 按最近站点判定：阈值 22px 按
       当前 zoom 换算成度，只对选中方案经过的站点生效，与拓扑图同语义。 */
    if(!tdMap._stHitBound && typeof tdMap.addEventListener==='function'){
      tdMap._stHitBound=true;
      try{
        tdMap.addEventListener('click',ev=>{
          try{
            const p2=ev&&ev.lnglat; if(!p2) return;
            const rr=state._res&&state._res.rows; if(!rr||!rr.length) return;
            const sel=rr[Math.min(state.sel,rr.length-1)];
            const z=tdMap.getZoom?tdMap.getZoom():10;
            const th=22*360/(256*Math.pow(2,z));   // 22px 命中半径在当前 zoom 下对应的经度度数
            const kx2=Math.cos(p2.getLat()*Math.PI/180);
            const seen2=new Set(); let best=null,bd=1e9;
            sel.segs.forEach(sg=>{[sg.e.stFrom,sg.e.stTo].forEach(id=>{
              if(!id||!ST[id]||seen2.has(id)) return; seen2.add(id);
              const p=ST[id];
              const d=Math.hypot((p.lng-p2.getLng())*kx2,p.lat-p2.getLat());
              if(d<th&&d<bd){bd=d;best=id;}
            })});
            if(best) stationPop(best);
          }catch(e2){}
        });
      }catch(e2){}   // 事件 API 不可用时静默放弃兜底，不阻断底图绘制（与 map.js:241 同口径）
    }
    // 视野聚焦：搜索聚焦 > 选中方案路线范围（用户随后仍可手动缩放拖动）
    const bb=state.mapFocusLL||mapFocusBB(r&&r.length?r[Math.min(v.sel,r.length-1)]:null);
    if(bb){
      const box=document.getElementById('map-view');
      const z=fitZoom(bb,(box&&box.clientWidth)||360,(box&&box.clientHeight)||320);
      const c=new T.LngLat((bb.x0+bb.x1)/2,(bb.y0+bb.y1)/2);
      try{ tdMap.centerAndZoom(c,z); }
      catch(e){ try{ tdMap.centerAndZoom(c,Math.max(3,Math.min(11,Math.round(z)))); }catch(e2){} }
    }
    return true;
  }catch(e){ return false; }
}
function showMapFallback(){
  const mv=document.getElementById('map-view'); if(mv) mv.style.display='none';
  const fb=document.getElementById('fallback'); if(!fb) return;
  fb.style.display='block';
  const r=state._res&&state._res.rows;
  let t='<div style="font-weight:600;color:var(--ink);margin-bottom:6px">底图未加载，已降级为网架清单</div>';
  t+='<div style="margin-bottom:12px;line-height:1.7;font-size:11.5px">'+(state.mapProvider==='td'
    ?'天地图未加载：请确认密钥有效且网络可达 api.tianditu.gov.cn。'
    :'腾讯地图需运行环境支持；天地图需你自己的密钥。')+'</div>';
  if(r&&r.length){
    const sel=Math.min(state.sel,r.length-1);
    t+=`<div style="font-weight:600;margin-bottom:6px">选中方案 #${sel+1}　${r[sel].nodes.map(N).join(' → ')}</div>`;
    r[sel].segs.forEach((s,i)=>{
      t+=`<div style="padding:6px 0;border-bottom:var(--hairline) solid var(--line2);line-height:1.6">
        <b>第 ${i+1} 段　${N(s.a)} → ${N(s.b)}</b><br>
        ${s.e.n}　${s.e.kv}　${s.t} 元/MWh　计费线损 ${s.billLossPct}%（物理估算 ${s.e.loss}%）<br>
        <span style="color:var(--ink3)">段入口 ${Math.round(s.inMW)} MW　占用 ${s.util!=null?(s.util*100).toFixed(0)+'%':'待补'}</span></div>`;
    });
  }
  t+='<div style="font-weight:600;margin:14px 0 6px">全部通道（'+CH.length+' 条）</div>';
  CH.forEach(c=>{
    const on=r&&r.some(row=>row.edges.some(e=>e.id===c.id))?' ●':'';
    t+=`<div style="padding:3px 0;border-bottom:var(--hairline) solid var(--line2)">${N(c.from)} → ${N(c.to)}　${c.n}　${c.regional?'送出省参考价 ':''}${c.t==null?'—':c.t+' 元/MWh'}${on}</div>`;
  });
  fb.innerHTML=t;
}

/* 判断当前是否运行在带腾讯地图代理的环境里（WorkBuddy 本地预览）。
   判定只在 template.html 的 head 脚本里做一次（M17），这里只读那个显式标志，
   不再与 _TMapSecurityConfig 占位符互相推断。标志缺失（旧构建产物、端侧复用）按 false 处理：
   宁可降级为内置拓扑图，也不要空白底图。 */
function isProxyEnv(){
  return typeof window!=='undefined' && window.__WB_TMAP_PROXY__===true;
}

/* ---------- 腾讯地图 SDK 按环境加载（H7） ----------
   旧实现把 <script src="https://map.qq.com/api/gljs?v=1.exp">（约 2.13MB）静态放在 <head>：
   APK 以 file:// 加载时该域名不可达、线上托管环境也没有本地代理，白白阻塞首屏解析。
   现在非代理环境一次请求都不发；代理环境在脚本求值时就注入（本脚本位于 body 末尾，不阻塞首屏），
   SDK 若尚未就绪则把回调挂起，就绪后统一回放——回调是否采用结果由 renderMap 的代际判定决定。
   SDK 地址只写在 head 的 #tmap-sdk 标签上，此处不再重复硬编码。 */
let tmapState='idle';                                // idle | loading | ready | failed | unavailable
const tmapQueue=[];
function tmapSdkSrc(){
  const tag=document.getElementById('tmap-sdk');
  return tag?String(tag.getAttribute('data-src')||tag.getAttribute('src')||''):'';
}
function tmapFlush(ok){
  const q=tmapQueue.splice(0,tmapQueue.length);
  q.forEach(cb=>{ try{ cb(ok); }catch(e){} });
}
function loadTMap(cb){
  if(typeof TMap!=='undefined'){ tmapState='ready'; if(cb) cb(true); return; }
  if(!isProxyEnv()){ tmapState='unavailable'; if(cb) cb(false); return; }
  if(tmapState==='failed'||tmapState==='unavailable'){ if(cb) cb(false); return; }
  if(cb) tmapQueue.push(cb);
  if(tmapState==='loading') return;
  const src=tmapSdkSrc();
  if(!src){ tmapState='failed'; return tmapFlush(false); }
  tmapState='loading';
  const tag=document.getElementById('tmap-sdk');
  const s=tag||document.createElement('script');
  s.src=src;
  s.async=true;                                      // 动态注入的脚本本就异步，再显式标一次避免将来被静态化后阻塞
  s.onload=()=>{ tmapState=(typeof TMap==='undefined')?'failed':'ready'; tmapFlush(tmapState==='ready'); };
  s.onerror=()=>{ tmapState='failed'; tmapFlush(false); };
  if(!tag) document.head.appendChild(s);
}
if(isProxyEnv()) loadTMap();   // 代理环境：脚本求值即开始下载（body 末尾，不阻塞首屏）；非代理环境不请求

/* 内置拓扑图：纯 SVG，不依赖任何外部地图服务，离线与托管环境均可用。
   按站点经纬度做等距圆柱投影，只画节点与连线，不绘制任何行政区划边界。 */
/* 触摸视图（change: grid-map-device-fixes，design D2）：topoViewMeta 由 topoSVG 每次渲染写入
   （full=全图视野 / min=最小视野[聚焦 0.5 倍或全图 1/6] / base=本次渲染的基准视野），
   供手势层夹取与双击复位；topoDragged=拖动标志，用于吞掉拖动结束后的 click（防误触通道过滤）。 */
let topoViewMeta=null, topoDragged=false;
/* 等距圆柱投影参数（真机 B3 复核抽出的共用层）：topoSVG 渲染与 mapSvgClick 的站点热区判定
   必须用同一套换算，「点击像素 ↔ 视图坐标」才能与所见严格一致。 */
function topoProj(){
  const ids=Object.keys(PV);
  const lngs=ids.map(k=>PV[k].lng), lats=ids.map(k=>PV[k].lat);
  const lngMin=Math.min(...lngs)-1.2, lngMax=Math.max(...lngs)+1.2;
  const latMin=Math.min(...lats)-1.6, latMax=Math.max(...lats)+1.6;
  const W=660,H=430,PAD=14;
  const kx=Math.cos((latMin+latMax)/2*Math.PI/180);
  const w=(lngMax-lngMin)*kx, hgt=(latMax-latMin);
  const s=Math.min((W-2*PAD)/w,(H-2*PAD)/hgt);
  const ox=PAD+((W-2*PAD)-w*s)/2, oy=PAD+((H-2*PAD)-hgt*s)/2;
  return { W, H, ids, P:(lng,lat)=>[ox+(lng-lngMin)*kx*s, oy+(latMax-lat)*s] };
}
function topoSVG(){
  const {P,W,H,ids}=topoProj();
  const ll=(ch,side)=>{
    const st=side==='from'?ch.stFrom:ch.stTo, pv=side==='from'?ch.from:ch.to;
    return (st&&ST[st])?[ST[st].lng,ST[st].lat]:[PV[pv].lng,PV[pv].lat];
  };

  const v=visibleChannels();
  const r=state._res&&state._res.rows;
  const selR=(r&&v.sel>=0)?r[v.sel]:null;
  /* 区域归属上图（批次 B 增补）：环=区域电网归属，点=原有状态语义（选中/途经/全网），互不覆盖。
     注意区域分区在 DATA.RGOF（data.js 未解构成全局），与 lib.js 取法一致。 */
  const rPal=state.mapRegion?regionPalette(DATA.RGOF):null;

  let edges='',segs='',nodes='',labels='';
  /* 断面高亮垫层（spec: grid-map 断面）：成员通道在底层垫紫色晕圈；基于成员通道高亮，不画虚构地理边界。
     真机 C3 复核：成员在选中方案上时原先直接跳过，晕圈被路线强视觉完全盖住等于没有反馈——
     改画更宽的外圈垫层从路线两侧露出（选中视觉仍在最上层，语义不被覆盖）；非成员垫层同步提对比度。 */
  if(state.mapSec){
    const mem=new Set(secMemberIds(state.mapSec));
    CH.forEach(c=>{
      if(!mem.has(c.id)) return;
      const ps=chanPts(c,P);
      if(!ps) return;
      const hot=v.hot.has(c.id);
      edges+=`<polyline points="${ptsAttr(ps)}" fill="none" style="stroke:var(--map-section)" stroke-width="${hot?10:5.5}" opacity="${hot?0.55:0.45}" stroke-linecap="round" stroke-linejoin="round"/>`;
    });
  }
  /* 其它候选/全网架连线与热区已随 grid-map-single-route-and-fixes 移除：图上只剩选中方案，
     点击必经过滤仅在选中方案通道上可用；其余通道经搜索结果浮层查看（mapGotoChan）。 */
  /* 标注防重叠（change: grid-map-single-route-and-fixes）：省名 > 站名 > 段名 按优先级贪心放置。
     换流站与省节点经纬度接近时三类文字会叠在同一点（真机实测 川→陕→甘→宁：宝鸡换流站/陕西/
     甘陕联络线三层相叠不可辨）。冲突的站名/段名先换对侧、仍无位则省略文字——站点圆点与通道线
     仍可点开浮层看全名。SVG 未入 DOM 拿不到 getBBox，宽度按字符估：CJK≈1em、ASCII≈0.62em，另加 3px 呼吸边。 */
  const placed=[];
  const labelBox=(text,fs,cx,cyBase)=>{
    let w=10;   // 两侧各留 5px：估宽偏小会让「实际相交但估算相离」漏检（MAP-07 实测 337px² 叠压）
    for(const ch of String(text)) w+=ch.charCodeAt(0)>255?fs:fs*0.62;
    return {x0:cx-w/2,y0:cyBase-fs*0.9,x1:cx+w/2,y1:cyBase+fs*0.45};
  };
  /* 真机/纯直线数据复核（2026-09-20）：本机制此前有两处失效——①y 轴相交条件写反（p.y1<b.y0），
     垂直方向碰撞永远漏检；②putText 成功后未把盒子登记进 placed，已放标签不占位。走廊 waypoints
     在场时折线中点天然分散掩盖了这两处，走廊数据还原后 MAP-07 即现形（337px² 叠压）。 */
  const boxHit=b=>placed.some(p=>b.x0<p.x1&&p.x0<b.x1&&b.y0<p.y1&&p.y0<b.y1);
  /* 放得下则写入 labels 并返回 true；attrs 携带字号/颜色/点击热区等其余属性 */
  const putText=(text,fs,x,yBase,attrs)=>{
    const box=labelBox(text,fs,x,yBase);
    if(boxHit(box)) return false;
    placed.push(box);
    labels+=`<text x="${x.toFixed(1)}" y="${yBase.toFixed(1)}" ${attrs}>${esc(text)}</text>`;
    return true;
  };
  // 选中路线：加粗并编号；段名文字延后到省名/站名之后放置（优先级最低），几何先算好供视野聚焦（design D4）
  let fx0=1e9,fy0=1e9,fx1=-1e9,fy1=-1e9;
  const segCircles=[],segLabelCands=[];
  if(selR){
    selR.segs.forEach((sg,i)=>{
      const ps=chanPts(sg.e,P);
      if(!ps) return;
      ps.forEach(p=>{ fx0=Math.min(fx0,p[0]); fx1=Math.max(fx1,p[0]); fy0=Math.min(fy0,p[1]); fy1=Math.max(fy1,p[1]); });
      const pts=ptsAttr(ps);
      segs+=`<polyline points="${pts}" fill="none" style="stroke:var(--map-casing)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
      segs+=`<polyline points="${pts}" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" data-chan="${sg.e.id}" style="stroke:var(--map-route);pointer-events:stroke"/>`;
      const m1=ps[Math.floor((ps.length-1)/2)], m2=ps[Math.ceil((ps.length-1)/2)];
      const mx=(m1[0]+m2[0])/2, my=(m1[1]+m2[1])/2;
      segs+=`<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="8.5" style="fill:var(--map-route)"/>`
          + `<text x="${mx.toFixed(1)}" y="${my.toFixed(1)}" style="fill:var(--on-fill)" font-size="10" font-weight="600" text-anchor="middle" dominant-baseline="central">${i+1}</text>`;
      segCircles.push({mx,my});
      /* 段名候选位：段线比例点 × 上下侧共 8 个。防重叠真正生效后（placed 登记修复），
         仅靠中点两侧两个候选在拥挤路线（川→陕→甘→宁）上会全冲突而被省略——违反
         grid-map spec「选中方案 SHALL 逐段标注线路名」（MAP-02）。沿段线挪位让
         「段名必在场」（MAP-02）与「零叠压」（MAP-07）同时成立。 */
      const at=f=>{const t=f*(ps.length-1),i0=Math.floor(t),i1=Math.min(ps.length-1,i0+1),k=t-i0;return [ps[i0][0]+(ps[i1][0]-ps[i0][0])*k,ps[i0][1]+(ps[i1][1]-ps[i0][1])*k];};
      const c05=at(0.5),c035=at(0.35),c065=at(0.65);
      const sPref=i%2?17:-14,sAlt=i%2?-14:17;
      segLabelCands.push([
        {name:sg.e.n,x:c05[0],yBase:c05[1]+sPref},
        {name:sg.e.n,x:c05[0],yBase:c05[1]+sAlt},
        {name:sg.e.n,x:c035[0],yBase:c035[1]+sPref},
        {name:sg.e.n,x:c065[0],yBase:c065[1]+sPref},
        {name:sg.e.n,x:c035[0],yBase:c035[1]+sAlt},
        {name:sg.e.n,x:c065[0],yBase:c065[1]+sAlt},
        {name:sg.e.n,x:c05[0],yBase:c05[1]-30},
        {name:sg.e.n,x:c05[0],yBase:c05[1]+33},
      ]);
    });
  }
  // 节点
  /* 视野聚焦优先级（批次 B）：搜索指定的包围盒（state.mapFocusLL，度）> 选中方案路线包围盒 > 全国视野。
     任何重算（solveState）会清掉搜索聚焦，让位回路线视野。 */
  let focusBox=null;   // px 坐标 {x0,y0,x1,y1}
  if(state.mapFocusLL){
    const f=state.mapFocusLL,[ax,ay]=P(f.x0,f.y1),[bx,by]=P(f.x1,f.y0),pad=70;
    focusBox={x0:Math.min(ax,bx)-pad,y0:Math.min(ay,by)-pad,x1:Math.max(ax,bx)+pad,y1:Math.max(ay,by)+pad};
  }else if(selR&&fx1>fx0){
    const pad=55;
    focusBox={x0:fx0-pad,y0:fy0-pad,x1:fx1+pad,y1:fy1+pad};
  }
  const focused=!!focusBox||!!state.mapView;
  /* 可视盒（spec: grid-map 聚焦 + grid-map-device-fixes D2）：用户触摸视野 state.mapView 优先——
     用户显式接管后重绘不再应用路线/搜索聚焦（视野从 state.mapView 恢复），标注裁剪与视野输出同源。 */
  const shownBox=state.mapView
    ?(mv=>({x:mv.x,y:mv.y,x1:mv.x+mv.w,y1:mv.y+mv.h,w:mv.w,h:mv.h}))(state.mapView)
    :(focusBox?{x:focusBox.x0,y:focusBox.y0,x1:focusBox.x1,y1:focusBox.y1,w:focusBox.x1-focusBox.x0,h:focusBox.y1-focusBox.y0}
              :{x:0,y:0,x1:W,y1:H,w:W,h:H});
  let vbx0=shownBox.x,vbx1=shownBox.x1,vby0=shownBox.y,vby1=shownBox.y1;
  /* 省名优先放置（最高优先级）：先放选中方案途经省，再放其余省（节点圆的绘制顺序不影响视觉） */
  const ordered=[...ids.filter(k=>v.routeNodes.has(k)),...ids.filter(k=>!v.routeNodes.has(k))];
  ordered.forEach(k=>{
    const [x,y]=P(PV[k].lng,PV[k].lat);
    const onRoute=v.routeNodes.has(k);
    const isEnd=selR&&(k===selR.nodes[0]||k===selR.nodes[selR.nodes.length-1]);
    const rad=isEnd?6:(onRoute?4.6:2.6);
    const fill=isEnd?'--map-end':(onRoute?'--map-route':'--map-node');
    nodes+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad}" style="fill:var(${fill});stroke:var(--map-casing)" stroke-width="1.3"/>`;
    if(rPal&&REGION_OF[k]) nodes+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(rad+2.8).toFixed(1)}" fill="none" style="stroke:${rPal[REGION_OF[k]]}" stroke-width="1.8" opacity="0.95"/>`;
    // 聚焦视野下，离线路径且出画的省名不再绘制（避免跨界半截字，spec: grid-map 聚焦）
    if(focused&&!onRoute&&(x<vbx0||x>vbx1||y<vby0||y>vby1)) return;
    putText(N(k),onRoute?10.5:9,x,y-rad-3,`font-size="${onRoute?10.5:9}" font-weight="${onRoute?600:400}" style="fill:var(${onRoute?'--map-label-on':'--map-label'})" text-anchor="middle"`);
  });
  segCircles.forEach(c=>placed.push({x0:c.mx-10,y0:c.my-10,x1:c.mx+10,y1:c.my+10}));   // 序号圆占位：站名/段名不得压圆
  // 选中路线的换流站
  let sts='';
  if(selR){
    const seen=new Set();
    selR.segs.forEach(sg=>{
      [['from',sg.e.stFrom],['to',sg.e.stTo]].forEach(([side,st])=>{
        if(!st||!ST[st]||seen.has(st)) return; seen.add(st);
        const [x,y]=P(ST[st].lng,ST[st].lat);
        sts+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" stroke-width="2" data-st="${st}" style="fill:var(--map-casing);stroke:var(--map-end);pointer-events:all"/>`;
        // 站名：默认在点上方，冲突换下方；仍冲突则省略文字（圆点保留，点击看站名浮层）
        const stAttrs=`font-size="10" font-weight="600" text-anchor="middle" data-st="${st}" style="fill:var(--map-end);pointer-events:all"`;
        if(!putText(ST[st].n,10,x,y-7,stAttrs)) putText(ST[st].n,10,x,y+14,stAttrs);
      });
    });
  }
  /* 段名最后放置（相对省名/站名优先级最低，但 spec 要求逐段必标——按候选序取第一个不冲突位） */
  segLabelCands.forEach(cands=>{
    const segAttrs='font-size="10" font-weight="600" style="fill:var(--map-label-on);stroke:var(--map-casing)" text-anchor="middle" paint-order="stroke" stroke-width="3"';
    for(const c of cands){ if(putText(c.name,10,c.x,c.yBase,segAttrs)) return; }
  });

  /* 视野输出：用户触摸视野 > 聚焦盒（搜索 / 选中方案）> 全国视野；
     并写入 topoViewMeta 供手势层夹取（design D2）。 */
  const vb=`${shownBox.x.toFixed(1)} ${shownBox.y.toFixed(1)} ${shownBox.w.toFixed(1)} ${shownBox.h.toFixed(1)}`;
  topoViewMeta={
    full:{x:0,y:0,w:W,h:H},
    min:focusBox?{w:(focusBox.x1-focusBox.x0)/2,h:(focusBox.y1-focusBox.y0)/2}:{w:W/6,h:H/6},
    base:focusBox?{x:focusBox.x0,y:focusBox.y0,w:focusBox.x1-focusBox.x0,h:focusBox.y1-focusBox.y0}:{x:0,y:0,w:W,h:H},
  };

  return `<svg viewBox="${vb}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" role="img" xmlns="http://www.w3.org/2000/svg">
<title>跨省电网拓扑图</title><desc>按站点经纬度投影的节点连线图，仅示拓扑不绘制行政区划边界。</desc>
<rect x="-200" y="-200" width="${W+400}" height="${H+400}" style="fill:var(--map-ground)"/>
${edges}${segs}${nodes}${sts}${labels}
</svg>`;
}

/* ---------- 网架视图交互（spec: grid-map 点击联动 / 站点信息 / 快照导出） ---------- */
/* 点击通道=必经过滤：与测算页通道组件筛选（boot.js i-chan）同一状态源与语义，再次点击解除 */
function toggleChan(id){
  state.mustHave=(state.mustHave.length&&state.mustHave[0]===id)?[]:[id];
  state.sel=0; doSolve();
  if(!document.getElementById('v-map').hidden) renderMap();   // 地图页联动重绘（spec: grid-map 三处联动）
  chanPop(id);   // 批次 B（design D13）：点击通道同步弹出容量浮层，必经过滤语义不变
}
/* 容量/占用率信息浮层（spec: grid-map 容量浮层）：点击任一通道即出，数据与费率库同源；
   字段缺失显式「待补」，不得以 0 或空白冒充；占用率取当前选中方案该段的 util（未在方案中则说明）。
   浮层内含必经过滤切换按钮——与点击过滤同一状态源。 */
function chanPop(id){
  const el=document.getElementById('map-pop'); if(!el) return;
  const c=CH.find(x=>x.id===id); if(!c) return;
  const r=state._res&&state._res.rows?state._res.rows[Math.min(state.sel,state._res.rows.length-1)]:null;
  const seg=r&&r.segs.find(s=>s.e.id===id);
  const util=(seg&&seg.util!=null)?fmt(seg.util*100,0)+'%':null;
  const on=state.mustHave.length&&state.mustHave[0]===id;
  const basis={cap:'实际输送能力（非 ATC）',rated:'仅额定容量',estimate:'模型估算（非 ATC）'}[c.capBasis]||'';
  el.innerHTML=`<div style="position:relative;background:var(--blue-bg);border-radius:var(--radius-field);padding:8px 60px 8px 11px;margin-top:6px;font-size:11.5px;line-height:1.75">
    <button class="btn ghost" style="position:absolute;top:8px;right:8px;width:auto;padding:2px 8px;font-size:11px" onclick="document.getElementById('map-pop').innerHTML=''">关闭</button>
    <b>${esc(c.n)}</b>　<span style="color:var(--ink3)">${esc(N(c.from))} → ${esc(N(c.to))}</span>　${tierTag(c.tier)}<br>
    <span style="color:var(--ink2)">${c.regional?'送出省参考价':'输电价'} <b>${c.t==null?'待补':fmt(c.t,1)+' 元/MWh'}</b>　物理线损 ${c.loss==null?'待补':fmt(c.loss,2)+'%'}</span><br>
    <span style="color:var(--ink2)">容量 <b>${c.cap==null?'待补':esc(String(c.cap))+' MW'}</b>${c.capActual!=null?'　实际 '+c.capActual+' MW':''}${c.capRated!=null?'　额定 '+c.capRated+' MW':''}</span><br>
    <span style="color:var(--ink2)">当前方案占用 <b>${util!=null?util:'未在当前方案/待补'}</b></span>
    <span style="color:var(--ink3)">${basis?'（'+basis+'）':''}${c.capSrc?'　'+esc(c.capSrc):''}</span><br>
    <button class="btn ghost" style="width:auto;padding:3px 10px;font-size:11px;margin-top:4px" onclick="toggleChan('${esc(c.id)}')">${on?'解除必经过滤':'设为必经通道'}</button>
    ${on?'<span style="color:var(--teal);font-size:11px;margin-left:6px">必经过滤中，测算页已同步</span>':''}
  </div>`;
}
/* 拓扑 SVG 事件委托：命中通道热区→必经过滤；命中站点→站点信息浮层（数据与费率库同源）。
   grid-map-device-fixes D2：位移超阈值的拖动结束后的 click 在此吞掉——拖地图不得误触通道过滤。 */
/* 拓扑 SVG 事件委托：命中通道热区→必经过滤；命中站点→站点信息浮层（数据与费率库同源）。
   grid-map-device-fixes D2：位移超阈值的拖动结束后的 click 在此吞掉——拖地图不得误触通道过滤。
   真机 B3 复核：换流站圆点 r=3.4 个视图单位，全国视野下不足 10px，手指点不中（e2e 是对元素
   直接派发 click，绕过了物理命中所以桌面全绿）。兜底：元素未命中时按点击坐标换算视图坐标，
   在选中方案经过的站点里找 22px 半径内最近者——44px 点按底线的坐标级实现。 */
function mapSvgClick(e){
  if(topoDragged) return;
  const t=e.target;
  const st=t.getAttribute&&t.getAttribute('data-st');
  if(st){ stationPop(st); return; }
  const chan=t.closest?t.closest('[data-chan]'):null;
  if(chan){ toggleChan(chan.getAttribute('data-chan')); return; }
  const svg=t.closest?t.closest('svg'):null;
  if(!svg||!isFinite(e.clientX)||!isFinite(e.clientY)) return;
  const box=svg.getBoundingClientRect(); if(!box.width||!box.height) return;
  const vb=topoVBof();
  const sc=Math.min(box.width/(vb.w||1),box.height/(vb.h||1));   // xMidYMid meet 的统一缩放
  const ox=box.left+(box.width-vb.w*sc)/2, oy=box.top+(box.height-vb.h*sc)/2;
  const ux=vb.x+(e.clientX-ox)/sc, uy=vb.y+(e.clientY-oy)/sc, th=22/sc;
  const r=state._res&&state._res.rows; if(!r||!r.length) return;
  const sel=r[Math.min(state.sel,r.length-1)];
  const seen=new Set(),{P}=topoProj();
  let best=null,bd=1e9;
  sel.segs.forEach(sg=>{[sg.e.stFrom,sg.e.stTo].forEach(id=>{
    if(!id||!ST[id]||seen.has(id)) return; seen.add(id);
    const [x,y]=P(ST[id].lng,ST[id].lat);
    const d=Math.hypot(x-ux,y-uy);
    if(d<th&&d<bd){bd=d;best=id;}
  })});
  if(best) stationPop(best);
}
/* ---------- 拓扑图触摸缩放与平移（change: grid-map-device-fixes，design D2） ----------
   机制：渲染内容（topoSVG 输出）不变，手势只改 <svg> 的 viewBox——矢量缩放天然清晰；
   视野状态存 state.mapView（会话内），重绘后由 topoSVG 从中恢复。
   手势（pointer 事件统一处理，Android WebView/桌面通吃）：
     单指位移=平移；双指=捏合（两指中点为中心按距离比例缩放）；双击=复位回聚焦视野；
     滚轮=桌面缩放。位移阈值 TOPO_DRAG_PX 区分拖动与点击。
   夹取用 format.js 纯函数 topoViewClamp/ZoomAt/Pan（test-modules 覆盖）。 */
const TOPO_DRAG_PX=6;
function topoVBof(){
  if(state.mapView) return {...state.mapView};
  return {...((topoViewMeta&&topoViewMeta.base)||{x:0,y:0,w:660,h:430})};
}
function topoViewSet(vb){
  if(!topoViewMeta) return;
  state.mapView=topoViewClamp(vb,topoViewMeta.full,topoViewMeta.min);
  const m=state.mapView, svg=document.querySelector('#map-view svg');
  if(svg) svg.setAttribute('viewBox',`${m.x.toFixed(1)} ${m.y.toFixed(1)} ${m.w.toFixed(1)} ${m.h.toFixed(1)}`);
}
function topoViewReset(){
  if(!state.mapView) return;
  state.mapView=null;
  const svg=document.querySelector('#map-view svg');
  if(svg&&topoViewMeta){
    const b=topoViewMeta.base;
    svg.setAttribute('viewBox',`${b.x.toFixed(1)} ${b.y.toFixed(1)} ${b.w.toFixed(1)} ${b.h.toFixed(1)}`);
  }
}
function attachTopoGestures(box){
  if(!box) return;
  const svg=box.querySelector('svg'); if(!svg) return;
  const ptrs=new Map();
  let start=null, pinch=null;                     // start=单指起点 {x,y,vb,moved}；pinch=捏合基准 {d,vb}
  const rectOf=()=>svg.getBoundingClientRect();
  /* 客户端坐标 → viewBox 坐标（容器纵横比与 viewBox 一致，线性映射无 letterboxing） */
  const ptOf=(cx,cy)=>{
    const r=rectOf(), vb=topoVBof();
    return {x:vb.x+(cx-r.left)*(vb.w/(r.width||1)), y:vb.y+(cy-r.top)*(vb.h/(r.height||1))};
  };
  box.addEventListener('pointerdown',e=>{
    if(e.pointerType==='mouse'&&e.button!==0) return;
    ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(ptrs.size===1) start={x:e.clientX,y:e.clientY,vb:topoVBof(),moved:false};
    else if(ptrs.size===2){
      start=null;
      const [a,b]=[...ptrs.values()];
      pinch={d:Math.hypot(a.x-b.x,a.y-b.y)||1,vb:topoVBof()};
    }
  });
  box.addEventListener('pointermove',e=>{
    if(!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(ptrs.size===2&&pinch&&topoViewMeta){
      const [a,b]=[...ptrs.values()];
      const d=Math.hypot(a.x-b.x,a.y-b.y)||1;
      const c=ptOf((a.x+b.x)/2,(a.y+b.y)/2);
      topoViewSet(topoViewZoomAt(pinch.vb,c.x,c.y,d/pinch.d,topoViewMeta.full,topoViewMeta.min));
      topoDragged=true;
    }else if(ptrs.size===1&&start&&topoViewMeta){
      const dx=e.clientX-start.x, dy=e.clientY-start.y;
      if(!start.moved&&Math.hypot(dx,dy)<TOPO_DRAG_PX) return;   // 阈值内不算拖动，click 照常
      start.moved=true; topoDragged=true;
      const sx=start.vb.w/(rectOf().width||1);
      topoViewSet(topoViewPan(start.vb,-dx*sx,-dy*sx,topoViewMeta.full,topoViewMeta.min));
    }
  });
  const up=e=>{
    ptrs.delete(e.pointerId);
    if(ptrs.size<2) pinch=null;
    if(ptrs.size===1){ const [p]=[...ptrs.values()]; start={x:p.x,y:p.y,vb:topoVBof(),moved:true}; }   // 双指抬起一指后继续单指平移
    if(ptrs.size===0) setTimeout(()=>{ topoDragged=false; },0);   // click 派发后再复位吞击标志
  };
  box.addEventListener('pointerup',up);
  box.addEventListener('pointercancel',up);
  box.addEventListener('dblclick',e=>{ e.preventDefault(); topoViewReset(); });
  box.addEventListener('wheel',e=>{
    if(!topoViewMeta) return;
    e.preventDefault();   // 地图上滚轮=缩放视野，不滚动页面
    const f=e.deltaY<0?1.18:1/1.18;
    const p=ptOf(e.clientX,e.clientY);
    topoViewSet(topoViewZoomAt(topoVBof(),p.x,p.y,f,topoViewMeta.full,topoViewMeta.min));
  },{passive:false});
}
function stationPop(st){
  const el=document.getElementById('map-pop'); if(!el||!ST[st]) return;
  const p=ST[st];
  const reg=p.p&&REGION_OF[p.p]?REGION_OF[p.p]:null;
  el.innerHTML=`<div style="position:relative;background:var(--blue-bg);border-radius:var(--radius-field);padding:8px 60px 8px 11px;margin-top:6px;font-size:11.5px;line-height:1.6">
    <button class="btn ghost" style="position:absolute;top:8px;right:8px;width:auto;padding:2px 8px;font-size:11px" onclick="document.getElementById('map-pop').innerHTML=''">关闭</button>
    <b>${esc(p.n)}</b>　<span style="color:var(--ink3)">${esc(PV[p.p]?PV[p.p].n:(p.p||''))}</span><br>
    <span style="color:var(--ink2)">${esc(p.a||'站址未采集')}</span>${reg?`<br><span style="color:var(--ink3)">区域归属：${esc(reg)}区域电网</span>`:''}</div>`;
}
/* ---------- 批次 B：站点/通道搜索（spec: 搜索聚焦，不改选中方案与必经过滤状态） ----------
   匹配逻辑在 format.js mapSearchHits（纯函数，可单测）；此处只做结果列表与聚焦动作。 */
function mapQSearch(v){
  state.mapQ=v;
  const out=document.getElementById('map-search-out'); if(!out) return;
  const hits=mapSearchHits(v,ST,CH);
  const total=hits.stations.length+hits.channels.length;
  if(!String(v||'').trim()){
    out.innerHTML='';
    /* grid-map-device-fixes D3：清空搜索=清除搜索聚焦，视野回到路线聚焦；
       不改命中列表其余行为，也不动选中方案与必经过滤。 */
    if(state.mapFocusLL){ state.mapFocusLL=null; if(!document.getElementById('v-map').hidden) renderMap(); }
    return;
  }
  if(!total){ out.innerHTML='<div class="note" style="margin:0 0 6px">无匹配的站点/通道，换个关键词试试。</div>'; return; }
  // 结果按钮换行排布、行距 6px：hit-x 让透明扩区只横向扩，免得下一行的按钮抢走上一行下沿的点击
  const chip=(label,fn)=>`<button class="btn ghost hit-x" style="width:auto;padding:3px 10px;font-size:11px" onclick="${fn}">${esc(label)}</button>`;
  let html='<div style="display:flex;flex-wrap:wrap;gap:6px;margin:0 0 6px">'
    +hits.stations.slice(0,6).map(st=>chip(ST[st].n,`mapGotoStation('${esc(st)}')`)).join('')
    +hits.channels.slice(0,6).map(id=>{ const c=CH.find(x=>x.id===id); return chip(c?c.n:id,`mapGotoChan('${esc(id)}')`); }).join('')
    +'</div>';
  if(total>12) html+='<div class="note" style="margin:0 0 6px">共 '+total+' 个命中，仅列前 12 个，请细化关键词。</div>';
  out.innerHTML=html;
}
/* 聚焦 = 写入度坐标包围盒（state.mapFocusLL）→ 重绘（拓扑算 viewBox / 天地图·腾讯 centerAndZoom）→ 信息浮层。
   聚焦由搜索触发；任何重算（solveState）会清掉它，让位回路线视野。 */
function mapGotoStation(st){
  if(!ST[st]) return;
  state.mapFocusLL={x0:ST[st].lng,x1:ST[st].lng,y0:ST[st].lat,y1:ST[st].lat};
  if(!document.getElementById('v-map').hidden) renderMap();
  mapQSearch(state.mapQ);
  stationPop(st);
}
function mapGotoChan(id){
  const c=CH.find(x=>x.id===id); if(!c) return;
  const a=lngLatOf(c,'from'), b=lngLatOf(c,'to');
  if(a&&b) state.mapFocusLL={x0:Math.min(a[0],b[0]),x1:Math.max(a[0],b[0]),y0:Math.min(a[1],b[1]),y1:Math.max(a[1],b[1])};
  if(!document.getElementById('v-map').hidden) renderMap();
  mapQSearch(state.mapQ);
  chanPop(id);
}
/* 拓扑图快照导出（design D5）：SVG 序列化→2× canvas 光栅化→toBlob 下载；
   priceVersion 与生成时间画在 canvas 层（不进 SVG 源）。栅格底图（天地图/腾讯）无 CORS 头，
   canvas 会被污染，故导出入口仅在拓扑图视图提供。
   落盘分两路：浏览器走 <a download>；安卓 WebView 壳里 download 会被静默丢弃（真机实测），
   检测到原生桥 AndroidBridge 时改交 base64 由壳写入下载目录并 Toast 反馈。 */
function exportTopo(){
  const svgEl=document.querySelector('#map-view svg'); if(!svgEl) return;
  const name=`iproute-grid-${String(PRICE_VERSION).slice(0,8)}.png`;
  const save=b=>{
    if(window.AndroidBridge&&window.AndroidBridge.savePng){
      const fr=new FileReader();
      fr.onload=()=>{ const s=String(fr.result); window.AndroidBridge.savePng(name,s.slice(s.indexOf(',')+1)); };
      fr.readAsDataURL(b);
      return;
    }
    const a=document.createElement('a');
    a.href=URL.createObjectURL(b);
    a.download=name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  };
  // 拓扑图配色写的是 var(--令牌)：序列化成独立图片后页面样式表不再生效，先把用到的令牌按当前值内联到根元素
  const url=URL.createObjectURL(new Blob([inlineTokenVars(svgEl.cloneNode(true)).outerHTML],{type:'image/svg+xml'}));
  const img=new Image();
  img.onload=()=>{
    try{
      const cv=document.createElement('canvas'); cv.width=660*2; cv.height=430*2;
      const ctx=cv.getContext('2d');
      ctx.fillStyle=tokenColor('--card'); ctx.fillRect(0,0,cv.width,cv.height);
      ctx.drawImage(img,0,0,cv.width,cv.height);
      ctx.fillStyle=tokenColor('--snapshot-caption'); ctx.font='16px sans-serif';
      ctx.fillText(`省间路径优选测算 · priceVersion ${String(PRICE_VERSION).slice(0,8)} · ${new Date().toLocaleString('zh-CN')}`,16,cv.height-14);
      cv.toBlob(b=>{ if(b) save(b); },'image/png');
    }finally{ URL.revokeObjectURL(url); }
  };
  img.src=url;
}

/* ---------- 批次 A·状态深链：复制带状态的链接（拓扑/天地图视图均可用） ----------
   URL 构造：现地址去掉旧 hash + #from=&to=&sel=（file:// 下 origin 为 "null"，
   故基于 location.href 而非 origin 拼接）。落点与 boot.js applyDeepLink 对应。 */
function mapLinkURL(){
  const r=state._res&&state._res.rows?Math.min(state.sel,state._res.rows.length-1):0;
  return location.href.split('#')[0]+'#from='+state.from+'&to='+state.to+'&sel='+r;
}
function copyMapLink(btn){
  const url=mapLinkURL();
  const done=ok=>{
    if(!btn) return;
    btn.textContent=ok?'已复制':'复制失败';
    setTimeout(()=>{ btn.textContent='复制链接'; },1500);
  };
  const fallbackCopy=t=>{
    try{
      const i=document.createElement('textarea'); i.value=t;
      i.style.cssText='position:fixed;opacity:0';
      document.body.appendChild(i); i.select();
      const ok=document.execCommand('copy'); i.remove(); return ok;
    }catch(e){ return false; }
  };
  try{
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(()=>done(true),()=>done(fallbackCopy(url)));
    else done(fallbackCopy(url));
  }catch(e){ done(fallbackCopy(url)); }
}

/* ---------- 网架视图 ---------- */
const MAP_MODES=[['svg','拓扑图'],['qq','腾讯地图'],['td','天地图']];
/* 代际计数（M16）：每次 renderMap 都换代。异步回调（天地图最长 5s 轮询、腾讯 SDK 下载）
   回来时若已换代或底图已切换，就直接丢弃——否则会 new T.Map 覆盖新容器，
   或走降级分支把刚画好的图藏起来。 */
let mapGen=0;
function renderMap(){
  const gen=++mapGen;
  mapReady=false; map=null; polyLayer=null; mkLayer=null; lbLayer=null; tdMap=null;
  const proxyOK=isProxyEnv();
  // 托管环境下腾讯地图代理不可用，自动退回内置拓扑图
  if(state.mapProvider==='qq' && !proxyOK) state.mapProvider='svg';
  const mode=MAP_MODES.some(m=>m[0]===state.mapProvider)?state.mapProvider:'svg';
  const stale=()=>gen!==mapGen||state.mapProvider!==mode;
  const r=state._res&&state._res.rows;
  const selR=(r&&r.length)?r[Math.min(state.sel,r.length-1)]:null;
  // 批次 B：断面高亮提示条（数据与费率库断面分区同源）
  const secObj=state.mapSec?SEC.find(s=>s.id===state.mapSec):null;
  const secStrip=secObj?`<div class="warn" style="margin:0 0 8px">断面高亮：<b>${esc(secObj.n)}</b>　限额 ${esc(String(secObj.limit))} ${esc(secObj.unit||'MW')}${secObj.note?'　'+esc(secObj.note):''}${secMemberIds(state.mapSec).length?'':'　<span style="color:var(--red)">成员通道未映射到本图</span>'}</div>`:'';
  // 批次 B 增补：区域着色图例（动态，依据 REGION_OF 区域电网分区）
  const rPal=state.mapRegion?regionPalette(DATA.RGOF):null;
  const regionLegend=rPal?`<div style="display:flex;gap:10px;flex-wrap:wrap;font-size:10.5px;color:var(--ink3);margin:0 0 8px;align-items:center">
      <span style="color:var(--ink2)">区域着色</span>
      ${Object.entries(rPal).map(([n,c])=>`<span><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c};margin-right:4px;vertical-align:middle"></i>${esc(n)}</span>`).join('')}
      <span style="margin-left:auto">环=区域归属 · 依据：区域电网分区</span>
    </div>`:'';

  let out=`<div class="card tight">
    <div class="sec-title">跨省网架<span class="hint">${CH.length} 条通道 · ${Object.keys(ST).length} 个站点</span>
      <button class="btn ghost hit-x" style="width:auto;padding:3px 10px;font-size:11px;flex:none" onclick="copyMapLink(this)" title="复制带当前起止省与选中方案的链接，打开即恢复">复制链接</button></div>
    <div class="seg small">${MAP_MODES.map(([k,t])=>`<button class="${mode===k?'on':''}" onclick="switchMap('${k}')">${t}</button>`).join('')}</div>`;

  if(!proxyOK && mode!=='svg'){
    out+=`<div class="warn" style="margin-bottom:10px">当前环境无法使用腾讯地图代理（该底图仅在本机预览时可用）。天地图需要你在下方填入自己的密钥。</div>`;
  }
  /* grid-map-device-fixes D4：探针失败自动降级的一次性红字说明（会话标志，成功应用有效密钥后清除） */
  if(mode==='svg'&&state.tdDegradeNote){
    out+=`<div class="warn bad" style="margin:0 0 8px">${esc(state.tdDegradeNote)}</div>`;
  }
  if(mode==='td'){
    out+=`<label class="f"><span>天地图密钥（tk）</span>
      <div class="tk-wrap"><input id="i-tk" type="${tkVis?'text':'password'}" value="${esc(state.tiandituKey||'')}" placeholder="在天地图开放平台申请后粘贴到这里" autocomplete="off" spellcheck="false">
        <button type="button" class="tk-eye" onclick="toggleTkVis()" aria-label="${tkVis?'隐藏密钥':'显示密钥'}" title="${tkVis?'隐藏密钥':'显示密钥'}">${tkVis?SVG_EYE_OFF:SVG_EYE}</button>
      </div></label>
      <div class="row3" style="margin-bottom:10px">
        <button class="btn ghost" onclick="applyTk()">应用密钥</button>
        <button class="btn ghost" onclick="clearTk()">清除密钥</button>
        <button class="btn ghost" onclick="window.open('https://cloudcenter.tianditu.gov.cn/center/development/myApp','_blank')">去申请密钥</button>
      </div>
      <div id="tk-msg" class="note" style="margin:0 0 10px"></div>
      <p class="note">密钥需在 <b>天地图开放平台</b> 注册/登录后申请：进入「应用管理 → 创建应用」，应用类型选「浏览器端」即可获取密钥。密钥默认掩码显示，点右侧小眼睛可见；仅存本机，代码中不内嵌任何有效密钥。</p>`;
  }
  if(mode==='svg'){
    out+=`<p class="note" style="margin:0 0 8px">内置拓扑图，不依赖任何外部地图服务，离线与托管环境均可用。节点按站点经纬度定位，仅示拓扑关系，不绘制行政区划边界。</p>`;
  }

  out+=`<div style="display:flex;gap:10px;flex-wrap:wrap;font-size:10.5px;color:var(--ink2);margin:8px 0 4px;align-items:center">
      <span><i style="display:inline-block;width:16px;height:3px;background:var(--map-route);vertical-align:middle;margin-right:5px"></i>选中方案</span>
      <span style="margin-left:auto;white-space:nowrap;display:flex;align-items:center"><label class="tg" style="gap:4px"><input type="checkbox" id="i-mapregion" ${state.mapRegion?'checked':''} onchange="state.mapRegion=this.checked;renderMap()">按区域着色</label></span>
    </div>
    ${regionLegend}
    <div style="display:flex;gap:8px;margin:0 0 8px;align-items:center">
      <input id="map-q" type="search" placeholder="搜索站点 / 通道…" value="${esc(state.mapQ||'')}" oninput="mapQSearch(this.value)" style="flex:1;min-width:0;padding:7px 10px;font-size:12px">
      <select id="i-mapsec" onchange="state.mapSec=this.value||null;renderMap()" style="flex:none;max-width:48%;padding:7px 24px 7px 8px;font-size:12px">
        <option value="">按断面高亮…</option>
        ${SEC.map(s=>`<option value="${esc(s.id)}" ${state.mapSec===s.id?'selected':''}>${esc(s.n)}</option>`).join('')}
      </select>
    </div>
    <div id="map-search-out"></div>
    ${secStrip}
    ${mode==='svg'?`<div style="display:flex;justify-content:flex-end;margin:0 0 6px"><button class="btn ghost hit-x" style="padding:5px 10px;font-size:11px" onclick="exportTopo()">导出快照 PNG</button></div>`:''}
    <div id="map-view" onclick="mapSvgClick(event)"></div><div id="fallback"></div><div id="map-pop"></div>`;

  if(selR){
    /* 路线选择下拉（change: grid-map-single-route-and-fixes）：默认推荐路线 #1，
       候选口径与测算页「可选路线」同源（routeMenuItems）；用户停留在阈值外方案时把当前项补进首位，保证下拉值与图上一致 */
    const cur=Math.min(state.sel,r.length-1);
    const items=routeMenuItems(state._res);
    if(!items.some(it=>it.i===cur)) items.unshift({r:selR,i:cur});
    out+=`<div style="margin-top:11px;padding-top:11px;border-top:var(--hairline) solid var(--line2)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:12.5px;font-weight:600;flex:none">选中方案</span>
        <select id="i-maproute" onchange="mapPick(+this.value)" style="flex:1;min-width:0;padding:6px 26px 6px 9px;font-size:12px;font-weight:600">
          ${items.map(it=>`<option value="${it.i}" ${it.i===cur?'selected':''}>${esc(routeOptLabel(it))}</option>`).join('')}
        </select>
      </div>
      ${selR.segs.map((s,i)=>`<div style="font-size:11px;color:var(--ink2);padding:4px 0;border-bottom:var(--hairline) solid var(--line2);line-height:1.6">
        <b style="color:var(--blue-ink)">${i+1}</b>　${esc(s.e.n)}　${esc(s.e.kv)}　${fmt(s.t)} 元/MWh　计费线损 ${fmt(s.billLossPct,2)}%（物理估算 ${fmt(s.e.loss,2)}%）
        <span style="color:var(--ink3)">｜入口 ${fmt(s.inMW,0)} MW　${s.util!=null?'占用 '+fmt(s.util*100,0)+'%':'容量待补'}</span>
      </div>`).join('')}
    </div>`;
  }
  out+=`<p class="note" style="margin-top:10px">站点位置为县/市级近似（精确站址见费率库中各通道的送受端地址）。落点未采集的通道以省会位置示意。</p></div>`;

  out+=`<div class="card tight"><div class="sec-title">通道费用分布<span class="hint">按输电价升序</span></div>
    <table><tr><th style="width:40%">通道</th><th>输电价 / 送出省参考价</th><th>物理估算线损</th><th>容量</th></tr>
    ${[...CH].filter(c=>c.t!=null).sort((a,b)=>a.t-b.t).map(c=>`<tr>
      <td>${esc(c.n)}<br><span style="color:var(--ink3);font-size:10.5px">${esc(N(c.from))}→${esc(N(c.to))}</span></td>
      <td>${fmt(c.t)}${c.regional?'（仅起点送出省）':''}</td><td>${fmt(c.loss,2)}%</td><td>${c.cap||'待补'}</td></tr>`).join('')}</table>
  </div>`;

  document.getElementById('v-map').innerHTML=out;
  setTimeout(()=>{
    if(stale()) return; // 80ms 内用户已切换底图或页面重画则放弃本次注入，避免迟到回调污染新容器
    if(mode==='svg'){
      const box=document.getElementById('map-view');
      if(box){ box.className='topo-svg'; box.style.background='transparent'; box.style.border='0'; box.style.borderRadius='var(--radius-btn)'; box.style.overflow='hidden'; box.innerHTML=topoSVG(); attachTopoGestures(box); }
      const fb=document.getElementById('fallback'); if(fb) fb.style.display='none';
    } else if(mode==='qq'){
      loadTMap(ok=>{
        if(stale()) return;                 // SDK 迟到：容器已换代，丢弃
        if(!ok||!drawMapQQ()) showMapFallback();
      });
    } else {
      loadTianditu((ok,why)=>{
        if(stale()) return;                 // 轮询窗口内迟到：不得 new T.Map 覆盖新容器、也不得降级隐藏容器
        if(ok&&drawMapTD()) tkMsg('ok');
        else { showMapFallback(); tkMsg(ok?'drawfail':(why||(state.tiandituKey?'loadfail':'empty'))); }
      });
    }
  },80);
}
/* 网架图下拉切换选中方案：语义同测算页 pick（state.js 深链 sel 同源），但不带测算页滚动副作用；
   触摸视野随方案切换复位（grid-map-device-fixes D2 同口径）。选项文案与测算页同源（routeOptLabel，calc.js）。 */
function mapPick(i){
  state.sel=i; if(state.mapView) state.mapView=null;
  saveLast(); renderMap();
}
function switchMap(p){
  // REQ-703：不可用底图必须给出明确反馈，不得静默回退（真机 APK 以 file:// 加载，
  // __WB_TMAP_PROXY__ 恒为 false，点击「腾讯地图」必然走到这里）。原生 confirm 在 WebView 中
  // 不显示且恒按「取消」返回，改用应用内确认框 uiConfirm（见 state.js）
  if(p==='qq'&&!isProxyEnv()){
    uiConfirm('腾讯地图不可用','腾讯地图需要本地代理环境，当前环境不可用。','改用天地图','保持内置拓扑图').then(ok=>{
      state.mapProvider=ok?'td':'svg';
      if(ok) tdReady=false;
      saveMap(); renderMap();
    });
    return;
  }
  state.mapProvider=p;
  saveMap(); renderMap();
}
function applyTk(){
  const el=document.getElementById('i-tk');
  const k=(el?el.value:'').trim();
  if(!k){
    /* FR-2：空输入不再半清空状态。旧实现会把 state.tiandituKey 清掉，而 tdApiReady 的
       SDK 短路让地图继续可用——红字一闪即被绿字覆盖、重启后才走空密钥分支，行为前后不一。
       现语义：输入为空 → 不改动已存密钥，给常驻灰字说明；停用走显式「清除密钥」。 */
    const m=document.getElementById('tk-msg');
    if(m){
      tkMsgGen++;   // 使在途启动探针的异步回写失效，「已保留」为常驻提示（PRD FR-2）
      m.innerHTML=state.tiandituKey
        ?'<span style="color:var(--ink2)">输入为空，已保留本机已存密钥（尾号 '+esc(state.tiandituKey.slice(-4))+'）。要换新密钥请粘贴后再点「应用密钥」；要停用天地图请点「清除密钥」。</span>'
        :'<span style="color:var(--error-text);font-weight:600">✗ 尚未填入密钥：请先在上方粘贴天地图 tk，再点「应用密钥」。</span>';
    }
    return;
  }
  const changed=(k!==state.tiandituKey);
  state.tiandituKey=k; tdReady=false; saveMap();
  const cooling=(!changed && k && Date.now()<tdCooldownUntil);
  if(changed){ tdTried=''; tdCooldownUntil=0; }
  if(!cooling) tdTried='';
  renderMap();
  // 点击后立刻给出可见反馈（REQ-703 同理：不得静默无响应）；最终定性由瓦片级探针给出（FR-2）
  if(!cooling) tkMsg(k?'loading':'empty');
}
function clearTk(){
  /* FR-2：显式清除密钥——清空存储并立即降级为内置拓扑图（mapProvider 随 LS_MAP 持久化，重启不回弹）。
     同步清掉风控冷却与尝试记录，下次填入新密钥即可立即重试。 */
  state.tiandituKey=''; tdReady=false; tdTried=''; tdAttempted=false; tdCooldownUntil=0;
  saveMap();
  state.mapProvider='svg'; saveMap(); renderMap();
}
/* 密钥应用的各阶段反馈：loading/ok/empty/loadfail/drawfail。
   script 标签拿不到 HTTP 状态码（天地图无 CORS 头），失败时给出排查清单而非单一定性。 */
function tkMsg(kind){
  const el=document.getElementById('tk-msg'); if(!el) return;
  const gen=++tkMsgGen;   // 新消息使一切在途异步回写失效
  if(kind==='ok'){ tdTileProbe(el,gen); return; }
  if(kind==='loading'){ el.innerHTML='<span style="color:var(--ink2)">密钥已保存到本机，正在加载天地图 API…</span>'; return; }
  if(kind==='empty'){ el.innerHTML='<span style="color:var(--error-text);font-weight:600">✗ 尚未填入密钥：请先在上方粘贴天地图 tk，再点「应用密钥」。</span>'; return; }
  if(kind==='drawfail'){ el.innerHTML='<span style="color:var(--error-text);font-weight:600">✗ 密钥已通过校验，但底图渲染失败（天地图 API 兼容性问题），已降级为网架清单。</span>'; return; }
  if(kind==='incomplete'){ el.innerHTML='<span style="color:var(--error-text);font-weight:600">✗ 天地图 SDK 已下载，但组件注册不完整（缺 T.Label 等叠加物）。</span>请刷新页面重试；若持续出现，说明 SDK 版本有变。已降级为网架清单。'; return; }
  tkFailDiagnose(el,gen);
}
/* 探针失败自动降级（grid-map-device-fixes D4，推翻《PRD-体验问题修复-20260918》决策 D-2：
   「探针失败保留容器不降级」——真机证明留一张没有底图的线条图比自动降级更困惑）。
   置一次性红字说明（state.tdDegradeNote，区分 密钥无效/风控拦截 vs 网络不可达）→
   自动切回内置拓扑图并持久化选择；说明在拓扑视图顶部显示，成功应用有效密钥后清除。 */
function tdDegrade(kind){
  state.tdDegradeNote=kind==='net'
    ?'✗ 天地图瓦片加载失败：网络不可达，已自动切回内置拓扑图。网络恢复后可在「天地图」视图重试。'
    :'✗ 天地图瓦片加载失败：密钥无效或被风控拦截，已自动切回内置拓扑图。核对密钥后可在「天地图」视图重试。';
  state.mapProvider='svg'; saveMap(); renderMap();
}
/* 瓦片级真校验（FR-2，PRD-体验问题修复）：fetch(no-cors) 对任何 HTTP 状态都 resolve，
   只能证明「传输可达」，证明不了密钥有效——乱码密钥显示「自检正常」的假阳性根源（清单 F2）。
   改用 Image 加载一张固定 vec_w 瓦片（与 SDK 实际瓦片同域同格式）：无论服务端以 403 还是
   拦截页（HTML）拒绝，均不可解码为图片，onerror 必然触发——与拒绝方式无关，绕开
   「浏览器拿不到跨域状态码」的平台限制（PRD §9 V4 双通道实测）。
   探针失败不再保留无底图叠加物：自动切回内置拓扑图（tdDegrade，grid-map-device-fixes D4）；
   探针通过时清除既有降级说明。文案按 密钥无效/风控拦截 与 网络不可达 二分。 */
function tdTileProbe(el,gen){
  try{
    if(typeof T==='undefined'||!T.Protocol) return;
    const tk=state.tiandituKey||window.TMAP_AUTHKEY||'';
    const url=T.Protocol.value+'t0.tianditu.'+(T.Domain||'gov.cn')
      +'/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default'
      +'&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX=5&TILEROW=1&TILECOL=1&tk='+encodeURIComponent(tk);
    const live=()=>document.getElementById('tk-msg')===el&&gen===tkMsgGen;   // 重绘/新消息竞态防护
    const failMsg=txt=>'<span style="color:var(--error-text);font-weight:600">✗ '+txt+'</span>已自动切回内置拓扑图，可核对密钥后在「天地图」视图重试。';
    const img=new Image();
    img.onload=()=>{
      if(!live()) return;
      if(img.naturalWidth>=256){
        el.innerHTML='<span style="color:var(--teal);font-weight:600">✓ 密钥有效，底图可用。</span>';
        state.tdDegradeNote=null;   // grid-map-device-fixes D4：有效密钥成功即清除降级说明
        return;
      }
      el.innerHTML=failMsg('瓦片返回内容异常（未能解码为有效图片）。');
      tdDegrade('key');
    };
    img.onerror=()=>{
      if(!live()) return;
      let probe;
      try{ probe=fetch(url,{mode:'no-cors'}); }catch(e){ probe=Promise.reject(e); }
      probe.then(
        ()=>{ if(!live()) return; el.innerHTML=failMsg('瓦片请求被拒（密钥无效或被风控拦截）。'); tdDegrade('key'); },
        ()=>{ if(!live()) return; el.innerHTML=failMsg('网络不可达，瓦片加载失败。'); tdDegrade('net'); });
    };
    el.innerHTML='<span style="color:var(--ink2)">SDK 已加载，正在验证瓦片…</span>';
    img.src=url;
  }catch(e){}
}
/* 加载失败二分诊断：script 标签拿不到状态码（天地图无 CORS 头），改用 no-cors fetch 探测——
   fetch 成功＝服务端有响应（密钥/白名单/风控拒绝，ORB 拦掉了非 JS 内容）；
   fetch 失败＝传输层不通（代理/防火墙/DNS）。 */
function tkFailDiagnose(el,gen){
  if(typeof location!=='undefined'&&location.protocol==='file:'){
    el.innerHTML='<span style="color:var(--error-text);font-weight:600">✗ 天地图 API 加载失败。</span>当前为离线包（file://）环境，请依次检查：①设备网络能否访问 api.tianditu.gov.cn（关闭飞行模式/代理）；②密钥是否有效（可在天地图开放平台「我的应用」核对）；③仍失败时点上方「拓扑图」使用内置底图。已降级为网架清单。';
    return;
  }
  if(!tdAttempted){ tkFailShow(el, tdFailKind, false); return; }  // 本次未发新请求：沿用上次诊断，不额外探测
  el.innerHTML='<span style="color:var(--ink2)">✗ 天地图 API 加载失败，正在区分原因…</span>';
  let probe;
  try{ probe=fetch('https://api.tianditu.gov.cn/api?v=4.0',{mode:'no-cors'}); }
  catch(e){ probe=Promise.reject(e); }
  const done=k=>{ if(document.getElementById('tk-msg')===el&&gen===tkMsgGen) tkFailShow(el, k, true); };
  probe.then(()=>{ tdFailKind='server'; tdCooldownUntil=Date.now()+TD_COOLDOWN_MS; done('server'); },()=>{ tdFailKind='net'; done('net'); });
}
function tkFailShow(el, kind, fresh){
  if(kind==='server'){
    el.innerHTML = (!fresh && Date.now()<tdCooldownUntil)
      ? '<span style="color:var(--error-text);font-weight:600">✗ 天地图风控拦截仍未解除。</span>反复重试会延长封禁，请安静等待约 '+Math.ceil((tdCooldownUntil-Date.now())/60000)+' 分钟后再点「应用密钥」。已降级为网架清单。'
      : '<span style="color:var(--error-text);font-weight:600">✗ 天地图服务端拦截了本次请求（临时风控封禁）。</span>静置 30 分钟以上再点「应用密钥」重试一次，期间勿反复点击。已降级为网架清单。';
    return;
  }
  el.innerHTML = '<span style="color:var(--error-text);font-weight:600">✗ 本机网络到不了 api.tianditu.gov.cn。</span>若开了代理，请将其设为直连或暂时关闭。已降级为网架清单。';
}
