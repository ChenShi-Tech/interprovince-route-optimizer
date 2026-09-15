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

function loadTianditu(cb){
  if(tdReady) return cb(true);
  if(typeof T!=='undefined'&&T.Map){ tdReady=true; return cb(true); }
  if(!state.tiandituKey) return cb(false);
  const s=document.createElement('script');
  s.src='https://api.tianditu.gov.cn/api?v=4.0&tk='+encodeURIComponent(state.tiandituKey);
  s.onload=()=>{ tdReady=true; cb(true); };
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
          tdMap.addOverLay(new T.Marker(new T.LngLat(p.lat,p.lng),{icon:new T.Icon({iconUrl:D_HOT,iconSize:new T.Point(14,14)})}));
          tdMap.addOverLay(new T.Label({text:p.n,position:new T.LngLat(p.lat,p.lng),offset:new T.Point(0,-14)}));
        });
      });
    }
    Object.keys(PV).forEach(k=>{
      const ll=provLngLat(k); if(!ll||seen.has(k)) return; seen.add(k);
      const onRoute=v.routeNodes.has(k);
      tdMap.addOverLay(new T.Marker(new T.LngLat(ll[0],ll[1]),{icon:new T.Icon({iconUrl:onRoute?D_HOT:D_BASE,iconSize:new T.Point(onRoute?14:9,onRoute?14:9)})}));
      tdMap.addOverLay(new T.Label({text:N(k),position:new T.LngLat(ll[0],ll[1]),offset:new T.Point(0,-12)}));
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
  t+='<div style="margin-bottom:12px;line-height:1.7;font-size:11.5px">腾讯地图需运行环境支持；天地图需你自己的密钥。</div>';
  if(r&&r.length){
    const sel=Math.min(state.sel,r.length-1);
    t+=`<div style="font-weight:600;margin-bottom:6px">选中方案 #${sel+1}　${r[sel].nodes.map(N).join(' → ')}</div>`;
    r[sel].segs.forEach((s,i)=>{
      t+=`<div style="padding:6px 0;border-bottom:.5px solid rgba(0,0,0,.06);line-height:1.6">
        <b>第 ${i+1} 段　${N(s.a)} → ${N(s.b)}</b><br>
        ${s.e.n}　${s.e.kv}　${s.e.t} 元/MWh　线损 ${s.e.loss}%<br>
        <span style="color:#8A8A85">段入口 ${Math.round(s.inMW)} MW　占用 ${s.util!=null?(s.util*100).toFixed(0)+'%':'待补'}</span></div>`;
    });
  }
  t+='<div style="font-weight:600;margin:14px 0 6px">全部通道（'+CH.length+' 条）</div>';
  CH.forEach(c=>{
    const on=r&&r.some(row=>row.edges.some(e=>e.id===c.id))?' ●':'';
    t+=`<div style="padding:3px 0;border-bottom:.5px solid rgba(0,0,0,.06)">${N(c.from)} → ${N(c.to)}　${c.n}　${c.t==null?'—':c.t+' 元/MWh'}${on}</div>`;
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

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" xmlns="http://www.w3.org/2000/svg">
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
      <input id="i-tk" type="text" value="${esc(state.tiandituKey||'')}" placeholder="在天地图开放平台申请后粘贴到这里"></label>
      <div class="row2" style="margin-bottom:10px">
        <button class="btn ghost" onclick="applyTk()">应用密钥</button>
        <button class="btn ghost" onclick="window.open('https://console.tianditu.gov.cn/api/key','_blank')">去申请密钥</button>
      </div>
      <p class="note">天地图密钥需你在 <b>天地图开放平台</b> 注册后自行申请，应用类型选「浏览器端」，并把本页面域名加入白名单。密钥仅存本机，代码中不内嵌任何有效密钥。</p>`;
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
        <b style="color:var(--blue-ink)">${i+1}</b>　${esc(s.e.n)}　${esc(s.e.kv)}　${fmt(s.e.t)} 元/MWh　线损 ${fmt(s.e.loss,2)}%
        <span style="color:var(--ink3)">｜入口 ${fmt(s.inMW,0)} MW　${s.util!=null?'占用 '+fmt(s.util*100,0)+'%':'容量待补'}</span>
      </div>`).join('')}
    </div>`;
  }
  out+=`<p class="note" style="margin-top:10px">站点位置为县/市级近似（精确站址见费率库中各通道的送受端地址）。落点未采集的通道以省会位置示意。</p></div>`;

  out+=`<div class="card tight"><div class="sec-title">通道费用分布<span class="hint">按输电价升序</span></div>
    <table><tr><th style="width:40%">通道</th><th>输电价</th><th>线损</th><th>容量</th></tr>
    ${[...CH].filter(c=>c.t!=null).sort((a,b)=>a.t-b.t).map(c=>`<tr>
      <td>${esc(c.n)}<br><span style="color:var(--ink3);font-size:10.5px">${esc(N(c.from))}→${esc(N(c.to))}</span></td>
      <td>${fmt(c.t)}</td><td>${fmt(c.loss,2)}%</td><td>${c.cap||'待补'}</td></tr>`).join('')}</table>
  </div>`;

  document.getElementById('v-map').innerHTML=out;
  setTimeout(()=>{
    if(mode==='svg'){
      const box=document.getElementById('map-view');
      if(box){ box.className=''; box.style.background='transparent'; box.style.border='0'; box.style.borderRadius='10px'; box.style.overflow='hidden'; box.innerHTML=topoSVG(); }
      const fb=document.getElementById('fallback'); if(fb) fb.style.display='none';
    } else if(mode==='qq'){
      if(!drawMapQQ()) showMapFallback();
    } else {
      loadTianditu(ok=>{ if(ok){ if(!drawMapTD()) showMapFallback(); } else showMapFallback(); });
    }
  },80);
}
function switchMap(p){ state.mapProvider=p; saveMap(); renderMap(); }
function applyTk(){ const el=document.getElementById('i-tk'); state.tiandituKey=(el?el.value:'').trim(); tdReady=false; saveMap(); renderMap(); }
