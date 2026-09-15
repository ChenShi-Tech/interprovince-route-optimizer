/* 图结构与几何工具。
 *
 * 纯函数：不读取任何全局状态。经纬度访问通过 geo 参数注入，
 * 便于 Android 端复用同一份实现。
 *
 * geo 契约：{ lngLatOf(channel, 'from'|'to') -> [lng,lat] | null,
 *            provLngLat(provinceCode)        -> [lng,lat] | null }
 */

/** 由通道数组构建无向邻接表。同一条通道会以两个方向各挂一次。 */
function buildAdj(edges){
  const adj={};
  edges.forEach(e=>{
    (adj[e.from]||(adj[e.from]=[])).push({to:e.to,e});
    (adj[e.to]||(adj[e.to]=[])).push({to:e.from,e});
  });
  return adj;
}

/** 路径的唯一标识。
 *  ⚠️ 必须用节点序列，不能用边对象的 from/to —— 对向通行的边，
 *  其存储方向与行进方向相反，用边拼键会把 A→B→C 与 C→B→A 误判为同一条。 */
function keyOf(nodes){ return nodes.join('>'); }

/** 经纬度近似距离（度数，已按纬度余弦修正）。 */
function distDeg(a,b){
  const dx=(a[0]-b[0])*Math.cos((a[1]+b[1])/2*Math.PI/180), dy=a[1]-b[1];
  return Math.sqrt(dx*dx+dy*dy);
}

/** 两点大圆距离，单位 km。 */
function havKm(a,b){
  if(!a||!b) return 0;
  const R=6371, r=Math.PI/180;
  const dp=(b[1]-a[1])*r, dl=(b[0]-a[0])*r;
  const s=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(dl/2)*Math.sin(dl/2);
  return 2*R*Math.asin(Math.min(1,Math.sqrt(s)));
}

/** 绕行度 = 路径实际里程 ÷ 起终点直线距离。
 *  用于剔除「绕行大半个中国」的荒谬组合；单段路径恒为 1。 */
function detourOf(nodes, edges, geo){
  if(nodes.length<3) return 1;
  let d=0;
  for(let i=0;i<edges.length;i++){
    const a=geo.lngLatOf(edges[i],'from'), b=geo.lngLatOf(edges[i],'to');
    if(a&&b) d+=distDeg(a,b);
  }
  const s=distDeg(geo.lngLatOf(edges[0],'from')||geo.provLngLat(nodes[0]), geo.provLngLat(nodes[nodes.length-1]));
  return s<1e-6?1:d/s;
}
