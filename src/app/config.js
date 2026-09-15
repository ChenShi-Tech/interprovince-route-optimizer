/* 构建期注入的常量与本地存储键。由 node tools/build.mjs 替换占位符。 */
const BUILD_TIME='__BUILD_TIME__';
const PRICE_VERSION='__PRICE_VERSION__';   // 价格数据指纹，与 shared/app-data.json 同源
const LS_LIB='iproute.v2.lib', LS_LAST='iproute.v2.last', LS_MAP='iproute.v2.map';
