/* 测算页：参数输入、可选路线列表、方案详情。
   依赖：config / format / data / state / algo/*。 */
/* ================= 测算页 ================= */
/* 重渲染稳定性（spec: ui-render-stability）：折叠面板展开态快照/恢复。
   全部面板按文档序快照；重建后数量一致且 id 位序相同才逐位还原
   （条件渲染会改变面板集合，错位恢复比收起更糟），否则仅有稳定 id 的面板按 id 恢复。
   ⚠ DOM 无 id 元素的 .id 是空串不是 null，比较两侧都要归一化。
   id 面板的展开态另存跨渲染 memo：穿过「该面板不存在的中间帧」（如错误态）再回来也不丢。 */
const _detailMemo={};
function snapDetails(root){
  if(!root || !root.querySelectorAll) return [];   // VM 测试桩无此方法（与旧 _capOpen 守卫同风格）
  const snap=[...root.querySelectorAll('details')].map(d=>({id:d.id||null,open:d.open}));
  snap.forEach(s=>{ if(s.id) _detailMemo[s.id]=s.open; });
  return snap;
}
function restoreDetails(root,snap){
  if(!root || !root.querySelectorAll) return;
  const now=[...root.querySelectorAll('details')];
  if(snap.length===now.length && snap.every((s,i)=>(now[i].id||null)===(s.id||null))){
    now.forEach((d,i)=>{ d.open=snap[i].open; });
    return;
  }
  now.forEach(d=>{ if(d.id && _detailMemo[d.id]!==undefined) d.open=_detailMemo[d.id]; });
}
function renderCalc(){
  const res=state._res;
  // 重渲染会整体替换 v-calc：先记录其中的焦点控件与光标位置，重建后恢复，
  // 否则连续步进或输入到一半就会被打断。
  const _host=document.getElementById('v-calc');
  const _ae=(typeof document.activeElement!=='undefined')?document.activeElement:null;
  // 参数面板正文同样会被重画，焦点在面板里时也要恢复
  const _sheet=document.getElementById('param-sheet');
  const _inside=el=>!!(el&&el.contains&&el.contains(_ae));
  const _fid=(_ae&&_ae.id&&(_inside(_host)||_inside(_sheet)))?_ae.id:null;
  // 重渲染稳定性：快照全部折叠面板展开态（含容量电费卡 d-capfee），重建后统一恢复
  const _detailSnap=_host?snapDetails(_host):[];
  let _caret=null;
  if(_fid){ try{ _caret=[_ae.selectionStart,_ae.selectionEnd]; }catch(e){ /* number 型输入无 selection */ } }
  const opt=(sel,ex)=>Object.keys(PV).map(k=>
    `<option value="${k}" ${k===sel?'selected':''} ${k===ex?'disabled':''}>${PV[k].n}</option>`).join('');
  // 只算到受端省界：受端省内两项（省网输配电价 / 基金及附加）不参与计算，界面上置灰并标注
  const noDst=state.includeDstCost===false;

  // 存储故障可见化（spec: local-persistence）：写入失败后常驻提示，测算功能不受影响
  const _sbHead=_storageBroken?`<div class="warn">⚠ 本机存储不可用（隐私模式或空间已满），本次的参数与费率修改在重开应用后不会保留。</div>`:'';
  let out=_sbHead+`<div class="hero">
    <div class="hero-top">
      <div class="picker">
        <div class="pk-col">
          <div class="pk-lb">出发地 · 送端</div>
          <select id="i-from">${opt(state.from,state.to)}</select>
        </div>
        <div class="pk-arw">→</div>
        <div class="pk-col">
          <div class="pk-lb">目的地 · 受端</div>
          <select id="i-to">${opt(state.to,state.from)}</select>
        </div>
      </div>
      ${res?renderChannelSelect(res):''}
      <div class="bar-params">
        <label><span>省间交付 MWh</span><input id="i-qty" type="number" value="${state.qty}" step="100" min="1"></label>
        <label><span>时长 h</span><input id="i-hours" type="number" value="${state.hours}" step="0.25" min="0.25"></label>
      </div>
    </div>
    <div class="hero-main">
      <label class="hero-price"><span>送端报价 元/MWh（含税）</span><input id="i-pgen" type="number" inputmode="decimal" value="${state.pGen}" step="5"></label>
      ${renderHeroResult(res)}
    </div>
    ${renderParamBar()}
    ${renderPriceComposition(res)}
  </div>

`;

  const _toPV=PV[state.to];
  if(!noDst && _toPV && (_toPV.fund===null || _toPV.fund===undefined)){
    out+=`<div class="warn">受端省「${esc(_toPV.n)}」的政府性基金及附加暂未获取官方标准，本次测算按 0 计，落地成本会被低估。</div>`;
  }

  if(res&&res.err){
    // 通道筛空或候选全部越限时，顶部通道选择器仍在；错误卡再给出可直接点的退路，避免困在错误态
    const _chanOn=(res.mustHave||[]).length>0;
    const _acts=(_chanOn?'<button class="btn ghost" type="button" onclick="clearChannel()">取消通道筛选</button>':'')
      +(res.allInfeasible?'<button class="btn ghost" type="button" onclick="state.showBad=true;state.sel=0;doSolve()">显示越限方案</button>':'');
    out+=`<div class="card"><div class="empty">${esc(res.err)}${_acts?`<div class="empty-acts">${_acts}</div>`:''}</div></div>`;
  } else if(res&&res.rows&&res.rows.length){
    // 左＝路线列表，中＝方案详情，右＝智能推荐（宽屏，AI_ENABLED 关闭时不渲染）；手机端纵向堆叠，布局由 .layout 的 CSS 决定
    out+='<div class="layout'+(AI_ENABLED?'':' no-ai')+'"><div class="col-side">'+renderRouteList(res)+'</div>'
       + (AI_ENABLED?'<div class="col-ai">'+renderAI(res)+'</div>':'')
       + '<div class="col-main">'+renderDetail(res,res.rows[Math.min(state.sel,res.rows.length-1)])+renderSensitivity(res)+'</div></div>';
  } else {
    out+=`<div class="card"><div class="empty">请选择不同的出发地与目的地</div></div>`;
  }
  // REQ-401 容量电费测算器：独立折叠卡，不参与路径比选（发改价格〔2020〕1441号 / 〔2023〕532号口径），放在方案之后
  out+=renderCapFee();
  // 政策口径与取值依据放在整页最下方
  out+=`<div class="policy-foot">
    <details class="explain"><summary>政策与取值依据</summary><div class="inner">
    <p class="note"><b>测算范围</b>：省间中长期单时段交付成本。默认交付点为受端省间交易节点；送端报价按手填合同或拟报价测算。候选路线取 ${MAX_HOPS} 段以内、不限绕行的全部路径，按价格从低到高排序。合同分时曲线、交易组织、安全校核、执行偏差与实际结算需另行处理。</p>
    <p class="note"><b>参数含义</b>：送端报价边界「不含省内输电费」指电能量报价，送出省输电费另计；「含省内费用」指送出关口报价，已含送出省输电费与省内网损，二者均不再追加。送端省内网损默认「另计」：按 1077号附件1 各省表注4 的送省外上网环节线损率估算（该注明确送出价「含税、不含线损」、线损率单列），长三角跨省中长期实施细则（2026）第三十六条亦规定落地侧价格含「送出省外送输电价格（含送出省外送输电网损）」；报价若已自行覆盖该损耗，选「不另计」。费用边界「省间交易节点」不含受端省网输配电价与政府性基金及附加；「到户已列费用」另计这两项与省内线损估算。中长期占用 % 用于容量校验时扣减参考容量。通道范围「仅专项工程」排除当期可交易性未确认的联络线。</p>
    <p class="note"><b>区域电网输电价格</b>采用发改价格〔2026〕1077号附件2公开的电量电价，含税、不含线损；区域容量电价已通过省级输配电价回收。区域费范围「途经区域各计一次」按交易路径中的共用网络归集；直接落地的专项工程是否另计受端区域，应以本笔中长期交易公告为准，公告要求时选「另计受端区域」。京津唐豁免须核对具体电网主体。</p>
    <p class="note"><b>区域网损</b>：默认「第三周期参考值」——长三角跨省中长期实施细则（2026）第三十六条规定落地侧价格含华东跨省输电网损，上网价格 =（落地侧成交价 − 华东跨省输电价格）×（1 − 华东跨省输电网损率）− 送出省外送输电价格。参考值为 ${Object.entries(DATA.RLOSS||{}).map(([k,v])=>esc(k)+' '+v.historicalPct+'%').join('、')}，来自国网第三监管周期历史公开表（转载来源），尚未确认适用于第四监管周期；「不计入」为缺项基准，不代表已核定为 0；「手填」为待核实假设。区域共用交流接口不再逐段计损。</p>
    <p class="note"><b>费用去重</b>：起点送出省费只计一次；报价已含则不再加。过境交流接口不单独收费，也不按每条抽象接口重复计损；独立专项工程按自身输电价与损耗口径。已含损耗的核价项目不再追加计费损耗。</p>
    <p class="note"><b>网损与合同约定</b>：默认买方承担跨省计费网损，可模拟双方分担。送端省内网损由报价边界选择是否另计，另计时以送端报价估算购损成本；实际合同、交易方案优先。现货规则中的卖方承担约定不自动套用于中长期。</p>
    <p class="note"><b>自动带入值</b>：受端省网输配电价与基金及附加在选定<b>受端省</b>时自动带入该省核定价（输配电价取 220kV 及以上两部制电量电价）；送端报价未手填时随省份带入演示参考值，手填后保留。以上均可手动覆盖，点「恢复」还原核定值。送端报价是可修改的演示假设，不是实时市场报价；省级输配电价默认高压两部制，实际须匹配电网主体、用户类别与电压档。</p>
    <div class="lib-src" style="margin-top:6px">当前取值依据：受端 <b>${esc(PV[state.to]?PV[state.to].n:'—')}</b>　输配电价 ${fmt(state.pNet)} 元/MWh　基金及附加 ${state.fundMissing?'<span style="color:var(--red)">未获取</span>':fmt(state.fund)+' 元/MWh'}${noDst?'　<span style="color:var(--ink3)">（当前口径不计入以上两项）</span>':''}<br>${esc(PV[state.to]?PV[state.to].netSrc:'—')}</div>
    </div></details>
  </div>`;
  document.getElementById('v-calc').innerHTML=out;
  renderParamSheet(res);
  restoreDetails(document.getElementById('v-calc'),_detailSnap);
  reapplyClampMarks();   // FR-1：重绘后重放越限红框红字（输入修正前提示常驻）
  if(_fid){
    const el=document.getElementById(_fid);
    if(el){
      try{ el.focus({preventScroll:true}); }catch(e){ el.focus(); }
      if(_caret&&_caret[0]!=null){ try{ el.setSelectionRange(_caret[0],_caret[1]); }catch(e){} }
    }
  }
}

/* ---------- 参数弹出面板 ----------
   面板壳在 template.html（#param-sheet，位于 #v-calc 之外），renderCalc 整块重画测算页时不会把面板关掉；
   每次重算只替换面板正文与顶部价格。参数改动即时重算（沿用 boot.js 的 change 分支），不设「应用」按钮。 */
let _sheetOpen=false;
function renderParamBody(noDst){
  const sel=(id,cur,opts,attr='')=>`<select id="${id}"${attr}>${opts.map(([v,t,dis])=>`<option value="${esc(v)}" ${String(cur)===String(v)?'selected':''}${dis?' disabled':''}>${t}</option>`).join('')}</select>`;
  const resetLink=k=>`<a class="p-reset" onclick="resetOne('${k}')" title="恢复核定值">恢复</a>`;
  const stations=srcStations();
  let dst='';
  if(!noDst){
    const vt=dstTariff(), ents=dstEntities(), tiers=dstTiers(vt.ent), cap=dstCapFee(vt);
    const twoOk=!!(vt.tier&&vt.tier.两部制!=null), oneOk=!!(vt.tier&&vt.tier.单一制!=null);
    dst=`<div class="psub">受端到户${vt.ent?`<em>${esc(vt.ent.名称)} · 附件1 第 ${esc(vt.ent.页码)} 页${vt.ent.电价含线损?' · 电价已含线损':''}</em>`:''}</div>
    ${vt.ent&&!tiers.length?`<p class="p-note">${esc(vt.ent.名称)}输配电价按用户容量类别分档（附件1 第 ${esc(vt.ent.页码)} 页），不适用标准电压档，请手填受端输配电价。</p>`:''}
    <div class="pgrid">
      ${ents.length>1?`<label class="f"><span>受端电网主体</span>${sel('i-dstentity',vt.ent.id,ents.map(e=>[e.id,esc(e.名称)]))}</label>`:''}
      ${tiers.length?`<label class="f"><span>电压等级</span>${sel('i-dsttier',vt.tier.档别,tiers.map(t=>[t.档别,esc(t.档别)]))}</label>
      <label class="f"><span>计价方式</span>${sel('i-dstbilling',vt.billing,[['twopart','两部制',!twoOk],['single','单一制',!oneOk]])}</label>`:''}
      <label class="f"><span>受端输配电价 ${resetLink('pNet')}</span><input id="i-pnet" type="number" value="${state.pNet}" step="0.1"></label>
      <label class="f"><span>基金及附加 ${resetLink('fund')}</span><input id="i-fund" type="number" value="${state.fund}" step="0.1"></label>
      ${vt.tier&&vt.billing==='twopart'?`<label class="f"><span>容（需）量电费</span>${sel('i-dstcapmode',state.dstCapMode||'none',[['none','不计入'],['demand','按需量分摊',vt.tier.需量电价==null],['capacity','按容量分摊',vt.tier.容量电价==null]])}</label>
      ${state.dstCapMode&&state.dstCapMode!=='none'?`<label class="f"><span>${state.dstCapMode==='capacity'?'容量利用率':'负荷率'} %${cap>0?`<em class="p-calc">≈ ${fmt(cap,1)} 元/MWh</em>`:''}</span><input id="i-dstlf" type="number" min="1" max="100" step="5" value="${state.dstLoadFactor??''}" placeholder="必填，如 60"></label>`:''}`:''}
      <label class="f"><span>系统运行费 元/MWh</span><input id="i-dstsysop" type="number" min="0" step="0.1" value="${state.dstSysOpFee??''}" placeholder="未填即缺项"></label>
    </div>`;
  }
  return `
    <div class="psub">费用口径</div>
    <div class="pgrid">
      <label class="f"><span>费用边界</span>${sel('i-dstcost',noDst?0:1,[[0,'省间交易节点'],[1,'到户已列费用']])}</label>
      <label class="f"><span>送端报价边界</span>${sel('i-sourcequote',state.sourceQuote,[['plant','不含省内输电费'],['export','含省内费用']])}</label>
      <label class="f"><span>送端省内网损</span>${sel('i-originloss',state.originLossMode==='separate'?'separate':'included',[['separate','另计'],['included','不另计']],state.sourceQuote==='export'?' disabled':'')}</label>
      ${stations.length&&state.sourceQuote!=='export'?`<label class="f"><span>送出价口径</span>${sel('i-srcstation',srcStation()?state.srcStation:'',[['','通用送出价'],...stations.map((x,k)=>[String(k),esc(x.范围)+' · '+fmt(x.送出价,1)])])}</label>`:''}
    </div>
    ${dst}
    <div class="psub">区域与网损</div>
    <div class="pgrid">
      <label class="f"><span>区域电网费</span>${sel('i-region',state.includeRegion?1:0,[[1,'计入'],[0,'不计入']])}</label>
      <label class="f"><span>区域费范围</span>${sel('i-regioncharge',state.regionChargeMode==='buyer'?'buyer':'network',[['network','途经区域各计一次'],['buyer','另计受端区域']])}</label>
      <label class="f"><span>区域网损</span>${sel('i-regionloss',state.regionLossMode,[['exclude','不计入'],['historical','第三周期参考值'],['custom','手填']])}</label>
      <label class="f"><span>网损承担方</span>${sel('i-bearer',state.lossBearer,[[1,'受端承担'],[0.5,'两端各半'],[0,'送端承担']])}</label>
      ${state.regionLossMode==='custom'?Object.keys(DATA.RLOSS||{}).map(k=>`<label class="f"><span>${esc(k)}区域网损 %</span><input id="i-rloss-${esc(k)}" type="number" min="0" max="99.999" step="0.01" value="${state.regionLossRates?.[k]??''}" placeholder="未填即缺项"></label>`).join(''):''}
    </div>
    <div class="psub">通道与容量</div>
    <div class="pgrid">
      <label class="f"><span>通道范围</span>${sel('i-tradable',state.tradableOnly?1:0,[[0,'全部通道'],[1,'仅专项工程']])}</label>
      <label class="f"><span>中长期占用 %</span><input id="i-zyocc" type="number" value="${state.occPct||0}" step="5" min="0" max="90"></label>
    </div>
`;
}
/* ---------- 受端到户：电网主体 × 电压档别 × 单一制/两部制（DATA.VT，1077号附件1） ----------
   输配电价由所选档别带入 pNet（仍可手改、「恢复」回到所选档核定值）；注3 线损率随电网主体；
   电价已含线损的主体（如深圳）受端线损按 0。基金按工商业用户口径，不随电压等级变化。 */
function dstEntities(){ const v=(DATA.VT||{})[state.to]; return v&&Array.isArray(v.主体)?v.主体:[]; }
function dstEntity(){
  const list=dstEntities(), def=((DATA.VT||{})[state.to]||{}).默认主体;
  return list.find(e=>e.id===state.dstEntity)||list.find(e=>e.id===def)||list[0]||null;
}
function dstTiers(ent){ return ent&&Array.isArray(ent.档位)?ent.档位.filter(t=>t.单一制!=null||t.两部制!=null):[]; }
function dstTariff(){
  const ent=dstEntity(), tiers=dstTiers(ent);
  const tier=tiers.find(t=>t.档别===state.dstTier)||tiers[tiers.length-1]||null;   // 缺省取最高电压档
  let billing=state.dstBilling==='single'?'single':'twopart';
  if(tier && tier[billing==='single'?'单一制':'两部制']==null) billing=billing==='single'?'twopart':'single';
  const net=tier?tier[billing==='single'?'单一制':'两部制']:null;
  const inLoss=ent?(ent.电价含线损?0:ent.省内上网环节线损率):null;
  return {ent,tier,billing,net:net??null,inLoss:inLoss??null};
}
/* 两部制容（需）量电费按用户负荷假设折成度电：月单价 × 12 ÷（8760 h × 负荷率）→ 元/MWh。负荷率未填则不计。 */
function dstCapFee(vt){
  if(!vt||!vt.tier||vt.billing!=='twopart'||!state.dstCapMode||state.dstCapMode==='none') return 0;
  const lf=+state.dstLoadFactor, price=state.dstCapMode==='capacity'?vt.tier.容量电价:vt.tier.需量电价;
  if(!(lf>0&&lf<=100)||price==null) return 0;
  return price*12/(8.76*lf/100);
}
// 原文未给数值的条目（如蒙西送华北「按现行模式执行」）不提供选择
function srcStations(){ const v=(DATA.SRCX||{})[state.from]; return Array.isArray(v)?v.filter(x=>x.送出价!=null):[]; }
function srcStation(){ const k=state.srcStation; return k!=null&&k!==''?srcStations()[+k]||null:null; }
/* 交给 solve() 的完整输入：state + 由界面选择派生的可选字段（不写回 state、不持久化） */
function solveInput(){
  const extra={};
  if(state.includeDstCost!==false){
    const vt=dstTariff();
    if(vt.ent){ extra.dstInLossPct=vt.inLoss; }
    if(vt.tier){ extra.dstBilling=vt.billing; }
    extra.dstCapFee=dstCapFee(vt);
    extra.dstSysOpFee=state.dstSysOpFee??null;
  }
  const st=srcStation();
  if(st && state.sourceQuote!=='export'){ extra.srcSendFee=st.送出价; extra.srcExportLossPct=st.线损率??null; extra.srcSendNote=st.范围; }
  return Object.assign({},state,extra);
}
/* 主卡口径摘要：费用边界与报价边界恒显示，其余只列与默认值不同的项（标色并计入角标） */
function paramSummary(){
  const t=PV[state.to], items=[
    ['费用边界',state.includeDstCost?'到户已列费用':'省间交易节点',state.includeDstCost!==PARAM_DEFAULTS.includeDstCost],
    ['报价边界',state.sourceQuote==='export'?'含省内费用':'不含省内输电费',state.sourceQuote!==PARAM_DEFAULTS.sourceQuote],
  ];
  if(state.includeDstCost){
    const vt=dstTariff(), def=((DATA.VT||{})[state.to]||{}).默认主体;
    if(vt.tier){
      const tiers=dstTiers(vt.ent), chg=(vt.ent&&vt.ent.id!==def)||vt.tier!==tiers[tiers.length-1]||vt.billing!=='twopart';
      items.push(['到户',(vt.ent&&vt.ent.id!==def?vt.ent.名称+' ':'')+vt.tier.档别+' '+(vt.billing==='single'?'单一制':'两部制'),chg]);
    }
    const base=vt.net??(t&&t.net);
    if(base!=null && state.pNet!==base) items.push(['受端输配电价',fmt(state.pNet,2),true]);
    const cap=dstCapFee(vt);
    if(cap>0) items.push(['容（需）量电费',fmt(cap,1)+' 元/MWh',true]);
    if(state.dstSysOpFee!=null) items.push(['系统运行费',fmt(state.dstSysOpFee,1)+' 元/MWh',true]);
  }
  if(srcStation() && state.sourceQuote!=='export') items.push(['送出价',srcStation().范围,true]);
  if(state.includeDstCost && t && state.fund!==(t.fund??0)) items.push(['基金及附加',fmt(state.fund,2),true]);
  if(state.sourceQuote!=='export' && state.originLossMode!==PARAM_DEFAULTS.originLossMode) items.push(['送端省内网损',state.originLossMode==='separate'?'另计':'不另计',true]);
  if(!state.includeRegion) items.push(['区域电网费','不计入',true]);
  else{
    if(state.regionChargeMode==='buyer') items.push(['区域费范围','另计受端区域',true]);
    if(state.regionLossMode!==PARAM_DEFAULTS.regionLossMode) items.push(['区域网损',{exclude:'不计入',historical:'第三周期参考值',custom:'手填'}[state.regionLossMode]||state.regionLossMode,true]);
  }
  if(+state.lossBearer!==PARAM_DEFAULTS.lossBearer) items.push(['网损承担',state.lossBearer==0.5?'两端各半':'送端承担',true]);
  if(state.tradableOnly) items.push(['通道范围','仅专项工程',true]);
  if(state.occPct>0) items.push(['中长期占用',state.occPct+'%',true]);
  return items;
}
function renderParamBar(){
  const items=paramSummary(), n=items.filter(x=>x[2]).length;
  return `<div class="cfg-bar">
    <div class="cfg-sum">${items.map(([k,v,chg])=>`<span${chg?' class="chg"':''}>${esc(k)} ${esc(v)}</span>`).join('')}</div>
    <button class="btn ghost cfg-btn" id="btn-params" type="button" onclick="openParams()" aria-haspopup="dialog"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4h7M13 4h1M2 12h1M7 12h7"/><circle cx="11" cy="4" r="2"/><circle cx="5" cy="12" r="2"/></svg>参数${n?`<b>${n}</b>`:''}</button>
  </div>${renderDstWarn()}`;
}
/* 到户口径下的醒目缺项提示：两部制未计容（需）量电费会明显低估到户价 */
function renderDstWarn(){
  if(state.includeDstCost===false) return '';
  const vt=dstTariff();
  if(vt.tier && vt.billing==='twopart' && !(dstCapFee(vt)>0))
    return `<div class="cfg-warn">⚠ 两部制未含容量/需量电费，到户价偏低　<a onclick="openParams()">填写负荷假设</a></div>`;
  return '';
}
function renderParamSheet(res){
  const body=document.getElementById('sheet-body'), price=document.getElementById('sheet-price');
  if(!body) return;
  body.innerHTML=renderParamBody(state.includeDstCost===false);   // 正文常驻 DOM：readInputs 按 id 读取，面板收起时也要在
  const r=selectedRow(res);
  if(price) price.innerHTML=r?`${fmt(r.landed,2)}<small>元/MWh · ${state.includeDstCost===false?'省界价格':'到户价格'}</small>`:'—';
}
function openParams(){
  const el=document.getElementById('param-sheet');
  if(!el || _sheetOpen) return;
  _sheetOpen=true;
  el.classList.add('open'); el.setAttribute('aria-hidden','false');
  document.body.classList.add('sheet-open');
  // 压一条历史记录：安卓返回键 / 浏览器后退时先关闭面板（安卓壳 onBackPressed 在可后退时后退）
  try{ history.pushState({paramSheet:1},''); }catch(e){}
  const x=document.getElementById('sheet-close');
  if(x&&x.focus){ try{ x.focus({preventScroll:true}); }catch(e){} }
}
function closeParams(fromHistory){
  if(!_sheetOpen) return;
  _sheetOpen=false;
  const el=document.getElementById('param-sheet');
  if(el){ el.classList.remove('open'); el.setAttribute('aria-hidden','true'); }
  document.body.classList.remove('sheet-open');
  if(!fromHistory){ try{ if(history.state&&history.state.paramSheet) history.back(); }catch(e){} }
  const b=document.getElementById('btn-params');
  if(b&&b.focus){ try{ b.focus({preventScroll:true}); }catch(e){} }
}
/* 恢复默认：参数回到 PARAM_DEFAULTS，受端输配电价 / 基金回到核定值；省份、通道、报价与电量不动。
   不走 doSolve —— readInputs 会把面板里的旧值读回来。 */
function resetParams(){
  Object.assign(state,PARAM_DEFAULTS);
  applyToProv();
  state.sel=0; state._res=solveState(); saveLast(); renderCalc();
}

/* ---------- 顶部结果：所选方案的最终价格与价格组成 ---------- */
function selectedRow(res){
  return res&&res.rows&&res.rows.length?res.rows[Math.min(state.sel,res.rows.length-1)]:null;
}
function renderHeroResult(res){
  const r=selectedRow(res);
  const costName=state.includeDstCost===false?'省界价格':'到户价格';
  if(!r) return `<div class="hero-res empty-res"><div class="hero-lb">${costName}</div><div class="hero-v">—</div>
    <div class="hero-sub">${res&&res.err?esc(res.err):'请选择不同的出发地与目的地'}</div></div>`;
  const stops=routeStops(r), landings=stops.filter(s=>s.landing);
  const tag=state.sel===0?((res.mustHave||[]).length?'所选通道最低价 #1':'最低价方案 #1'):'方案 #'+(Math.min(state.sel,res.rows.length-1)+1);
  return `<div class="hero-res">
    <div class="hero-lb">${costName}<span class="hero-tag">${tag}</span></div>
    <div class="hero-v" title="完整值 ${fmt(r.landed,2)} 元/MWh">${fmtCompact(r.landed,2)}<small>元/MWh</small></div>
    <div class="hero-sub">${stops.map(s=>esc(s.name)).join(' → ')}${landings.length?'　落点 '+landings.map(s=>esc(s.landing)).join('、'):''}</div>
  </div>`;
}
/* 价格组成：各项之和即最终价格（comp 与 landed 同口径，见 algo/cost.js）。为 0 的项不列，送端报价始终列出。 */
const COMP_ITEMS=[['gen','送端报价','#185FA5'],['originLoss','送端省内网损','#378ADD'],['send','送出省输电费','#85B7EB'],['trans','跨省通道费','#EF9F27'],
  ['reg','区域电网费','#5DCAA5'],['loss','网损折价','#F0997B'],['inLoss','受端上网线损','#AFA9EC'],['net','受端输配电价','#B4B2A9'],['fund','基金及附加','#D3D1C7'],['cap','容（需）量电费','#8E8AD6'],['sysOp','系统运行费','#7FA7A0']];
function priceItems(r){
  return COMP_ITEMS.filter(([k])=>k==='gen'||Math.abs(r.comp[k])>1e-9).map(([k,label,color])=>({k,label,color,v:r.comp[k]}));
}
function renderPriceComposition(res){
  const r=selectedRow(res);
  if(!r) return '';
  const items=priceItems(r), tot=items.reduce((s,x)=>s+Math.abs(x.v),0)||1;
  return `<div class="cmp">
    <div class="cmp-hd"><span>价格组成</span><em>单位 元/MWh</em></div>
    <div class="cmp-bar">${items.map(x=>`<i style="width:${(Math.abs(x.v)/tot*100).toFixed(2)}%;background:${x.color}" title="${esc(x.label)} ${fmt(x.v,2)}"></i>`).join('')}</div>
    <div class="cmp-list">
      ${items.map((x,i)=>`<div class="cmp-item"><div class="l"><i style="background:${x.color}"></i>${i?'+ ':''}${esc(x.label)}</div><div class="v">${fmt(x.v,2)}</div><div class="p">${fmt(x.v/r.landed*100,1)}%</div></div>`).join('')}
      <div class="cmp-item tot"><div class="l">= ${state.includeDstCost===false?'省界价格':'到户价格'}</div><div class="v">${fmt(r.landed,2)}</div><div class="p">100%</div></div>
    </div>
  </div>`;
}

/* ---------- 可选路线列表 ---------- */
const RLIMIT=18;
function renderRouteList(res){
  const rows=res.rows, sel=Math.min(state.sel,rows.length-1);
  const isDst=state.includeDstCost!==false;
  // 口径A 的主指标随「费用边界」换名；口径B/C 本就不含受端省内费用，不受开关影响
  // 阈值基准取列表中最低的落地价（越限方案排在可行方案之后，首条不一定最低）
  const bestPrice=rows.length?Math.min(...rows.map(r=>r.landed)):0;
  const thr=bestPrice+Math.abs(bestPrice)*(state.degrade??0.10);
  const inThr=rows.filter(r=>r.landed<=thr);
  const shown=state.showAll?rows:inThr;
  const cut=rows.length-inThr.length;
  const mustN=(res.mustHave||[]).length;
  let out=`<div class="card tight">
    <div class="sec-title">可选路线<span class="hint">共 ${res.total} 条候选 · 参考未越限 ${res.feasibleCount} 条${res.truncated?' · 已达枚举上限':''}${mustN?' · 已按通道筛选':''}</span></div>
    <details class="explain"><summary>候选与可行的定义<em>费用边界：${isDst?'到户已列费用小计':'只算到受端省界'}</em></summary><div class="inner">
    <p class="note">按所选报价和费用假设比较成本，默认只列出成本不高于最优 ${fmt((state.degrade??0.10)*100,0)}% 的方案${cut>0?'，另有 '+cut+' 条成本更高者已折叠':''}。${isDst?'':'当前费用边界为<b>只算到受端省界</b>，下列金额与排序均<u>不含</u>受端省网输配电价与政府性基金及附加。'}</p>
    <p class="note">「候选」是 ${state.maxHops} 段以内、${state.maxDetour==null?'不限绕行':'绕行度不超过 '+state.maxDetour+'x'}、不重复经过同一省的全部路径，按价格从低到高排序；「参考未越限」仅表示已录入容量及历史断面参数未被超过，不代表当期可交易。当前拓扑只按已录入方向枚举；中长期反向交易可能另有组织安排，本工具未覆盖的方向不代表规则禁止。单向记录的直流按库内方向计入，互济型工程（德宝、青藏、长南荆等）与省间联络线双向。截断时无法保证全局最优。</p>
    <p class="note">路线进入区域共用网络时只写区域与物理落点（专项工程的受端），区域内电能按网架潮流分布，不列经过的省份。</p>
    <p class="note">通道（页面顶部）：选定通道后只列出经过它的方案；选「全部通道」显示全部候选。下拉项标注经过该通道的参考未越限方案中的最低价，同组内从低到高排列。</p>
    </div></details>
    ${res.truncated?'<div class="warn">候选集已达枚举上限（800 条），排序仅基于已枚举部分，不能保证全局最优——可用通道组件缩小范围后重算。</div>':''}
    <div class="rlist">`;
  rows.forEach((r,i)=>{
    if(!state.showAll && r.landed>thr) return;
    if(!state.showAll && i>=RLIMIT) return;
    const via=routeVia(r);
    out+=`<button class="rc ${i===sel?'on':''} ${r.feasible?'':'bad'}" onclick="pick(${i})" title="${esc(routeStops(r).map(s=>s.name).join(' → '))}">
      <div class="rc-top"><span class="rc-no">#${i+1}</span><span class="rc-hop">${routeDisplayBlocks(r).length}段</span></div>
      <div class="rc-line">${esc(routeLead(r))}</div>
      <div class="rc-price">${fmt(r.landed,0)}<small>元/MWh</small></div>
      <div class="rc-meta">${via?esc(via)+' · ':''}${fmt(r.dist,0)}km${r.feasible?'':' · <span style="color:var(--red)">越限</span>'}</div>
    </button>`;
  });
  out+=`</div>
    <div class="rlist-foot">
      <span>按价格从低到高</span>
      <label class="tg"><input type="checkbox" ${state.showBad?'checked':''} onchange="state.showBad=this.checked;state.sel=0;doSolve()"> 含越限</label>
    </div>`;
  const hiddenN=rows.length-shown.length;
  if(hiddenN>0){
    out+=`<button class="btn ghost" style="margin-top:8px" onclick="state.showAll=${!state.showAll};renderCalc()">${state.showAll?'收起，仅显示成本接近的方案':'展开全部 '+rows.length+' 条路线（含 '+hiddenN+' 条成本更高者）'}</button>`;
  }
  out+=`<div class="rlist-foot" style="margin-top:7px">
      <span>成本阈值</span>
      <select id="i-degrade" style="width:auto;padding:3px 20px 3px 7px;font-size:11px;border-radius:6px">
        ${[[0.03,'3%'],[0.05,'5%'],[0.10,'10%'],[0.20,'20%'],[9,'不限']].map(([v,t])=>
          `<option value="${v}" ${(state.degrade??0.10)==v?'selected':''}>${t}</option>`).join('')}
      </select>
    </div>`;
  out+=`</div>`;
  return out;
}
/* ---------- 通道：按通道优选方案（顶部主卡） ----------
   语义：选中的通道必须出现在方案里（不区分行进方向，方向由通道自身的 bidir 决定）。
   候选清单来自绕行度筛选后的完整候选集，所以选中一条后其余通道仍然可选、可取消。
   每个通道标注「经过它的参考未越限方案中的最低价」，同组内按此价升序，便于直接按通道比价。 */
const _chanBest=new WeakMap();
function channelBest(res){
  if(_chanBest.has(res)) return _chanBest.get(res);
  // 已选组件时 res.rows 只含筛出的方案，最低价须按全量候选另算一次（按结果对象缓存，切方案不重算）
  const full=(res.mustHave||[]).length?solve(Object.assign(solveInput(),{mustHave:[]}),algoData()):res;
  let best=full.channelBest;
  if(!best){ best={}; for(const r of full.rows||[]) if(r.feasible) for(const e of r.edges) if(best[e.id]==null||r.landed<best[e.id]) best[e.id]=r.landed; }
  _chanBest.set(res,best);
  return best;
}
/* 通道单选下拉：原生 select 在安卓 / iOS 上弹系统选择器，只占一行。
   多选（必须同时经过多条通道）实际很少用到，界面只提供单选；算法层 mustHave 仍是数组，兼容多选。 */
function renderChannelSelect(res){
  const list=res.availChannels||[];
  if(!list.length) return '';
  const cur=(res.mustHave||[])[0]||'', best=channelBest(res);
  const isDc=c=>c.type==='DC'||c.type==='AC/DC';
  const byPrice=(a,b)=>(best[a.id]??Infinity)-(best[b.id]??Infinity)||b.count-a.count;
  const opt=c=>`<option value="${esc(c.id)}" ${c.id===cur?'selected':''}>${esc(c.n)} · ${best[c.id]!=null?fmt(best[c.id],0):'无未越限方案'}</option>`;
  const dc=list.filter(isDc).sort(byPrice), ac=list.filter(c=>!isDc(c)).sort(byPrice);
  return `<div class="pk-col chan">
    <div class="pk-lb">通道 · 按经过该通道的最低价排序</div>
    <select id="i-chan"${cur?' class="on"':''}>
      <option value="" ${cur?'':'selected'}>全部通道（不限）</option>
      ${dc.length?`<optgroup label="直流 / 专项工程（${dc.length}）">${dc.map(opt).join('')}</optgroup>`:''}
      ${ac.length?`<optgroup label="交流联络线（${ac.length}）">${ac.map(opt).join('')}</optgroup>`:''}
    </select>
  </div>`;
}
/* 求解当前状态。界面只提供单选通道；换省对后已选通道不在候选里时自动取消，避免筛成空结果。 */
function solveState(){
  if(state.mapFocusLL) state.mapFocusLL=null;   // 批次 B：任何重算让位搜索聚焦（聚焦只由搜索触发）
  if((state.mustHave||[]).length>1) state.mustHave=state.mustHave.slice(0,1);
  let res=solve(solveInput(), algoData());
  const avail=new Set((res.availChannels||[]).map(c=>c.id));
  if(avail.size && (state.mustHave||[]).some(id=>!avail.has(id))){
    state.mustHave=state.mustHave.filter(id=>avail.has(id));
    res=solve(solveInput(), algoData());
  }
  return res;
}
function clearChannel(){ state.mustHave=[]; state.sel=0; doSolve(); }
function pick(i){ state.sel=i; saveLast(); renderCalc();
  const sel=document.querySelector('.rc.on'); if(sel) sel.scrollIntoView({block:'nearest',inline:'center',behavior:'smooth'}); }

/* ---------- 选中路线详情 ---------- */
/* 连续的区域内共用交流接口仅在展示层合并；不改动计价路径、容量链或区域计费位置。 */
function sharedRegionOf(s){
  const region=REGION_OF[s.a];
  return s.e.regional && s.e.type==='AC' && region && region===REGION_OF[s.b]?region:null;
}
function routeDisplayBlocks(r){
  const blocks=[];
  r.segs.forEach((s,i)=>{
    const region=sharedRegionOf(s),last=blocks[blocks.length-1];
    if(region && last?.region===region) last.end=i;
    else blocks.push({start:i,end:i,region});
  });
  return blocks;
}
/* 路线的展示站点：进入区域共用网络时只写「X区域」与物理落点（前一段专项工程的受端），
   不列区域内经过的省份——区域内电能按网架潮流分布，未必经过这些省。
   例：新疆 →吉泉直流→ 安徽 →华东交流→ 江苏 → 上海，显示为「新疆 → 华东区域」、落点安徽。仅影响展示。 */
function routeStops(r){
  const stops=[{name:N(r.nodes[0])}];
  for(const b of routeDisplayBlocks(r)){
    if(!b.region){ stops.push({name:N(r.nodes[b.end+1])}); continue; }
    const landing=stops.length>1 && !stops[stops.length-1].region ? stops.pop().name : null;
    if(stops[stops.length-1].region===b.region) continue;   // 经背靠背等衔接后仍在同一区域，合并
    stops.push({name:b.region+'区域',region:b.region,landing});
  }
  return stops;
}
/* 路线卡片标题：方案的核心通道（专项工程 / 直流），区域网架内的联络线不作标题；全程只走区域网架时写区域名 */
function routeLead(r){
  const own=routeDisplayBlocks(r).filter(b=>!b.region).map(b=>r.edges[b.start]);
  const main=own.find(e=>e.type==='DC')||own[0];
  if(main) return own.length>1?main.n+' 等 '+own.length+' 条':main.n;
  const regs=[...new Set(routeDisplayBlocks(r).map(b=>b.region))];
  return regs.join('、')+'区域网架';
}
/* 路线卡片的途经摘要：中间站点 + 末尾区域（末尾是省份时即受端，不重复写）。 */
function routeVia(r){
  const mid=routeStops(r).slice(1).filter((s,i,a)=>s.region||i<a.length-1);
  return mid.length?'经'+mid.map(s=>s.name+(s.landing?'（落点'+s.landing+'）':'')).join('→'):'';
}
function renderRouteNode(r,i){
  const nd=r.nodes[i];
  const isEnd=i===0||i===r.nodes.length-1;
  const stationAt=(e,code)=>e[e.from===code?'stFrom':'stTo'];
  const stUse=i===0?stationAt(r.edges[0],nd):i===r.edges.length?stationAt(r.edges[i-1],nd):(stationAt(r.edges[i],nd)||stationAt(r.edges[i-1],nd));
  return `<div class="tl-node ${isEnd?'end':''}">
    <div class="tl-dot"></div>
    <div class="tl-info">
      <div class="tl-name">${esc(N(nd))}${isEnd?`<span class="pill">${i===0?'送端':'受端'}</span>`:''}</div>
      ${stUse?`<div class="tl-st">${esc(stName(stUse))}<span class="tl-ad">@ ${esc(stAddr(stUse))}</span></div>`
        :(isEnd?`<div class="tl-st" style="color:var(--ink3)">落点站点待补</div>`:'')}
    </div>
  </div>`;
}
/* 方案里「自有」的通道段：区域共用网络内的交流接口只是连通抽象，电能未必经过，不单列、不据此告警或计段数 */
function ownEdges(r){ return routeDisplayBlocks(r).filter(b=>!b.region).map(b=>r.edges[b.start]); }
function renderRouteSegment(r,i){
  const s=r.segs[i], e=s.e;
  return `<div class="tl-seg">
    <div class="tl-seg-line"></div>
    <div class="tl-seg-card">
      <div class="tl-seg-hd"><span class="tl-seg-n">${esc(e.n)}</span><span class="pill ${e.type==='DC'?'':'g'}">${esc(e.type)} ${esc(e.kv)}</span>${e.tradable===false?'<span class="pill g" title="本笔中长期交易是否可使用待交易中心确认">交易网络·待确认</span>':''}</div>
      <div class="kpi">
        <div><span>${e.regional?'单独通道费':'输电价'}</span><b>${fmt(s.t)}</b><small>元/MWh</small></div>
        <div><span>计费线损率</span><b>${fmt(s.billLossPct,2)}</b><small>%</small></div>
        <div><span>容量</span><b>${e.cap?e.cap:'待补'}</b>${e.cap?'<small>MW</small>':''}</div>
      </div>
      ${s.util!=null?`<div class="meter"><i class="${s.util>1?'over':(s.util>0.8?'hi':'')}" style="width:${Math.min(s.util*100,100).toFixed(1)}%"></i></div>
        <div class="tl-cap">占用 <b>${fmt(s.util*100,1)}%</b>　剩余 ${fmt(s.headroom,0)} / ${e.cap} MW</div>`
        :`<div class="tl-cap">核定容量待补，无法校验占用</div>`}
      <div class="tl-sub">长度 ${e.lenKm?e.lenKm+' km':'约 '+fmt(s.crow,0)+' km*'}<i>·</i>段入口功率 ${fmt(s.inMW,0)} MW<i>·</i>段损耗 ${fmt(s.lossMwh,2)} MWh<em>（物理估算）</em></div>
      ${e.regional?`<details class="explain"><summary>计费说明</summary><div class="inner"><p class="note">${e.tariffStatus==='unknown'?'独立输电价待核，当前未计此项；':'区域共用网络接口，不逐个收通道费；'}${i===0?'送出省费用只在交易起点计一次。':'不收过境省外送费。'}${e.type==='AC' && s.billLossPct===0?'计费损耗 0，物理损耗仅作容量估算。':'背靠背损耗为估算，须核对备案标准。'}</p></div></details>`:''}
      <div class="tl-src">${tierTag(e.tier)} ${esc(e.doc||'无发改委文号')}${e.eff?'　生效 '+esc(e.eff):''}</div>
    </div>
  </div>`;
}
function renderRegionalCharge(r,region){
  const item=r.regionItems?.find(x=>x.region===region);
  const rate=Number.isFinite(RG[region])?(item?.rate ?? RG[region]*1000):null;
  const hasLoss=item && item.status!=='missing';
  const lossStatus=!item?'区域费开关关闭时，区域网损也排除。':!hasLoss?'未计入不代表已核定为 0%。'
    :item.status==='historical'?'第三监管周期参考值，当前适用性待核实。'
    :item.status==='custom'?'用户手填假设，待核实。':'使用已核实的区域参数。';
  const lossTag=!item||!hasLoss?'':item.status==='historical'?'第三周期参考':item.status==='custom'?'手填':'已核实';
  return `<div class="region-charge" id="region-charge-${esc(region)}" data-region="${esc(region)}">
    <div class="region-charge-hd"><b>区域计费</b><span class="pill ${item?'':'g'}">${item?(rate!=null?'全路径合并计 1 次':'区域电量价缺项'):'本情景未计入'}</span></div>
    <div class="region-charge-grid">
      <div><span>区域电量价</span><b>${rate!=null?fmt(rate,2):'待核实'}</b>${rate!=null?'<small>元/MWh</small>':''}</div>
      <div><span>折合交付费用</span><b>${item&&rate!=null?fmt(item.fee,2):'—'}</b>${item&&rate!=null?'<small>元/MWh</small>':''}</div>
      <div><span>区域网损</span><b>${!item?'—':hasLoss?fmt(item.pct,2):'未计入'}</b>${hasLoss?`<small>%</small><em>${lossTag}</em>`:''}</div>
    </div>
    ${rate==null?'<p class="region-charge-note">本区域电量价未收录，当前未计入该项，不代表免费。</p>':''}
    <details class="explain"><summary>计费说明</summary><div class="inner">
      <p class="note">${lossStatus}${hasLoss?' 本次区域计费损耗 '+fmt(item.lossMwh,2)+' MWh，已纳入总损耗。':''}</p>
      <p class="note">电量价不含线损；折合费用按本次区域出口电量计算。收费范围以当前测算情景为准，须按交易公告确认。</p>
    </div></details>
  </div>`;
}
function renderRouteTimeline(r){
  const blocks=routeDisplayBlocks(r),shownRegions=new Set();
  const regionCount=new Set(blocks.filter(b=>b.region).map(b=>b.region)).size;
  const ownCount=blocks.filter(b=>!b.region).length;
  let out=`<div class="card route-timeline">
    <div class="sec-title">交易连接与区域计费<span class="hint">${ownCount?ownCount+' 段通道':''}${ownCount&&regionCount?' · ':''}${regionCount?regionCount+' 个区域网架':''}</span></div>
    <details class="explain"><summary>图示说明</summary><div class="inner">
      <p class="note">展示交易连接关系与计费归属。区域网架内电能按实际潮流分布，不列区域内的联络线和经过的省份。</p>
      <p class="note">区域网架不按联络线逐条计费、计损；区域费与所选区域网损统一归集。容量与功率仅作估算参考，当期可交易性及可用输电容量（ATC）待确认。区域内联络线的参考数据保留在「完整明细」的逐段溯源中。</p>
      ${r.segs.some(s=>s.kmEst)?'<p class="note">* 参考长度按站点直线距离估算，实际路径长度待补。</p>':''}
    </div></details>
    <div class="tl">`;
  for(const block of blocks){
    out+=renderRouteNode(r,block.start);
    if(!block.region){ out+=renderRouteSegment(r,block.start);continue; }
    const {region,start,end}=block,segs=r.segs.slice(start,end+1);
    const charge=shownRegions.has(region)
      ?`<p class="region-charge-note">已合并至<a href="#region-charge-${esc(region)}">${esc(region)}区域计费</a>，本处不重复归集。</p>`
      :renderRegionalCharge(r,region);
    shownRegions.add(region);
    const exceeds=segs.some(s=>s.util>1);
    out+=`<div class="tl-seg region-seg"><div class="tl-seg-line"></div><div class="region-network" data-region="${esc(region)}">
      <div class="region-network-hd"><h3>${esc(region)}区域共用网络</h3><span class="pill g">交易连接示意</span></div>
      <div class="region-connection"><span><b>${esc(N(r.nodes[start]))}</b><small>区域接入</small></span><i aria-hidden="true">↔</i><strong>${esc(region)}区域网架</strong><i aria-hidden="true">↔</i><span><b>${esc(N(r.nodes[end+1]))}</b><small>${end===r.segs.length-1?'节点交付':'网架转接'}</small></span></div>
      ${charge}
      ${exceeds?'<p class="region-capacity exceeded">区域网架参考容量存在越限，详见「完整明细」逐段溯源。</p>':''}
    </div></div>`;
  }
  out+=renderRouteNode(r,r.nodes.length-1)+'</div>';
  // 背靠背、跨区域接口或公告要求的受端区域可能没有区域内交流区块；仍展示求解器已计入的区域费。
  for(const item of r.regionItems||[]){
    if(shownRegions.has(item.region)) continue;
    out+=`<div class="region-network region-settlement"><div class="region-network-hd"><h3>${esc(item.region)}区域计费</h3><span class="pill g">当前情景适用区域</span></div>${renderRegionalCharge(r,item.region)}</div>`;
    shownRegions.add(item.region);
  }
  return out+'</div>';
}

function renderDetail(res,r){
  if(!r) return '';
  const costName=state.includeDstCost!==false?'落地成本':'省界成本';
  const priceName=state.includeDstCost===false?'省界价格':'到户价格';
  const blocks=routeDisplayBlocks(r), own=ownEdges(r);
  // REQ-201：未确认可用于本笔中长期交易的通道——只看方案自有通道，区域网架内的联络线不告警
  const ntSegs=own.filter(e=>e.tradable===false);
  const unverified=own.filter(e=>e.tier!=='gov').length;
  const stops=routeStops(r), landings=stops.filter(s=>s.landing);
  const items=priceItems(r), tot=items.reduce((a,x)=>a+Math.abs(x.v),0)||1;

  let out=`<div class="card plan">
    <div class="plan-hd"><span class="plan-no">方案 #${state.sel+1}</span><span class="plan-st ${r.feasible?'ok':'bad'}">${r.feasible?'参考参数未越限 · ATC待核实':'存在越限'}</span></div>
    <div class="plan-main">
      <div class="plan-route">
        <div class="hd-route">${stops.map((s,i)=>(i?'<span class="arw">→</span>':'')+(s.region?`<span class="rg">${esc(s.name)}</span>`:esc(s.name))).join('')}</div>
        <div class="plan-sub">
          ${landings.length?`<div class="hd-landing">${landings.map(s=>`落点 <b>${esc(s.landing)}</b>${landings.length>1?'（'+esc(s.name)+'）':''}`).join('　')}</div>`:''}
          <div class="lines">${blocks.map(b=>`<span class="ln ${b.region?'ac':r.edges[b.start].type==='DC'?'dc':'ac'}">${esc(b.region?b.region+'区域网架':r.edges[b.start].n)}</span>`).join('<span class="plus">+</span>')}</div>
        </div>
      </div>
      <div class="plan-price"><b>${fmt(r.landed,2)}</b><small>元/MWh · ${priceName}</small></div>
    </div>
    <div class="pbar" role="img" aria-label="价格组成：${items.map(x=>esc(x.label)+' '+fmt(x.v,2)).join('，')}">${items.map(x=>`<i tabindex="0" style="width:${(Math.abs(x.v)/tot*100).toFixed(2)}%;background:${x.color}" data-tip="${esc(x.label)} ${fmt(x.v,2)} 元/MWh（${fmt(x.v/r.landed*100,1)}%）"></i>`).join('')}</div>
    <div class="plan-kpi">
      <div><span>过网费</span><b>${fmt(r.channelOnly,1)}</b><small>元/MWh</small></div>
      <div><span>计费网损</span><b>${fmt((1-r.D)*100,2)}</b><small>%</small></div>
      <div><span>最高占用</span><b>${fmt(r.maxLoad*100,0)}</b><small>%</small></div>
      <div><span>长度参考</span><b>${fmt(r.dist,0)}</b><small>km</small></div>
    </div>
    <div class="plan-tags">
      <span class="chip">${blocks.length} 段</span>
      <span class="chip ${unverified?'warn':'ok'}">${unverified?unverified+' 段非核定':'全部发改委核定'}</span>
      ${renderRegionComparison(r)}
    </div>
    ${r.pricingIssues?.length?`<details class="plan-issues"><summary>适用条件与缺项<b>${r.pricingIssues.length}</b></summary>${r.pricingIssues.map(v=>`<p class="note">${esc(v)}</p>`).join('')}</details>`:''}
    ${!r.feasible?`<div class="warn bad" style="margin:10px 0 0">${r.overSeg.length?'通道超容：'+r.overSeg.map(s=>esc(s.name)+' '+fmt(s.mw,0)+'/'+(s.effCap!=null?fmt(s.effCap,0):s.cap)+' MW').join('；')+'<br>':''}${r.secOver.length?'断面越限：'+r.secOver.map(h=>esc(h.sec.n)+' '+fmt(h.mw,0)+'/'+h.sec.limit+' MW').join('；'):''}</div>`:''}
    ${ntSegs.length?`<div class="warn" style="margin:10px 0 0">⚠ 含 <b>${ntSegs.length}</b> 段当期可交易性待确认的通道（${esc(ntSegs.slice(0,3).map(e=>e.n).join('、'))}${ntSegs.length>3?' 等':''}）</div>`:''}
    <div class="plan-actions">
      <button class="btn ghost" onclick="go('map')">网架图</button>
      <button class="btn ghost" onclick="document.getElementById('d-detail').open=true;document.getElementById('d-detail').scrollIntoView({behavior:'smooth'})">完整明细</button>
      <button class="btn ghost" onclick="exportReport()">导出报告</button>
    </div>
  </div>`;

  out+=renderRouteTimeline(r);

  // 完整明细
  out+=`<details class="adv boxed" id="d-detail"><summary>完整明细</summary><div class="inner">
    <div class="sub">费用拆解<em>单价 元/MWh · 总额 元</em></div><p class="note">输入为省间节点交付 ${fmt(r.qty,2)} MWh；${state.includeDstCost!==false?'按省内线损推算终端用电 '+fmt(r.consumerQty,2)+' MWh，以下到户单价及金额以此为基数':'省界单价及金额以交付电量为基数'}。区域网损电量包含在计费总损耗中。</p>
    <table>
      <tr><th style="width:40%">费用项</th><th>单价</th><th>总额</th><th>占比</th></tr>
      <tr><td>送端省内网损另计</td><td>${fmt(r.comp.originLoss)}</td><td>${num(r.yuan.originLoss)}</td><td>—</td></tr>
      <tr><td>送端报价购电</td><td>${fmt(r.comp.gen)}</td><td>${num(r.yuan.gen)}</td><td>${fmt(r.yuan.gen/r.yuan.total*100,1)}%</td></tr>
      <tr><td>送端省内段（送出省输电价格）</td><td>${fmt(r.comp.send)}</td><td>${num(r.yuan.send)}</td><td>${fmt(r.yuan.send/r.yuan.total*100,1)}%</td></tr>
      <tr><td>跨省专项工程输电费</td><td>${fmt(r.comp.trans)}</td><td>${num(r.yuan.trans)}</td><td>${fmt(r.yuan.trans/r.yuan.total*100,1)}%</td></tr>
      ${r.comp.reg>0?`<tr><td>区域电网输电费</td><td>${fmt(r.comp.reg)}</td><td>${num(r.yuan.reg)}</td><td>${fmt(r.yuan.reg/r.yuan.total*100,1)}%</td></tr>`:''}
      <tr><td>网损折价（受端承担部分${r.Dphys!==r.D?'，含线损段不另收':''}）</td><td>${fmt(r.comp.loss)}</td><td>${num(r.yuan.loss)}</td><td>${fmt(r.yuan.loss/r.yuan.total*100,1)}%</td></tr>
      ${r.comp.inLoss>0?`<tr><td>受端省内上网环节线损费用（线损率 ${fmt(r.inLossPct,2)}%）</td><td>${fmt(r.comp.inLoss)}</td><td>${num(r.yuan.inLoss)}</td><td>${fmt(r.yuan.inLoss/r.yuan.total*100,1)}%</td></tr>`:''}
      ${r.comp.net>0?`<tr><td>受端省网输配电价</td><td>${fmt(r.comp.net)}</td><td>${num(r.yuan.net)}</td><td>${fmt(r.yuan.net/r.yuan.total*100,1)}%</td></tr>`:''}
      ${r.comp.fund>0?`<tr><td>政府性基金及附加</td><td>${fmt(r.comp.fund)}</td><td>${num(r.yuan.fund)}</td><td>${fmt(r.yuan.fund/r.yuan.total*100,1)}%</td></tr>`:''}
      ${r.comp.cap>0?`<tr><td>容（需）量电费分摊（负荷率 ${fmt(state.dstLoadFactor,0)}% 假设）</td><td>${fmt(r.comp.cap)}</td><td>${num(r.yuan.cap)}</td><td>${fmt(r.yuan.cap/r.yuan.total*100,1)}%</td></tr>`:''}
      ${r.comp.sysOp>0?`<tr><td>系统运行费（手填）</td><td>${fmt(r.comp.sysOp)}</td><td>${num(r.yuan.sysOp)}</td><td>${fmt(r.yuan.sysOp/r.yuan.total*100,1)}%</td></tr>`:''}
      ${state.includeDstCost===false?`<tr><td style="color:var(--ink3)">受端省内费用</td><td style="color:var(--ink3)">已按口径排除</td><td style="color:var(--ink3)">—</td><td style="color:var(--ink3)">—</td></tr>`:''}
      <tr><td><b>合计</b></td><td><b>${fmt(r.landed)}</b></td><td><b>${num(r.yuan.total)}</b></td><td>100%</td></tr>
    </table>

    <div class="sub">电量与损耗<em>按 ${fmt(r.qty,0)} MWh 交付电量</em></div>
    <div class="g3">
      <div class="mc"><div class="l">送端计费电量</div><div class="v">${fmt(r.genMWh,1)}<small>MWh</small></div></div>
      <div class="mc"><div class="l">计费网损电量</div><div class="v">${fmt(r.lossMwh,2)}<small>MWh</small></div></div>
      <div class="mc"><div class="l">计费线损率</div><div class="v">${fmt((1-r.D)*100,3)}<small>%</small></div></div>
    </div>
    ${Math.abs(r.Dphys-r.D)>1e-9?`<p class="note" style="margin-top:6px">串联损耗估算：送端电量 ${fmt(r.genMWhPhys,1)} MWh，物理网损 ${fmt(r.lossMwhPhys,2)} MWh（${fmt((1-r.Dphys)*100,3)}%）。物理链用于容量校验；计费链剔除已含在输电价中的网损，以及区域共用交流接口的估算损耗，避免重复计费。</p>`:''}
    <p class="note" style="margin-top:6px">送端省内网损：${state.sourceQuote==='export'?'送出关口报价已含，不另计':state.originLossMode==='separate'?'按公开参数另计 '+fmt(r.cOriginLoss,2)+' 元/交付MWh':'按报价已覆盖处理，不另计'}。公开送省外上网环节线损率：${r.exportLossPct!=null?fmt(r.exportLossPct,2)+'%':'未获取'}。</p>
    <div class="g3" style="margin-top:8px">
      <div class="mc"><div class="l">路径长度</div><div class="v">${fmt(r.dist,0)}<small>km</small></div></div>
      <div class="mc"><div class="l">直线距离</div><div class="v">${fmt(r.straight,0)}<small>km</small></div></div>
      <div class="mc"><div class="l">绕行度</div><div class="v">${fmt(r.detour,2)}<small>x</small></div></div>
    </div>
    <div style="margin-top:9px;font-size:11px;color:var(--ink2);line-height:1.75">
      <div><b>途经节点</b>：${esc(r.nodes.map(N).join(' → '))}</div>
      <div><b>经过线路</b>：${esc(r.edges.map(e=>e.n).join(' + '))}</div>
      <div><b>电压等级</b>：${esc(r.kvList.join(' / ')||'—')}　<b>直流/交流</b>：${r.dcCount} / ${r.acCount} 段</div>
      <div><b>涉及区域</b>：${esc(r.regionList.join('、')||'—')}</div>
      ${r.stationList.length?`<div><b>换流/变电站</b>：${esc(r.stationList.map(stName).join('、'))}</div>`:''}
    </div>
    <div class="formula" style="margin-top:9px">
      <div class="mono">送达系数 D = ${fmt(r.D,6)}　送端需发电 ${fmt(r.genQty,6)} MWh / 每交付 1 MWh</div>
      <div class="txt">多段串联时线损为乘法关系：D = Π(1−ηᵢ)。网损因此是乘法项，不能直接作为路径搜索的边权。</div>
    </div>

    <div class="sub">断面校验<em>${r.secHits.length?r.secHits.length+' 个断面':'本路径未经过已录入断面'}</em></div>
    <p class="note" style="margin:0 0 8px">容量校验：${state.occPct>0?`按参考容量×(1−中长期占用 ${state.occPct}%) 扣减；`:''}非可用输电能力（ATC），未扣检修等其它占用，结果偏乐观。</p>
    ${r.secHits.length? r.secHits.map(h=>`<div class="segblk">
      <div class="hd"><span>${esc(h.sec.n)}</span><em>${fmt(h.mw,0)} / ${h.sec.limit} MW</em></div>
      <div style="font-size:11px;color:var(--ink2)">利用率 ${fmt(h.util*100,1)}%　余量 ${fmt(h.sec.limit-h.mw,0)} MW　${h.over?'<span class="pill" style="background:var(--red-bg);color:var(--red)">越限</span>':'<span class="pill" style="background:var(--teal-bg);color:var(--teal)">通过</span>'}</div>
      <div class="meter"><i class="${h.over?'over':(h.util>0.8?'hi':'')}" style="width:${Math.min(h.util*100,100).toFixed(1)}%"></i></div>
      <div class="src">计入通道：${esc(h.members.join('、'))}<br>${esc(h.sec.note)}<br>来源：${esc(h.sec.src)}</div>
    </div>`).join('') : `<p class="note">该路径经过的通道未映射到已录入的断面。断面限额属向注册市场成员披露的信息，公开渠道无法获取运行限额。</p>`}

    <div class="sub">逐段溯源<em>每段费率的原始依据</em></div>
    ${r.segs.map((s,si)=>{const e=s.e;return `<div class="segblk">
      <div class="hd"><span>第 ${si+1} 段　${esc(N(s.a))} → ${esc(N(s.b))}</span><em>${esc(e.n)}${sharedRegionOf(s)?' · '+esc(sharedRegionOf(s))+'区域网架参考接口，不单独计费':''}</em></div>
      <div class="src" style="margin-top:4px;padding-top:0;border-top:0">
        ${tierTag(e.tier)}　${e.doc?esc(e.doc):'无发改委文号'}${e.eff?'　生效 '+esc(e.eff):(e.pubDate?'　发布 '+esc(e.pubDate):'')}<br>
        ${e.docTitle?esc(e.docTitle)+'<br>':''}
        ${e.regional?`区域接口单独通道费 0；${si===0?'起点送出省价格 '+fmt(s.sf0)+' 元/MWh':'不叠加过境省外送费'}；计费损耗 ${fmt(s.billLossPct,2)}%，物理估算损耗 ${fmt(e.loss,2)}%。<br>`:''}
        计费口径：${e.regional?'区域共用网络统一归集（按上方计费损耗执行）':esc(e.bill)+(e.incLoss?'（含输电环节线损，本段网损不再另收；规则 3.3.2）':'（不含线损，线损另计）')}${e.tax?'　含税':'　不含税'}　输电费 = 输电价 × 段后电量（规则 4.3.1）<br>
        ${!e.regional && s.a===e.to && s.t!==e.t?`本段反向行进：按送端 ${esc(N(s.a))} 的送出省输电价格 ${fmt(s.t)} 元/MWh 计（存储方向 ${esc(N(e.from))}→${esc(N(e.to))} 为 ${fmt(e.t)}）<br>`:''}
        ${(si===0 && s.a===e.to && e.sendFeeRev!=null && s.sf0!==e.sendFee)?`本段反向行进（${esc(e.dirNote||'双向工程')}）：送端省内段按 ${esc(N(s.a))} 送出省输电价格 ${fmt(s.sf0)} 元/MWh 计<br>`:''}
        ${e.marginalNote?`边际输电价说明：${esc(e.marginalNote)}<br>`:''}
        ${e.status?'状态：'+esc(e.status)+'<br>':''}
        ${e.fn&&e.fn!==e.n?'别名：'+esc(e.fn)+'<br>':''}
        ${e.stFrom?`送端 ${esc(stName(e.stFrom))} @ ${esc(stAddr(e.stFrom))}<br>`:''}
        ${e.stTo?`受端 ${esc(stName(e.stTo))} @ ${esc(stAddr(e.stTo))}<br>`:''}
        ${e.note?esc(e.note)+'<br>':''}
        ${e.excerpt?`<q>原文摘录：${esc(e.excerpt)}</q>`:''}
        ${e.hist&&e.hist.length?`<div style="margin-top:6px"><b>调价历史</b>${e.hist.map(h=>`<br>· ${esc(h.effective_from||'—')}　${esc(h.tariff_raw||'')}${h.loss_rate_pct!=null?'　线损 '+h.loss_rate_pct+'%':''}　${esc(h.doc_number||'')}${h.note?'　'+esc(h.note):''}`).join('')}</div>`:''}
      </div>
    </div>`;}).join('')}

    ${r.regionItems?.length?`<div class="sub">区域参数出处与适用期</div>${r.regionItems.map(v=>`<p class="note">${esc(v.region)}：电量电价 ${fmt(v.rate,2)} 元/MWh，计费网损 ${fmt(v.pct,2)}%，状态 ${esc(v.status)}。${esc(v.source.document||'当前来源未获取')}；${v.source.url?`<a target="_blank" rel="noopener" href="${esc(v.source.url)}">历史原件</a>`:''}。${esc(v.source.note||'')}</p>`).join('')}`:''}

    <div class="sub">数据溯源汇总</div>
    <div class="g3">
      <div class="mc"><div class="l">发改委核定段</div><div class="v">${r.tiers.gov||0}<small>/${r.hops}</small></div></div>
      <div class="mc"><div class="l">国网披露段</div><div class="v">${r.tiers.grid||0}<small>段</small></div></div>
      <div class="mc"><div class="l">区域/送出省段</div><div class="v">${r.tiers.region||0}<small>段</small></div></div>
    </div>
    ${r.unverified?`<div class="warn" style="margin-top:9px">本路径有 <b>${r.unverified} 段</b>不属于发改委核定价，结论仅供比选参考，正式结算前须逐段核对原始文件。</div>`
      :`<div class="warn ok" style="margin-top:9px">本路径全部 ${r.hops} 段均为发改委核定价格，可回溯到原文。</div>`}

    <div class="sub">口径位置<em>两个口径下的排名与差距</em></div>
    <div class="g2">
      <div class="mc"><div class="l">${costName}</div><div class="v">#${r.rankA}</div><div style="font-size:10.5px;color:var(--ink3)">${r.rankA===1?'最优':'高 '+fmt(r.landed-res.byA[0].landed)+' 元/MWh'}</div></div>
      <div class="mc"><div class="l">过网费</div><div class="v">#${r.rankB}</div><div style="font-size:10.5px;color:var(--ink3)">${r.rankB===1?'最低':'高 '+fmt(r.channelOnly-res.byB[0].channelOnly)+' 元/MWh'}</div></div>
    </div>
    <div class="formula" style="margin-top:12px">
      <div class="mono">节点交付费用小计 = 手填送端报价 × 报价折算系数 + 未包含的起点输电费 + Σ[专项工程价 × 工程出口电量系数] + Σ[适用区域价 × 区域出口电量系数]</div>
      <div class="txt">报价折算系数 = 1 + 买方网损分担比例 × 跨省计费损耗电量系数 + 送端省内网损另计系数（选择另计时）。损耗通过率连乘，逐段输电费按出口电量折算；已包含的费用不再叠加。到户扩展另计受端省内已列费用。</div>
    </div>
    <div class="sub">中长期测算依据与范围</div>
    <p class="note">按《电力中长期市场基本规则》（发改能源规〔2025〕1656号）、适用区域细则、价格文件与合同边界进行报价测算。合同参考点、分时曲线和差价/差量结算仍以交易机构规则及合同为准。用户提供的省间现货规则用于公式对照研究；现货出清及其结算专属条款不作为本页的中长期结算规则。</p>
  </div></details>`;
  return out;
}

/* ---------- REQ-403 价差敏感性：对当前省对按送端报价扫描 ---------- */
/* 扫描要重算 36 次 solve()；跳数放宽到 MAX_HOPS 后单次可达数十毫秒，故只在展开折叠卡时计算，
   避免每次重渲染（切方案、改参数）都付出这笔开销。重渲染后若面板恢复为展开，toggle 事件会再次触发填充。 */
const SENS_P0=100, SENS_P1=800, SENS_STEP=20;
function renderSensitivity(res){
  if(!res||!res.rows) return '';
  return `<details class="adv boxed" id="d-sens" ontoggle="if(this.open)fillSensitivity(this)"><summary>价差敏感性</summary><div class="inner"></div></details>`;
}
function fillSensitivity(el){
  const box=el.querySelector('.inner');
  if(box && !box.dataset.done){ box.innerHTML=sensitivityTable(); box.dataset.done='1'; }
}
function sensitivityTable(){
  const P0=SENS_P0,P1=SENS_P1,STEP=SENS_STEP; let prev=null; const rowsA=[];
  for(let p=P0;p<=P1;p+=STEP){
    const R=solve(Object.assign(solveInput(),{pGen:p}), algoData());
    const best=R.err?null:(R.bestA||R.rows[0]||null);
    const flip=!!(best&&prev&&(prev.nodes.join('>')!==best.nodes.join('>')||prev.edges.map(e=>e.id).join(',')!==best.edges.map(e=>e.id).join(',')));
    rowsA.push({p,best,flip});
    if(best) prev=best;
  }
  const trs=rowsA.map(pt=>`<tr${pt.flip?' style="background:var(--amber-bg)"':''}>
    <td>${pt.p}</td>
    <td>${pt.best?esc(pt.best.edges.map(e=>e.n).join(' + ')):'—'}</td>
    <td>${pt.best?fmt(pt.best.landed):'—'}</td>
    <td>${pt.best?fmt(pt.best.channelOnly):'—'}</td>
    <td>${pt.flip?'★ 最优切换':''}</td></tr>`).join('');
  return `<p class="note" style="margin:0 0 8px">送端报价 ${P0}~${P1} 元/MWh 扫描（步长 ${STEP}），★ 为最优路线切换点。</p>
    <table><tr><th>送端报价 元/MWh</th><th>最优路线（口径一）</th><th>落地成本</th><th>过网费</th><th>翻转</th></tr>${trs}</table>
    <p class="note">纯前端复用 solve() 重算；金额为对应送端报价下的口径一最优方案。切换点表示该价格档起另一条路线成为最优。</p>`;
}

/* ---------- REQ-404 方案报告导出（Markdown） ---------- */
function exportReport(){
  const res=state._res; if(!res||!res.rows||!res.rows.length) return;
  const r=res.rows[Math.min(state.sel,res.rows.length-1)];
  const L=[];
  L.push('# 省间路径测算报告');
  L.push('');
  L.push('- 生成时间：'+new Date().toLocaleString('zh-CN'));
  L.push('- priceVersion：'+PRICE_VERSION+'（BUILD_TIME '+BUILD_TIME+'）');
  L.push('- 路径：'+r.nodes.map(N).join(' → ')+'（'+r.hops+' 段）');
  L.push('- 测算日期：'+state.tradeDate);
  L.push('- 电量（省间节点交付）：'+state.qty+' MWh / '+state.hours+' h　网损承担：'+(state.lossBearer==1?'受端':state.lossBearer==0.5?'两端各半':'送端'));
  L.push('- 产品：省间中长期；送端报价边界：'+state.sourceQuote+'；送端省内网损：'+state.originLossMode+'；区域计费范围：'+state.regionChargeMode);
  L.push('- 价格参数：送端报价 '+state.pGen+' / 受端输配电价 '+state.pNet+' / 基金及附加 '+state.fund+' 元/MWh');
  if(state.includeDstCost!==false){ const vt=dstTariff(); if(vt.tier) L.push('- 受端到户：'+(vt.ent?vt.ent.名称+' ':'')+vt.tier.档别+' '+(vt.billing==='single'?'单一制':'两部制')+'（1077号附件1 第 '+vt.ent.页码+' 页）；省内上网环节线损率 '+fmt(vt.inLoss,2)+'%'); }
  if(srcStation() && state.sourceQuote!=='export') L.push('- 送出价口径：'+srcStation().范围+' '+fmt(srcStation().送出价,2)+' 元/MWh');
  L.push('- 口径：'+(state.includeDstCost===false?'只算到受端省界':'到户已列费用小计')+'　区域电网费：'+(state.includeRegion?'计入':'不计入'));
  for(const issue of r.pricingIssues||[]) L.push('- 适用条件：'+issue);
  L.push('- 区域网损模式：'+(state.regionLossMode||'exclude'));
  L.push('- 金额基数：'+r.amountQty+' MWh（到户价使用推算终端用电量）');
  for(const x of r.regionScenarios||[]) L.push('- 同路径情景 '+x.mode+'：省界 '+fmt(x.border,4)+' / 到户小计 '+fmt(x.landed,4)+' 元/MWh；'+x.regions.map(v=>v.region+' '+v.pct+'% '+v.status).join('、'));
  for(const x of r.regionItems||[]) L.push('- 网损来源 '+x.region+'：'+x.source.document+' '+x.source.url);
  L.push('- 容量状态：参考参数校验，非当期 ATC / 安全校核；不能据此保证成交。');
  L.push('');
  L.push('## 测算结果');
  L.push('- 落地成本：'+fmt(r.landed)+' 元/MWh（候选内排名 #'+r.rankA+'）');
  L.push('- 过网费：'+fmt(r.channelOnly)+' 元/MWh（排名 #'+r.rankB+'）');
  L.push('');
  L.push('## 费用拆解（单价与金额基数 '+r.amountQty+' MWh）');
  L.push('| 费用项 | 单价 元/MWh | 总额 元 |');
  L.push('|---|---|---|');
  L.push('| 送端省内网损另计 | '+fmt(r.comp.originLoss)+' | '+num(r.yuan.originLoss)+' |');
  L.push('| 送端报价购电 | '+fmt(r.comp.gen)+' | '+num(r.yuan.gen)+' |');
  L.push('| 送端省内段（送出省输电价格） | '+fmt(r.comp.send)+' | '+num(r.yuan.send)+' |');
  L.push('| 跨省专项工程输电费 | '+fmt(r.comp.trans)+' | '+num(r.yuan.trans)+' |');
  if(r.comp.reg>0) L.push('| 区域电网输电费 | '+fmt(r.comp.reg)+' | '+num(r.yuan.reg)+' |');
  L.push('| 网损折价 | '+fmt(r.comp.loss)+' | '+num(r.yuan.loss)+' |');
  if(r.comp.inLoss>0) L.push('| 受端上网环节线损费用 | '+fmt(r.comp.inLoss)+' | '+num(r.yuan.inLoss)+' |');
  if(r.comp.net>0) L.push('| 受端省网输配电价 | '+fmt(r.comp.net)+' | '+num(r.yuan.net)+' |');
  if(r.comp.fund>0) L.push('| 政府性基金及附加 | '+fmt(r.comp.fund)+' | '+num(r.yuan.fund)+' |');
  if(r.comp.cap>0) L.push('| 容（需）量电费分摊（负荷假设） | '+fmt(r.comp.cap)+' | '+num(r.yuan.cap)+' |');
  if(r.comp.sysOp>0) L.push('| 系统运行费（手填） | '+fmt(r.comp.sysOp)+' | '+num(r.yuan.sysOp)+' |');
  L.push('| **合计** | **'+fmt(r.landed)+'** | **'+num(r.yuan.total)+'** |');
  L.push('');
  L.push('## 逐段明细与溯源');
  r.segs.forEach((s,i)=>{
    const e=s.e;
    L.push('');
    L.push('### 第 '+(i+1)+' 段 '+N(s.a)+' → '+N(s.b)+'：'+e.n);
    if(e.regional) L.push('- 区域共用网络接口：不单独收通道费；'+(i===0?'送出省费仅起点计入':'不收过境省外送费'));
    L.push('- 电压 '+e.kv+'　输电价 '+fmt(s.t)+' 元/MWh　计费线损率 '+fmt(s.billLossPct,2)+'%　物理估算线损 '+fmt(e.loss,2)+'%　段入口 '+fmt(s.inMW,0)+' MW'+(e.cap?'　容量 '+e.cap+' MW':''));
    L.push('- 文号：'+(e.doc||'无发改委文号')+(e.eff?'　生效 '+e.eff:''));
    if(e.excerpt) L.push('- 原文摘录：'+e.excerpt);
  });
  L.push('');
  L.push('> 本工具为测算与比选辅助，不构成交易建议；实际可交易路径以电力交易中心公布为准。');
  const blob=new Blob([L.join('\n')],{type:'text/markdown;charset=utf-8'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='省间测算报告-'+N(r.nodes[0])+'-'+N(r.nodes[r.nodes.length-1])+'.md'; a.click();
}

/* ---------- FR-1（PRD-体验问题修复）：输入钳制与红框红字反馈 ----------
   sanNum（format.js）只管数值；这里负责界面反馈：越限时输入框红框 + 输入框下方红字，
   修正后消失。越限状态显式记入 _clampBad（而不是重绘后按当前值重判——重绘后输入框
   已是钳制值，重判永远"合法"，提示会被自己擦掉），renderCalc 整块重绘后重放。 */
const _clampBad={};
function clampApply(el,entry){
  if(!el) return;
  el.classList.toggle('clamp-bad',!!entry);
  const box=el.parentElement;
  let hint=box?box.querySelector('.clamp-hint'):null;
  if(entry){
    if(!hint&&box){ hint=document.createElement('div'); hint.className='clamp-hint'; box.appendChild(hint); }
    if(hint) hint.textContent='超出上限，已按 '+sanNum(entry.n,entry.lim)+' 计算';
  } else if(hint) hint.remove();
}
function clampRegister(el,raw,lim){
  if(!el) return;
  const s=String(raw==null?'':raw).trim();
  const n=Number(s);
  const bad=s!==''&&Number.isFinite(n)&&n>lim.max;   // PRD 只定义上限钳制，红字仅报超上限
  if(bad) _clampBad[el.id]={lim,n}; else delete _clampBad[el.id];
  clampApply(el,bad?{lim,n}:null);
}
/* 读输入框并按业务上限钳制；nonNeg=true 时沿用旧口径：0/负数回落默认值（B-02/B-03 行为锁） */
function readSan(g,id,lim,nonNeg){
  const el=g(id); if(!el) return lim.fallback;
  let v=sanNum(el.value,lim);
  if(nonNeg&&!(v>0)) v=lim.fallback;
  clampRegister(el,el.value,lim);
  return v;
}
function reapplyClampMarks(){
  for(const id of Object.keys(_clampBad)) clampApply(document.getElementById(id),_clampBad[id]);
}

function doSolve(){
  readInputs(); state._res=solveState();
  const n=state._res.rows?state._res.rows.length:0;
  if(state.sel>=n) state.sel=0;
  saveLast(); renderCalc();
}
function readInputs(){
  const g=id=>document.getElementById(id);
  if(!g('i-from')) return;
  state.from=g('i-from').value; state.to=g('i-to').value;
  // FR-1：数值输入按业务上限钳制（NUM_LIMITS），超上限红框红字提示，state 只存钳制后值；
  // 电量/时长维持旧口径 0/负数回落默认值（nonNeg）
  state.qty=readSan(g,'i-qty',NUM_LIMITS.qty,true);
  state.hours=readSan(g,'i-hours',NUM_LIMITS.hours,true);
  state.pGen=readSan(g,'i-pgen',NUM_LIMITS.quote);
  // 受端输配电价 / 基金及附加只在「到户已列费用」口径下渲染；按渲染时的口径决定是否读取，未渲染时保留预填值
  if(state.includeDstCost!==false){
    const pn=g('i-pnet'), fd=g('i-fund'), lf=g('i-dstlf'), so=g('i-dstsysop');
    if(pn) state.pNet=readSan(g,'i-pnet',NUM_LIMITS.quote);
    if(fd) state.fund=readSan(g,'i-fund',NUM_LIMITS.quote);
    const num=el=>{ const v=String(el.value??'').trim(); return v===''||!Number.isFinite(+v)||+v<0?null:+v; };
    if(lf && state.dstCapMode && state.dstCapMode!=='none'){ const v=num(lf); state.dstLoadFactor=v!=null&&v>0&&v<=100?v:null; }
    if(so){ const s=String(so.value??'').trim(); state.dstSysOpFee=s===''||!Number.isFinite(+s)?null:sanNum(so.value,NUM_LIMITS.quote); clampRegister(so,so.value,NUM_LIMITS.quote); }
  }
  state.lossBearer=+g('i-bearer').value;
  state.includeRegion=g('i-region').value==='1';
  state.sourceQuote=g('i-sourcequote')?.value||state.sourceQuote;
  state.originLossMode=g('i-originloss')?.value||state.originLossMode;
  state.regionChargeMode=g('i-regioncharge')?.value||state.regionChargeMode;
  state.regionLossMode=g('i-regionloss')?.value||state.regionLossMode||'exclude';
  state.regionLossRates=state.regionLossRates||{};
  for(const k of Object.keys(DATA.RLOSS||{})){
    const el=g('i-rloss-'+k);
    if(el){ const s=el.value.trim(); state.regionLossRates[k]=s===''?null:sanNum(s,NUM_LIMITS.pct); if(s!=='') clampRegister(el,el.value,NUM_LIMITS.pct); }
  }
  state.includeDstCost=g('i-dstcost').value==='1';
  state.tradableOnly=g('i-tradable')?.value==='1';   // REQ-203
  const _o=+g('i-zyocc')?.value||0;                  // REQ-302（百分比维持现有 0~90 钳制）
  state.occPct=Math.min(90,Math.max(0,_o));
}
/* 送端省变化：只影响送端报价 */
function applyFromProv(){
  const f=PV[state.from];
  if(!state.pGenManual&&f&&f.clear!=null) state.pGen=f.clear;
}
/* 受端省变化：影响受端省网输配电价、政府性基金及附加 */
function applyToProv(){
  const t=PV[state.to];
  if(!t) return;
  const vn=dstTariff().net;
  if(vn!=null) state.pNet=vn; else if(t.net!=null) state.pNet=t.net;
  state.fundMissing=(t.fund===null||t.fund===undefined);
  state.fund=state.fundMissing?0:t.fund;
}
function applyBothProv(){ applyFromProv(); applyToProv(); }
/* 把某一项恢复为当前受端省的核定值 */
function resetOne(k){
  const t=PV[state.to];
  if(!t) return;
  if(k==='pNet'){ const vn=dstTariff().net; if(vn!=null) state.pNet=vn; else if(t.net!=null) state.pNet=t.net; }
  if(k==='fund'){ state.fundMissing=(t.fund===null||t.fund===undefined); state.fund=state.fundMissing?0:t.fund; }
  state._res=solveState(); saveLast(); renderCalc();
}

/* ---------- REQ-401 容量电费测算器（独立折叠卡，不参与路径比选） ---------- */
/* 默认预选档口径：优先「1~10（20）千伏」档；该省无此档别的取表内最低电压档（第一档）。 */
function capProv(){ return (state.capProv&&PV[state.capProv])?state.capProv:state.to; }
function capTiers(p){ const e=CAP[p]; return (e&&e.需量电价)?e.需量电价:[]; }
function capDefaultTier(tiers){ return tiers.find(t=>/1~10（20）/.test(t.档别))||tiers[0]||null; }
function capTier(p){
  const tiers=capTiers(p);
  if(!tiers.length) return null;
  return tiers.find(t=>t.档别===state.capTier)||capDefaultTier(tiers);
}
function setCapMode(m){ state.capMode=m; saveLast(); renderCalc(); }
function renderCapFee(){
  const p=capProv(), entry=CAP[p], tiers=capTiers(p), tier=capTier(p);
  const isCap=state.capMode==='cap';
  const modeLbl=isCap?'按容量':'按需量';
  const unit=isCap?'kVA':'kW';
  const priceUnit=isCap?'元/千伏安·月':'元/千瓦·月';
  let inner;
  if(!entry||!tiers.length){
    // 缺省省份（西藏 XZ）：暂无数据，不补估
    inner=`<div class="warn">「${esc(PV[p].n)}」的两部制容量/需量电价暂无数据（数据源未收录该省输配电价表），本测算器不参与路径比选。</div>`;
  } else {
    const priceList=isCap?entry.容量电价:entry.需量电价;
    const priceObj=tier?priceList.find(t=>t.档别===tier.档别):null;
    const price=priceObj?priceObj.价:null;
    const val=+state.capValue||0, qty=+state.capQty||0;
    const annual=(price!=null&&val>0)?price*val*12:null;
    const per=(annual!=null&&qty>0)?annual/qty:null;
    inner=`
    <div class="row2">
      <label class="f"><span>省份</span><select id="i-capprov">
        ${Object.keys(PV).map(k=>`<option value="${k}" ${k===p?'selected':''}>${esc(PV[k].n)}</option>`).join('')}
      </select></label>
      <label class="f"><span>电压档（默认预选项 = 1~10（20）千伏档，无此档取第一档）</span><select id="i-captier">
        ${tiers.map(t=>`<option value="${esc(t.档别)}" ${tier&&t.档别===tier.档别?'selected':''}>${esc(t.档别)}</option>`).join('')}
      </select></label>
    </div>
    <div class="sub">计费方式<em>二选一，互斥切换</em></div>
    <div class="seg">
      <button class="${isCap?'on':''}" onclick="setCapMode('cap')">按容量 kVA</button>
      <button class="${!isCap?'on':''}" onclick="setCapMode('demand')">按需量 kW</button>
    </div>
    <div class="row2">
      <label class="f"><span>${modeLbl} ${unit}</span><input id="i-capval" type="number" value="${state.capValue}" step="10" min="0"></label>
      <label class="f"><span>年用电量 MWh</span><input id="i-capqty" type="number" value="${state.capQty}" step="100" min="0"></label>
    </div>
    <div class="g3" style="margin-top:2px">
      <div class="mc"><div class="l">所选档单价</div><div class="v">${price!=null?fmt(price):'—'}<small>${priceUnit}</small></div></div>
      <div class="mc"><div class="l">年容量电费</div><div class="v" ${annual!=null?`title="完整值 ${num(annual)} 元/年"`:''}>${annual!=null?fmtCompact(annual):'—'}<small>元/年</small></div></div>
      <div class="mc"><div class="l">度电分摊额</div><div class="v" ${per!=null?`title="完整值 ${fmt(per,2)} 元/MWh"`:''}>${per!=null?fmtCompact(per,2):'—'}<small>元/MWh</small></div></div>
    </div>
    ${tier?`<details class="explain"><summary>本省全部电压档单价<em>1077号附件1</em></summary><div class="inner">
      <table><tr><th>档别</th><th>容量电价<br>元/千伏安·月</th><th>需量电价<br>元/千瓦·月</th></tr>
      ${(entry.容量电价||[]).map(t=>{
        const dm=(entry.需量电价||[]).find(x=>x.档别===t.档别);
        const cur=tier&&t.档别===tier.档别;
        return `<tr${cur?' style="background:var(--blue-bg)"':''}><td>${esc(t.档别)}${cur?'　<b>当前</b>':''}</td><td>${t.价!=null?fmt(t.价):'—'}</td><td>${dm&&dm.价!=null?fmt(dm.价):'—'}</td></tr>`;
      }).join('')}</table>
      <p class="note">数据同费率库「容量/需量电价」分区；测算取当前所选档，其余档别供核对。</p>
    </div></details>`:''}
    ${qty<=0?'<p class="note">年用电量为 0，度电分摊额不计算（显示 —）。</p>':''}
    <div class="lib-src" style="margin-top:8px">当前取值依据：${esc(entry.省)} · ${esc(tier?tier.档别:'—')} · ${modeLbl}　${esc(entry.来源)}</div>`;
  }
  return `<details class="adv boxed" id="d-capfee"><summary>容量电费测算<span style="font-weight:400;color:var(--ink3);font-size:11px;margin-left:6px">算一笔容量电费的独立小工具</span></summary><div class="inner">
    ${inner}
    <p class="note cap-note" style="margin-top:10px"><b>容量电费与电量来自省内或省外无关，不参与路径比选</b>（发改价格〔2020〕1441号 / 〔2023〕532号口径；年费用 = 单价 × ${isCap?'容量':'需量'} × 12，度电分摊 = 年费用 ÷ 年用电量）。</p>
  </div></details>`;
}

function renderRegionComparison(r){
  if(!r.regionScenarios?.length || !r.regionItems?.length) return '';
  const cur=state.regionLossMode||'exclude';
  return `<span class="rl-cmp" id="region-comparison" title="同一路径、送端报价与区域输电费不变，仅比较区域网损">区域网损${r.regionScenarios.map(v=>`<span class="${v.mode===cur?'on':''}">${v.mode==='exclude'?'不计':'第三周期'} <b>${fmt(v.landed,2)}</b></span>`).join('')}</span>`;
}
