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
  };
  const ctx={
    pGen: input.pGen, pDst: input.pDst, pNet: input.pNet, fund: input.fund,
    lossBearer: input.lossBearer, qty: input.qty, hours: input.hours,
    includeDstCost: input.includeDstCost !== false,
    sourceQuote: input.sourceQuote || 'plant', originLossMode: input.originLossMode || 'included',
    regionLossMode:input.regionLossMode||'exclude', regionLossRates:input.regionLossRates||{},
    occPct: Math.min(90, Math.max(0, +input.occPct || 0)),   // REQ-302：中长期占用 %
  };
  const { from, to } = input;
  const N = data.name;

  if(!['plant','export'].includes(ctx.sourceQuote)||!['included','separate'].includes(ctx.originLossMode)||!['network','buyer'].includes(input.regionChargeMode||'network')) return {err:'报价边界或区域计费模式无效'};

  if(!data.PV[from] || !data.PV[to]) return {err:'省份代码无效'};
  if(from === to) return {err:'送端与受端不能相同'};

  for(const k of ['qty','hours','pGen','pDst','lossBearer','maxHops','maxDetour']){
    if(!Number.isFinite(input[k])) return {err:'参数 '+k+' 必须为有限数值'};
  }
  if(input.qty<=0 || input.hours<0.25) return {err:'电量须大于 0，时长不得小于 0.25 小时'};
  if(input.lossBearer<0 || input.lossBearer>1) return {err:'网损承担比例须在 0 到 1 之间'};
  if(!Number.isInteger(input.maxHops)||input.maxHops<1||input.maxHops>6||input.maxDetour<1) return {err:'路径范围无效'};
  if(input.includeDstCost!==false && (!Number.isFinite(input.pNet)||!Number.isFinite(input.fund))) return {err:'受端输配电价、基金须明确填写；缺项不能静默按零结算'};
  if(!['exclude','historical','custom','verified'].includes(ctx.regionLossMode)) return {err:'区域网损模式无效'};
  if(ctx.regionLossMode==='custom' && Object.values(ctx.regionLossRates).some(v=>v!=null && (!Number.isFinite(v)||v<0||v>=100))) return {err:'区域网损率须为 0（含）到 100（不含）之间的百分数'};
  if(input.occPct!=null && (!Number.isFinite(input.occPct)||input.occPct<0||input.occPct>90)) return {err:'占用比例须在 0 到 90 之间'};
  const date=input.tradeDate || (data.VALIDITY||{}).reviewedAt || '2026-09-17';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date) return {err:'交易日期无效'};
  if(data.VALIDITY && date<data.VALIDITY.provinceFrom) return {err:'当前价库仅支持 2026-08-01 起的价格口径，尚未收录此前完整历史费率'};
  if(input.includeDstCost!==false && data.PV[to].effectiveFrom && date<data.PV[to].effectiveFrom) return {err:N(to)+' 受端输配电价自 '+data.PV[to].effectiveFrom+' 起适用，当前日期不可提前使用；可切换省界测算或调整交易日期'};
  const invalid=data.CH.find(e=>(e.loss!=null && (!Number.isFinite(e.loss)||e.loss<0||e.loss>=100)) || (e.cap!=null && (!Number.isFinite(e.cap)||e.cap<=0)) || (e.t!=null&&!Number.isFinite(e.t)));
  if(invalid) return {err:'费率库参数无效：'+invalid.n+'，请恢复或修正费率库'};

  // REQ-203：仅按已确认可交易通道——开启后排除 tradable===false 的交流联络线
  const CHpool = data.CH.filter(c=>(!input.tradableOnly || c.tradable!==false) && (!c.eff || c.eff<=date));
  const adj = buildAdj(CHpool);
  if(!adj[from]) return {err:N(from)+' 暂无接入的跨省通道'};

  const maxHops = input.maxHops;
  const raw = enumPaths(adj, from, to, maxHops, ENUM_CAP,
    (nb,u)=>approxW(env, nb.e, u, nb.to));
  if(!raw.length){
    return {err:'在 '+maxHops+' 段以内没有 '+N(from)+' 到 '+N(to)+' 的连通路径，请放宽跳数上限'};
  }
  const truncated = !!raw.hitCap;   // REQ-601：enumPaths 因 cap 提前返回时置位，消除「恰好满 800」歧义

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

  const rows = picked.map(p=>{
    const r=evalPath(p,ctx,env);
    r.pricingIssues=pricingIssues(r,input,data,date);
    r.priceComplete=r.pricingIssues.length===0;
    r.regionScenarios=['exclude','historical'].map(mode=>{
      const x=ctx.regionLossMode===mode?r:evalPath(p,{...ctx,regionLossMode:mode},env);
      return {mode,border:x.border,landed:x.landed,D:x.D,amount:x.yuan.total,
        regions:x.regionItems.map(v=>({region:v.region,pct:v.pct,status:v.status})),
        complete:false};
    });
    return r;
  });
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
  if(r.regionItems.some(v=>v.status==='historical')) issues.push('采用第三监管周期区域网损作敏感性假设；第四周期继续适用性未核实。');
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
  if(input.includeDstCost!==false){
    if(data.PV[input.to].fund==null) issues.push('受端基金及附加核定标准待补；手填值仅为测算输入。');
    if(data.PV[input.to].inLoss==null) issues.push('受端上网环节线损未获取，当前未计此项。');
    issues.push('到户结果仅为已列费用小计；系统运行费、容需量电费、地方分摊及用户电压/类别差异需另计。');
    if(data.PV[input.to].inLoss!=null) issues.push('受端线损以本路径省界价作购损电价假设；实际月度购损价格可能不同。');
  }
  return [...new Set(issues)];
}
