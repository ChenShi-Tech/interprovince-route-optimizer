/* 网架图：内置 SVG 拓扑图 + 腾讯地图 + 天地图（均为白名单底图）。 */
/* ================= 地图 ================= */
let map=null,mapReady=false,polyLayer=null,mkLayer=null,lbLayer=null;
let tdMap=null,tdReady=false,tdLayer=null;

const dotSvg=f=>`data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14'%3E%3Ccircle cx='7' cy='7' r='4.5' fill='${encodeURIComponent(f)}' stroke='%23ffffff' stroke-width='1.5'/%3E%3C/svg%3E`;
const D_HOT=dotSvg('#185FA5'), D_ON=dotSvg('#0F6E56'), D_BASE=dotSvg('#8A8A85');

function visibleChannels(){
  const r=state._res&&state._res.rows;
  const hot=new Set(), alt=new Set(), nodes=new Set(), routeNodes=new Set();
  if(r&&r.length){
    const sel=Math.min(state.sel,r.length-1);
    r[sel].edges.forEach(e=>hot.add(e.id));
    r[sel].nodes.forEach(k=>{nodes.add(k);routeNodes.add(k);});
    r.forEach((row,i)=>{ if(i!==sel) row.edges.forEach(e=>alt.add(e.id)); });
  }
  return {list:CH, hot, alt, nodes, routeNodes, sel:r?Math.min(state.sel,r.length-1):-1};
}

function initMap(){
  if(mapReady) return true;
  if(typeof TMap==='undefined') return false;
  try{
    map=new TMap.Map('map-view',{center:new TMap.LatLng(34,108),zoom:4});
    polyLayer=new TMap.MultiPolyline({map,styles:{
      hot:new TMap.PolylineStyle({color:'#185FA5',width:6,borderWidth:2,borderColor:'#ffffff',lineCap:'round'}),
      alt:new TMap.PolylineStyle({color:'#EF9F27',width:3,borderWidth:1,borderColor:'#ffffff',lineCap:'round'}),
      base:new TMap.PolylineStyle({color:'#C9C8C3',width:1,borderWidth:0,lineCap:'round'})},geometries:[]});
    mkLayer=new TMap.MultiMarker({map,styles:{
      hot:new TMap.MarkerStyle({width:16,height:16,anchor:{x:8,y:8},src:D_HOT}),
      on:new TMap.MarkerStyle({width:18,height:18,anchor:{x:9,y:9},src:D_ON}),
      base:new TMap.MarkerStyle({width:9,height:9,anchor:{x:4.5,y:4.5},src:D_BASE})},geometries:[]});
    lbLayer=new TMap.MultiLabel({map,styles:{
      hot:new TMap.LabelStyle({color:'#0C447C',size:12,offset:{x:0,y:-15},alignment:'center'}),
      st:new TMap.LabelStyle({color:'#0F6E56',size:11,offset:{x:0,y:-14},alignment:'center'}),
      seq:new TMap.LabelStyle({color:'#ffffff',size:11,offset:{x:0,y:0},alignment:'center',backgroundColor:'#185FA5',padding:'2px 5px',borderRadius:9}),
      base:new TMap.LabelStyle({color:'#9A9A95',size:10,offset:{x:0,y:-11},alignment:'center'})},geometries:[]});
    mapReady=true; return true;
  }catch(e){ return false; }
}

function drawMapQQ(){
  if(!initMap()) return false;
  const v=visibleChannels();
  const polys=[],mks=[],lbs=[],seen=new Set();
  v.list.forEach(c=>{
    const a=lngLatOf(c,'from'), b=lngLatOf(c,'to'); if(!a||!b) return;
    const sid=v.hot.has(c.id)?'hot':(v.alt.has(c.id)?'alt':'base');
    polys.push({id:c.id,styleId:sid,paths:[new TMap.LatLng(a[1],a[0]),new TMap.LatLng(b[1],b[0])]});
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
  return true;
}

/* tdTried：同一密钥只自动尝试一次，失败后不再自动重发（每次渲染都重发会形成请求风暴，
   触发天地图 CloudWAF 风控临时拦截）；点「应用密钥」或换密钥才重新尝试。 */
let tdTried='', tdAttempted=false, tdFailKind='server', tdCooldownUntil=0;
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
function loadTianditu(cb){
  tdAttempted=false;
  if(tdReady) return cb(true);
  if(tdApiReady()){ tdReady=true; return cb(true); }
  if(!state.tiandituKey) return cb(false);
  const src='https://api.tianditu.gov.cn/api?v=4.0&tk='+encodeURIComponent(state.tiandituKey);
  if(tdTried===src) return cb(false);
  tdTried=src; tdAttempted=true;
  const s=document.createElement('script');
  s.src=src;
  // script 元素的 load 事件在脚本解析失败时也会触发，必须确认所需类真正可用才算成功。
  // onload 时叠加物类可能尚未注册，故轮询等待而非一次判定（见上方 TD_REQUIRED 说明）；
  // 超时单独回一句 why='incomplete'，避免被误诊成网络或风控问题。
  let waited=0;
  const poll=()=>{
    if(tdApiReady()){ tdReady=true; return cb(true); }
    waited+=TD_POLL_MS;
    if(waited>=TD_WAIT_MS){ tdReady=false; return cb(false,'incomplete'); }
    setTimeout(poll,TD_POLL_MS);
  };
  s.onload=poll;
  s.onerror=()=>cb(false);
  document.head.appendChild(s);
}
function drawMapTD(){
  if(!tdReady) return false;
  try{
    if(!tdMap){ tdMap=new T.Map('map-view'); tdMap.centerAndZoom(new T.LngLat(108,34),5); }
    tdMap.clearOverLays();
    const v=visibleChannels(), seen=new Set();
    v.list.forEach(c=>{
      const a=lngLatOf(c,'from'), b=lngLatOf(c,'to'); if(!a||!b) return;
      const isHot=v.hot.has(c.id), isAlt=v.alt.has(c.id);
      tdMap.addOverLay(new T.Polyline([new T.LngLat(a[0],a[1]),new T.LngLat(b[0],b[1])],
        {color:isHot?'#185FA5':(isAlt?'#EF9F27':'#C9C8C3'),weight:isHot?6:(isAlt?3:1),opacity:isHot||isAlt?0.9:0.5}));
    });
    const r=state._res&&state._res.rows;
    if(r&&v.sel>=0){
      r[v.sel].segs.forEach(s=>{
        [s.e.stFrom,s.e.stTo].forEach(st=>{
          if(!st||!ST[st]||seen.has(st)) return; seen.add(st);
          const p=ST[st];
          tdMap.addOverLay(new T.Marker(new T.LngLat(p.lng,p.lat),{icon:new T.Icon({iconUrl:D_HOT,iconSize:new T.Point(14,14)})}));
        });
      });
    }
    Object.keys(PV).forEach(k=>{
      const ll=provLngLat(k); if(!ll||seen.has(k)) return; seen.add(k);
      const onRoute=v.routeNodes.has(k);
      tdMap.addOverLay(new T.Marker(new T.LngLat(ll[0],ll[1]),{icon:new T.Icon({iconUrl:onRoute?D_HOT:D_BASE,iconSize:new T.Point(onRoute?14:9,onRoute?14:9)})}));
    });
    return true;
  }catch(e){ return false; }
}
function showMapFallback(){
  const mv=document.getElementById('map-view'); if(mv) mv.style.display='none';
  const fb=document.getElementById('fallback'); if(!fb) return;
  fb.style.display='block';
  const r=state._res&&state._res.rows;
  let t='<div style="font-weight:600;color:#1F2328;margin-bottom:6px">底图未加载，已降级为网架清单</div>';
  t+='<div style="margin-bottom:12px;line-height:1.7;font-size:11.5px">'+(state.mapProvider==='td'
    ?'天地图未加载：请确认密钥有效且网络可达 api.tianditu.gov.cn。'
    :'腾讯地图需运行环境支持；天地图需你自己的密钥。')+'</div>';
  if(r&&r.length){
    const sel=Math.min(state.sel,r.length-1);
    t+=`<div style="font-weight:600;margin-bottom:6px">选中方案 #${sel+1}　${r[sel].nodes.map(N).join(' → ')}</div>`;
    r[sel].segs.forEach((s,i)=>{
      t+=`<div style="padding:6px 0;border-bottom:.5px solid rgba(0,0,0,.06);line-height:1.6">
        <b>第 ${i+1} 段　${N(s.a)} → ${N(s.b)}</b><br>
        ${s.e.n}　${s.e.kv}　${s.t} 元/MWh　计费线损 ${s.billLossPct}%（物理估算 ${s.e.loss}%）<br>
        <span style="color:#8A8A85">段入口 ${Math.round(s.inMW)} MW　占用 ${s.util!=null?(s.util*100).toFixed(0)+'%':'待补'}</span></div>`;
    });
  }
  t+='<div style="font-weight:600;margin:14px 0 6px">全部通道（'+CH.length+' 条）</div>';
  CH.forEach(c=>{
    const on=r&&r.some(row=>row.edges.some(e=>e.id===c.id))?' ●':'';
    t+=`<div style="padding:3px 0;border-bottom:.5px solid rgba(0,0,0,.06)">${N(c.from)} → ${N(c.to)}　${c.n}　${c.regional?'送出省参考价 ':''}${c.t==null?'—':c.t+' 元/MWh'}${on}</div>`;
  });
  fb.innerHTML=t;
}

/* 判断当前是否运行在带腾讯地图代理的环境里（WorkBuddy 本地预览）。
   托管到外网后代理不可用，必须改用天地图或内置拓扑图，否则底图会是一片空白。 */
function isProxyEnv(){
  try{
    const h=(typeof location!=='undefined'&&location.hostname)||'';
    const cfg=window._TMapSecurityConfig||{};
    return /^(127\.0\.0\.1|localhost)$/.test(h)
      && typeof cfg.serviceHost==='string' && cfg.serviceHost.indexOf('__WB_HTTP_PORT__')<0;
  }catch(e){ return false; }
}

/* 内置拓扑图：纯 SVG，不依赖任何外部地图服务，离线与托管环境均可用。
   按站点经纬度做等距圆柱投影，只画节点与连线，不绘制任何行政区划边界。 */
function topoSVG(){
  const ids=Object.keys(PV);
  const lngs=ids.map(k=>PV[k].lng), lats=ids.map(k=>PV[k].lat);
  const lngMin=Math.min(...lngs)-1.2, lngMax=Math.max(...lngs)+1.2;
  const latMin=Math.min(...lats)-1.6, latMax=Math.max(...lats)+1.6;
  const W=660,H=430,PAD=14;
  const kx=Math.cos((latMin+latMax)/2*Math.PI/180);
  const w=(lngMax-lngMin)*kx, hgt=(latMax-latMin);
  const s=Math.min((W-2*PAD)/w,(H-2*PAD)/hgt);
  const ox=PAD+((W-2*PAD)-w*s)/2, oy=PAD+((H-2*PAD)-hgt*s)/2;
  const P=(lng,lat)=>[ox+(lng-lngMin)*kx*s, oy+(latMax-lat)*s];
  const ll=(ch,side)=>{
    const st=side==='from'?ch.stFrom:ch.stTo, pv=side==='from'?ch.from:ch.to;
    return (st&&ST[st])?[ST[st].lng,ST[st].lat]:[PV[pv].lng,PV[pv].lat];
  };

  const v=visibleChannels();
  const r=state._res&&state._res.rows;
  const selR=(r&&v.sel>=0)?r[v.sel]:null;
  const inRoutes=new Set();
  if(r) r.forEach(row=>row.edges.forEach(e=>inRoutes.add(e.id)));

  let edges='',segs='',nodes='',labels='';
  // 底图连线：全部通道
  CH.forEach(c=>{
    if(v.hot.has(c.id)) return;
    const a=ll(c,'from'), b=ll(c,'to');
    const [x1,y1]=P(a[0],a[1]), [x2,y2]=P(b[0],b[1]);
    const isAlt=v.alt.has(c.id);
    edges+=`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${isAlt?'#EF9F27':'#D3D1C7'}" stroke-width="${isAlt?1.6:0.7}" opacity="${isAlt?0.85:0.75}"/>`;
  });
  // 选中路线：加粗并编号
  if(selR){
    selR.segs.forEach((sg,i)=>{
      const a=ll(sg.e,'from'), b=ll(sg.e,'to');
      const [x1,y1]=P(a[0],a[1]), [x2,y2]=P(b[0],b[1]);
      segs+=`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/>`;
      segs+=`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#185FA5" stroke-width="3.2" stroke-linecap="round"/>`;
      const mx=(x1+x2)/2, my=(y1+y2)/2;
      segs+=`<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="8.5" fill="#185FA5"/>`
          + `<text x="${mx.toFixed(1)}" y="${my.toFixed(1)}" fill="#ffffff" font-size="10" font-weight="600" text-anchor="middle" dominant-baseline="central">${i+1}</text>`;
    });
  }
  // 节点
  ids.forEach(k=>{
    const [x,y]=P(PV[k].lng,PV[k].lat);
    const onRoute=v.routeNodes.has(k);
    const isEnd=selR&&(k===selR.nodes[0]||k===selR.nodes[selR.nodes.length-1]);
    const rad=isEnd?6:(onRoute?4.6:2.6);
    const fill=isEnd?'#0F6E56':(onRoute?'#185FA5':'#B4B2A9');
    nodes+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad}" fill="${fill}" stroke="#ffffff" stroke-width="1.3"/>`;
    labels+=`<text x="${x.toFixed(1)}" y="${(y-rad-3).toFixed(1)}" font-size="${onRoute?10.5:9}" font-weight="${onRoute?600:400}" fill="${onRoute?'#0C447C':'#9A9A95'}" text-anchor="middle">${esc(N(k))}</text>`;
  });
  // 选中路线的换流站
  let sts='';
  if(selR){
    const seen=new Set();
    selR.segs.forEach(sg=>{
      [['from',sg.e.stFrom],['to',sg.e.stTo]].forEach(([side,st])=>{
        if(!st||!ST[st]||seen.has(st)) return; seen.add(st);
        const [x,y]=P(ST[st].lng,ST[st].lat);
        sts+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" fill="#ffffff" stroke="#0F6E56" stroke-width="2"/>`
           + `<text x="${x.toFixed(1)}" y="${(y-7).toFixed(1)}" font-size="9" font-weight="600" fill="#0F6E56" text-anchor="middle">${esc(ST[st].n)}</text>`;
      });
    });
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" role="img" xmlns="http://www.w3.org/2000/svg">
<title>跨省电网拓扑图</title><desc>按站点经纬度投影的节点连线图，仅示拓扑不绘制行政区划边界。</desc>
<rect x="0" y="0" width="${W}" height="${H}" fill="#F7F8FA" rx="10"/>
${edges}${segs}${nodes}${sts}${labels}
</svg>`;
}

/* ---------- 网架视图 ---------- */
const MAP_MODES=[['svg','拓扑图'],['qq','腾讯地图'],['td','天地图']];
function renderMap(){
  mapReady=false; map=null; polyLayer=null; mkLayer=null; lbLayer=null; tdMap=null;
  const proxyOK=isProxyEnv();
  // 托管环境下腾讯地图代理不可用，自动退回内置拓扑图
  if(state.mapProvider==='qq' && !proxyOK) state.mapProvider='svg';
  const mode=MAP_MODES.some(m=>m[0]===state.mapProvider)?state.mapProvider:'svg';
  const r=state._res&&state._res.rows;
  const selR=(r&&r.length)?r[Math.min(state.sel,r.length-1)]:null;

  let out=`<div class="card tight">
    <div class="sec-title">跨省网架<span class="hint">${CH.length} 条通道 · ${Object.keys(ST).length} 个站点</span></div>
    <div class="seg small">${MAP_MODES.map(([k,t])=>`<button class="${mode===k?'on':''}" onclick="switchMap('${k}')">${t}</button>`).join('')}</div>`;

  if(!proxyOK && mode!=='svg'){
    out+=`<div class="warn" style="margin-bottom:10px">当前环境无法使用腾讯地图代理（该底图仅在本机预览时可用）。天地图需要你在下方填入自己的密钥。</div>`;
  }
  if(mode==='td'){
    out+=`<label class="f"><span>天地图密钥（tk）</span>
      <div class="tk-wrap"><input id="i-tk" type="${tkVis?'text':'password'}" value="${esc(state.tiandituKey||'')}" placeholder="在天地图开放平台申请后粘贴到这里" autocomplete="off" spellcheck="false">
        <button type="button" class="tk-eye" onclick="toggleTkVis()" aria-label="${tkVis?'隐藏密钥':'显示密钥'}" title="${tkVis?'隐藏密钥':'显示密钥'}">${tkVis?SVG_EYE_OFF:SVG_EYE}</button>
      </div></label>
      <div class="row2" style="margin-bottom:10px">
        <button class="btn ghost" onclick="applyTk()">应用密钥</button>
        <button class="btn ghost" onclick="window.open('https://cloudcenter.tianditu.gov.cn/center/development/myApp','_blank')">去申请密钥</button>
      </div>
      <div id="tk-msg" class="note" style="margin:0 0 10px"></div>
      <p class="note">密钥需在 <b>天地图开放平台</b> 注册/登录后申请：进入「应用管理 → 创建应用」，应用类型选「浏览器端」即可获取密钥。密钥默认掩码显示，点右侧小眼睛可见；仅存本机，代码中不内嵌任何有效密钥。</p>`;
  }
  if(mode==='svg'){
    out+=`<p class="note" style="margin:0 0 8px">内置拓扑图，不依赖任何外部地图服务，离线与托管环境均可用。节点按站点经纬度定位，仅示拓扑关系，不绘制行政区划边界。</p>`;
  }

  out+=`<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:10.5px;color:var(--ink2);margin:8px 0">
      <span><i style="display:inline-block;width:16px;height:3px;background:#185FA5;vertical-align:middle;margin-right:5px"></i>选中方案</span>
      <span><i style="display:inline-block;width:16px;height:3px;background:#EF9F27;vertical-align:middle;margin-right:5px"></i>其它候选</span>
      <span><i style="display:inline-block;width:16px;height:3px;background:#D3D1C7;vertical-align:middle;margin-right:5px"></i>全网架</span>
    </div>
    <div id="map-view"></div><div id="fallback"></div>`;

  if(selR){
    out+=`<div style="margin-top:11px;padding-top:11px;border-top:.5px solid var(--line2)">
      <div style="font-size:12.5px;font-weight:600;margin-bottom:6px">选中方案 #${state.sel+1}　${esc(selR.nodes.map(N).join(' → '))}</div>
      ${selR.segs.map((s,i)=>`<div style="font-size:11px;color:var(--ink2);padding:4px 0;border-bottom:.5px solid var(--line2);line-height:1.6">
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
    if(state.mapProvider!==mode) return; // 80ms 内用户已切换底图则放弃本次注入，避免迟到回调污染新容器
    if(mode==='svg'){
      const box=document.getElementById('map-view');
      if(box){ box.className='topo-svg'; box.style.background='transparent'; box.style.border='0'; box.style.borderRadius='10px'; box.style.overflow='hidden'; box.innerHTML=topoSVG(); }
      const fb=document.getElementById('fallback'); if(fb) fb.style.display='none';
    } else if(mode==='qq'){
      if(!drawMapQQ()) showMapFallback();
    } else {
      loadTianditu((ok,why)=>{
        if(ok&&drawMapTD()) tkMsg('ok');
        else { showMapFallback(); tkMsg(ok?'drawfail':(why||(state.tiandituKey?'loadfail':'empty'))); }
      });
    }
  },80);
}
function switchMap(p){
  // REQ-703：不可用底图必须给出明确反馈，不得静默回退（真机 APK 以 file:// 加载，
  // isProxyEnv 恒为 false，点击「腾讯地图」必然走到这里）。原生 confirm 在 WebView 中
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
  const changed=(k!==state.tiandituKey);
  state.tiandituKey=k; tdReady=false; saveMap();
  const cooling=(!changed && k && Date.now()<tdCooldownUntil);
  if(changed){ tdTried=''; tdCooldownUntil=0; }
  if(!cooling) tdTried='';
  renderMap();
  // 点击后立刻给出可见反馈（REQ-703 同理：不得静默无响应），随后的加载结果再覆盖；
  // 冷却期内不发请求，80ms 后由 tkFailShow 给出剩余等待时间
  if(!cooling) tkMsg(k?'loading':'empty');
}
/* 密钥应用的各阶段反馈：loading/ok/empty/loadfail/drawfail。
   script 标签拿不到 HTTP 状态码（天地图无 CORS 头），失败时给出排查清单而非单一定性。 */
function tkMsg(kind){
  const el=document.getElementById('tk-msg'); if(!el) return;
  if(kind==='ok'){ el.innerHTML='<span style="color:#0F6E56;font-weight:600">✓ 密钥已应用，天地图加载成功。</span>'; tdTileProbe(el); return; }
  if(kind==='loading'){ el.innerHTML='<span style="color:var(--ink2)">密钥已保存到本机，正在加载天地图 API…</span>'; return; }
  if(kind==='empty'){ el.innerHTML='<span style="color:#B3261E;font-weight:600">✗ 尚未填入密钥：请先在上方粘贴天地图 tk，再点「应用密钥」。</span>'; return; }
  if(kind==='drawfail'){ el.innerHTML='<span style="color:#B3261E;font-weight:600">✗ 密钥已通过校验，但底图渲染失败（天地图 API 兼容性问题），已降级为网架清单。</span>'; return; }
  if(kind==='incomplete'){ el.innerHTML='<span style="color:#B3261E;font-weight:600">✗ 天地图 SDK 已下载，但组件注册不完整（缺 T.Label 等叠加物）。</span>请刷新页面重试；若持续出现，说明 SDK 版本有变。已降级为网架清单。'; return; }
  tkFailDiagnose(el);
}
/* 瓦片自检：叠加物（线路/圆点）正常而底图全灭时肉眼难辨原因。按 SDK 此刻将用的协议
   探测一张真实 vec_w 瓦片——no-cors 拿不到状态码（天地图无 CORS 头），仅区分
   「传输可达」与「连接被禁/不通」，把失败定性直接显示在界面上，供真机截图定位。 */
function tdTileProbe(el){
  try{
    if(typeof T==='undefined'||!T.Protocol) return;
    const tk=state.tiandituKey||window.TMAP_AUTHKEY||'';
    const url=T.Protocol.value+'t0.tianditu.'+(T.Domain||'gov.cn')
      +'/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default'
      +'&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX=5&TILEROW=1&TILECOL=1&tk='+encodeURIComponent(tk);
    const done=txt=>{ if(document.getElementById('tk-msg')!==el) return;
      el.innerHTML=el.innerHTML.replace(/ ?｜瓦片自检：[^<]*/,'')+' <span style="color:var(--ink3)">｜瓦片自检：'+txt+'</span>'; };
    fetch(url,{mode:'no-cors'}).then(
      ()=>done(T.Protocol.value==='https://'?'https 通道传输正常':'异常：瓦片仍走非 https'),
      ()=>done(T.Protocol.value!=='https://'?'明文 http 被系统禁止（应走 https）':'网络不可达'));
  }catch(e){}
}
/* 加载失败二分诊断：script 标签拿不到状态码（天地图无 CORS 头），改用 no-cors fetch 探测——
   fetch 成功＝服务端有响应（密钥/白名单/风控拒绝，ORB 拦掉了非 JS 内容）；
   fetch 失败＝传输层不通（代理/防火墙/DNS）。 */
function tkFailDiagnose(el){
  if(typeof location!=='undefined'&&location.protocol==='file:'){
    el.innerHTML='<span style="color:#B3261E;font-weight:600">✗ 天地图 API 加载失败。</span>file:// 直开发不出 Referer，请改为 http 访问。已降级为网架清单。';
    return;
  }
  if(!tdAttempted){ tkFailShow(el, tdFailKind, false); return; }  // 本次未发新请求：沿用上次诊断，不额外探测
  el.innerHTML='<span style="color:var(--ink2)">✗ 天地图 API 加载失败，正在区分原因…</span>';
  let probe;
  try{ probe=fetch('https://api.tianditu.gov.cn/api?v=4.0',{mode:'no-cors'}); }
  catch(e){ probe=Promise.reject(e); }
  const done=k=>{ if(document.getElementById('tk-msg')===el) tkFailShow(el, k, true); };
  probe.then(()=>{ tdFailKind='server'; tdCooldownUntil=Date.now()+TD_COOLDOWN_MS; done('server'); },()=>{ tdFailKind='net'; done('net'); });
}
function tkFailShow(el, kind, fresh){
  if(kind==='server'){
    el.innerHTML = (!fresh && Date.now()<tdCooldownUntil)
      ? '<span style="color:#B3261E;font-weight:600">✗ 天地图风控拦截仍未解除。</span>反复重试会延长封禁，请安静等待约 '+Math.ceil((tdCooldownUntil-Date.now())/60000)+' 分钟后再点「应用密钥」。已降级为网架清单。'
      : '<span style="color:#B3261E;font-weight:600">✗ 天地图服务端拦截了本次请求（临时风控封禁）。</span>静置 30 分钟以上再点「应用密钥」重试一次，期间勿反复点击。已降级为网架清单。';
    return;
  }
  el.innerHTML = '<span style="color:#B3261E;font-weight:600">✗ 本机网络到不了 api.tianditu.gov.cn。</span>若开了代理，请将其设为直连或暂时关闭。已降级为网架清单。';
}
