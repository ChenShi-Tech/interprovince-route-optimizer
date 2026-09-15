/* 智能推荐：把当前的可行路线与用户用自然语言写的额外考虑因素交给大模型，
   由它在候选里挑选并说明理由。

   边界：
   - 独立于算法层。候选、计价、排序全部来自 solve()，模型只能在给定的候选里选，
     不参与任何数值计算，也不改变列表顺序。
   - 无后端。浏览器直接调用 OpenAI 兼容的 chat/completions 接口（DeepSeek 默认），
     密钥只存在本机浏览器的 localStorage，不进入构建产物、不上传到本站点。
   - 依赖：config / format / state / algo 的结果结构（state._res）。 */

const AI_PRESETS = {
  deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com', model: 'deepseek-chat' },
  zhipu:    { name: '智谱 GLM',  base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  moonshot: { name: 'Moonshot Kimi', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
  openai:   { name: 'OpenAI',   base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  custom:   { name: '自定义（OpenAI 兼容）', base: '', model: '' },
};
const AI_MAX_ROUTES = 40;   // 送给模型的候选上限，超出时按当前排序取前 N 条

let aiState = { provider: 'deepseek', base: AI_PRESETS.deepseek.base, model: AI_PRESETS.deepseek.model, key: '', prompt: '', showCfg: false };

function aiLoad(){
  try{ const s=localStorage.getItem(LS_AI); if(s) Object.assign(aiState, JSON.parse(s)); }catch(e){}
}
function aiSave(){
  try{ const {provider,base,model,key,prompt,showCfg}=aiState; localStorage.setItem(LS_AI, JSON.stringify({provider,base,model,key,prompt,showCfg})); }catch(e){}
}
function aiField(k, v){
  aiState[k]=v;
  if(k==='provider' && AI_PRESETS[v] && v!=='custom'){ aiState.base=AI_PRESETS[v].base; aiState.model=AI_PRESETS[v].model; }
  aiSave();
  if(k==='provider') renderCalc();
}

/** 送给模型的候选摘要：只取可行路线，字段全部来自 evalPath 的结果。id 即列表里的 #序号。 */
function aiRouteDigest(res){
  const rows = res.rows.map((r,i)=>({r,i})).filter(x=>x.r.feasible);
  const take = rows.slice(0, AI_MAX_ROUTES);
  const f1 = v=>Math.round(v*10)/10;
  return {
    total: rows.length, sent: take.length,
    routes: take.map(({r,i})=>({
      id: i+1,
      途经省份: r.nodes.map(N).join('→'),
      线路: r.edges.map(e=>e.n).join('+'),
      段数: r.hops,
      落地成本_元每MWh: f1(r.landed),
      过网费_元每MWh: f1(r.channelOnly),
      送端净收益_元每MWh: f1(r.senderNet),
      综合线损率_pct: f1((1-r.D)*100),
      最高通道占用_pct: f1(r.maxLoad*100),
      里程_km: Math.round(r.dist),
      绕行度: f1(r.detour),
      直流段数: r.dcCount, 交流段数: r.acCount,
      电压等级: r.kvList.join('/'),
      途经区域: r.regionList.join('、'),
      非发改委核定段数: r.unverified,
      费率来源: r.edges.map(e=>e.n+':'+(TIER[e.tier]||e.tier)).join('；'),
      经过断面: r.secHits.map(h=>h.sec.n+' 利用率'+f1(h.util*100)+'%').join('；')||'无',
      容量待补段数: r.capUnknown,
      排名_落地成本: r.rankA, 排名_过网费: r.rankB, 排名_送端净收益: r.rankC,
    })),
  };
}

function aiBuildMessages(res){
  const d = aiRouteDigest(res);
  const costName = state.includeDstCost===false ? '送到受端省界的价格（不含受端省内费用）' : '受端完整落地价';
  const system = [
    '你是省间电力现货交易的送电路径分析助手。用户已经用确定性算法枚举并计价了从送端省到受端省的全部可行路径，',
    '现在给出额外的考虑因素，请你只在给定的候选路径中挑选，不得虚构候选之外的路径，不得修改任何数值。',
    '判断要有依据：引用候选表里的字段（成本、线损、占用、断面、里程、费率来源等）解释为什么推荐或不推荐。',
    '如果用户的要求与候选数据冲突或无法满足，直接说明，不要勉强推荐。',
    '必须以 JSON 格式输出，结构为：',
    '{"recommendations":[{"id":候选id,"rank":1,"reason":"推荐理由"}],"summary":"总体判断（2~4 句）","caveats":"需要提醒用户核实的事项，没有则为空字符串"}',
    'recommendations 最多 5 条，按推荐优先级排序，id 必须来自候选表。',
  ].join('');
  const user = [
    `送端：${N(state.from)}；受端：${N(state.to)}；电量 ${state.qty} MWh，时段 ${state.hours} h；`,
    `送端出清价 ${state.pGen} 元/MWh，受端结算价 ${state.pDst} 元/MWh；网损承担方：${state.lossBearer==1?'受端':state.lossBearer==0?'送端':'两端各半'}；`,
    `主指标口径：${costName}。`,
    d.sent<d.total ? `可行路径共 ${d.total} 条，按当前排序只给出前 ${d.sent} 条。` : `可行路径共 ${d.total} 条，全部列出。`,
    '\n候选路径（JSON）：\n', JSON.stringify(d.routes),
    '\n\n用户的额外考虑因素：\n', (aiState.prompt||'').trim() || '（用户未填写，请按综合成本、可靠性与费率可信度给出建议）',
    '\n\n请以 JSON 格式输出推荐结果。',
  ].join('');
  return [{role:'system',content:system},{role:'user',content:user}];
}

async function aiRun(){
  const res = state._res;
  if(!res || !res.rows || !res.rows.length){ state._ai={error:'当前没有可推荐的路线'}; renderCalc(); return; }
  if(!res.rows.some(r=>r.feasible)){ state._ai={error:'当前没有可行路线（全部越限），无法推荐'}; renderCalc(); return; }
  if(!aiState.key){ state._ai={error:'请先在「模型设置」里填写 API Key'}; aiState.showCfg=true; aiSave(); renderCalc(); return; }
  const base=(aiState.base||'').replace(/\/+$/,''), model=aiState.model;
  if(!base||!model){ state._ai={error:'请填写接口地址与模型名'}; aiState.showCfg=true; aiSave(); renderCalc(); return; }
  state._ai={loading:true}; renderCalc();
  const messages = aiBuildMessages(res);
  try{
    const resp = await fetch(base+'/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+aiState.key},
      body:JSON.stringify({model, messages, temperature:0.2, response_format:{type:'json_object'}}),
    });
    if(!resp.ok){
      let msg=''; try{ msg=(await resp.text()).slice(0,300); }catch(e){}
      throw new Error(`接口返回 HTTP ${resp.status}${msg?'：'+msg:''}`);
    }
    const data = await resp.json();
    const text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    const parsed = aiParse(text);
    const recs = (parsed.recommendations||[]).map(x=>{
      const idx = (+x.id)-1;
      const row = res.rows[idx];
      return row && row.feasible ? {idx, row, rank:x.rank, reason:String(x.reason||'')} : null;
    }).filter(Boolean);
    // 记住这次推荐对应的结果对象：参数一变 solve() 会产生新对象，旧推荐即失效不再显示
    state._ai={ res, result:{recs, summary:String(parsed.summary||''), caveats:String(parsed.caveats||''),
      model, sent:aiRouteDigest(res).sent, at:new Date().toLocaleTimeString('zh-CN',{hour12:false}),
      usage:data.usage||null }, prompt:aiState.prompt };
  }catch(e){
    const m = String(e && e.message || e);
    state._ai={error: /Failed to fetch|NetworkError|Load failed/.test(m)
      ? '请求未能发出：可能是网络不通、接口地址错误，或该服务不允许浏览器跨域调用（需改用支持 CORS 的接口或本地代理）。原始错误：'+m
      : m};
  }
  renderCalc();
}

/** 模型可能把 JSON 包在 ```json 围栏里，或前后带说明文字，尽量取出其中的对象。 */
function aiParse(text){
  const s=String(text||'').trim();
  try{ return JSON.parse(s); }catch(e){}
  const fence=s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence){ try{ return JSON.parse(fence[1]); }catch(e){} }
  const a=s.indexOf('{'), b=s.lastIndexOf('}');
  if(a>=0&&b>a){ try{ return JSON.parse(s.slice(a,b+1)); }catch(e){} }
  throw new Error('模型没有返回可解析的 JSON：'+s.slice(0,200));
}

function renderAI(res){
  // 推荐结果只对生成它的那次测算有效；参数变了就不再显示旧结果（错误与加载态照常显示）
  const raw=state._ai||{};
  const ai=(raw.result && raw.res!==res) ? {} : raw;
  const feasible=res.rows.filter(r=>r.feasible).length;
  const preset=AI_PRESETS[aiState.provider]||AI_PRESETS.custom;
  let out=`<div class="card tight ai">
    <div class="sec-title">智能推荐<span class="hint">在 ${feasible} 条可行路线中按你的要求挑选</span></div>
    <p class="note" style="margin:-4px 0 8px">把成本之外的考虑因素用自然语言写在下面，例如「优先全部发改委核定的线路」「避开占用超过 60% 的通道」「不要经过断面」「直流段不超过 1 段」「线损和过网费都要兼顾」。模型只在上面列出的可行路线里选，不改动任何数值。</p>
    <textarea id="i-ai-prompt" rows="3" placeholder="例：优先发改委核定价格的线路，避开容量待补的通道，线损率不超过 5%" oninput="aiField('prompt',this.value)">${esc(aiState.prompt)}</textarea>
    <div class="ai-bar">
      <button class="btn" ${ai.loading?'disabled':''} onclick="aiRun()">${ai.loading?'正在分析…':'让模型推荐'}</button>
      <button class="btn ghost" onclick="aiState.showCfg=!aiState.showCfg;aiSave();renderCalc()">模型设置${aiState.key?'':' · 未填密钥'}</button>
    </div>
    <div class="ai-cfg" ${aiState.showCfg?'':'hidden'}>
      <label class="f"><span>服务商</span><select id="i-ai-provider" onchange="aiField('provider',this.value)">
        ${Object.entries(AI_PRESETS).map(([k,p])=>`<option value="${k}" ${aiState.provider===k?'selected':''}>${p.name}</option>`).join('')}
      </select></label>
      <div class="row2">
        <label class="f"><span>接口地址</span><input id="i-ai-base" type="text" value="${esc(aiState.base)}" placeholder="${esc(preset.base||'https://…/v1')}" oninput="aiField('base',this.value)"></label>
        <label class="f"><span>模型</span><input id="i-ai-model" type="text" value="${esc(aiState.model)}" placeholder="${esc(preset.model||'model-name')}" oninput="aiField('model',this.value)"></label>
      </div>
      <label class="f"><span>API Key</span><input id="i-ai-key" type="password" value="${esc(aiState.key)}" placeholder="sk-…" autocomplete="off" oninput="aiField('key',this.value)"></label>
      <p class="note" style="margin-top:2px">密钥只保存在本机浏览器，不会写入本站点或构建产物。浏览器直接调用服务商接口（OpenAI 兼容的 chat/completions），服务商须允许跨域；DeepSeek 已验证可用。</p>
    </div>`;
  if(ai.error) out+=`<div class="warn bad" style="margin:10px 0 0">${esc(ai.error)}</div>`;
  if(ai.loading) out+=`<div class="ai-loading">已把 ${Math.min(feasible,AI_MAX_ROUTES)} 条可行路线与你的要求发给 ${esc(aiState.model)}，通常需要 10～40 秒…</div>`;
  if(ai.result){
    const r=ai.result;
    out+=`<div class="ai-res">
      <div class="sub">推荐结果<em>${esc(r.model)} · ${esc(r.at)} · 送入 ${r.sent} 条</em></div>
      ${r.summary?`<p class="ai-sum">${esc(r.summary)}</p>`:''}
      ${r.recs.length? r.recs.map((x,k)=>`<button class="ai-rec ${state.sel===x.idx?'on':''}" onclick="pick(${x.idx})">
          <div class="ai-rec-hd"><span class="rc-no">推荐 ${k+1}</span><span class="rc-hop">#${x.idx+1} · ${x.row.hops}段</span><span class="ai-rec-price">${fmt(x.row.landed,0)}<small>元/MWh</small></span></div>
          <div class="ai-rec-route">${esc(x.row.nodes.map(N).join(' → '))}</div>
          <div class="ai-rec-line">${esc(x.row.edges.map(e=>e.n).join(' + '))}</div>
          <div class="ai-rec-why">${esc(x.reason)}</div>
        </button>`).join('') : `<p class="note">模型没有给出符合要求的路线${r.summary?'，见上面的说明':''}。</p>`}
      ${r.caveats?`<div class="warn" style="margin:8px 0 0">${esc(r.caveats)}</div>`:''}
      <p class="note">推荐由大模型根据候选表与你的描述生成，属于辅助判断，成本与可行性以上方确定性测算为准。${ai.prompt!==aiState.prompt?'你已修改要求，结果尚未更新。':''}</p>
    </div>`;
  }
  out+=`</div>`;
  return out;
}
