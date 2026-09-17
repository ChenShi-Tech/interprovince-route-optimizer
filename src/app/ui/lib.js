/* 费率库页：通道费率、省级参数、输电断面。 */
/* ================= 费率库 ================= */
let libTab='ch';
function libSearch(v){ state.libQ=v; const b=document.getElementById('lib-list'); if(b) b.innerHTML=renderLibList(); }
function pvSearch(v){ state.pvQ=v; const b=document.getElementById('pv-list'); if(b) b.innerHTML=renderPvList(); }
function renderPvList(){
  const q=(state.pvQ||'').trim().toLowerCase();
  const ids=Object.keys(PV).filter(k=>{
    if(!q) return true;
    const p=PV[k];
    return (p.n+' '+k+' '+(p.netSrc||'')).toLowerCase().includes(q);
  });
  if(!ids.length) return '<p class="note">没有匹配的省份，试试其它关键词。</p>';
  return '<div class="libcount">匹配 '+ids.length+' 省</div><div class="libgrid">'
    + ids.map(k=>{
      const p=PV[k];
      const verified=/发改|监管周期|130号|116号|460号|556号|157号|242号|432号|1055号|520号|421号|602号/.test(p.netSrc||'');
      return `<details class="libcard">
        <summary>
          <span class="lc-n">${esc(p.n)}</span>
          <span class="lc-p">${p.net==null?'—':fmt(p.net,1)}<small>元/MWh</small></span>
          <span class="lc-m">省网输配电价 220kV+ · 基金附加 ${p.fund==null?'<span style="color:var(--red)">未获取</span>':fmt(p.fund,1)+' 元/MWh'}</span>
          <span class="lc-b">${verified?'<span class="tier gov">已核实</span>':'<span class="tier est">待补</span>'}</span>
        </summary>
        <div class="lc-body">
          <div class="lib-io" style="grid-template-columns:1fr 1fr 1fr">
            <div><label>出清价 元/MWh</label><input type="number" step="5" value="${p.clear??''}" onchange="setPv('${k}','clear',this.value)"></div>
            <div><label>省网输配电价 元/MWh</label><input type="number" step="0.1" value="${p.net??''}" onchange="setPv('${k}','net',this.value)"></div>
            <div><label>基金附加 元/MWh</label><input type="number" step="0.1" value="${p.fund??''}" onchange="setPv('${k}','fund',this.value)"></div>
          </div>
          <div class="lc-kv">
            <div><span>省代码</span>${k}</div>
            <div><span>区域电网</span>${esc((DATA.RGOF||{})[k]||'—')}</div>
          </div>
          <div class="lib-src">取值依据：${esc(p.netSrc||'—')}</div>
        </div>
      </details>`;
    }).join('') + '</div>';
}
function renderLibList(){
  const q=(state.libQ||'').trim().toLowerCase();
  const flt=state.libFilter||'all';
  const hit=(c)=>{
    if(flt==='gov'&&c.tier!=='gov') return false;
    if(flt==='grid'&&c.tier!=='grid') return false;
    if(flt==='region'&&c.tier!=='region') return false;
    if(flt==='capacity'&&c.priceType!=='capacity') return false;
    if(flt==='noCap'&&c.capActual!=null) return false;
    if(flt==='incLoss'&&c.incLoss!==true) return false;                 // REQ-405
    if(flt==='dd'&&!(c.bill||'').includes('落地端')) return false;      // REQ-405
    if(!q) return true;
    return (c.n+' '+(c.fn||'')+' '+N(c.from)+' '+N(c.to)+' '+(c.doc||'')+' '+(c.kv||'')+' '+(c.status||'')).toLowerCase().includes(q);
  };
  const list=CH.map((c,i)=>({c,i})).filter(x=>hit(x.c));
  if(!list.length) return '<p class="note">没有匹配的通道，试试其它关键词。</p>';
  const TODAY=new Date().toISOString().slice(0,10);
  const effBadge=c=>{                                   // REQ-402：价格时效徽标
    const fut=(c.hist||[]).find(h=>/^\d{4}-\d{2}-\d{2}$/.test(h.effective_from||'') && h.effective_from>TODAY);
    if(fut) return '<span class="lc-tag">即将生效 '+esc(fut.effective_from)+'</span>';
    return c.doc?'<span class="lc-tag">现行 '+esc((c.doc||'').replace(/^.*(〔\d+〕\d+号).*$/,'$1'))+'</span>':'';
  };
  return '<div class="libcount">匹配 '+list.length+' 条</div>'+list.map(({c,i})=>`<details class="libcard">
    <summary>
      <span class="lc-n">${esc(c.n)}${c.priceType==='capacity'?'<span class="lc-tag">容量制</span>':''}${effBadge(c)}${c.tradable===false?'<span class="lc-tag">交易网络·待确认</span>':''}</span>
      <span class="lc-p">${c.regional?'送出省参考价 ':''}${c.t==null?'—':fmt(c.t,1)}<small>元/MWh</small></span>
      <span class="lc-m">${esc(N(c.from))}→${esc(N(c.to))} · ${esc(c.kv)} · 线损 ${c.loss==null?'—':fmt(c.loss,2)+'%'} · ${c.capActual!=null?c.capActual+' MW':(c.cap!=null?'额定 '+c.cap+' MW':'容量待补')}</span>
      <span class="lc-b">${tierTag(c.tier)}</span>
    </summary>
    <div class="lc-body">
      <div class="lib-io">
        <div><label>${c.regional?'送出省参考价':'输电价'} 元/MWh</label><input type="number" step="0.1" value="${c.t==null?'':c.t}" onchange="setCh(${i},'t',this.value)"></div>
        <div><label>线损率 %</label><input type="number" step="0.05" value="${c.loss==null?'':c.loss}" onchange="setCh(${i},'loss',this.value)"></div>
        <div><label>容量 MW</label><input type="number" step="100" value="${c.cap==null?'':c.cap}" onchange="setCh(${i},'cap',this.value)" placeholder="待补"></div>
      </div>
      <div class="lc-kv">
        <div><span>送端省</span>${esc(N(c.from))}　<b>送出省输电价格</b> ${c.regional?fmt(c.t,1)+' 元/MWh（仅交易起点计入）':c.sendFee>0?fmt(c.sendFee,1)+' 元/MWh（仅交易起点计入）':'已含在通道价中'}</div>
        <div><span>受端省</span>${esc(N(c.to))}</div>
        <div><span>容量口径</span>${c.capBasis==='cap'?'实际输送能力（非 ATC）':c.capBasis==='rated'?'仅额定容量':'未获取'}${c.capActual!=null?'　实际 '+c.capActual+' MW':''}${c.capRated!=null?'　额定 '+c.capRated+' MW':''}</div>
        <div><span>容量来源</span>${esc(c.capSrc||'—')}</div>
        ${c.priceType==='capacity'?`<div><span>计价方式</span>单一容量电价制　容量电价 ${c.capPrice?c.capPrice.容量电价+' '+c.capPrice.单位:''}　折算等效 ${c.capEq!=null?fmt(c.capEq,2)+' 元/MWh':''}（按 ${DATA._capHours||4500} 小时）</div>`:''}
        ${c.sendFee>0?`<div><span>送端省内段</span>按送端省「送出省输电价格」计，发改价格〔2018〕1227号第五条</div>`:''}
        ${c.regional?'<div><span>区域接口</span>不单独收通道费，不叠加过境省外送费；区域共用交流接口计费损耗为 0，原线损仅作容量估算。</div>':''}
        <div><span>计费口径</span>${esc(c.bill)}${c.incLoss?'（含线损）':'（不含线损）'}${c.tax?'　含税':'　不含税'}</div>
        ${c.status?`<div><span>状态</span>${esc(c.status)}</div>`:''}
        ${c.stFrom?`<div><span>送端落点</span>${esc(stName(c.stFrom))} @ ${esc(stAddr(c.stFrom))}</div>`:''}
        ${c.stTo?`<div><span>受端落点</span>${esc(stName(c.stTo))} @ ${esc(stAddr(c.stTo))}</div>`:''}
        ${c.lenKm?`<div><span>线路长度</span>${c.lenKm} km</div>`:''}
      </div>
      <div class="lib-src">${esc(c.doc||'无发改委文号')}${c.eff?'　生效 '+esc(c.eff):''}${c.docVersion?'　'+esc(c.docVersion):''}
        ${c.docTitle?'<br>'+esc(c.docTitle):''}
        ${c.note?'<br>'+esc(c.note):''}
        ${c.sourceIssue?'<br><span style="color:var(--red)">'+esc(c.sourceIssue)+'</span>':''}
        ${c.excerpt?'<q>原文摘录：'+esc(c.excerpt)+'</q>':''}
        ${c.hist&&c.hist.length?'<div style="margin-top:6px"><b>调价历史</b>'+c.hist.map(x=>'<br>· '+esc(x.effective_from||'—')+'　'+esc(x.tariff_raw||'')+(x.loss_rate_pct!=null?'　线损 '+x.loss_rate_pct+'%':'')+'　'+esc(x.doc_number||'')).join('')+'</div>':''}
      </div>
    </div>
  </details>`).join('');
}
function renderLib(){
  let out=`<div class="warn">本库为按任务提示词实际检索所得。<b>发改委核定</b>类有正式文号与原文摘录可回溯；<b>国网披露</b>类为交易中心公开的结算价格表（含报备价）；<b>区域/送出省口径</b>为第四监管周期规定的省间互济送出省输电价格；<b>待补</b>为估算值，须替换。修改即时生效并保存在本机。</div>`
  // REQ-602：加载时用户选择「暂保留」旧版价格覆盖（state.js 置 _libStale），费率库必须给出常驻提示
  +(state._libStale?`<div class="warn" style="margin-top:8px">⚠ 本机保存的费率修改基于<b>旧版价格数据</b>（priceVersion 不一致），当前仍在使用这些旧值，测算结果可能与最新核定不符——请逐条核对，或点下方「恢复检索原始值」放弃本地修改；重新改价并保存后本提示自动消失。</div>`:'');
  out+=`<div class="card tight seg">
    <button class="${libTab==='ch'?'on':''}" onclick="libTab='ch';renderLib()">通道 (${CH.length})</button>
    <button class="${libTab==='pv'?'on':''}" onclick="libTab='pv';renderLib()">省级参数 (${Object.keys(PV).length})</button>
    <button class="${libTab==='sec'?'on':''}" onclick="libTab='sec';renderLib()">断面 (${SEC.length})</button>
  </div>`;

  if(libTab==='ch'){
    out+=`<div class="card tight">
      <div class="sec-title">通道费率<span class="hint">共 ${CH.length} 条</span></div>
      <input id="lib-q" type="search" placeholder="搜索通道名 / 别名 / 省份 / 文号…" value="${esc(state.libQ||'')}" oninput="libSearch(this.value)" style="margin-bottom:8px">
      <div class="seg small" style="flex-wrap:wrap">
        ${[['all','全部'],['gov','发改委核定'],['grid','国网披露'],['region','区域口径'],['capacity','容量制'],['noCap','缺实际容量'],['incLoss','含线损'],['dd','落地端计费']].map(([k,t])=>
          `<button class="${(state.libFilter||'all')===k?'on':''}" onclick="state.libFilter='${k}';state._libScr=window.scrollY;renderLib()">${t}</button>`).join('')}
      </div>
      <div id="lib-list">${renderLibList()}</div>
    </div>`;
  } else if(libTab==='pv'){
    out+=`<div class="card tight">
      <div class="sec-title">省级参数<span class="hint">共 ${Object.keys(PV).length} 省 · 元/MWh</span></div>
      <input id="pv-q" type="search" placeholder="搜索省份 / 文号 / 来源…" value="${esc(state.pvQ||'')}" oninput="pvSearch(this.value)" style="margin-bottom:8px">
      <div id="pv-list">${renderPvList()}</div>
    </div>`;
  } else {
    out+=`<div class="card tight"><div class="sec-title">输电断面<span class="hint">公开报道/文献值</span></div><div class="libgrid">`;
    out+=SEC.map(s=>`<div class="lib-row">
      <div class="lib-nm"><span>${esc(s.n)}</span><em>${s.limit} MW</em></div>
      <div class="lib-src">${esc(s.note)}<br>来源：${esc(s.src)}${s.edges&&s.edges.length?'　关联通道：'+esc(s.edges.join('、')):'　<span class="tier est">未映射到本图通道</span>'}</div>
    </div>`).join('');
    out+=`</div><p class="note"><b>重要边界</b>：断面限额属向注册市场成员披露的信息，不是公众信息。以上数值来自公开报道与学术文献，与交易中心实际运行限额可能有差异。国网省间现货按「交易路径」建模，南网区域市场按「断面潮流约束（GSDF）」建模，两套口径不能共用同一约束结构。</p></div>`;
  }

  out+=`<div class="card tight"><div class="sec-title">数据管理</div>
    <div class="row2"><button class="btn ghost" onclick="exportLib()">导出 JSON</button>
    <button class="btn ghost" onclick="resetLib()">恢复检索原始值</button></div>
    <p class="note">构建时间 ${esc(BUILD_TIME)}　·　<b>价格数据版本 ${esc(PRICE_VERSION)}</b>　·　通道 ${CH.length} 条　·　断面 ${SEC.length} 个　·　区域电网电量电价：${Object.entries(RG).filter(([k])=>!k.startsWith('_')).map(([k,v])=>k+' '+v+' 元/kWh').join('，')}</p>
    <p class="note">Web 版与手机端共用同一份数据：构建时同时产出 <code>shared/app-data.json</code>，两端的 priceVersion 一致即表示数值同源。</p></div>`;

  document.getElementById('v-lib').innerHTML=out;
}
function setCh(i,k,v){ CH[i][k]=(v===''?null:+v); saveLib(); state._res=null;
  const b=document.getElementById('verBadge'); b.textContent='费率已本地修改'; b.style.background='var(--blue-bg)'; b.style.color='var(--blue-ink)'; }
function setPv(k,f,v){ PV[k][f]=+v||0; saveLib(); state._res=null; }
function exportLib(){ const b=new Blob([JSON.stringify({ch:CH,pv:PV,sec:SEC},null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download='费率库-v2.json'; a.click(); }
function resetLib(){
  uiConfirm('恢复检索原始值','恢复为检索原始值？本地修改将丢失。','恢复原始值','取消').then(ok=>{
    if(!ok) return;
    CH=DATA.CH.map(c=>({...c})); saveLib(); renderLib(); state._res=null;
  });
}
