/* 显示格式化与徽标。纯函数，不依赖任何数据。 */
const fmt=(v,d=1)=>(v===null||v===undefined||isNaN(v))?'—':Number(v).toFixed(d);
const num=v=>(v===null||v===undefined||isNaN(v))?'—':Math.round(v).toLocaleString('zh-CN');
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const TIER={gov:'发改委核定',grid:'国网披露',region:'区域/送出省口径',est:'待补'};
const tierTag=t=>`<span class="tier ${t}">${TIER[t]||t}</span>`;

