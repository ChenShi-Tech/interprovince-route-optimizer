/* 测算页：参数输入、可选路线列表、方案详情。
   依赖：config / format / data / state / algo/*。 */
/* ================= 测算页 ================= */
function renderCalc(){
  const res=state._res;
  // 重渲染会整体替换 v-calc：先记录其中的焦点控件与光标位置，重建后恢复，
  // 否则连续步进或输入到一半就会被打断。
  const _host=document.getElementById('v-calc');
  const _ae=(typeof document.activeElement!=='undefined')?document.activeElement:null;
  const _fid=(_ae&&_ae.id&&_host&&_host.contains&&_host.contains(_ae))?_ae.id:null;
  let _caret=null;
  if(_fid){ try{ _caret=[_ae.selectionStart,_ae.selectionEnd]; }catch(e){ /* number 型输入无 selection */ } }
  const opt=(sel,ex)=>Object.keys(PV).map(k=>
    `<option value="${k}" ${k===sel?'selected':''} ${k===ex?'disabled':''}>${PV[k].n}</option>`).join('');
  // 只算到受端省界：受端省内两项（省网输配电价 / 基金及附加）不参与计算，界面上置灰并标注
  const noDst=state.includeDstCost===false;

  let out=`<div class="topbar"><div class="picker">
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
    <label><span>电量</span><input id="i-qty" type="number" value="${state.qty}" step="100" min="1"></label>
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
      <label class="f"><span>送端出清价 元/MWh</span><input id="i-pgen" type="number" value="${state.pGen}" step="5"></label>
      <label class="f"><span>受端结算价 元/MWh</span><input id="i-pdst" type="number" value="${state.pDst}" step="5"></label>
    </div>
    <div class="row2">
      <label class="f${noDst?' off':''}"><span>受端省网输配电价 ${noDst?'<span class="pill g">本口径下不使用</span>':`<a onclick="resetOne('pNet')" style="color:var(--blue);font-weight:500;cursor:pointer">恢复核定值</a>`}</span><input id="i-pnet" type="number" value="${state.pNet}" step="0.1"${noDst?' disabled':''}></label>
      <label class="f${noDst?' off':''}"><span>基金及附加 ${noDst?'<span class="pill g">本口径下不使用</span>':`<a onclick="resetOne('fund')" style="color:var(--blue);font-weight:500;cursor:pointer">恢复核定值</a>`}</span><input id="i-fund" type="number" value="${state.fund}" step="0.1"${noDst?' disabled':''}></label>
    </div>

    <div class="sub">计价口径<em>决定算式怎么算、主指标是什么</em></div>
    <label class="f"><span>费用边界</span><select id="i-dstcost">
      <option value="1" ${!noDst?'selected':''}>完整落地价 —— 含受端省内费用</option>
      <option value="0" ${noDst?'selected':''}>只算到受端省界 —— 不含受端省内费用</option>
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
    <p class="note">受端省网输配电价与基金及附加在选定<b>受端省</b>时自动带入该省核定价（输配电价取 220kV 及以上两部制电量电价）；送端出清价与受端结算价随送端省 / 受端省变化自动带入。以上均可手动覆盖，点「恢复核定值」还原。口径二（过网费）与口径三（送端净收益）不含受端省内费用，因此不受「费用边界」开关影响。</p>
    <p class="note"><b>区域电网输电价格</b>是国网华北、华东、华中、东北、西北五个区域分部运营的区域共用输电网络（跨省 500kV / 1000kV 联络网架）的电量电价，由国家发改委核定（发改价格〔2026〕1077号附件2），随区域电网实际交易结算电量向购电方收取。本工具只对经省间联络线走区域网架的段计收，按该段到达省所在区域取价；跨区直流等专项工程有单独核定的输电价格，其购电价格构成（发改价格〔2018〕1227号第五条）不含此项，故专项工程段不计。跨区联络线取到达区域的价格是本工具的口径假设。</p>
    <p class="note"><b>网损承担方</b>的政策口径是<b>受端（购电方）承担</b>：按落地端结算电量结算，送端为线损多发的电量由购电方按送端出清价补偿（1227号第五条「专项工程输电价格及损耗」；发改价格规〔2025〕1490号附件4第十八条，线损率偏差损益由购电方承担或享有）。「两端各半」与「送端承担」用于模拟中长期双边谈判条款，送端承担实质是送端把线损折入报价。各段线损率一律按核定值计，不按实际值。</p>
    <div class="lib-src" style="margin-top:6px">当前取值依据：受端 <b>${esc(PV[state.to]?PV[state.to].n:'—')}</b>　输配电价 ${fmt(state.pNet)} 元/MWh　基金及附加 ${state.fundMissing?'<span style="color:var(--red)">未获取</span>':fmt(state.fund)+' 元/MWh'}${noDst?'　<span style="color:var(--ink3)">（当前口径不计入以上两项）</span>':''}<br>${esc(PV[state.to]?PV[state.to].netSrc:'—')}</div>
  </div></details>`;

  const _toPV=PV[state.to];
  if(_toPV && (_toPV.fund===null || _toPV.fund===undefined)){
    out+=`<div class="warn">受端省「${esc(_toPV.n)}」的政府性基金及附加暂未获取官方标准，本次测算按 0 计，落地成本会被低估。</div>`;
  }

  if(res&&res.err){
    out+=`<div class="card"><div class="empty">${esc(res.err)}</div></div>`;
  } else if(res&&res.rows&&res.rows.length){
    // 智能推荐放在右侧主栏顶部：左栏的路线列表展开后很长，放在它下面要滚很远才看得到
    out+='<div class="layout"><div class="col-side">'+renderRouteList(res)+'</div>'
       + '<div class="col-main">'+renderAI(res)+renderDetail(res,res.rows[Math.min(state.sel,res.rows.length-1)])+'</div></div>';
  } else {
    out+=`<div class="card"><div class="empty">请选择不同的出发地与目的地</div></div>`;
  }
  document.getElementById('v-calc').innerHTML=out;
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
  const sortName={A:'按'+costName,B:'按过网费',C:'按送端净收益'}[state.sortBy];
  // 阈值基准取列表中最低的落地价：按过网费 / 送端收益排序时首条并不是落地价最低者
  const bestPrice=rows.length?Math.min(...rows.map(r=>r.landed)):0;
  const thr=bestPrice*(1+(state.degrade??0.10));
  const inThr=rows.filter(r=>r.landed<=thr);
  const shown=state.showAll?rows:inThr;
  const cut=rows.length-inThr.length;
  let out=`<div class="card tight">
    <div class="sec-title">可选路线<span class="hint">共 ${res.total} 条候选 · 可行 ${res.feasibleCount} 条${res.truncated?' · 已达枚举上限':''}</span></div>
    <p class="note" style="margin:-4px 0 9px">按规则「优先选择节点间输电价格（含网损折价）最低的交易路径」，默认只列出成本不高于最优 ${fmt((state.degrade??0.10)*100,0)}% 的方案${cut>0?'，另有 '+cut+' 条成本更高者已折叠':''}。${isDst?'':'当前费用边界为<b>只算到受端省界</b>，下列金额与排序均<u>不含</u>受端省网输配电价与政府性基金及附加。'}</p>
    <p class="note" style="margin:-4px 0 9px">「候选」是 ${state.maxHops} 段以内、${state.maxDetour>=9?'绕行度不限':'绕行度不超过 '+state.maxDetour+'x'}、不重复经过同一省的全部路径；「可行」是其中各段入口功率不超过通道容量且断面不越限者。专项工程只按核定方向计入，省间联络线可双向，放宽跳数与绕行会让候选数成倍增长，但排在前面的方案不受影响。</p>
    <div class="seg small">
      ${[['A',costName],['B','过网费'],['C','送端收益']].map(([k,t])=>
        `<button class="${state.sortBy===k?'on':''}" onclick="setSort('${k}')">${t}</button>`).join('')}
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
function setSort(k){ state.sortBy=k; state.sel=0; doSolve(); }
function pick(i){ state.sel=i; saveLast(); renderCalc();
  const sel=document.querySelector('.rc.on'); if(sel) sel.scrollIntoView({block:'nearest',inline:'center',behavior:'smooth'}); }

/* ---------- 选中路线详情 ---------- */
function renderDetail(res,r){
  if(!r) return '';
  const costName=state.includeDstCost!==false?'落地成本':'省界成本';
  const colors=['#85B7EB','#EF9F27','#F0997B','#5DCAA5','#B4B2A9','#AFA9EC'];
  const comp=[['送端出清价',r.comp.gen],['送端省内段',r.comp.send],['跨省通道费',r.comp.trans],['区域电网费',r.comp.reg],
    ['网损折价',r.comp.loss],['受端输配电价',r.comp.net],['基金及附加',r.comp.fund]].filter(c=>c[1]>0);
  const tot=comp.reduce((s,c)=>s+c[1],0);

  let out=`<div class="card">
    <div class="sec-title">方案 #${state.sel+1}<span class="hint">${r.feasible?'<span style="color:var(--teal)">容量与断面均通过</span>':'<span style="color:var(--red)">存在越限</span>'}</span></div>
    <div class="hd-route">${routeStr(r.nodes)}</div>
    <div class="lines">
      ${r.edges.map(e=>`<span class="ln ${e.type==='DC'?'dc':'ac'}">${esc(e.n)}</span>`).join('<span class="plus">+</span>')}
    </div>
    <div class="big">${fmt(r.landed)}<span class="u">元/MWh ${state.includeDstCost===false?'送到受端省界':'落地'}</span></div>
    ${state.includeDstCost===false?'<p class="note" style="margin:-4px 0 8px">当前口径<b>不含</b>受端省网输配电价与政府性基金及附加，仅为送到受端省界的价格。</p>':''}
    <div class="bar">${comp.map((c,j)=>`<div style="width:${(c[1]/tot*100).toFixed(2)}%;background:${colors[j%6]}"></div>`).join('')}</div>
    <div class="lg">${comp.map((c,j)=>`<span><i style="background:${colors[j%6]}"></i>${c[0]} ${fmt(c[1])}</span>`).join('')}</div>
    <div class="chips">
      <span class="chip info">过网费 ${fmt(r.channelOnly)}</span>
      <span class="chip info">送端净收益 ${fmt(r.senderNet)}</span>
      <span class="chip">${r.hops} 段</span>
      <span class="chip">${fmt(r.dist,0)} km</span>
      <span class="chip">网损 ${fmt((1-r.D)*100,2)}%</span>
      <span class="chip">占用 ${fmt(r.maxLoad*100,0)}%</span>
      <span class="chip ${r.unverified?'warn':'ok'}">${r.unverified? r.unverified+' 段非核定':'全部发改委核定'}</span>
    </div>
    ${!r.feasible?`<div class="warn bad" style="margin-top:11px">${r.overSeg.length?'通道超容：'+r.overSeg.map(s=>esc(s.name)+' '+fmt(s.mw,0)+'/'+s.cap+' MW').join('；')+'<br>':''}${r.secOver.length?'断面越限：'+r.secOver.map(h=>esc(h.sec.n)+' '+fmt(h.mw,0)+'/'+h.sec.limit+' MW').join('；'):''}</div>`:''}
    <div class="row2" style="margin-top:12px">
      <button class="btn ghost" onclick="go('map')">在网架图上查看</button>
      <button class="btn ghost" onclick="document.getElementById('d-detail').open=true;document.getElementById('d-detail').scrollIntoView({behavior:'smooth'})">展开完整明细</button>
    </div>
  </div>`;

  // 节点与线路时间轴
  out+=`<div class="card">
    <div class="sec-title">途经节点与线路<span class="hint">${r.nodes.length} 个节点 · ${r.segs.length} 段线路</span></div>
    <div class="tl">`;
  r.nodes.forEach((nd,i)=>{
    const isEnd=i===0||i===r.nodes.length-1;
    const st=i===0?r.edges[0].stFrom:(i<r.edges.length?r.edges[i].stFrom:null);
    const stUse = i===0 ? (r.edges[0].stFrom||null) : (i===r.edges.length ? (r.edges[i-1].stTo||null) : (r.edges[i].stFrom||r.edges[i-1].stTo||null));
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
          <div class="tl-seg-hd"><span>${esc(e.n)}</span><span class="pill ${e.type==='DC'?'':'g'}">${esc(e.type)} ${esc(e.kv)}</span></div>
          <div class="tl-seg-g">
            <div>长度<b>${e.lenKm?e.lenKm+' km':'约 '+fmt(s.crow,0)+' km*'}</b></div>
            <div>容量<b>${e.cap?e.cap+' MW':'待补'}</b></div>
            <div>输电价<b>${fmt(s.t)} 元/MWh</b></div>
            <div>线损率<b>${fmt(e.loss,2)}%</b></div>
            <div>段入口功率<b>${fmt(s.inMW,0)} MW</b></div>
            <div>段损耗电量<b>${fmt(s.lossMwh,2)} MWh</b></div>
          </div>
          ${s.util!=null?`<div class="meter"><i class="${s.util>1?'over':(s.util>0.8?'hi':'')}" style="width:${Math.min(s.util*100,100).toFixed(1)}%"></i></div>
            <div class="tl-cap">占用 ${fmt(s.util*100,1)}%　剩余 ${fmt(s.headroom,0)} / ${e.cap} MW</div>`
            :`<div class="tl-cap">核定容量待补，无法校验占用</div>`}
          <div class="tl-src">${tierTag(e.tier)} ${esc(e.doc||'无发改委文号')}${e.eff?'　生效 '+esc(e.eff):''}</div>
        </div>
      </div>`;
    }
  });
  out+=`</div>${r.segs.some(s=>s.kmEst)?`<p class="note">* 该段线路长度以站点直线距离估算，实际路径长度待补。</p>`:''}</div>`;

  // 完整明细
  out+=`<details class="adv boxed" id="d-detail"><summary>完整明细：费用 · 断面 · 溯源 · 口径</summary><div class="inner">
    <div class="sub">费用拆解<em>单价 元/MWh · 总额 元</em></div>
    <table>
      <tr><th style="width:40%">费用项</th><th>单价</th><th>总额</th><th>占比</th></tr>
      <tr><td>送端出清价购电</td><td>${fmt(r.comp.gen)}</td><td>${num(r.yuan.gen)}</td><td>${fmt(r.yuan.gen/r.yuan.total*100,1)}%</td></tr>
      <tr><td>送端省内段（送出省输电价格）</td><td>${fmt(r.comp.send)}</td><td>${num(r.yuan.send)}</td><td>${fmt(r.yuan.send/r.yuan.total*100,1)}%</td></tr>
      <tr><td>跨省专项工程输电费</td><td>${fmt(r.comp.trans)}</td><td>${num(r.yuan.trans)}</td><td>${fmt(r.yuan.trans/r.yuan.total*100,1)}%</td></tr>
      ${r.comp.reg>0?`<tr><td>区域电网输电费</td><td>${fmt(r.comp.reg)}</td><td>${num(r.yuan.reg)}</td><td>${fmt(r.yuan.reg/r.yuan.total*100,1)}%</td></tr>`:''}
      <tr><td>网损折价（受端承担部分）</td><td>${fmt(r.comp.loss)}</td><td>${num(r.yuan.loss)}</td><td>${fmt(r.yuan.loss/r.yuan.total*100,1)}%</td></tr>
      ${r.comp.net>0?`<tr><td>受端省网输配电价</td><td>${fmt(r.comp.net)}</td><td>${num(r.yuan.net)}</td><td>${fmt(r.yuan.net/r.yuan.total*100,1)}%</td></tr>`:''}
      ${r.comp.fund>0?`<tr><td>政府性基金及附加</td><td>${fmt(r.comp.fund)}</td><td>${num(r.yuan.fund)}</td><td>${fmt(r.yuan.fund/r.yuan.total*100,1)}%</td></tr>`:''}
      ${state.includeDstCost===false?`<tr><td style="color:var(--ink3)">受端省内费用</td><td style="color:var(--ink3)">已按口径排除</td><td style="color:var(--ink3)">—</td><td style="color:var(--ink3)">—</td></tr>`:''}
      <tr><td><b>合计</b></td><td><b>${fmt(r.landed)}</b></td><td><b>${num(r.yuan.total)}</b></td><td>100%</td></tr>
    </table>

    <div class="sub">电量与损耗<em>按 ${fmt(r.qty,0)} MWh 交付电量</em></div>
    <div class="g3">
      <div class="mc"><div class="l">送端发电量</div><div class="v">${fmt(r.genMWh,1)}<small>MWh</small></div></div>
      <div class="mc"><div class="l">网损电量</div><div class="v">${fmt(r.lossMwh,2)}<small>MWh</small></div></div>
      <div class="mc"><div class="l">综合线损率</div><div class="v">${fmt((1-r.D)*100,3)}<small>%</small></div></div>
    </div>
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
        计费口径：${esc(e.bill)}${e.incLoss?'（含输电环节线损，输电费按段后电量计）':'（不含线损，线损另计）'}${e.tax?'　含税':'　不含税'}<br>
        ${s.t!==e.t?`本段反向行进：按送端 ${esc(N(s.a))} 的送出省输电价格 ${fmt(s.t)} 元/MWh 计（存储方向 ${esc(N(e.from))}→${esc(N(e.to))} 为 ${fmt(e.t)}）<br>`:''}
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
      <div class="mc"><div class="l">送端净收益</div><div class="v">#${r.rankC}</div><div style="font-size:10.5px;color:var(--ink3)">${r.rankC===1?'最高':'低 '+fmt(res.byC[0].senderNet-r.senderNet)+' 元/MWh'}</div></div>
    </div>
    <div class="formula" style="margin-top:12px">
      <div class="mono">${state.includeDstCost===false
        ? '送到省界价 = 出清价 × (1 + ' + state.lossBearer + ' × 网损电量) + Σ[(送端省内段费 + 通道输电价) × 段前系数] + 区域电网费　—— 不含受端省内费用'
        : '落地成本 = 出清价 × (1 + ' + state.lossBearer + ' × 网损电量) + Σ[(送端省内段费 + 通道输电价) × 段前系数] + 区域电网费 + 受端省网输配电价 + 政府性基金及附加'}</div>
      <div class="txt">段前电量 = 1 / Π(该段及之后各段的通过率)。每段导体上都流着下游全部损耗之后的电量，因此越靠送端的段，承担的电量与损耗越多。</div>
    </div>
  </div></details>`;
  return out;
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
  state.includeDstCost=g('i-dstcost').value==='1';
}
/* 送端省变化：只影响送端出清价 */
function applyFromProv(){
  const f=PV[state.from];
  if(f&&f.clear!=null) state.pGen=f.clear;
}
/* 受端省变化：影响受端省网输配电价、政府性基金及附加、受端结算价 */
function applyToProv(){
  const t=PV[state.to];
  if(!t) return;
  if(t.net!=null) state.pNet=t.net;
  state.fundMissing=(t.fund===null||t.fund===undefined);
  state.fund=state.fundMissing?0:t.fund;
  if(t.clear!=null) state.pDst=t.clear;
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
