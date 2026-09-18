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
 *   pGen                送端报价 元/MWh
 *   pDst                可选：受端目标交付价 元/MWh；缺省时不反推可接受送端报价（senderNet=null，不产出 byC）
 *   pNet, fund          受端省网输配电价 / 政府性基金及附加 元/MWh
 *   lossBearer          网损承担比例（受端承担 1 / 各半 0.5 / 送端承担 0）
 *   maxHops             跳数上限（1～MAX_HOPS）
 *   maxDetour           可选：绕行度上限；null / 缺省 = 不限
 *   includeRegion       是否计入区域电网费
 *   includeDstCost      是否计入受端省内费用（false = 只算到受端省界）
 *   sortBy, showBad     排序口径（A/B/C）/ 是否显示越限方案
 *   mustHave            必经通道 id 数组（「通道组件」筛选），空数组或缺失 = 不筛选
 *   以下均为可选，缺省时与旧口径完全一致：
 *   dstInLossPct        受端省内上网环节线损率 %（按所选受端电网主体，覆盖省默认值）；另计线损费用
 *   dstQtyLossPct       可选：仅用于终端电量折算的受端上网环节线损率 %。受端主体电价已含线损费用时
 *                       （如深圳，1077号附件1 第22页注2）使用：终端电量按 (1-ρ) 折算，不单列线损费用行。
 *                       省界及以前各项的金额仍按节点交付电量实付（单价改按到户电量表述），
 *                       landed = 省界价/(1-ρ) + 受端各项。缺省（不传）时与旧口径完全一致。
 *   dstBilling          受端计价方式 'single' | 'twopart'（只用于缺项提示，输配电价仍由 pNet 传入）
 *   dstCapFee           两部制容（需）量电费分摊 元/到户MWh（用户负荷假设下的估算）
 *   dstSysOpFee         系统运行费 元/到户MWh（手填；null = 缺项）
 *   srcSendFee          送端电站专属送出价 元/MWh（覆盖通用送出省输电价格）
 *   srcExportLossPct    与之配套的送省外上网环节线损率 %（覆盖省默认值）
 *   srcSendNote         专属送出价的范围说明（进入适用条件提示）
 *
 * data 契约（静态数据）：
 *   CH, PV, SEC, RG, REGION_OF, geo, name
 */
const ENUM_CAP = 800;   // 枚举上限：防止组合爆炸，同时保证低成本方案优先生成
const MAX_HOPS = 10;    // 跳数硬上限：界面固定取此值，不再提供选项（2026-09-17 全省对实测未触发 ENUM_CAP）
const PROBE_CAP = 16;   // 单通道可达性探测的取数上限：只用于补全候选集/通道清单，远小于主枚举上限

function solve(input, data){
  if(input.marketMode && input.marketMode!=='mlt') return {err:'省间现货入口待拓展，当前仅提供中长期交付成本与报价测算'};
  const env={
    REGION_OF: data.REGION_OF,
    RG: data.RG,
    LOSS_OF: data.LOSS_OF || {}, RLOSS:data.RLOSS || {},
    SEC: data.SEC,
    geo: data.geo,
    includeRegion: input.includeRegion !== false,
    buyerRegionRequired: input.regionChargeMode==='buyer',
    sourceQuote: input.sourceQuote || 'plant',
    pGen: input.pGen,
    source: input.from,
    srcSendFee: input.srcSendFee ?? null,
  };
  const ctx={
    pGen: input.pGen, pDst: input.pDst ?? null, pNet: input.pNet, fund: input.fund,
    lossBearer: input.lossBearer, qty: input.qty, hours: input.hours,
    includeDstCost: input.includeDstCost !== false,
    sourceQuote: input.sourceQuote || 'plant', originLossMode: input.originLossMode || 'included',
    regionLossMode:input.regionLossMode||'exclude', regionLossRates:input.regionLossRates||{},
    occPct: Math.min(90, Math.max(0, +input.occPct || 0)),   // REQ-302：中长期占用 %
    dstInLossPct: input.dstInLossPct ?? null, dstQtyLossPct: input.dstQtyLossPct ?? null,
    dstCapFee: input.dstCapFee ?? 0, dstSysOpFee: input.dstSysOpFee ?? null,
    srcSendFee: input.srcSendFee ?? null, srcExportLossPct: input.srcExportLossPct ?? null,
  };
  const { from, to } = input;
  const N = data.name;

  if(!['plant','export'].includes(ctx.sourceQuote)||!['included','separate'].includes(ctx.originLossMode)||!['network','buyer'].includes(input.regionChargeMode||'network')) return {err:'报价边界或区域计费模式无效'};

  if(!data.PV[from] || !data.PV[to]) return {err:'省份代码无效'};
  if(from === to) return {err:'送端与受端不能相同'};

  for(const k of ['qty','hours','pGen','lossBearer','maxHops']){
    if(!Number.isFinite(input[k])) return {err:'参数 '+k+' 必须为有限数值'};
  }
  // 可选参数：缺省表示不反推 / 不限绕行，但给了就必须是有限数值
  for(const k of ['pDst','maxDetour']){
    if(input[k]!=null && !Number.isFinite(input[k])) return {err:'参数 '+k+' 必须为有限数值'};
  }
  const hasDst = input.pDst!=null;
  for(const k of ['dstInLossPct','dstQtyLossPct','srcExportLossPct']){
    if(input[k]!=null && (!Number.isFinite(input[k])||input[k]<0||input[k]>=100)) return {err:'参数 '+k+' 须为 0（含）到 100（不含）之间的百分数'};
  }
  for(const k of ['dstCapFee','dstSysOpFee','srcSendFee']){
    if(input[k]!=null && (!Number.isFinite(input[k])||input[k]<0)) return {err:'参数 '+k+' 须为非负有限数值'};
  }
  if(input.dstBilling!=null && !['single','twopart'].includes(input.dstBilling)) return {err:'受端计价方式无效'};
  if(input.qty<=0 || input.hours<0.25) return {err:'电量须大于 0，时长不得小于 0.25 小时'};
  if(input.lossBearer<0 || input.lossBearer>1) return {err:'网损承担比例须在 0 到 1 之间'};
  if(!Number.isInteger(input.maxHops)||input.maxHops<1||input.maxHops>MAX_HOPS||(input.maxDetour!=null&&input.maxDetour<1)) return {err:'路径范围无效'};
  if(input.includeDstCost!==false && (!Number.isFinite(input.pNet)||!Number.isFinite(input.fund))) return {err:'受端输配电价、基金须明确填写；缺项不能静默按零结算'};
  if(!['exclude','historical','custom','verified'].includes(ctx.regionLossMode)) return {err:'区域网损模式无效'};
  if(ctx.regionLossMode==='custom' && Object.values(ctx.regionLossRates).some(v=>v!=null && (!Number.isFinite(v)||v<0||v>=100))) return {err:'区域网损率须为 0（含）到 100（不含）之间的百分数'};
  if(input.occPct!=null && (!Number.isFinite(input.occPct)||input.occPct<0||input.occPct>90)) return {err:'占用比例须在 0 到 90 之间'};
  const date=input.tradeDate || (data.VALIDITY||{}).reviewedAt || '2026-09-17';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date) return {err:'交易日期无效'};
  if(data.VALIDITY && date<data.VALIDITY.provinceFrom) return {err:'当前价库仅支持 2026-08-01 起的价格口径，尚未收录此前完整历史费率'};
  if(input.includeDstCost!==false && data.PV[to].effectiveFrom && date<data.PV[to].effectiveFrom) return {err:N(to)+' 受端输配电价自 '+data.PV[to].effectiveFrom+' 起适用，当前日期不可提前使用；可切换为省间节点交付口径'};
  const invalid=data.CH.find(e=>(e.loss!=null && (!Number.isFinite(e.loss)||e.loss<0||e.loss>=100)) || (e.cap!=null && (!Number.isFinite(e.cap)||e.cap<=0)) || (e.t!=null&&!Number.isFinite(e.t)));
  if(invalid) return {err:'费率库参数无效：'+invalid.n+'，请恢复或修正费率库'};

  // REQ-203：仅按已确认可交易通道——开启后排除 tradable===false 的交流联络线
  // 价格待核通道（南网云广/普侨/高肇/兴安/禄高肇等物理直流，无发改委独立核价文件、
  // 收费并入 842 号「云南送广东」等聚合交易成分）一律不参与枚举：
  // 纳入会按 0 元过网费参与最短路，产出价格虚低的错误方案。清单回传给界面显式提示。
  const pendingChannels = data.CH.filter(c=>c.pricePending)
    .map(c=>({id:c.id, n:c.n, from:c.from, to:c.to, kv:c.kv, reason:'未检索到独立核定输电价格，收费并入对应聚合交易成分'}));
  const CHpool = data.CH.filter(c=>!c.pricePending)
    .filter(c=>(!input.tradableOnly || c.tradable!==false) && (!c.eff || c.eff<=date));
  const adj = buildAdj(CHpool);
  if(!adj[from]) return {err:N(from)+' 暂无接入的跨省通道', pendingChannels};

  const maxHops = input.maxHops;
  // 按跳数由少到多逐层枚举（迭代加深）：单次深度优先在 ENUM_CAP 处截断时，会被零费用的区域联络线排列占满，
  // 直达专项工程反而进不了候选集（2026-09-17 四川→江苏漏掉锦苏直流）。逐层合并保证较少跳数的路径先完整入选。
  const weightOf = (nb,u)=>approxW(env, nb.e, u, nb.to);
  const raw = [], seenPath = new Set();
  let hitCap = false;
  for(let h=1; h<=maxHops; h++){
    // 累计候选已达上限：后续层不再枚举——同样是「提前截断」，只退出不置位会让 truncated 出现假阴性（M3）
    if(raw.length>=ENUM_CAP){ hitCap = true; break; }
    const part = enumPaths(adj, from, to, h, ENUM_CAP, weightOf);
    for(const p of part){
      const k = pathKeyOf(p);
      if(!seenPath.has(k)){ seenPath.add(k); raw.push(p); }
    }
    if(part.hitCap){ hitCap = true; break; }
  }
  if(!raw.length){
    return {err:'在 '+maxHops+' 段以内没有 '+N(from)+' 到 '+N(to)+' 的连通路径', pendingChannels};
  }
  const truncated = hitCap;   // REQ-601：枚举因 cap 提前返回（或在 cap 处停层）时置位

  const maxDetour = input.maxDetour;
  const keepPath = p => maxDetour==null || detourOf(p.nodes, p.edges, env.geo) <= maxDetour;
  const kept = raw.filter(keepPath);
  if(!kept.length) return {err:'绕行度上限把所有候选都筛掉了，请放宽绕行度上限'};

  // H1：主枚举被截断时，候选集里可能整条通道都不出现（availChannels 缺失、mustHave 筛成空）。
  // 对「还没出现过、且跳数上允许经过」的通道做一次单通道浅层枚举，把找到的路径并回候选集：
  // 这样候选清单、下拉最低价与筛选结果都与完整候选集一致，且不抬高 ENUM_CAP（只按通道定向补录）。
  if(truncated){
    const covered = new Set();
    for(const p of kept) for(const e of p.edges) covered.add(e.id);
    const dOut = hopDist(adj, from, maxHops, false), dIn = hopDist(adj, to, maxHops, true);
    for(const c of CHpool){
      if(covered.has(c.id) || !channelCouldFit(c, dOut, dIn, maxHops)) continue;
      const part = enumPathsMust(adj, from, to, maxHops, maxDetour==null?PROBE_CAP:PROBE_CAP*8, weightOf, [c.id]);
      for(const p of part){
        if(!keepPath(p)) continue;
        const k = pathKeyOf(p);
        if(!seenPath.has(k)){ seenPath.add(k); kept.push(p); }
      }
    }
  }

  // 「通道组件」候选集：取自绕行度筛选后的**完整候选**，不能用最终 rows。
  // 否则用户选中某组件后其余组件会从选择器里消失、再也点不回来。
  const availChannels = collectChannels(kept);

  // 必经组件筛选：所选通道须全部出现在路径里（不区分行进方向，方向由通道自身 bidir 决定）
  // 旧存档里的组件 id 可能已不存在，先按当前通道表过滤，避免筛出空结果。
  const validIds = new Set(data.CH.map(c=>c.id));
  const mustHave = (input.mustHave||[]).filter(id=>validIds.has(id));
  let picked = mustHave.length
    ? kept.filter(p=>mustHave.every(id=>p.edges.some(e=>e.id===id)))
    : kept;
  // H1：主枚举截断时，候选集只补录了每个通道的少量路径（PROBE_CAP）。用户明确选中组件时改用
  // 「约束枚举」单独求全部经过它的路径（上限同主枚举），使筛选结果与完整枚举一致，不再返回假阴性。
  if(mustHave.length && truncated){
    const seen = new Set(picked.map(pathKeyOf));
    for(const p of enumPathsMust(adj, from, to, maxHops, ENUM_CAP, weightOf, mustHave)){
      if(!keepPath(p)) continue;
      const k = pathKeyOf(p);
      if(!seen.has(k)){ seen.add(k); picked.push(p); }
    }
  }
  if(!picked.length){
    return {err:'没有任何方案同时包含所选的 '+mustHave.length+' 个通道组件，请减少组件',
      availChannels, mustHave, totalAll:kept.length, pendingChannels};
  }

  // 区域共用网络内部走法不同的路径计费完全相同（同区域交流接口不单独收费、不逐段计损），展示上也合并为「X区域网架」：
  // 按「自有通道 + 区域块」签名只保留一条（参考未越限优先，其次物理估算损耗更低、跳数更少），避免同价方案刷屏
  const sigOf = p => { const parts=[]; p.edges.forEach((e,i)=>{
      const ra=env.REGION_OF[p.nodes[i]], rb=env.REGION_OF[p.nodes[i+1]];
      const tok=(e.regional && e.type==='AC' && ra && ra===rb) ? 'R:'+ra : 'E:'+e.id;
      if(tok[0]!=='R' || parts[parts.length-1]!==tok) parts.push(tok);
    }); return parts.join('|'); };
  const rowsAll = picked.map(p=>{
    const r=applyDstQtyLoss(evalPath(p,ctx,env), ctx);
    r.pricingIssues=pricingIssues(r,input,data,date);
    r.priceComplete=r.pricingIssues.length===0;
    r.regionScenarios=['exclude','historical'].map(mode=>{
      const x=ctx.regionLossMode===mode?r:applyDstQtyLoss(evalPath(p,{...ctx,regionLossMode:mode},env), ctx);
      return {mode,border:x.border,landed:x.landed,D:x.D,amount:x.yuan.total,
        regions:x.regionItems.map(v=>({region:v.region,pct:v.pct,status:v.status})),
        complete:false};
    });
    return r;
  });
  // 各通道「经过它的参考未越限方案最低价」按合并前的全部方案统计，区域网架内的联络线也能取到价格
  const channelBest = {};
  for(const r of rowsAll) if(r.feasible) for(const e of r.edges) if(channelBest[e.id]==null || r.landed<channelBest[e.id]) channelBest[e.id]=r.landed;
  const bySig = new Map();
  for(const r of rowsAll){
    const k = sigOf(r), cur = bySig.get(k);
    const better = !cur || (r.feasible!==cur.feasible ? r.feasible
      : Math.abs(r.landed-cur.landed)>1e-9 ? r.landed<cur.landed
      : r.hops!==cur.hops ? r.hops<cur.hops : r.Dphys>cur.Dphys);
    if(better) bySig.set(k, r);
  }
  const rows = [...bySig.values()];
  rows.forEach(r=>{ r.tagLabel = tagOf(r, N); });

  // 三口径各自排名（在任何过滤之前算，保证「与最优差多少」是全局口径）
  const byA=[...rows].sort((a,b)=>a.landed-b.landed);
  const byB=[...rows].sort((a,b)=>a.channelOnly-b.channelOnly);
  // 口径三依赖受端目标交付价；未给出时不排、不评名次
  const byC=hasDst ? [...rows].sort((a,b)=>b.senderNet-a.senderNet) : null;
  rows.forEach(r=>{r.rankA=byA.indexOf(r)+1;r.rankB=byB.indexOf(r)+1;r.rankC=byC?byC.indexOf(r)+1:null;});
  const bestA=byA.find(r=>r.feasible)||byA[0];
  const bestB=byB.find(r=>r.feasible)||byB[0];
  const bestC=byC ? (byC.find(r=>r.feasible)||byC[0]) : null;

  const total = rows.length;
  const feasibleCount = rows.filter(r=>r.feasible).length;
  const cmp = input.sortBy==='B' ? (a,b)=>a.channelOnly-b.channelOnly
    : input.sortBy==='C' && hasDst ? (a,b)=>b.senderNet-a.senderNet
    : (a,b)=>a.landed-b.landed;
  // 同价时按跳数、节点序列定序，结果与枚举顺序无关
  const tie = (a,b)=> cmp(a,b) || a.hops-b.hops || (a.nodes.join('>')<b.nodes.join('>')?-1:a.nodes.join('>')>b.nodes.join('>')?1:0);
  rows.sort((a,b)=> a.feasible===b.feasible ? tie(a,b) : (a.feasible?-1:1));

  let shown = rows;
  if(!input.showBad) shown = rows.filter(r=>r.feasible);
  if(!shown.length){
    // 仍带回通道清单与筛选条件：界面据此保留通道选择器，用户可取消筛选或改看越限方案，不会被困在错误态
    return {err:'全部 '+total+' 条候选路线均超出通道容量或断面限额',
      allInfeasible:true, availChannels, mustHave, totalAll:kept.length, pendingChannels};
  }
  return {rows:shown,byA,byB,byC,bestA,bestB,bestC,n:shown.length,total,feasibleCount,truncated,
    availChannels,mustHave,totalAll:kept.length,pendingChannels,channelBest};
}

/** 路径唯一键：节点序列 + 边序列。不能用边对象的 from/to（反向通行的联络线存储方向与行进方向相反）。 */
function pathKeyOf(p){ return p.nodes.join('>')+'#'+p.edges.map(e=>e.id).join(','); }

/** 受端电价已含上网环节线损费用时的终端电量折算（M10）。
 *  这类主体（深圳：1077号附件1 第22页注2「各电价含…上网环节线损费用」）线损率只用于把省间节点交付电量
 *  折算成终端用电量，不单列「受端上网环节线损费用」一项。
 *  ⚠ 折算只改金额基数，不改实付总额：qty 是买方在省间节点的交付电量，省界及以前的每一项都按 qty 实付，
 *  折量后金额不得跟着缩水（曾经整体等比缩放，1000 MWh / 2.11% 少计了 2.11% 的上游成本）。
 *  因此：上游项金额不动、单价改按到户电量表述（÷k）；受端项单价本就按到户电量计、金额改按到户电量（×k）。
 *  结果满足 Σ单价 = landed、Σ金额 = 实付总额，landed = 省界价/(1−ρ) + 受端各项。
 *  缺省（不传 dstQtyLossPct）时不进入本函数，旧口径完全不变。 */
const UPSTREAM_COMPS=['gen','loss','send','trans','reg','originLoss'];   // 省界及以前，按节点交付电量实付
const DST_COMPS=['inLoss','net','fund','cap','sysOp'];                   // 受端省内，单价按到户电量计
function applyDstQtyLoss(r, ctx){
  if(ctx.dstQtyLossPct==null || ctx.includeDstCost===false) return r;
  const consumerQty=ctx.qty*(1-ctx.dstQtyLossPct/100);
  if(!(r.amountQty>0) || !(consumerQty>0)) return r;
  const k=consumerQty/r.amountQty;
  for(const key of UPSTREAM_COMPS) r.comp[key]/=k;      // 金额不变 ⇒ 单价 = 金额/到户电量
  for(const key of DST_COMPS) r.yuan[key]*=k;           // 单价不变 ⇒ 金额 = 单价×到户电量
  r.yuan.total=UPSTREAM_COMPS.concat(DST_COMPS).reduce((a,key)=>a+r.yuan[key],0);
  r.consumerQty=consumerQty; r.amountQty=consumerQty;
  r.landed=r.yuan.total/consumerQty;
  r.qtyLossPct=ctx.dstQtyLossPct;                       // 界面据此说明「电价已含线损、不单列线损费用行」
  return r;
}

/** 从 start 出发（reverse=true 时沿反向图）不超过 maxHops 跳可达的省 → 最小跳数。
 *  仅用于通道探测的廉价剪枝：最小跳数和已超过 maxHops 的通道不必再跑枚举。 */
function hopDist(adj, start, maxHops, reverse){
  const g={};
  if(reverse){ for(const u in adj) for(const nb of adj[u]) (g[nb.to]||(g[nb.to]=[])).push(u); }
  else for(const u in adj) g[u]=adj[u].map(nb=>nb.to);
  const d={}, q=[start];
  d[start]=0;
  for(let i=0;i<q.length;i++){
    const u=q[i];
    if(d[u]>=maxHops) continue;
    for(const v of g[u]||[]) if(d[v]==null){ d[v]=d[u]+1; q.push(v); }
  }
  return d;
}

/** 通道 c 在跳数上是否可能出现在某条 src→dst 路径里（必要非充分：两段最短路的节点可能重叠）。
 *  只用于过滤明显不可能经过的通道，避免为它们做无谓的枚举。 */
function channelCouldFit(c, dOut, dIn, maxHops){
  const dirs = c.bidir ? [[c.from,c.to],[c.to,c.from]] : [[c.from,c.to]];
  return dirs.some(([u,v])=> dOut[u]!=null && dIn[v]!=null && dOut[u]+1+dIn[v]<=maxHops);
}

/** 带「必经通道」约束的路径枚举：规则与 enumPaths 一致（简单路径、跳数上限、originOnly 仅首段），
 *  额外要求路径覆盖 requiredIds 中每一条通道（不区分行进方向，方向由 bidir 决定）。
 *  与 enumPaths 解耦，使通道筛选不受主枚举截断影响（H1）。 */
function enumPathsMust(adj, src, dst, maxHops, cap, weightOf, requiredIds){
  const need=new Set(requiredIds), got=new Set();
  const out=[], nodes=[src], edges=[], visited=new Set([src]);
  let hitCap=false;
  const ord={};
  for(const k in adj) ord[k]=adj[k].slice().sort((a,b)=>weightOf(a,k)-weightOf(b,k));
  (function dfs(u){
    if(hitCap) return;
    if(u===dst){
      if(got.size!==need.size) return;
      if(out.length===cap){ hitCap=true; return; }
      out.push({nodes:nodes.slice(),edges:edges.slice()});
      return;
    }
    if(edges.length>=maxHops) return;
    for(const nb of ord[u]||[]){
      if(visited.has(nb.to)) continue;
      if(nb.e.originOnly && u!==src) continue;
      const add = need.has(nb.e.id) && !got.has(nb.e.id);
      if(add) got.add(nb.e.id);
      visited.add(nb.to); nodes.push(nb.to); edges.push(nb.e);
      dfs(nb.to);
      edges.pop(); nodes.pop(); visited.delete(nb.to);
      if(add) got.delete(nb.e.id);
      if(hitCap) return;
    }
  })(src);
  out.hitCap=hitCap;
  return out;
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

/** 缺少适用证据不等于费用为零。issues 随页面和导出报告保留。 */
function pricingIssues(r,input,data,date){
  const issues=[];
  issues.push('区域收费范围按所选路径/公告假设归集，实际收费单元和送受端计量点须核对本笔中长期交易方案。');
  if(input.sourceQuote==='export') issues.push('假设送出关口报价已含送出省输电费与省内网损，不重复加收。');
  else if(input.originLossMode!=='separate') issues.push('假设送端报价已覆盖省内网损；未覆盖时需选择另计。');
  else if(r.exportLossPct==null) issues.push('送端省内网损率缺项，另计金额未完整计入。');
  const first=r.edges[0];
  const rawSend=first.regional?tariffOf(first,r.nodes[0]):first.bidir&&r.nodes[0]===first.to?first.sendFeeRev:first.sendFee;
  if(input.sourceQuote!=='export' && rawSend==null) issues.push('起点送出省输电价格缺项，当前费用小计未完整计入。');
  if(r.regionLossMissing.length) issues.push('区域网损尚未计入：'+r.regionLossMissing.join('、')+'；当前结果为缺项测算。');
  if(r.regionItems.some(v=>v.status==='historical')) issues.push('区域网损采用第三监管周期参考值；第四周期继续适用性未核实。');
  if(r.regionItems.some(v=>v.status==='custom')) issues.push('区域网损为用户输入假设，须核对备案文件、适用期及交易品种。');
  if(input.includeRegion===false) issues.push('区域输电费已关闭，仅为对比情景；须确认交易方案是否豁免或已含区域费用。');
  if(input.lossBearer!==1) issues.push('网损分担为自定义合同模拟，实际需按中长期合同与交易方案执行。');
  if(r.nodes.some(k=>data.REGION_OF[k]==='南方')) issues.push('涉及南方电网：需另核南方区域及跨经营区规则，本规则不能直接覆盖；区域费缺项不代表免费。');
  for(const code of [...new Set([r.nodes[0],r.nodes.at(-1)])]) if(data.PV[code].scopeNote) issues.push(data.PV[code].scopeNote);
  if(r.nodes.slice(1,-1).some(k=>k==='NM'||k==='HE')) issues.push('过境节点存在多个电网主体，省级连通不保证主体间可连续转送。');
  if(r.regTransit) issues.push('过境区域按共用网络最后出口归集为测算假设；具体交易路径收费范围须核对交易机构发布方案。');
  if(r.nodes.every(k=>['BJ','TJ','HE'].includes(k))) issues.push('京津唐内部交易可能免华北电量电费；需明确电厂所在电网，当前按未豁免情景计算。');
  if(r.edges.some(e=>e.tariffStatus==='unknown')) issues.push('背靠背接口独立输电价尚未核实，未计独立费用；不得据此判定免费。');
  if(r.edges.some(e=>e.lossStatus==='estimate' && e.type!=='AC')) issues.push('背靠背接口线损为估算参数，缺少核定或备案依据。');
  if(r.edges.some(e=>!e.regional && (e.t==null || e.loss==null))) issues.push('专项工程价格或线损存在缺项，当前小计不完整。');
  if(r.edges.some(e=>e.sourceIssue || !e.eff)) issues.push('部分专项工程来源版本或生效日期未核实，详见逐段溯源。');
  if(r.edges.some(e=>/电厂|白鹤滩/.test(e.fn+' '+e.note))) issues.push('点对网或配套电源工程可能有专属电源/送出费用，不可直接视为全省通用交易接口。');
  if(r.edges.some(e=>e.priceType==='capacity')) issues.push('容量制工程使用边际费用情景；输电权取得与实际报价、容量费用分摊需另核。');
  if(input.srcSendFee!=null && input.sourceQuote!=='export') issues.push('采用送端电站专属送出价'+(input.srcSendNote?'（'+input.srcSendNote+'）':'')+'，须确认本笔电量在核定电站范围与年度额度内。');
  if(input.includeDstCost!==false){
    const inLoss=input.dstInLossPct ?? data.PV[input.to].inLoss;
    if(data.PV[input.to].fund==null) issues.push('受端基金及附加核定标准待补；手填值仅为测算输入。');
    if(inLoss==null) issues.push('受端上网环节线损未获取，当前未计此项。');
    if(input.dstQtyLossPct!=null) issues.push('受端电网主体电价已含上网环节线损费用：终端电量按 '+input.dstQtyLossPct+'% 折算，不单列线损费用行；省界及以前各项金额仍按节点交付电量实付（1077号附件1 注2、注3）。');
    if(input.dstBilling==='twopart' && !(input.dstCapFee>0)) issues.push('受端按两部制计价，未含容量/需量电费，到户价偏低。');
    if(input.dstCapFee>0) issues.push('容量/需量电费按用户负荷假设分摊为度电费用，属估算，实际按月度账单计收。');
    if(input.dstSysOpFee==null) issues.push('系统运行费未计入（按月变化，可手填）。');
    issues.push('到户结果仅为已列费用小计；政府性基金按工商业用户口径取值，地方分摊、峰谷分时、力调电费及特殊用户减免未计。');
    if(inLoss!=null && inLoss>0) issues.push('受端线损以本路径省界价作购损电价假设；实际月度购损价格可能不同。');
  }
  return [...new Set(issues)];
}
