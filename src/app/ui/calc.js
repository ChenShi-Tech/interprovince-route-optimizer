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
  const _fid=(_ae&&_ae.id&&_host&&_host.contains&&_host.contains(_ae))?_ae.id:null;
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
  let out=_sbHead+`<div class="card tight" id="market-entries"><div class="row2">
    <button class="btn" type="button" aria-pressed="true">省间中长期 · 交付成本与报价测算</button>
    <button class="btn ghost" type="button" disabled title="现货出清与结算功能后续拓展">省间现货 · 待拓展</button>
  </div><p class="note">默认交付点：受端省间交易节点。手填合同或拟报价，按选定费用边界测算。</p></div><div class="topbar"><div class="picker">
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

  <div class="bar-params">
    <label><span>省间交付 MWh</span><input id="i-qty" type="number" value="${state.qty}" step="100" min="1"></label>
    <label><span>时长 h</span><input id="i-hours" type="number" value="${state.hours}" step="0.25" min="0.25"></label>
    <label><span>跳数</span><select id="i-hops">
      ${[1,2,3,4,5,6].map(v=>`<option value="${v}" ${state.maxHops==v?'selected':''}>${v===6?'6（上限）':v}</option>`).join('')}
    </select></label>
    <label><span>绕行</span><select id="i-detour">
      ${[[1.5,'1.5x'],[2,'2.0x'],[2.5,'2.5x'],[9,'不限']].map(([v,t])=>`<option value="${v}" ${state.maxDetour==v?'selected':''}>${t}</option>`).join('')}
    </select></label>
  </div></div>

  <details class="adv boxed" open><summary>价格与口径</summary><div class="inner">
    <div class="row2">
      <label class="f"><span>送端报价 元/MWh（含税）</span><input id="i-pgen" type="number" value="${state.pGen}" step="5"></label>
      <label class="f"><span>受端目标交付价 元/MWh（含税）</span><input id="i-pdst" type="number" value="${state.pDst}" step="5"></label>
    </div>
    <div class="row2">
      <label class="f${noDst?' off':''}"><span>受端省网输配电价 ${noDst?'<span class="pill g">本口径下不使用</span>':`<a onclick="resetOne('pNet')" style="color:var(--blue);font-weight:500;cursor:pointer">恢复核定值</a>`}</span><input id="i-pnet" type="number" value="${state.pNet}" step="0.1"${noDst?' disabled':''}></label>
      <label class="f${noDst?' off':''}"><span>基金及附加 ${noDst?'<span class="pill g">本口径下不使用</span>':`<a onclick="resetOne('fund')" style="color:var(--blue);font-weight:500;cursor:pointer">恢复核定值</a>`}</span><input id="i-fund" type="number" value="${state.fund}" step="0.1"${noDst?' disabled':''}></label>
    </div>

    <div class="row2">
      <label class="f"><span>送端报价边界</span><select id="i-sourcequote">
        <option value="plant" ${state.sourceQuote==='plant'?'selected':''}>电能量报价：未含送出省输电费</option>
        <option value="export" ${state.sourceQuote==='export'?'selected':''}>送出关口报价：已含送出省费用及省内网损</option>
      </select></label>
      <label class="f"><span>送端省内网损费用</span><select id="i-originloss" ${state.sourceQuote==='export'?'disabled':''}>
        <option value="included" ${state.originLossMode!=='separate'?'selected':''}>报价已覆盖，不再另加</option>
        <option value="separate" ${state.originLossMode==='separate'?'selected':''}>报价未覆盖，按公开省内网损率另计</option>
      </select></label>
    </div>
    <label class="f"><span>区域费适用范围（按交易公告确认）</span><select id="i-regioncharge">
      <option value="network" ${state.regionChargeMode!=='buyer'?'selected':''}>按路径涉及的区域共用网络，各区域计一次</option>
      <option value="buyer" ${state.regionChargeMode==='buyer'?'selected':''}>上述基础上，另计受端区域一次（公告要求时）</option>
    </select></label>
    <label class="f"><span>交付日期（按当前价库适用期校验）</span><input id="i-date" type="date" value="${esc(state.tradeDate)}"></label>
    <div class="sub">计价口径<em>决定算式怎么算、主指标是什么</em></div>
    <label class="f"><span>费用边界</span><select id="i-dstcost">
      <option value="1" ${!noDst?'selected':''}>到户已列费用小计 —— 含省内线损估算等</option>
      <option value="0" ${noDst?'selected':''}>受端省间交易节点交付（默认）—— 不含省内到户费用</option>
    </select></label>
    <div class="row2">
      <label class="f"><span>区域电网输电价格</span><select id="i-region">
        <option value="1" ${state.includeRegion?'selected':''}>计入</option>
        <option value="0" ${!state.includeRegion?'selected':''}>不计入</option>
      </select></label>
      <label class="f"><span>网损承担方</span><select id="i-bearer">
        <option value="1" ${state.lossBearer==1?'selected':''}>受端承担</option>
        <option value="0.5" ${state.lossBearer==0.5?'selected':''}>两端各半</option>
        <option value="0" ${state.lossBearer==0?'selected':''}>送端承担</option>
      </select></label>
    </div>
    <label class="f"><span>区域网损情景（在已计区域环节中应用）</span><select id="i-regionloss">
      ${[['exclude','未计入区域网损（缺项基准）'],['historical','计入第三监管周期参考网损（敏感性情景）'],['custom','计入手填区域网损（待核实）']].map(([v,t])=>`<option value="${v}" ${state.regionLossMode===v?'selected':''}>${t}</option>`).join('')}
    </select></label>
    <p class="note">公开参考值：${Object.entries(DATA.RLOSS||{}).map(([k,v])=>esc(k)+' '+v.historicalPct+'%').join('、')}。已核对历史公开表（转载来源），尚未确认适用于第四监管周期；区域共用交流接口不再逐段计损。</p>
    ${state.regionLossMode==='custom'?`<div class="row2">${Object.keys(DATA.RLOSS||{}).map(k=>`<label class="f"><span>${esc(k)}区域网损 %</span><input id="i-rloss-${esc(k)}" type="number" min="0" max="99.999" step="0.01" value="${state.regionLossRates?.[k]??''}" placeholder="未填写即缺项"></label>`).join('')}</div>`:''}
    <p class="note">送受端价格是可修改的演示假设，不是实时市场送端报价；省级输配电价默认高压两部制，实际须匹配电网主体、用户类别与电压档。</p>
    <div class="row2">
      <label class="f"><span>通道资料范围</span><select id="i-tradable">
        <option value="0" ${!state.tradableOnly?'selected':''}>全部通道 —— 含未确认联络线</option>
        <option value="1" ${state.tradableOnly?'selected':''}>仅专项工程（当期可交易性仍待确认）</option>
      </select></label>
      <label class="f"><span>中长期占用 %（容量校验扣减）</span><input id="i-zyocc" type="number" value="${state.occPct||0}" step="5" min="0" max="90"></label>
    </div>
    <details class="explain"><summary>政策口径与取值依据<em>区域电网费 · 网损承担方 · 自动带入值</em></summary><div class="inner">
    <p class="note">受端省网输配电价与基金及附加在选定<b>受端省</b>时自动带入该省核定价（输配电价取 220kV 及以上两部制电量电价）；送受端价格未手填时随省份带入演示参考值，手填后保留。以上均可手动覆盖，点「恢复核定值」还原。口径二（过网费）与口径三（可接受送端报价）不含受端省内费用，因此不受「费用边界」开关影响。</p>
    <p class="note"><b>区域电网输电价格</b>采用发改价格〔2026〕1077号附件2公开的电量电价，含税、不含线损；区域容量电价已通过省级输配电价回收。本页按交易路径中的共用网络归集，各区域一次。直接落地的专项工程是否另计受端区域，应以本笔中长期交易公告为准，可选择“另计受端区域”。京津唐豁免须核对具体电网主体。</p>
    <p class="note"><b>费用去重</b>：起点送出省费只计一次；报价已含则不再加。过境交流接口不单独收费，也不按每条抽象接口重复计损；独立专项工程按自身输电价与损耗口径。已含损耗的核价项目不再追加计费损耗。</p>
    <p class="note"><b>网损与合同约定</b>：默认买方承担跨省计费网损，可模拟双方分担。送端省内网损由报价边界选择是否另计，另计时以送端报价估算购损成本；实际合同、交易方案优先。现货规则中的卖方承担约定不自动套用于中长期。</p>
    <div class="lib-src" style="margin-top:6px">当前取值依据：受端 <b>${esc(PV[state.to]?PV[state.to].n:'—')}</b>　输配电价 ${fmt(state.pNet)} 元/MWh　基金及附加 ${state.fundMissing?'<span style="color:var(--red)">未获取</span>':fmt(state.fund)+' 元/MWh'}${noDst?'　<span style="color:var(--ink3)">（当前口径不计入以上两项）</span>':''}<br>${esc(PV[state.to]?PV[state.to].netSrc:'—')}</div>
    </div></details>
  </div></details>`;

  // REQ-401 容量电费测算器：独立折叠卡，不参与路径比选（发改价格〔2020〕1441号 / 〔2023〕532号口径）
  out+=renderCapFee();

  const _toPV=PV[state.to];
  if(!noDst && _toPV && (_toPV.fund===null || _toPV.fund===undefined)){
    out+=`<div class="warn">受端省「${esc(_toPV.n)}」的政府性基金及附加暂未获取官方标准，本次测算按 0 计，落地成本会被低估。</div>`;
  }

  if(res&&res.err){
    out+=`<div class="card"><div class="empty">${esc(res.err)}</div></div>`;
    // 组件筛选把候选筛空时，选择器必须留在页面上，否则用户没法取消已选组件
    if(res.availChannels&&res.availChannels.length){
      out+=`<div class="card tight">${renderCompPicker(res)}</div>`;
    }
  } else if(res&&res.rows&&res.rows.length){
    // 三栏：左＝路线列表，中＝方案详情，右＝智能推荐（宽屏）；窄屏退为两栏、手机端纵向堆叠，布局由 .layout 的 CSS 决定
    out+='<div class="layout"><div class="col-side">'+renderRouteList(res)+'</div>'
       + '<div class="col-ai">'+renderAI(res)+'</div>'
       + '<div class="col-main">'+renderDetail(res,res.rows[Math.min(state.sel,res.rows.length-1)])+renderSensitivity(res)+'</div></div>';
  } else {
    out+=`<div class="card"><div class="empty">请选择不同的出发地与目的地</div></div>`;
  }
  document.getElementById('v-calc').innerHTML=out;
  restoreDetails(document.getElementById('v-calc'),_detailSnap);
  if(_fid){
    const el=document.getElementById(_fid);
    if(el){
      try{ el.focus({preventScroll:true}); }catch(e){ el.focus(); }
      if(_caret&&_caret[0]!=null){ try{ el.setSelectionRange(_caret[0],_caret[1]); }catch(e){} }
    }
  }
}

/* ---------- 可选路线列表 ---------- */
const RLIMIT=18;
function renderRouteList(res){
  const rows=res.rows, sel=Math.min(state.sel,rows.length-1);
  const isDst=state.includeDstCost!==false;
  // 口径A 的主指标随「费用边界」换名；口径B/C 本就不含受端省内费用，不受开关影响
  const costName=isDst?'落地成本':'省界成本';
  const sortName={A:'按'+costName,B:'按过网费',C:'按可接受送端报价'}[state.sortBy];
  // 阈值基准取列表中最低的落地价：按过网费 / 送端收益排序时首条并不是落地价最低者
  const bestPrice=rows.length?Math.min(...rows.map(r=>r.landed)):0;
  const thr=bestPrice+Math.abs(bestPrice)*(state.degrade??0.10);
  const inThr=rows.filter(r=>r.landed<=thr);
  const shown=state.showAll?rows:inThr;
  const cut=rows.length-inThr.length;
  const mustN=(res.mustHave||[]).length;
  let out=`<div class="card tight">
    <div class="sec-title">可选路线<span class="hint">共 ${res.total} 条候选 · 参考未越限 ${res.feasibleCount} 条${res.truncated?' · 已达枚举上限':''}${mustN?' · 按 '+mustN+' 个组件筛选':''}</span></div>
    <details class="explain"><summary>候选与可行的定义<em>费用边界：${isDst?'到户已列费用小计':'只算到受端省界'}</em></summary><div class="inner">
    <p class="note">按所选报价和费用假设比较成本，默认只列出成本不高于最优 ${fmt((state.degrade??0.10)*100,0)}% 的方案${cut>0?'，另有 '+cut+' 条成本更高者已折叠':''}。${isDst?'':'当前费用边界为<b>只算到受端省界</b>，下列金额与排序均<u>不含</u>受端省网输配电价与政府性基金及附加。'}</p>
    <p class="note">「候选」是 ${state.maxHops} 段以内、${state.maxDetour>=9?'绕行度不限':'绕行度不超过 '+state.maxDetour+'x'}、不重复经过同一省的全部路径；「参考未越限」仅表示已录入容量及历史断面参数未被超过，不代表当期可交易。当前拓扑只按已录入方向枚举；中长期反向交易可能另有组织安排，本工具未覆盖的方向不代表规则禁止。单向记录的直流按库内方向计入，互济型工程（德宝、青藏、长南荆等）与省间联络线双向。放宽搜索范围可能改变最优路线；截断时无法保证全局最优。</p>
    </div></details>
    ${res.truncated?'<div class="warn">候选集已达枚举上限（800 条），排序仅基于已枚举部分，不能保证全局最优——建议收紧跳数 / 绕行上限后重算。</div>':''}
    ${renderCompPicker(res)}
    <div class="seg small">
      ${[['A',costName],['B','过网费'],['C','送端收益']].map(([k,t])=>
        `<button class="${state.sortBy===k?'on':''}" onclick="setSort('${k}')" ${k==='C'?'title="口径三：同一费用约定下由目标交付价反推"':''}>${t}</button>`).join('')}
    </div>
    <div class="rlist">`;
  rows.forEach((r,i)=>{
    if(!state.showAll && r.landed>thr) return;
    if(!state.showAll && i>=RLIMIT) return;
    out+=`<button class="rc ${i===sel?'on':''} ${r.feasible?'':'bad'}" onclick="pick(${i})" title="${esc(r.nodes.map(N).join(' → '))}">
      <div class="rc-top"><span class="rc-no">#${i+1}</span><span class="rc-hop">${r.hops}段</span></div>
      <div class="rc-line">${esc(r.leadLine)}</div>
      <div class="rc-price">${fmt(r.landed,0)}<small>元/MWh</small></div>
      <div class="rc-meta">${r.via?esc(r.via)+' · ':''}${fmt(r.dist,0)}km${r.feasible?'':' · <span style="color:var(--red)">越限</span>'}</div>
    </button>`;
  });
  out+=`</div>
    <div class="rlist-foot">
      <span>${sortName}升序${state.sortBy==='C'?'（降序）':''}</span>
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
/* ---------- 通道组件：把直流（专项工程）等通道当作可选组件来筛方案 ----------
   语义：选中的通道必须出现在方案里（不区分行进方向，方向由通道自身的 bidir 决定）。
   候选清单来自绕行度筛选后的完整候选集，所以选中一条后其余组件仍然可选、可取消。 */
function renderCompPicker(res){
  const list=res.availChannels||[];
  if(!list.length) return '';
  const sel=res.mustHave||[];
  const dcN=list.filter(c=>c.type==='DC'||c.type==='AC/DC').length;
  let out=`<div class="comp-box">
    <div class="comp-hd"><span>通道组件</span><em>${list.length} 个可选 · 直流 ${dcN} 个${sel.length?' · 已选 '+sel.length+' 条':''}</em></div>
    <p class="comp-tip">点选通道即把它设为<b>必经组件</b>，只列出包含它的方案；不选则显示全部候选。直流排在最前。</p>
    <div class="chips comps">`;
  list.forEach(c=>{
    const on=sel.indexOf(c.id)>=0;
    const dc=(c.type==='DC'||c.type==='AC/DC');
    out+=`<button class="chip ${dc?'dc':''}${on?' on':''}" onclick="toggleComp('${c.id}')" title="${esc(c.n)} · ${esc(c.type)} · ${c.bidir?'双向':'仅核定方向'} · 出现在 ${c.count} 条候选路径里">${esc(c.n)}<em>${esc(c.type)} ${c.bidir?'双向':'单向'}</em></button>`;
  });
  out+=`</div>`;
  if(sel.length){
    out+=`<button class="btn ghost" style="margin-top:8px;padding:7px;font-size:12px" onclick="clearComp()">清除全部组件${res.total!=null?'（当前筛出 '+res.total+' 条 / 全量 '+res.totalAll+' 条）':''}</button>`;
  }
  out+=`</div>`;
  return out;
}
function toggleComp(id){
  const a=state.mustHave||(state.mustHave=[]);
  const i=a.indexOf(id);
  if(i<0) a.push(id); else a.splice(i,1);
  state.sel=0; doSolve();
}
function clearComp(){ state.mustHave=[]; state.sel=0; doSolve(); }
function setSort(k){ state.sortBy=k; state.sel=0; doSolve(); }
function pick(i){ state.sel=i; saveLast(); renderCalc();
  const sel=document.querySelector('.rc.on'); if(sel) sel.scrollIntoView({block:'nearest',inline:'center',behavior:'smooth'}); }

/* ---------- 选中路线详情 ---------- */
function renderDetail(res,r){
  if(!r) return '';
  const costName=state.includeDstCost!==false?'落地成本':'省界成本';
  const colors=['#85B7EB','#EF9F27','#F0997B','#5DCAA5','#B4B2A9','#AFA9EC'];
  const comp=[['送端报价',r.comp.gen],['送端省内段',r.comp.send],['送端省内网损另计',r.comp.originLoss],['跨省通道费',r.comp.trans],['区域电网费',r.comp.reg],
    ['网损折价',r.comp.loss],['受端上网环节线损',r.comp.inLoss],['受端输配电价',r.comp.net],['基金及附加',r.comp.fund]].filter(c=>c[1]!==0);
  const tot=comp.reduce((s,c)=>s+Math.abs(c[1]),0)||1;
  // REQ-201：未确认可用于本笔中长期交易的交流联络线段
  const ntSegs=r.edges.filter(e=>e.tradable===false);

  let out=`<div class="card">
    <div class="sec-title">方案 #${state.sel+1}<span class="hint">${r.feasible?'<span style="color:var(--teal)">参考参数未越限 · ATC待核实</span>':'<span style="color:var(--red)">存在越限</span>'}</span></div>
    <div class="hd-route">${routeStr(r.nodes)}</div>
    <div class="lines">
      ${r.edges.map(e=>`<span class="ln ${e.type==='DC'?'dc':'ac'}">${esc(e.n)}</span>`).join('<span class="plus">+</span>')}
    </div>
    <div class="big">${fmt(r.landed)}<span class="u">元/MWh ${state.includeDstCost===false?'省间节点费用小计':'到户已列费用小计'}</span></div>
    ${r.pricingIssues?.length?`<details class="warn" open><summary>适用条件与缺项（${r.pricingIssues.length}）</summary>${r.pricingIssues.map(v=>`<p class="note">${esc(v)}</p>`).join('')}</details>`:''}
    ${renderRegionComparison(r)}
    <p class="note" style="margin:-2px 0 8px">中长期单时段交付成本测算。合同分时曲线、交易组织、安全校核、执行偏差与实际结算需另行处理。</p>
    ${state.includeDstCost===false?'<p class="note" style="margin:-4px 0 8px">当前口径<b>不含</b>受端省网输配电价与政府性基金及附加，仅为送到受端省界的价格。</p>':''}
    <div class="bar">${comp.map((c,j)=>`<div style="width:${(Math.abs(c[1])/tot*100).toFixed(2)}%;background:${colors[j%6]}"></div>`).join('')}</div>
    <div class="lg">${comp.map((c,j)=>`<span><i style="background:${colors[j%6]}"></i>${c[0]} ${fmt(c[1])}</span>`).join('')}</div>
    <div class="chips">
      <span class="chip info">过网费 ${fmt(r.channelOnly)}</span>
      <span class="chip info">可接受送端报价 ${fmt(r.senderNet)}</span>
      <span class="chip">${r.hops} 段</span>
      <span class="chip">${fmt(r.dist,0)} km</span>
      <span class="chip">网损 ${fmt((1-r.D)*100,2)}%${Math.abs(r.Dphys-r.D)>1e-9?'（物理 '+fmt((1-r.Dphys)*100,2)+'%）':''}</span>
      <span class="chip">占用 ${fmt(r.maxLoad*100,0)}%</span>
      <span class="chip ${r.unverified?'warn':'ok'}">${r.unverified? r.unverified+' 段非核定':'全部发改委核定'}</span>
    </div>
    <p class="note" style="margin:-2px 0 0">容量校验：${state.occPct>0?`按参考容量×(1−中长期占用 ${state.occPct}%) 扣减；`:''}非可用输电能力（ATC），未扣检修等其它占用，结果偏乐观。</p>
    ${!r.feasible?`<div class="warn bad" style="margin-top:11px">${r.overSeg.length?'通道超容：'+r.overSeg.map(s=>esc(s.name)+' '+fmt(s.mw,0)+'/'+(s.effCap!=null?fmt(s.effCap,0):s.cap)+' MW').join('；')+'<br>':''}${r.secOver.length?'断面越限：'+r.secOver.map(h=>esc(h.sec.n)+' '+fmt(h.mw,0)+'/'+h.sec.limit+' MW').join('；'):''}</div>`:''}
    ${ntSegs.length?`<div class="warn" style="margin-top:8px">⚠ 本方案含 <b>${ntSegs.length}</b> 段未确认可用于本笔中长期交易的交流联络线（${esc(ntSegs.slice(0,3).map(e=>e.n).join('、'))}${ntSegs.length>3?' 等 '+ntSegs.length+' 段':''}），实际可交易性待交易中心确认。</div>`:''}
    <div class="row2" style="margin-top:12px">
      <button class="btn ghost" onclick="go('map')">在网架图上查看</button>
      <button class="btn ghost" onclick="document.getElementById('d-detail').open=true;document.getElementById('d-detail').scrollIntoView({behavior:'smooth'})">展开完整明细</button>
      <button class="btn ghost" onclick="exportReport()">导出报告</button>
    </div>
  </div>`;

  // 节点与线路时间轴
  out+=`<div class="card">
    <div class="sec-title">途经节点与线路<span class="hint">${r.nodes.length} 个节点 · ${r.segs.length} 段线路</span></div>
    <div class="tl">`;
  r.nodes.forEach((nd,i)=>{
    const isEnd=i===0||i===r.nodes.length-1;
    const st=i===0?r.edges[0].stFrom:(i<r.edges.length?r.edges[i].stFrom:null);
    const stationAt=(e,code)=>e[e.from===code?'stFrom':'stTo'];
    const stUse=i===0?stationAt(r.edges[0],nd):i===r.edges.length?stationAt(r.edges[i-1],nd):(stationAt(r.edges[i],nd)||stationAt(r.edges[i-1],nd));
    out+=`<div class="tl-node ${isEnd?'end':''}">
      <div class="tl-dot"></div>
      <div class="tl-info">
        <div class="tl-name">${esc(N(nd))}${isEnd?`<span class="pill">${i===0?'送端':'受端'}</span>`:''}</div>
        ${stUse?`<div class="tl-st">${esc(stName(stUse))}<span class="tl-ad">@ ${esc(stAddr(stUse))}</span></div>`
          :(isEnd?`<div class="tl-st" style="color:var(--ink3)">落点站点待补</div>`:'')}
      </div>
    </div>`;
    if(i<r.edges.length){
      const s=r.segs[i], e=s.e;
      out+=`<div class="tl-seg">
        <div class="tl-seg-line"></div>
        <div class="tl-seg-card">
          <div class="tl-seg-hd"><span>${esc(e.n)}</span><span class="pill ${e.type==='DC'?'':'g'}">${esc(e.type)} ${esc(e.kv)}</span>${e.tradable===false?'<span class="pill g" title="本笔中长期交易是否可使用待交易中心确认">交易网络·待确认</span>':''}</div>
          <div class="tl-seg-g">
            <div>长度<b>${e.lenKm?e.lenKm+' km':'约 '+fmt(s.crow,0)+' km*'}</b></div>
            <div>容量<b>${e.cap?e.cap+' MW':'待补'}</b></div>
            <div>${e.regional?'单独通道费':'输电价'}<b>${fmt(s.t)} 元/MWh</b></div>
            <div>计费线损率<b>${fmt(s.billLossPct,2)}%</b></div>
            <div>段入口功率（物理估算）<b>${fmt(s.inMW,0)} MW</b></div>
            <div>段损耗电量（物理估算）<b>${fmt(s.lossMwh,2)} MWh</b></div>
          </div>
          ${s.util!=null?`<div class="meter"><i class="${s.util>1?'over':(s.util>0.8?'hi':'')}" style="width:${Math.min(s.util*100,100).toFixed(1)}%"></i></div>
            <div class="tl-cap">占用 ${fmt(s.util*100,1)}%　剩余 ${fmt(s.headroom,0)} / ${e.cap} MW</div>`
            :`<div class="tl-cap">核定容量待补，无法校验占用</div>`}
          ${e.regional?`<p class="note">${e.tariffStatus==='unknown'?'独立输电价待核，当前未计此项；':'区域共用网络接口，不逐个收通道费；'}${i===0?'送出省费用只在交易起点计一次。':'不收过境省外送费。'}${e.type==='AC' && s.billLossPct===0?'计费损耗 0，物理损耗仅作容量估算。':'背靠背损耗为估算，须核对备案标准。'}</p>`:''}
          <div class="tl-src">${tierTag(e.tier)} ${esc(e.doc||'无发改委文号')}${e.eff?'　生效 '+esc(e.eff):''}</div>
        </div>
      </div>`;
    }
  });
  out+=`</div>${r.segs.some(s=>s.kmEst)?`<p class="note">* 该段线路长度以站点直线距离估算，实际路径长度待补。</p>`:''}</div>`;

  // 完整明细
  out+=`<details class="adv boxed" id="d-detail"><summary>完整明细：费用 · 断面 · 溯源 · 口径</summary><div class="inner">
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
    <p class="note" style="margin-top:6px">送端省内网损：${state.sourceQuote==='export'?'送出关口报价已含，不另计':state.originLossMode==='separate'?'按公开参数另计 '+fmt(r.cOriginLoss,2)+' 元/交付MWh':'假设报价已覆盖，不另计'}。公开送省外上网环节线损率：${r.exportLossPct!=null?fmt(r.exportLossPct,2)+'%':'未获取'}。</p>
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
    ${r.secHits.length? r.secHits.map(h=>`<div class="segblk">
      <div class="hd"><span>${esc(h.sec.n)}</span><em>${fmt(h.mw,0)} / ${h.sec.limit} MW</em></div>
      <div style="font-size:11px;color:var(--ink2)">利用率 ${fmt(h.util*100,1)}%　余量 ${fmt(h.sec.limit-h.mw,0)} MW　${h.over?'<span class="pill" style="background:var(--red-bg);color:var(--red)">越限</span>':'<span class="pill" style="background:var(--teal-bg);color:var(--teal)">通过</span>'}</div>
      <div class="meter"><i class="${h.over?'over':(h.util>0.8?'hi':'')}" style="width:${Math.min(h.util*100,100).toFixed(1)}%"></i></div>
      <div class="src">计入通道：${esc(h.members.join('、'))}<br>${esc(h.sec.note)}<br>来源：${esc(h.sec.src)}</div>
    </div>`).join('') : `<p class="note">该路径经过的通道未映射到已录入的断面。断面限额属向注册市场成员披露的信息，公开渠道无法获取运行限额。</p>`}

    <div class="sub">逐段溯源<em>每段费率的原始依据</em></div>
    ${r.segs.map((s,si)=>{const e=s.e;return `<div class="segblk">
      <div class="hd"><span>第 ${si+1} 段　${esc(N(s.a))} → ${esc(N(s.b))}</span><em>${esc(e.n)}</em></div>
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

    <div class="sub">数据溯源汇总</div>
    <div class="g3">
      <div class="mc"><div class="l">发改委核定段</div><div class="v">${r.tiers.gov||0}<small>/${r.hops}</small></div></div>
      <div class="mc"><div class="l">国网披露段</div><div class="v">${r.tiers.grid||0}<small>段</small></div></div>
      <div class="mc"><div class="l">区域/送出省段</div><div class="v">${r.tiers.region||0}<small>段</small></div></div>
    </div>
    ${r.unverified?`<div class="warn" style="margin-top:9px">本路径有 <b>${r.unverified} 段</b>不属于发改委核定价，结论仅供比选参考，正式结算前须逐段核对原始文件。</div>`
      :`<div class="warn ok" style="margin-top:9px">本路径全部 ${r.hops} 段均为发改委核定价格，可回溯到原文。</div>`}

    <div class="sub">口径位置<em>三个口径下的排名与差距</em></div>
    <div class="g3">
      <div class="mc"><div class="l">${costName}</div><div class="v">#${r.rankA}</div><div style="font-size:10.5px;color:var(--ink3)">${r.rankA===1?'最优':'高 '+fmt(r.landed-res.byA[0].landed)+' 元/MWh'}</div></div>
      <div class="mc"><div class="l">过网费</div><div class="v">#${r.rankB}</div><div style="font-size:10.5px;color:var(--ink3)">${r.rankB===1?'最低':'高 '+fmt(r.channelOnly-res.byB[0].channelOnly)+' 元/MWh'}</div></div>
      <div class="mc"><div class="l">可接受送端报价</div><div class="v">#${r.rankC}</div><div style="font-size:10.5px;color:var(--ink3)">${r.rankC===1?'最高':'低 '+fmt(res.byC[0].senderNet-r.senderNet)+' 元/MWh'}</div></div>
    </div>
    <p class="note" style="margin:4px 0 0">“可接受送端报价”是以受端目标交付价反推、使费用小计恰好达到目标的送端报价上限；采用与正向测算相同的费用约定，不代表卖方利润或成交价。</p>
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
function renderSensitivity(res){
  if(!res||!res.rows) return '';
  const P0=100,P1=800,STEP=20; let prev=null; const rowsA=[];
  for(let p=P0;p<=P1;p+=STEP){
    const R=solve(Object.assign({},state,{pGen:p}), algoData());
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
  return `<details class="adv boxed" id="d-sens"><summary>价差敏感性：送端报价 ${P0}~${P1} 元/MWh 扫描（步长 ${STEP}）<em>★ 为最优路线切换点</em></summary><div class="inner">
    <table><tr><th>送端报价 元/MWh</th><th>最优路线（口径一）</th><th>落地成本</th><th>过网费</th><th>翻转</th></tr>${trs}</table>
    <p class="note">纯前端复用 solve() 重算；金额为对应送端报价下的口径一最优方案。切换点表示该价格档起另一条路线成为最优。</p>
  </div></details>`;
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
  L.push('- 交易日期：'+state.tradeDate);
  L.push('- 电量（省间节点交付）：'+state.qty+' MWh / '+state.hours+' h　网损承担：'+(state.lossBearer==1?'受端':state.lossBearer==0.5?'两端各半':'送端'));
  L.push('- 产品：省间中长期；送端报价边界：'+state.sourceQuote+'；送端省内网损：'+state.originLossMode+'；区域计费范围：'+state.regionChargeMode);
  L.push('- 价格参数：送端报价 '+state.pGen+' / 受端目标交付价 '+state.pDst+' / 受端输配电价 '+state.pNet+' / 基金及附加 '+state.fund+' 元/MWh');
  L.push('- 口径：'+(state.includeDstCost===false?'只算到受端省界':'到户已列费用小计')+'　区域电网费：'+(state.includeRegion?'计入':'不计入'));
  for(const issue of r.pricingIssues||[]) L.push('- 适用条件：'+issue);
  L.push('- 区域网损模式：'+(state.regionLossMode||'exclude'));
  L.push('- 金额基数：'+r.amountQty+' MWh（到户价使用推算终端用电量）');
  for(const x of r.regionScenarios||[]) L.push('- 同路径情景 '+x.mode+'：省界 '+fmt(x.border,4)+' / 到户小计 '+fmt(x.landed,4)+' 元/MWh；'+x.regions.map(v=>v.region+' '+v.pct+'% '+v.status).join('、'));
  for(const x of r.regionItems||[]) L.push('- 网损来源 '+x.region+'：'+x.source.document+' '+x.source.url);
  L.push('- 容量状态：参考参数校验，非当期 ATC / 安全校核；不能据此保证成交。');
  L.push('');
  L.push('## 三口径结果');
  L.push('- 落地成本：'+fmt(r.landed)+' 元/MWh（候选内排名 #'+r.rankA+'）');
  L.push('- 过网费：'+fmt(r.channelOnly)+' 元/MWh（排名 #'+r.rankB+'）');
  L.push('- 可接受送端报价：'+fmt(r.senderNet)+' 元/MWh（排名 #'+r.rankC+'，受端价折回估算，非结算口径）');
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

function doSolve(){
  readInputs(); state._res=solve(state, algoData());
  const n=state._res.rows?state._res.rows.length:0;
  if(state.sel>=n) state.sel=0;
  saveLast(); renderCalc();
}
function readInputs(){
  const g=id=>document.getElementById(id);
  if(!g('i-from')) return;
  state.from=g('i-from').value; state.to=g('i-to').value;
  // 电量必须为正：负数是真值，`+v||1000` 拦不住，需显式归一化
  const _q=+g('i-qty').value; state.qty=_q>0?_q:1000;
  const _h=+g('i-hours').value; state.hours=_h>0?_h:1;
  state.maxHops=+g('i-hops').value||3; state.maxDetour=+g('i-detour').value||2;
  state.pGen=+g('i-pgen').value||0; state.pDst=+g('i-pdst').value||0;
  state.pNet=+g('i-pnet').value||0; state.fund=+g('i-fund').value||0;
  state.lossBearer=+g('i-bearer').value;
  state.includeRegion=g('i-region').value==='1';
  state.sourceQuote=g('i-sourcequote')?.value||state.sourceQuote;
  state.originLossMode=g('i-originloss')?.value||state.originLossMode;
  state.regionChargeMode=g('i-regioncharge')?.value||state.regionChargeMode;
  state.regionLossMode=g('i-regionloss')?.value||state.regionLossMode||'exclude';
  state.tradeDate=g('i-date')?.value||state.tradeDate;
  state.regionLossRates=state.regionLossRates||{};
  for(const k of Object.keys(DATA.RLOSS||{})){const el=g('i-rloss-'+k);if(el)state.regionLossRates[k]=el.value.trim()===''?null:Number(el.value);}
  state.includeDstCost=g('i-dstcost').value==='1';
  state.tradableOnly=g('i-tradable')?.value==='1';   // REQ-203
  const _o=+g('i-zyocc')?.value||0;                  // REQ-302
  state.occPct=Math.min(90,Math.max(0,_o));
}
/* 送端省变化：只影响送端报价 */
function applyFromProv(){
  const f=PV[state.from];
  if(!state.pGenManual&&f&&f.clear!=null) state.pGen=f.clear;
}
/* 受端省变化：影响受端省网输配电价、政府性基金及附加、受端目标交付价 */
function applyToProv(){
  const t=PV[state.to];
  if(!t) return;
  if(t.net!=null) state.pNet=t.net;
  state.fundMissing=(t.fund===null||t.fund===undefined);
  state.fund=state.fundMissing?0:t.fund;
  if(!state.pDstManual&&t.clear!=null) state.pDst=t.clear;
}
function applyBothProv(){ applyFromProv(); applyToProv(); }
/* 把某一项恢复为当前受端省的核定值 */
function resetOne(k){
  const t=PV[state.to];
  if(!t) return;
  if(k==='pNet'&&t.net!=null) state.pNet=t.net;
  if(k==='fund'){ state.fundMissing=(t.fund===null||t.fund===undefined); state.fund=state.fundMissing?0:t.fund; }
  state._res=solve(state, algoData()); saveLast(); renderCalc();
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
      <div class="mc"><div class="l">年容量电费</div><div class="v">${annual!=null?num(annual):'—'}<small>元/年</small></div></div>
      <div class="mc"><div class="l">度电分摊额</div><div class="v">${per!=null?fmt(per,2):'—'}<small>元/MWh</small></div></div>
    </div>
    ${qty<=0?'<p class="note">年用电量为 0，度电分摊额不计算（显示 —）。</p>':''}
    <div class="lib-src" style="margin-top:8px">当前取值依据：${esc(entry.省)} · ${esc(tier?tier.档别:'—')} · ${modeLbl}　${esc(entry.来源)}</div>`;
  }
  return `<details class="adv boxed" id="d-capfee"><summary>容量电费测算（两部制 · 独立参考）</summary><div class="inner">
    ${inner}
    <p class="note cap-note" style="margin-top:10px"><b>容量电费与电量来自省内或省外无关，不参与路径比选</b>（发改价格〔2020〕1441号 / 〔2023〕532号口径；年费用 = 单价 × ${isCap?'容量':'需量'} × 12，度电分摊 = 年费用 ÷ 年用电量）。</p>
  </div></details>`;
}

function renderRegionComparison(r){
  if(!r.regionScenarios?.length) return '';
  return `<div class="sub">同一路径 · 区域网损对照<em>元/MWh</em></div>
    <table id="region-comparison"><tr><th>情景</th><th>省界小计</th><th>当前费用边界</th></tr>
    ${r.regionScenarios.map(v=>`<tr><td>${v.mode==='exclude'?'未计入（缺项）':'计入历史参考值'}<div class="note">${v.regions.map(x=>esc(x.region)+' '+fmt(x.pct,2)+'%').join('、')}</div></td><td>${fmt(v.border,2)}</td><td>${fmt(v.landed,2)}</td></tr>`).join('')}</table>
    <p class="note">保持路径、送端报价和区域输电费不变，仅比较区域网损。历史参考率不是当前已核定率；上述两种结果均不能直接作为结算单。${!state.includeRegion?'区域电网费开关已关闭，区域网损随区域环节一起排除。':''}</p>
    ${r.regionItems?.length?`<details class="explain"><summary>区域参数出处与适用期</summary><div class="inner">${r.regionItems.map(v=>`<p class="note">${esc(v.region)}：电量电价 ${fmt(v.rate,2)} 元/MWh，计费网损 ${fmt(v.pct,2)}%，状态 ${esc(v.status)}。${esc(v.source.document||'当前来源未获取')}；${v.source.url?`<a target="_blank" rel="noopener" href="${esc(v.source.url)}">历史原件</a>`:''}。${esc(v.source.note||'')}</p>`).join('')}</div></details>`:''}`;
}
