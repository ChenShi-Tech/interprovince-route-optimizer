/* 隐私政策同意弹窗（上架合规 #1）与政策全文常量（#2，来源：outputs/上架合规/隐私政策-全文-草稿-20260930.md v1.1）。
   硬要求：① 同意前零网络请求——本模块自身无任何网络行为，地图 SDK 的拉起由 go('map') 闸门
   （boot.js）与代理环境启动加载（ui/map.js）两处用 privacyStatus() 把守；
   ② 网架页入口同意前「不可达」（非隐藏）：go('map') 未同意直接返回，视图永不渲染；
   ③ 「暂不同意」不写任何键——每次冷启动重问、网架页始终不可达（不实现「记住拒绝」）；
   ④ 同意态存 localStorage（键 LS_PRIVACY，JSON {v,at}，v 供未来政策版本升级重签）。
   常驻入口：费率库「数据管理」卡的「隐私政策」按钮调 privacyReview()（同一全文常量，单「关闭」按钮）。
   纯函数式模块：无顶层执行；boot.js 在启动序列最前面调 privacyEnsure()。
   样式一律 var(--令牌)（tools/test-design-tokens.mjs 守卫），DOM 动态创建（template.html 不动）。
   遮罩点击不关闭（与 uiConfirm 相反）——同意必须显式点击「同意并继续」。
   注意：vm 系测试脚本（tools/test-*.mjs）用内存 mock DOM 跑本模块，DOM 操作全部包在 try 里。 */
const PRIVACY_TEXT_HTML=[
  '<b>版本 v1.1 ｜ 生效日期：____________（提交上架前填写）</b>',
  '适用应用：省间路径优选（Android 包名 com.iproute.calc）',
  '',
  '<b>一、政策摘要</b>',
  '<b>本应用不收集你的个人信息。</b>全部使用数据保存在你手机本机，我方不设服务器接收任何数据。',
  '· 业务功能与涉及的信息：测算与比选、费率库、网架图、导出报告 —— 只需要你输入<b>交易参数</b>（省份、电量、金额等），这些参数<b>仅在你的设备上参与计算</b>，不构成可识别到你个人的信息；你填写的<b>接口密钥</b>同样只存本机。',
  '· 你可以随时关闭的功能：智能推荐（<b>默认关闭</b>）、网架图在线底图（不填密钥即用内置离线拓扑图）。关闭后不影响其余功能。',
  '· 拒绝提供非必要信息的后果：本应用不索取非必要个人信息；唯一可选的“个人信息填写项”是接口密钥，你不填，则对应在线功能不可用，其余功能不受影响。',
  '',
  '<b>二、个人信息处理者</b>',
  '· 名称：____________（待填，建议填工商全称）',
  '· 注册地址：____________（待填）',
  '· 统一社会信用代码：____________（待填）',
  '· 个人信息保护负责人及联系方式：____________（待填，建议留邮箱 + 电话）',
  '',
  '<b>三、我们不收集什么</b>',
  '· 不需要注册、登录，不采集手机号、微信等身份标识；',
  '· 不读取通讯录、相册、位置、通话记录、短信；',
  '· 不采集设备标识（IMEI / OAID / IDFA 等），不做设备指纹；',
  '· <b>不含任何第三方统计、广告、推送、崩溃上报 SDK</b>——依赖列表为空，<b>零第三方 SDK</b>；',
  '· <b>不设自建服务端</b>，不存在向本应用处理者回传数据的行为。',
  '',
  '<b>四、你的数据存在哪里（存储地点）</b>',
  '本应用的全部使用数据保存在<b>你的设备本机</b>（Android 应用私有存储 / 浏览器本机存储）：',
  '· 你在费率库里做的修改、外观偏好、界面设置，以及你填写的接口密钥，全部存于本机；',
  '· <b>我方不存储、不备份你的任何数据</b>，因此不涉及我方服务器所在地；',
  '· <b>本应用已关闭 Android 系统云备份</b>，上述内容不会被同步到云端；',
  '· 卸载应用或在系统设置清除应用数据，这些内容即被删除。',
  '',
  '<b>五、个人信息收集清单</b>',
  '（业务功能 ｜ 信息种类 ｜ 必要与否 ｜ 收集目的 ｜ 收集方式 ｜ 保存方式与期限 ｜ 拒绝的影响）',
  '· 测算与比选 ｜ 交易参数（省份、电量、金额等）｜ 实现功能所必需 ｜ 完成路径枚举与费用测算 ｜ 你在界面手动填写 ｜ <b>仅在你设备内存/本机存储</b>，不落我方服务器 ｜ 无法出测算结果',
  '· 费率库 ｜ 你修改的费率值 ｜ 实现功能所必需 ｜ 按你的口径测算 ｜ 你在界面手动修改 ｜ 仅存你设备本机，直至你清除 ｜ 按内置默认费率测算',
  '· 外观偏好 ｜ 主题选择 ｜ 非必要 ｜ 记住你的界面偏好 ｜ 你在界面选择 ｜ 仅存你设备本机，直至你清除 ｜ 每次回到默认主题',
  '· 网架图（在线底图）｜ 你填写的天地图密钥 ｜ 非必要（可选用内置离线拓扑图）｜ 加载在线底图 ｜ 你手动粘贴 ｜ 仅存你设备本机，直至你清除 ｜ 使用内置离线拓扑图（<b>不产生任何网络请求</b>）',
  '· 智能推荐 ｜ 你填写的接口密钥；你输入的<b>文字要求</b>；当前方案的<b>路线摘要</b> ｜ 非必要 ｜ 让模型在候选路线中挑选 ｜ 你开启功能并点击后发起 ｜ 密钥仅存本机；<b>发送内容不落我方</b>（直接发给你选择的服务商）｜ 该功能不可用，其余不受影响',
  '说明：上述“信息”中，交易参数与密钥均<b>不是可识别到你个人的信息</b>；本应用不存在任何把上述内容回传给我方的通道。',
  '',
  '<b>六、个人信息对外提供清单</b>',
  '本应用<b>不向任何第三方提供你的个人信息</b>。仅在你<b>主动使用智能推荐</b>时，你输入的文字要求与当前方案的路线摘要，会由本应用<b>直接发送给「你自己选择的大模型服务商」</b>（我方不经手、不落库）：',
  '· 情形：智能推荐（你在应用内开启并点击触发）',
  '· 提供的种类：你输入的文字要求 + 当前方案的路线摘要',
  '· 接收方：<b>你自己选择的大模型服务商</b>：DeepSeek / 智谱 / Moonshot / OpenAI / 你自定义的 OpenAI 兼容接口',
  '· 接收方目的：为该请求生成推荐结果',
  '· 提供方式：由本应用从你的设备直接发起 HTTPS 请求',
  '· 安全措施：密钥由你自备、仅存本机；功能默认关闭、仅在点击时发起',
  '· 风险 / 跨境：⚠️ <b>若你选择 OpenAI，其服务器位于中国境外，相关内容将传输至境外</b>。请求接收方是你选择的服务商，其数据处理适用该服务商自己的隐私政策',
  '除上述情形外，本应用无任何对外提供、共享、转让或公开披露个人信息的行为；<b>我们不出售你的任何数据</b>。',
  '',
  '<b>七、什么时候会联网</b>',
  '本应用<b>默认完全离线可用</b>：测算、费率库、内置拓扑图在断网（飞行模式）下照常工作。只有你主动使用下列功能时才会发起网络请求：',
  '1. <b>网架图底图（天地图）</b>：粘贴<b>你自己申请的</b>天地图密钥后加载其底图；不填密钥则用内置离线拓扑图，<b>不发起任何请求</b>。',
  '2. <b>智能推荐（默认关闭）</b>：开启并填写<b>你自己的</b>密钥后，把路线摘要与你输入的要求发给你选择的服务商（见第六节）。',
  '<b>除上述两处外，本应用没有其他出网行为。</b>',
  '',
  '<b>八、系统权限说明</b>',
  '本应用<b>只申请一项权限——「网络访问（INTERNET）」</b>，仅用于第七节所述的底图加载。它属普通权限，安装即授予，使用中不弹询问。<b>测算与费率库完全不依赖网络。</b>',
  '',
  '<b>九、安全保护措施</b>',
  '· <b>数据最小化</b>：本应用不索取与功能无关的任何权限与信息；',
  '· <b>本地存储</b>：密钥与偏好只存你的设备；本应用已关闭 Android 系统云备份；',
  '· <b>传输安全</b>：仅有的对外请求走 HTTPS；',
  '· <b>无回传面</b>：本应用无自建服务端、零第三方 SDK，故不存在我方侧的数据泄露面。',
  '',
  '<b>十、保存期限</b>',
  '你本机数据的保存期限为<b>你自行决定</b>：应用不作自动删除，直至你在应用内清除数据、或在系统设置里清除应用数据、或卸载本应用。<b>我方不保存你的任何数据，故无我方侧的保存期限。</b>',
  '',
  '<b>十一、你的权利与控制</b>',
  '本应用无账号体系，相关权利通过本机操作实现：',
  '· <b>查阅 / 复制</b>：应用内可直接查看你填写的参数、费率与偏好；',
  '· <b>更正</b>：在界面直接修改；',
  '· <b>删除 / 撤回同意</b>：在应用内清除数据，或在系统设置清除应用数据、或卸载本应用；撤回隐私政策同意后，网架图入口将再次不可达；',
  '· <b>关闭网络</b>：在系统设置中关闭本应用的网络权限，此后仅“网架图在线底图 / 智能推荐”不可用，其余不受影响。',
  '',
  '<b>十二、未成年人</b>',
  '本应用是面向电力交易与输电费用测算场景的专业工具，<b>不面向未成年人</b>，也不会有意收集未成年人的个人信息。',
  '',
  '<b>十三、政策更新与本政策的历史版本</b>',
  '· 政策如有变更，我们会在应用内以弹窗<b>重新征求你的同意</b>（应用按版本号记录同意状态）；',
  '· 本政策当前版本 <b>v1.1</b>；生效日期与<b>历史版本</b>（按国标要求提供最近 24 个月内正式发布的历史版本）访问链接：____________（待提供）。',
  '',
  '<b>十四、投诉与争议解决</b>',
  '如你认为本应用的处理行为侵犯了你的合法权益，可通过第二节的联系方式向我们反馈，我们将在收到后 <b>15 个工作日</b>内答复。你也可以向应用分发平台或<b>网信、工信、市场监管</b>等主管部门投诉举报；协商不成的，可依法向有管辖权的人民法院提起诉讼。',
  '',
  '<b>十五、联系我们</b>',
  '· 运营主体：____________（待填）',
  '· 联系方式：____________（待填）',
].join('<br>');

function privacyStatus(){
  try{
    const raw=localStorage.getItem(LS_PRIVACY);
    if(!raw) return null;
    const s=JSON.parse(raw);
    if(!s||s.v!==1||!s.at) return null;   // 版本不符（未来政策升级）按未同意处理
    return { consented:true, version:s.v };
  }catch(e){ return null; }
}
let _privOpen=false;
function _privacyRemove(){
  const ov=document.getElementById('privacy-box'); if(ov) ov.remove();
  document.removeEventListener('keydown',_privacyOnKey);
}
function privacyDecline(){
  _privOpen=false;
  _privacyRemove();   // 不写任何键：下次冷启动重问，网架页保持不可达
}
function _privacyOnKey(e){ if(e.key==='Escape') privacyDecline(); }   // Esc 等同「暂不同意」/「关闭」
function privacyConsent(){
  try{ localStorage.setItem(LS_PRIVACY,JSON.stringify({v:1,at:new Date().toISOString()})); }catch(e){}
  _privOpen=false;
  _privacyRemove();
  // 已拍板：同意后当次补导览——guide 键缺席则延时触发，保持原首启体验（boot.js 的调度已带同意条件，这里是同意前被拦下的兜底）
  try{ if(!localStorage.getItem(LS_GUIDE)) setTimeout(guideStart,400); }catch(e){}
}
/* 渲染政策弹窗（同意态与常驻入口共用的全文与外壳）：buttonsHtml 由调用方给（同意/暂不同意，或单独「关闭」）。 */
function _privacyOpen(buttonsHtml){
  try{
    const ov=document.createElement('div');
    ov.id='privacy-box';
    ov.style.cssText='position:fixed;inset:0;z-index:4100;background:var(--scrim-dialog);display:flex;align-items:center;justify-content:center;padding:28px';
    ov.innerHTML='<div role="dialog" aria-modal="true" aria-label="隐私政策" style="background:var(--card);border-radius:var(--radius-dialog);max-width:340px;width:100%;max-height:80vh;overflow:auto;padding:18px 16px 14px;box-shadow:var(--shadow-dialog)">'
      +'<div style="font-size:14.5px;font-weight:600;color:var(--ink);margin-bottom:8px">隐私政策与用户协议</div>'
      +'<div style="font-size:12.5px;color:var(--ink2);line-height:1.7">'+PRIVACY_TEXT_HTML+'</div>'
      +'<div style="display:flex;gap:10px;margin-top:16px">'+buttonsHtml+'</div></div>';
    ov.addEventListener('click',e=>{ if(!e.target.closest('[role="dialog"]')) return; });   // 点遮罩不关闭（与 uiConfirm 相反）
    document.addEventListener('keydown',_privacyOnKey);
    document.body.appendChild(ov);
    _privOpen=true;
    return true;
  }catch(e){ _privOpen=false; return false; }
}
/* 未同意 ⇒ 渲染弹窗并返回 false；已同意 ⇒ 返回 true。
   弹窗已开着时再次调用不叠层，直接返回 false。 */
function privacyEnsure(){
  if(privacyStatus()) return true;
  if(_privOpen) return false;
  _privacyOpen('<button class="btn ghost" onclick="privacyDecline()" style="flex:1">暂不同意</button>'
    +'<button class="btn" onclick="privacyConsent()" style="flex:1;font-size:14px;padding:10px">同意并继续</button>');
  return false;
}
/* 常驻入口（费率库「数据管理」卡）：已同意也可回看全文，单「关闭」按钮、不写任何键。 */
function privacyReview(){
  if(_privOpen) return;
  _privacyOpen('<button class="btn" onclick="privacyDecline()" style="flex:1;font-size:14px;padding:10px">关闭</button>');
}
