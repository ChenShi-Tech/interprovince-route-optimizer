/* 显示格式化与徽标。纯函数，不依赖任何数据。 */
const fmt=(v,d=1)=>(v===null||v===undefined||isNaN(v))?'—':Number(v).toFixed(d);
const num=v=>(v===null||v===undefined||isNaN(v))?'—':Math.round(v).toLocaleString('zh-CN');
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const TIER={gov:'发改委核定',grid:'国网披露',region:'区域/送出省口径',est:'待补'};
const tierTag=t=>`<span class="tier ${t}">${TIER[t]||t}</span>`;
/* ---------- FR-1（PRD-体验问题修复-20260918）：数值输入防御与展示缩略 ---------- */
/* 数值输入业务上限（决策 D-3）：lim = {max,fallback}。PRD 只定义上限钳制；
   0/负数的回落沿用各输入项旧口径（电量/时长 >0 否则取默认、报价 +v||0 等，
   e2e B-02/B-03 为此行为锁），sanNum 不改变下限语义。界面红框红字反馈见 calc.js。 */
const NUM_LIMITS={
  quote:{max:10000,fallback:0},        // 送端报价 / 各类费率 ≤ 10,000 元/MWh
  qty:{max:10000000,fallback:1000},    // 省间交付电量 ≤ 10,000,000 MWh（非法回退默认 1000）
  hours:{max:8760,fallback:1},         // 时长 ≤ 8,760 h
  capacity:{max:1000000,fallback:0},   // 容量/需量 ≤ 1,000,000 kVA(kW)
  annualQty:{max:10000000,fallback:0}, // 年用电量 ≤ 10,000,000 MWh
  pct:{max:99.999,fallback:0},         // 百分比类维持现有上限
};
const sanNum=(v,lim)=>{
  const s=String(v==null?'':v).trim();
  let n=s===''?NaN:Number(s);   // 空串按非法处理（Number('')===0，不走此分支会错把空输入当 0）
  if(!Number.isFinite(n)) n=(lim&&lim.fallback!=null)?lim.fallback:0;
  if(lim&&n>lim.max) n=lim.max;
  return n;
};
/* 大数缩略显示：|v| ≥ 1e8 → "X.X亿"、≥ 1e4 → "X.X万"，其余按原格式透传
   （传 d 走 toFixed(d)，缺省走千分位整数）——正常量级显示与现状逐字符一致。
   仅用于 hero 大字与容量电费三卡等展示位；表格内精组数字保持原样（数据可信感）。 */
const fmtCompact=(v,d)=>{
  if(v===null||v===undefined||isNaN(v)) return '—';
  const n=Number(v);
  if(!Number.isFinite(n)) return '—';   // Infinity 等非有限值不进万/亿换算（避免渲染 "Infinity亿"）
  const a=Math.abs(n);
  if(a>=1e8) return (Math.round(n/1e7)/10)+'亿';
  if(a>=1e4) return (Math.round(n/1e3)/10)+'万';
  return d!=null?n.toFixed(d):num(n);
};

/* ---------- 批次 B（grid-map P1，change: grid-map-p1-and-ux-fixes）：tier 线型与地图搜索纯函数 ---------- */
/* tier 线型编码（spec: 仅作用于候选/全网弱化层，选中层保持统一强视觉）：
   gov 实线 / grid 细实线（宽度系数 0.7）/ region 长虚线 / est 短虚线。
   dash 为 SVG stroke-dasharray 字符串；天地图 dasharray / 腾讯 dashArray 的数组形式由消费方 split。 */
const TIER_STYLE={
  gov:{dash:'',w:1},
  grid:{dash:'',w:0.7},
  region:{dash:'8 5',w:1},
  est:{dash:'2 4',w:1},
};
const tierStyle=t=>TIER_STYLE[t]||TIER_STYLE.gov;
/* 地图搜索匹配（spec: 按名称子串匹配站点与通道；不改选中方案与必经过滤状态）。
   站点匹配站名+站址，通道匹配名称+别名。纯函数，ST/CH 由参数传入。 */
const mapSearchHits=(q,ST,CH)=>{
  const s=String(q||'').trim().toLowerCase();
  if(!s) return {stations:[],channels:[]};
  const stations=Object.keys(ST||{}).filter(k=>((ST[k].n||'')+' '+(ST[k].a||'')).toLowerCase().includes(s));
  const channels=(CH||[]).filter(c=>((c.n||'')+' '+(c.fn||'')).toLowerCase().includes(s)).map(c=>c.id);
  return {stations,channels};
};
/* 区域归属上图（批次 B 增补）：区域→颜色调色板。按区域名排序后固定分配，
   同一名单下颜色稳定（图例与节点一致）；跳过 _note 等元数据键。 */
const REGION_COLORS=['#185FA5','#0F6E56','#B0651A','#8E8AD6','#993C1D','#5DCAA5','#7FA7A0','#854F0B'];
const regionPalette=rgof=>{
  const names=[...new Set(Object.keys(rgof||{}).filter(k=>!k.startsWith('_')).map(k=>rgof[k]))].sort();
  const out={};
  names.forEach((n,i)=>{ out[n]=REGION_COLORS[i%REGION_COLORS.length]; });
  return out;
};

/* 选中方案的地图标注清单：每段线路名+段序号，路径起止及途经站名（去重）。
   纯函数：输入选中方案行与站点表，不引用任何界面全局；拓扑图与天地图共用同一清单（spec: grid-map 标注同源）。 */
const routeLabelList=(row,ST)=>{
  const out=[],seen=new Set();
  ((row&&row.segs)||[]).forEach((s,i)=>{
    out.push({kind:'seg',no:i+1,name:s.e.n,stFrom:s.e.stFrom,stTo:s.e.stTo});
    [s.e.stFrom,s.e.stTo].forEach(st=>{
      if(st&&ST[st]&&!seen.has(st)){ seen.add(st); out.push({kind:'station',st,name:ST[st].n}); }
    });
  });
  return out;
};

