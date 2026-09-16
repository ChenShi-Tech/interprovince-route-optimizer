/* 路径枚举。
 *
 * 依据《省间电力现货交易规则》3.2.2：
 *   「同一交易路径不重复经过同一交易节点」→ 只枚举简单路径；
 *   「优先选择节点间输电价格（含网损折价）最低的交易路径」→ 邻居按近似成本升序展开，
 *   使低成本路径优先被发现，达到枚举上限时保留最有价值的候选，而不是任意截断。
 */

/** 枚举 src→dst 的全部简单路径（不重复经过同一节点）。
 *
 * @param adj      邻接表（见 network.js buildAdj）
 * @param src,dst  起止省代码
 * @param maxHops  跳数上限（段数）
 * @param cap      枚举上限，防止组合爆炸
 * @param weightOf (adjEntry, currentNode) => number，决定邻居展开顺序
 */
function enumPaths(adj,src,dst,maxHops,cap,weightOf){
  const out=[], visited=new Set([src]), nodes=[src], edges=[];
  let hitCap=false;   // REQ-601：区分「提前截断」与「自然枚举完恰好 cap 条」
  const ord={};
  for(const k in adj) ord[k]=adj[k].slice().sort((a,b)=>weightOf(a,k)-weightOf(b,k));
  (function dfs(u){
    if(out.length>=cap){ hitCap=true; return; }
    if(u===dst){ out.push({nodes:nodes.slice(),edges:edges.slice()}); return; }
    if(edges.length>=maxHops) return;
    for(const nb of ord[u]||[]){
      if(visited.has(nb.to)) continue;
      visited.add(nb.to); nodes.push(nb.to); edges.push(nb.e);
      dfs(nb.to);
      edges.pop(); nodes.pop(); visited.delete(nb.to);
      if(out.length>=cap){ hitCap=true; return; }
    }
  })(src);
  out.hitCap=hitCap;
  return out;
}
