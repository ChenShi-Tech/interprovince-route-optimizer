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
 *   mustHave            必经通道 id 数组（「通道组件」筛选），空数组或缺失 = 不筛选
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

  // 「通道组件」候选集：取自绕行度筛选后的**完整候选**，不能用最终 rows。
  // 否则用户选中某组件后其余组件会从选择器里消失、再也点不回来。
  const availChannels = collectChannels(kept);

  // 必经组件筛选：所选通道须全部出现在路径里（不区分行进方向，方向由通道自身 bidir 决定）
  // 旧存档里的组件 id 可能已不存在，先按当前通道表过滤，避免筛出空结果。
  const validIds = new Set(data.CH.map(c=>c.id));
  const mustHave = (input.mustHave||[]).filter(id=>validIds.has(id));
  const picked = mustHave.length
    ? kept.filter(p=>mustHave.every(id=>p.edges.some(e=>e.id===id)))
    : kept;
  if(!picked.length){
    return {err:'没有任何方案同时包含所选的 '+mustHave.length+' 个通道组件，请减少组件或放宽跳数上限',
      availChannels, mustHave, totalAll:kept.length};
  }

  const rows = picked.map(p=>evalPath(p, ctx, env));
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
  return {rows:shown,byA,byB,byC,bestA,bestB,bestC,n:shown.length,total,feasibleCount,truncated,
    availChannels,mustHave,totalAll:kept.length};
}

/** 「通道组件」选择器的候选清单：候选路径里出现过的通道，每条只列一项。
 *  直流（专项工程）排在前，同类按出现次数降序 —— 出现得多说明它是绕不开的主干通道。
 *  dirs 记录该通道在候选里出现过的行进方向，供界面提示「仅单向」还是「两方向都有」。
 *  直流可直接作为组件挑选（用户要求的用法），交流联络线同样可挑，语义一致。 */
function collectChannels(paths){
  const byId = new Map();
  for(const p of paths){
    for(let i=0;i<p.edges.length;i++){
      const e = p.edges[i];
      let rec = byId.get(e.id);
      if(!rec){
        rec = { id:e.id, n:e.n, type:e.type, kv:e.kv, from:e.from, to:e.to,
                tier:e.tier, bidir:!!e.bidir, count:0, dirs:[] };
        byId.set(e.id, rec);
      }
      rec.count++;
      const d = p.nodes[i]+'>'+p.nodes[i+1];
      if(rec.dirs.indexOf(d) < 0) rec.dirs.push(d);
    }
  }
  const rank = (t)=> t==='DC' ? 0 : (t==='AC/DC' ? 1 : 2);
  return [...byId.values()].sort((a,b)=>
    rank(a.type)!==rank(b.type) ? rank(a.type)-rank(b.type) : b.count-a.count);
}

/** 方案的短标签：单段用线路名，多段用途经省。 */
function tagOf(r, N){
  const mid=r.nodes.slice(1,-1);
  r.leadLine=r.edges[0].n;
  r.via = mid.length ? '经'+mid.map(N).join('、') : '';
  return r.leadLine;
}
