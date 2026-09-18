/* 构建期注入的常量与本地存储键。由 node tools/build.mjs 替换占位符。 */
const BUILD_TIME='__BUILD_TIME__';
const PRICE_VERSION='__PRICE_VERSION__';   // 价格数据指纹，与 shared/app-data.json 同源
const LS_LIB='iproute.v2.lib', LS_LAST='iproute.v2.last', LS_MAP='iproute.v2.map';
const LS_AI='iproute.v2.ai';   // 智能推荐的服务商 / 模型 / 密钥 / 上次输入，只存本机浏览器
const LS_GUIDE='iproute.v2.guide';   // FR-3：新手导览完成标记（存在即不再自动弹出；仅清应用数据重置）
const LS_UI='iproute.v2.ui';   // 外观偏好 {style:'clear'|'tech', mode:'system'|'light'|'dark'}；src/template.html <head> 内联脚本里写的是同名字面串，改名须两处同步
