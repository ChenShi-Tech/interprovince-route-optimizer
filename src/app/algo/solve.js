/* 求解编排：把输入与数据组装成一次完整测算。
 *
 * 这是算法层唯一的入口，也是安卓端需要复刻的全部逻辑：
 *   solve(input, data) -> { rows, byA, byB, byC, bestA, bestB, bestC, ... } 或 { err }
 *
 * 流程：建图 → 枚举简单路径 → 绕行度筛选 → 逐条精确计价 → 三口径排序 → 可行性过滤。
 *
 * input 契约（全部来自用户输入）：
 *   from, to            送端 / 受端省代码
 *   qty, hours          电量 MWh / 时段 h
 *   pGen, pDst          送端出清价 / 受端结算价 元/MWh
 *   pNet, fund          受端省网输配电价 / 政府性基金及附加 元/MWh
 *   lossBearer          网损承担比例（受端承担 1 / 各半 0.5 / 送端承担 0）
 *   maxHops, maxDetour  跳数上限 / 绕行度上限
 *   includeRegion       是否计入区域电网费
 *   includeDstCost      是否计入受端省内费用（false = 只算到受端省界）
 *   sortBy, showBad     排序口径（A/B/C）/ 是否显示越限方案
 *
 * data 契约（静态数据）：
 *   CH, PV, SEC, RG, REGION_OF, geo, name
 */
const ENUM_CAP = 800;   // 枚举上限：防止组合爆炸，同时保证低成本方案优先生成

function solve(input, data){
  const env={
    REGION_OF: data.REGION_OF,
    RG: data.RG,
    LOSS_OF: data.LOSS_OF || {},
    SEC: data.SEC,
    geo: data.geo,
    includeRegion: input.includeRegion !== false,
    pGen: input.pGen,
  };
  const ctx={
    pGen: input.pGen, pDst: input.pDst, pNet: input.pNet, fund: input.fund,
    lossBearer: input.lossBearer, qty: input.qty, hours: input.hours,
    includeDstCost: input.includeDstCost !== false,
  };
  const { from, to } = input;
  const N = data.name;

  if(!data.PV[from] || !data.PV[to]) return {err:'省份代码无效'};
  if(from === to) return {err:'送端与受端不能相同'};

  const adj = buildAdj(data.CH);
  if(!adj[from]) return {err:N(from)+' 暂无接入的跨省通道'};

  const maxHops = input.maxHops;
  const raw = enumPaths(adj, from, to, maxHops, ENUM_CAP,
    (nb,u)=>approxW(env, nb.e, u, nb.to));
  if(!raw.length){
    return {err:'在 '+maxHops+' 段以内没有 '+N(from)+' 到 '+N(to)+' 的连通路径，请放宽跳数上限'};
  }
  const truncated = raw.length >= ENUM_CAP;

  const maxDetour = input.maxDetour;
  const kept = raw.filter(p=>detourOf(p.nodes, p.edges, env.geo) <= maxDetour);
  if(!kept.length) return {err:'绕行度上限把所有候选都筛掉了，请放宽绕行度上限'};

  const rows = kept.map(p=>evalPath(p, ctx, env));
  rows.forEach(r=>{ r.tagLabel = tagOf(r, N); });

  // 三口径各自排名（在任何过滤之前算，保证「与最优差多少」是全局口径）
  const byA=[...rows].sort((a,b)=>a.landed-b.landed);
  const byB=[...rows].sort((a,b)=>a.channelOnly-b.channelOnly);
  const byC=[...rows].sort((a,b)=>b.senderNet-a.senderNet);
  rows.forEach(r=>{r.rankA=byA.indexOf(r)+1;r.rankB=byB.indexOf(r)+1;r.rankC=byC.indexOf(r)+1;});
  const bestA=byA.find(r=>r.feasible)||byA[0];
  const bestB=byB.find(r=>r.feasible)||byB[0];
  const bestC=byC.find(r=>r.feasible)||byC[0];

  const total = rows.length;
  const feasibleCount = rows.filter(r=>r.feasible).length;
  const cmp = input.sortBy==='B' ? (a,b)=>a.channelOnly-b.channelOnly
    : input.sortBy==='C' ? (a,b)=>b.senderNet-a.senderNet
    : (a,b)=>a.landed-b.landed;
  rows.sort((a,b)=> a.feasible===b.feasible ? cmp(a,b) : (a.feasible?-1:1));

  let shown = rows;
  if(!input.showBad) shown = rows.filter(r=>r.feasible);
  if(!shown.length){
    return {err:'全部 '+total+' 条候选路线均超出通道容量或断面限额，可勾选「显示越限方案」查看'};
  }
  return {rows:shown,byA,byB,byC,bestA,bestB,bestC,n:shown.length,total,feasibleCount,truncated};
}

/** 方案的短标签：单段用线路名，多段用途经省。 */
function tagOf(r, N){
  const mid=r.nodes.slice(1,-1);
  r.leadLine=r.edges[0].n;
  r.via = mid.length ? '经'+mid.map(N).join('、') : '';
  return r.leadLine;
}
