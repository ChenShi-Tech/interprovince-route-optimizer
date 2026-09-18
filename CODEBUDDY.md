# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## 仓库位置

本文件即位于仓库根，GitHub `ChenShi-Tech/interprovince-route-optimizer`，分支 `main`。**以下所有路径与命令都以仓库根为基准。**

上一级目录 `跨省交易app/` 不是 git 仓库，只是外层工作目录，放着两份松散的核实源文件（`ndrc842.pdf`、`省级电网输配电价_第四监管周期.json/.md`）；仓库内已归档同名副本，见 `docs/原始文件/`。改动请以仓库内的副本为准。

## 项目是什么

省间中长期交易的**交付成本与报价测算工具**（现货入口待拓展）。给定送端省、受端省与节点交付电量，枚举候选输电路径，按三种口径比选并逐段拆解费用。

- Web：`index.html`，自包含单文件、离线可用，线上 `https://interprovince-route.app.workbuddy.host/`
- 安卓：`android/` WebView 壳工程
- iOS：`ios/` **仅有目录与路线图，Xcode 工程尚未创建**
- 无后端、无 npm 依赖（根目录没有 `package.json`，全部是系统 Node 直跑的 `.mjs`）

## 常用命令

```bash
# 构建：src/ + data/ → index.html（自包含）+ shared/app-data.json(.min)
node tools/build.mjs

# 算法回归基线（条数随数据修正变化，以脚本输出为准；2026-09-18 实测 425 省对 / 987 条）
# ⚠️ 它会先用基线里的费率快照覆盖 CH，因此只证明实现未漂移、不证明费率数值正确
node tools/baseline-check.mjs

# 基线只读核对 + 渲染冒烟测试 + 底图合规检查（默认不写任何文件）
node tools/baseline2.mjs
# 差异确认有据后才显式接受，覆写基线（会打印 priceVersion 变化与变更条目）
node tools/baseline2.mjs --accept

# 门禁变异测试：改费率 / 反转方向 / 删字段 / 破坏占位符，四个反事实必须让门禁变红
node tools/test-mutation.mjs

# 一键发版：构建 → 8 组测试 → 数据审计 → 提交 → 推送（任一不过即中止）
node tools/release.mjs "提交信息"
node tools/release.mjs "提交信息" --no-push     # 只到提交为止
node tools/release.mjs "提交信息" --mutation    # 额外跑门禁变异测试

# 发版必跑的 8 组测试，可单独跑
node tools/test-modules.mjs        # 模块结构 + 算法层纯度守卫
node tools/test-data-share.mjs     # Web 与安卓端数据一致性
node tools/baseline-check.mjs      # 算法回归基线（2026-09-18 实测 987 条路线）
node tools/test-model-audit.mjs    # 全模型独立公式与适用期
node tools/test-regional-billing.mjs # 全国区域计费回归
node tools/test-prefill.mjs        # 受端参数预填行为
node tools/test-interaction.mjs    # 交互与计价口径回归
node tools/test-design-tokens.mjs  # 设计令牌守卫：颜色/圆角字面值只在 src/tokens.css、令牌引用有定义、字号在允许集合内

# 数据审计（也已纳入 release 前置；audit-voltage-tariffs 需 pdftotext）
node tools/audit-fees.mjs            # 费率库内部审计：单位换算、数值合理性、来源可追溯
node tools/audit-voltage-tariffs.mjs .   # 用 pdftotext 逐值回对 1077号附件1 原件

# 校验外部引擎（迁移到 RN/Swift 后包装成导出 solve/state/CH/PV 同名接口即可）
node tools/baseline-check.mjs <你的引擎.js>

# Playwright 端到端（需先在 tests/ 下 npm install）
node tests/dev-server.mjs          # 仓库根挂到 http://127.0.0.1:8734/，需另开终端常驻
node tests/e2e.mjs                 # 产出 tests/report.md + tests/shots/*.png + tests/results.json

# 安卓 APK（工具链 ~/android-toolchain：便携 JDK 17 + Gradle 8.7 + Android SDK）
node android/build-apk.mjs         # → android/app/build/outputs/apk/debug/app-debug.apk

# 数据维护
node tools/fetch-sources.mjs       # 抓取 sources.md 的 S01~S13 原文到 docs/原始文件/
node tools/push-github.mjs         # 推送到 GitHub（走 Git Data API，见下文）
node tools/restore-from-remote.mjs <commit_sha> [文件路径...]   # 从历史提交恢复误删文件
```

## 架构

### 构建管线：四进一出

`node tools/build.mjs` 把三个输入合成一个自包含 HTML：

| 输入 | 职责 |
|---|---|
| `data/fixed-prices.json` | **所有价格数值的唯一来源**（改价只改这个文件） |
| `src/extra.json` | 非价格数据：站点、断面、经纬度、容量、线路长度 |
| `src/template.html` | 页面骨架 + 样式 + 三处注入占位符（`__TOKENS__` / `__DATA__` / `__APP__`） |
| `src/tokens.css` | 设计令牌（`:root` 变量）：全站唯一允许写颜色 / 阴影 / 圆角字面值的地方，构建时注入 `<style>` 开头；样式与界面脚本只写 `var(--令牌)`，由 `tools/test-design-tokens.mjs` 守住 |

`docs/tariff.json` 是采集档案（含原文摘录），**不再参与构建**。

产出三份（同源同版本）：

| 产物 | 消费方 |
|---|---|
| `index.html` | Web，数据内联，离线可用 |
| `shared/app-data.json` | 安卓/iOS，含 `schema` / `priceVersion` / `dataHash` / `counts` |
| `shared/app-data.min.json` | 手机端随包内置的紧凑版 |

**`index.html` 和 `shared/` 都是构建产物，不要手改**——下次构建会被覆盖。

### 单文件打包与模块内联顺序

`src/app/*.js` 不是 ES 模块，构建时按 `build.mjs` 里的 `APP_FILES` 顺序**字符串拼接**进一个 `<script>`，共享全局作用域。顺序有硬约束：

```
config → format → data → state → algo/{network,cost,paths,solve} → ui/{theme,calc,lib,map,ai} → boot
```

`ui/ai.js` 是智能推荐（**当前隐藏**，`AI_ENABLED=false`，逻辑与测试保留）：把 `solve()` 产出的可行路线摘要与用户的自然语言要求发给 OpenAI 兼容接口（默认 DeepSeek），模型只在候选里挑选。它不参与计价、排序或候选生成，密钥存 `localStorage`（`LS_AI`），推荐结果绑定生成它的 `state._res` 对象，参数一变即失效。

「**通道**」下拉（`ui/calc.js` 的 `renderChannelSelect`，位于测算页顶部主卡，界面单选，选项标注经过该通道的最低价）把直流（专项工程）等通道当作组件来筛选方案：`solve()` 的 `input.mustHave` 是通道 id 数组，路径须**全部包含**它们，不区分行进方向。候选清单来自 `solve()` 返回的 `availChannels`——它取自从绕行度筛选后的**完整候选集**，不能用最终 `rows`，否则用户选中一条组件后其余组件会从选择器里消失、再也点不回来。组件 id 取自 `CH[].id`，旧存档里已失效的 id 要忽略而不是筛成空。

`boot.js` **必须最后**——它是唯一含顶层执行语句的模块。`src/template.html` 里的 `/*__TOKENS__*/`、`/*__DATA__*/` 与 `/*__APP__*/` **必须独占一行**，替换后残留文字会变成悬空代码导致语法错误。新增模块时要同步改 `build.mjs` 的 `APP_FILES` 和 `tools/test-modules.mjs` 的同一列表。

`build.mjs` 现在自带**构建期 fail-fast**（不过即 `exit 1`）：占位符各出现且仅出现 1 次并独占一行、两份 `APP_FILES` 逐项一致、注入串不含 `String.replace` 的四种替换模式（美元符后接 & 、美元符、反引号、单引号）、内联脚本可被 `vm` 解析、三份产物 `dataHash`/`priceVersion` 同源、数据值域 lint（坐标包络 / `PV` 线损率 / 区域电价 / 双向通道成对 / `CH` 端点省码）。

### 算法层必须是纯函数

`src/app/algo/*` **不得引用任何界面全局**（`state` / `PV` / `CH` / `DATA` / DOM）。数据经 `data` 参数传入，用户参数经 `input` 传入：

```js
solve(input, data)                                 // 算法层唯一入口 → {rows,byA,byB,byC,bestA,bestB,bestC,...} 或 {err}
regionRate(env, code)                              // 省所在区域的电量电价；买方区域在路径层面计一次
sendFeeOf(e, fromCode)                             // 按行进方向取送端省内段费用（双向工程反向取 sendFeeRev）
tariffOf(e, fromCode)                              // 按行进方向取联络线输电价（反向取 tRev）
enumPaths(adj, src, dst, maxHops, cap, weightOf)   // 展开顺序由调用方给权重函数
```

**这是为了让安卓端/iOS 端能原样复用同一份算法**，不必从 HTML 里抠代码。`tools/test-modules.mjs` 守住这条（会检测算法层里的裸引用界面全局，守卫本身已用反向注入验证过）。

界面层通过 `algoData()`（`src/app/data.js`）组装数据包：`{CH, PV, SEC, RG, REGION_OF, geo:{lngLatOf,provLngLat}, name}`。

### 七个高频陷阱

1. **网损是乘法项，不能直接当边权**。送达系数 `D = Π(1−ηᵢ)`，故分两步：① 用线性近似权重 `独立工程价 + 起点送出省价 + 计费线损率×出清价` 求候选路径；② 对候选路径按乘性公式精确重算并重新排序。
2. **路径唯一标识用节点序列** `nodes.join('>')`，不能用边的 `from`/`to`——反向通行的联络线存储方向与行进方向相反，用边拼键会把 `A→B→C` 与 `C→B→A` 误判为同一条。
3. **通道方向逐条由数据给定（`bidir`），任何用到边方向的地方都必须按实际行进方向取值**。单向送电直流（锦苏、复奉、天中……）只按核定方向；德宝、青藏、长南荆、辛洹、灵宝、高岭、云霄经公开报道证实双向运行（依据在 `data/fixed-prices.json` 的「方向依据」与 `CH[].dirNote`）；联络线双向。反向时联络线输电价取 `tRev`，双向专项工程的送端省内段取 `sendFeeRev`，绕行度起点按行进方向。2026-09-15 之前曾把全部通道建成双向（河北→四川会反着走锦界送出+德宝），后又一度把全部专项工程改成单向（把德宝这类互济直流也砍掉了），两次都是错的，方向必须逐条核对。
4. **跳数上限必须保留**（`MAX_HOPS=10`，界面固定取上限、不再提供选项）；绕行度上限改为可选输入（`maxDetour` 缺省 = 不限，界面不限绕行、按价格排序）。2026-09-17 全部 870 个省对实测未触发枚举上限、单次求解最慢约 25ms。不限绕行后，区域网损若不计入，经区域网架的绕行路线会被低估——这也是界面默认计入区域网损参考值的原因之一。绕行度 = 实际里程 ÷ 起终点直线距离（`detourOf`）。
5. **输出目录不能用 `dist/`**——发布工具把它当构建产物排除，站点会 404。本项目用 `shared/`。
6. **842 号附件的单位是「元/千千瓦时」**，数值上等于 元/MWh，不要误按「分/千瓦时」再乘 10。`docs/开发约定与操作手册.md` 与 `README.md` 都记了这条。
7. **两栏布局（900–1279px）下 `.col-side` 必须 `grid-row:1/3`**。左栏带 `sticky` + `max-height:calc(100vh - 106px)`，若只占第一行就会把该行撑到整屏高；而智能推荐（`.col-ai`）也在第一行，于是推荐卡片下方空出几百像素、方案详情被推到屏幕外。跨两行后行高由右列两张卡片决定。三栏断点（≥1280px）要把 `grid-row` 复位为 `1`。改动 `.layout` 后请跑 `tests/e2e.mjs` 的 `R-04`。

### 中长期计价口径

默认中长期测算（marketMode=mlt），交付点为受端省间交易节点（includeDstCost=false）。现货仅预留入口，非 mlt 请求返回尚未实现。

```
D = 工程计费通过率 × 所选区域环节通过率（各区域一次）
E = 选择省内网损另计时：1/D × ρ送/(1-ρ送)，否则 0
A = 1 + lossBearer × (1/D-1) + E
F = 未含的起点送出费 × 首段入口系数
  + Σ 独立工程价 × 工程出口系数 + Σ 适用区域价 × 区域出口系数
border = pGen × A + F
maxSourceQuote = (pDst-F)/A
landed = includeDstCost ? border/(1-ρ受)+pNet+fund : border
```

- pGen 为手填合同/拟报价；pDst 为可选的受端节点目标交付价（界面已不提供，缺省时 senderNet=null、不产出 byC）。PV.clear 只是演示参考。
- sourceQuote=plant：报价未含送出省费；originLossMode=separate 或 included 决定省内网损是否另计。**界面默认 separate（2026-09-17 起）**：1077号附件1 注4 送出价「含税、不含线损」、线损率单列，长三角跨省中长期实施细则（2026）第三十六条规定落地侧价格含「送出省外送输电价格（含送出省外送输电网损）」。算法层缺省（未传该字段）仍按 included，基线在 included/exclude 口径下生成。sourceQuote=export：报价已含送出省费和省内网损，均不再追加。
- regionChargeMode=network（默认）：根据区域共用接口按区域去重，归集至最后出口；buyer：按交易公告在此基础上另计受端区域一次。该收费范围是待确认假设，不代表已取得合同证据。
- regionLossMode=exclude/historical/custom，regionLossRates={华东:1.59,...}。**界面默认 historical（2026-09-17 起）**：同一第三十六条规定落地侧价格含华东跨省输电网损；不计入会让经区域网架的绕行路线显得更便宜（如四川→江苏曾排出 6 段绕行低于锦苏直流）。算法层缺省仍为 exclude。RLOSS.currentPct=null 为当前未核实；historicalPct 为第三周期公开表参考值。内部 verified 模式仅允许使用有证据的 currentPct，当前未提供界面入口。未填不是已核定 0。
- 每段出口电量系数为下游所有计费环节通过率乘积的倒数，含区域网损；本段自身损耗不放大该段输电费。
- 共用交流接口不作专项收费，不逐接口计损；独立专项工程/背靠背直流保留自身口径，incLoss=true 不重复计损。送出省费仅起点一次。
- qty 为节点交付量。到户扩展 consumerQty=qty×(1-ρ受)，amountQty=consumerQty；否则 amountQty=qty。yuan.total/amountQty=landed，不能把到户价直接乘节点电量。
- senderNet 为 maxSourceQuote 的兼容别名，语义已改为“可接受送端报价”，不再是利润/现货卖方结算价。排序 C 取其最大值。
- regionItems 含收费位置、费率、网损率、来源、状态及电量；regionScenarios 提供同一路径未计/历史两情景。pricingIssues 与 priceComplete=false 保留适用性待核状态。
- 受端到户可选输入（缺省与旧口径一致）：dstInLossPct（所选受端电网主体的注3 线损率，电价已含线损的主体如深圳传 0）、dstBilling（single/twopart，仅用于缺项提示）、dstCapFee（两部制容/需量电费按用户负荷率折算的元/到户MWh：月单价×12÷(8.76×负荷率)）、dstSysOpFee（系统运行费手填，null=缺项）。输配电价仍由 pNet 传入，界面按「电网主体 × 电压档 × 单一制/两部制」从数据 VT 带入。
- 送端电站专属送出价可选输入：srcSendFee、srcExportLossPct、srcSendNote（1077号附件1 川、滇、冀北表注4 对特定电站/电量范围另定的送出价与线损口径，须确认额度）。
- 数据含 VT（`受端分电压输配电价`：31 省 34 个电网主体、161 档（2026-09-18 实测，海南已补录），电量/需量/容量电价与注3 线损率）与 SRCX（`送端电站专属送出价`），均在 data/fixed-prices.json；`node tools/audit-voltage-tariffs.mjs .` 用 pdftotext 逐值回对 S11 原件，**已纳入 release 发版前置**（缺 pdftotext 时打印跳过原因）。线损率与基金不随电压等级变化（注3 每表一个值；基金按用户类别取工商业口径）。
- Dphys、inMW 来自独立物理估算链（含交流估损），不能解释为运行潮流或 ATC。capacityStatus 仅 exceeded/unconfirmed。tradeDate 校验当前价格适用日（界面不再提供交付日期，取当天）；不提供完整历史价库。

来源和可复算数字见 [全模型审计](./docs/09-算法模型与收费标准审计.md)。

### 数据契约与分档

`shared/app-data.json`（当前 **schema v6**）的顶层键：`ST`（站点）`CH`（通道）`SEC`（断面）`PV`（省级参数）`LOSS_OF`（省级上网环节线损率，v6 新增）`RG`（区域电网输电价格）`RGOF`（省→区域归属）`RLOSS`（区域损耗来源）`VALIDITY`（适用期）`CAP`（两部制容/需量电价）`VT`（受端分电压输配电价）`SRCX`（送端电站专属送出价）`NIC`（非省间通道台账）。完整 TypeScript 定义见 `docs/03-数据接口说明.md`。

- **`LOSS_OF`（v6）**：`{ [省]: { inLoss, exportLoss } }`，与 `PV` 同源派生；算法层读它决定省内/送省外网损。**缺字段或与 PV 不一致时消费方必须显式告警（fail-closed），不得静默按 0 计**（H3：v5 端侧实测 SC→JS 到户差约 12.6 元/MWh 而基线全绿）。加字段已升 `schema` v5→v6
- `CH[].tier`：`gov`（发改委核定，有文号）/ `grid`（国网披露，含报备价）/ `region`（区域电网或送出省口径）/ `est`（待补：价格待核，界面显示「待补」）。路径含非 `gov` 段时界面要主动告警；构建期保证四档计数之和 = `CH` 长度
- `CH[].cap` 优先取「实际输送能力」，缺失回退额定，`capBasis` 标明口径（`cap`/`rated`/`reported`/`estimate`/`unknown`）；**`estimate` 与 `unknown` 不得用于越限判断**。`priceType` 区分电量制 / 容量制（容量制的 `t` 是交易方的边际输电价，见 `marginalNote`）
- `CH[].pricePending`：价格待核通道。南网 5 条物理直流无独立核定输电价格（收费并入 842 号聚合交易成分），**建边但一律不参与路径枚举**——纳入会按 0 元过网费产出价格虚低的错误方案。消费方（安卓/iOS）必须同样处理，不能当免费通道
- `NIC`（非省间通道台账）：物理存在但无法建成省级跨省边的工程（广东省内分区背靠背、对俄跨境受入），只登记不计价
- `PV[].fund` **可能为 `null`**（当前仅西藏）。消费方必须按「缺失」处理并提示用户，**不要静默当 0**——那会低估落地成本
- 两端通过 `priceVersion`（`data/fixed-prices.json` 的内容哈希）比对版本，`dataHash` 校验完整性。**版本不一致时不要混用两端数据**

## 界面与设计系统（移动端优先）

> 本节与 CLAUDE.md「界面与设计系统」、AGENTS.md「界面红线」同一口径；完整规范见 `docs/12-设计系统与界面规范.md`，可视化设计系统见 <https://claude.ai/artifact/AnZvVZEak5xQW2uPqGuZMp>。

- 这是以手机为主的 app：安卓 WebView 壳是主要形态，Web 只作辅助。所有界面先按 390px 宽度设计和验收。
- `src/tokens.css` 是唯一允许写颜色、阴影、圆角字面值的地方，构建时注入模板的 `/*__TOKENS__*/`；样式与脚本只写 `var(--x)`，地图 SDK、data: URI、canvas 用 `ui/theme.js` 的 `tokenColor()`。
- 三套主题：`clear`（默认）/ `clear-dark` / `tech`（科技·调度大屏，固定深色）。页头「外观」切换，存 `iproute.v2.ui`。安卓壳用 `values-night` 跟随系统明暗，app 内切换时通过 `IPRouteShell.setSystemBars` 同步系统栏（这个桥只能改颜色）。
- 可读性底线：文字 ≥4.5:1、控件边框 ≥3:1、CSS 最小字号 10.5px、可点区域 ≥44px，`tools/test-design-tokens.mjs` 对三套主题逐一检查。
- 改界面用 `tools/ui-shots.mjs` 截改前改后：纯重构必须零像素差异，有意改动要逐张看三套主题。

## 纪律（最高优先级）

来自 `docs/开发约定与操作手册.md`，接手前必读。

1. **不得编造费率数值。** 找不到就写 `null` 并在文档里记录已检索路径。这条高于一切——一个编造的费率比一个缺失的费率危害大得多。容量同理：ATC 我国不公开，宁可标「未获取」也不编系数。
2. **价格数据只有一处来源**：`data/fixed-prices.json`。改价格只改这个文件，然后 `node tools/build.mjs`。
3. **费率必须分档标注来源**，不得把报备价与发改委核定价混为一谈。2024 年后新投运的金永、中衡、坤渝、庆东、宝合与吉泉、昭沂目前只有国网报备价（昭沂的还有被追溯清算的可能）。
4. **改动算法后必须跑基线**，`node tools/baseline-check.mjs` 全绿才算完成（条数随数据修正变化，以脚本输出为准）。
   注意**基线只证明实现未漂移、不证明费率数值正确**（校验时会先用基线快照覆盖 CH）；费率/数据正确性靠 `audit-fees.mjs`、`audit-voltage-tariffs.mjs` 与一手来源核对。基线变更必须 `node tools/baseline2.mjs --accept` 显式接受，默认只读。
5. **新功能开发必须开新 worktree + 新分支**，不在 `main` 工作区直接改。`git worktree add .claude/worktrees/<分支名把/换成-> -b feat/<名字> origin/main`（`.claude/worktrees/` 已在 `.gitignore`；旧的 `.worktrees/` 约定作废，存量随 PR 合并自然消亡），做完合回 `main` 再发版。**不在功能分支上跑 `release.mjs`**——`tools/push-github.mjs:22` 把分支写死为 `main`，会把未合并的改动直接推到远端。详见 `docs/开发约定与操作手册.md` 纪律 5。
6. **界面改动守设计系统纪律**：只用令牌、390px 截图验收、三套主题过对比度，流程见 `docs/12-设计系统与界面规范.md` 第 13 节。

## Slack 工作简报（irp-work-bot）

> 本节与 `AGENTS.md` 的「Slack 工作简报」是同一份约定（CodeBuddy 读本文件、ZCode/Codex 读 AGENTS.md），修改时两处同步。

本工作区已接入 Slack MCP（服务器名 `slack`），目标频道：**跨省电力小程序**（私人频道，channel ID `C0C23DYR0S0`，team `T0AHYQRJ0HM`）。

**先问，后发（硬规则）**：任何消息发到频道之前，必须先把要发的全文给用户过目、得到明确同意后才能发。没有例外，每次发送前都要重新确认；用户没有回应或拒绝就不发。

触发起草的时机（到达时起草 → 征求同意 → 同意后才发）：① 完成一轮可交付工作（提交推送 / PR / 发版）；② 测试或构建状态变化（挂转绿、绿转挂）；③ 方案或数据契约定稿。日常小步骤连草稿都不用起草。开工前可读频道最近几条消息了解进展（读不需要确认，发需要）。

**消息格式**：第一行 `[CodeBuddy-成员名]`，例如 `[CodeBuddy-李四]`；成员名优先问用户，确认不到取 `git config user.name`。正文：一句话做了什么 / 关键点 / 提交或 PR 链接 / 验证结果 / 遗留事项。

**禁令**：禁止把会话记录、对话原文、思考过程发到频道；禁止贴文件大段原文、数据内容、密钥 / 令牌 / 环境变量；只允许发整理后的结论性简报。不要为「自动同步」添加任何 hooks 或后台静默上报机制——同步只能由 agent 在回合内显式调用 Slack 工具完成。

## 底图与合规

只用监管白名单内的底图：**腾讯地图**（默认，走本地代理、免密钥）与**天地图**（用户在应用内粘贴自己的 tk）。

- 代码中不内嵌任何有效地图密钥；`_TMapSecurityConfig` 的 `__WB_HTTP_PORT__` / `__WB_TMAP_SECRET__` 占位符须原样保留
- 不使用 Google / Apple / Bing 海外版 / OpenStreetMap / Mapbox / Leaflet
- 省界由合规底图负责，应用不自行绘制行政区划
- 腾讯地图那条线依赖 WorkBuddy 预览环境注入的本地代理，安卓包内与 iOS 里都不存在该代理，网架图会**按设计降级为内置 SVG 拓扑图 / 文本清单**；天地图路径在手机上可用

`tools/baseline2.mjs` 末尾的「底图合规检查」会守住这些约束。

## 推送机制

早期本机代理对 `github.com` 返回 502，`git push` / `pull` / `ls-remote` 都不可用，只能走 API。**2026-07-16 起代理已放行**，2026-09-16 与 2026-09-18 均实测 `fetch` / `pull --rebase` / `push` / `ls-remote` 正常，常规推送与 PR 直接用 git：功能分支 `git push -u origin <branch>` → `gh pr create`，合并后主工作区 `git pull`。

`tools/push-github.mjs`（GitHub Git Data API）**保留作兜底**：代理再次挡住 `github.com` 时使用（`release.mjs` 末尾也仍在调它）。注意它把目标分支写死为 `main`，**不能在功能分支上跑**。

兜底脚本的注意事项：

- 它用 `base_tree` **在远端现有树上叠加本地文件**，而不是用本地文件重建整棵树——后者会在多会话并行时删掉别人推送的内容（2026-09-14 真实发生过，误删 18 个文件）
- API 推送会把本地多个提交压成远端**单个提交**（取 `git log -1` 信息），历史粒度不如 git push
- **改文件名 = 新增 + 遗留旧文件**。`base_tree` 会保留远端旧名文件形成重复；确认新旧 blob sha 相同后用 `--allow-delete` 清理
- 推送前会列出「远端有、本地没有」的文件，默认保留；确实要删须显式加 `--allow-delete`
- `git ls-files` 默认对中文路径做八进制转义，脚本读文件会 ENOENT，**必须用 `git -c core.quotepath=false ls-files`**

## 发布

- 线上：`https://interprovince-route.app.workbuddy.host/`，管理入口在 WorkBuddy「设置—数据管理—应用」
- 部署是本机目录的**快照**，不是 git 钩子——改完要重新发布才生效
- 部署偶发报「3000 端口未就绪」（旧静态服务占着端口），**直接重试一次即可**
- 部署是**叠加式**的：重新发布不会删除站点上已移除的文件，仓库清理后线上可能仍有残留（无害，但要知道原因）
- 安卓端数据有三种取数方式（随包内置 / 站点同目录 / jsDelivr CDN），推荐内置一份兜底 + 联网比对 `priceVersion`

## 当前状态与已知缺口

已验证：**31 个省**输配电价 + **91 条通道**全部有来源文号；一手原件归档在 `docs/原始文件/`（S01～S34，可离线核对）。2026-09-17 完成全网通道覆盖核对与补录，见 `docs/gaps.md` 末节。

回归基线：`node tools/baseline-check.mjs` 全绿即通过（**2026-09-18 实测 425 省对 / 987 条路线**，条数随数据修正变化，以脚本输出为准）。基线变更必须 `node tools/baseline2.mjs --accept` 显式接受；`node tools/test-mutation.mjs` 用四个反事实守住「门禁真的会变红」。

**已知缺口（不要假装它们不存在）**：

| 项 | 状态 |
|---|---|
| ATC（可用输电能力） | 27 条主要通道全部未获取，公开渠道无口径；当前用「实际输送能力」校验容量 |
| 省内重要输电通道清单与限额 | 未获取（由省调披露，非交易中心）；两端省内段只能按省网输配电价近似 |
| 交易路径集合 | 确认不存在公开清单，路径由国调中心在等值交易网络上运行时生成；已改用规则条款推导约束 |
| 省级参数 | 31/31 已取自发改价格〔2026〕1077号 附件1 官方核定值（海南于 2026-09-17 补录；西藏于 2026-09-18 回填送出省价格口径与两个线损率，其表源为西藏自治区发展改革委 2026-07-31 通知附件，非附件1）；**西藏政府性基金及附加仍缺** |
| 通道额定容量 | 直流侧多为「实际输送能力」；**2026-09-17 起省间联络线一律不填估算值**——公开来源只给到回数、未给逐回输送能力，填估算会参与越限判断而假告警，故 cap=null、界面显示「容量待补」、不做容量校验。2026-09-18 已按 `docs/11` D6/H2 清理完 14 条历史估算容量（原值与口径移入说明列可追溯），构建期 lint 断言「regional 交流边容量必须为 null」；当前 `capBasis` 分布 `{unknown:62, cap:21, reported:8}` |
| 省间联络线（**33 条**） | 含特高压交流 11 条、西北 750kV 4 条。无独立核定通道价，送出省参考价仅在交易起点计；交流接口计费网损 0 |
| 南网物理直流（**5 条**） | 云广/普侨/高肇/兴安/禄高肇 未检索到发改委独立核价文件，标 `pricePending` 建边但**不参与枚举**；收费并入 842 号聚合交易成分 |
| 非省间通道（3 条） | 大湾区广州/东莞背靠背（广东省内分区）、黑河背靠背（对俄跨境受入）无法建省级图边，登记在 `NIC` 台账 |
| 断面限额（10 个） | 来自公开报道与学术文献，**不是交易中心披露的运行限额** |
| 西藏政府性基金及附加 | 未获取，应用内显式告警 |

未实现的想法见 `docs/改进计划.md`：时间维度（96 点时序）、两部制容量电费独立测算、现货出清与结算、交易路径集合约束、方案并排对比。

## 重要边界

- 本工具是**测算与比选辅助工具**，不构成交易建议，不能替代正式交易系统
- 实际可用交易路径须在电力交易中心公布的路径集合内；本工具按全网拓扑枚举
- 南方及跨经营区中长期需匹配对应规则和交易公告，当前图模型不能认证其实际可交易或完整收费。
- 额定容量 ≠ 可用输电能力（ATC）。ATC 的 TRM / CBM 取值我国不公开，工具中不写死默认值

## 法规依据与文档地图

费率分政府核定、国网披露与估算/待核，不能将全库视为已认证可结算，原件在 `docs/原始文件/`：

- 省级输配电价 → 发改价格〔2026〕1077号 附件1（34 张表）
- 通道专项工程输电价 → 多个文号，存量部分主依据〔2019〕842号 附件
- 送出省输电价格 → 各省第四监管周期通知
- 定价规则 → **发改价格规〔2025〕1490号 附件4（现行）**
- 购电价格构成与线损偏差归属 → 发改价格〔2018〕1227号

**定价规则谱系**：`〔2017〕2269号` → `〔2021〕1455号` → **`〔2025〕1490号`（现行）**。引用条款注意用现行版本——1455号 已被 1490号 废止（`tools/patch-regulation-refs.mjs` 专门修过这类过期引用）。

按需查阅：

| 文档 | 内容 |
|---|---|
| `CLAUDE.md` | ★ 本文件的精简孪生版（Claude Code 入口），事实性内容两边须同步 |
| `docs/开发约定与操作手册.md` | ★ 接手必读：纪律、踩坑清单、推送机制、缺口 |
| `docs/10-跨省交易费用计算教程.md`（含 PDF） | ★ 业务侧必读：中长期七层费用与统一公式、现货折算与出清，含可复算算例 |
| `docs/03-数据接口说明.md` | ★ Web/端侧共用的数据契约、算法公式、字段 TypeScript 定义 |
| `README.md` | 项目总览、界面、路线枚举、验证 |
| `docs/gaps.md` | 已知数据缺口与检索路径 |
| `docs/sources.md` | 费率来源清单（S01~S13 与原文链接） |
| `docs/费率核实报告.md` | 逐条核实结论 |
| `docs/改进计划.md` | 未实现想法与依据 |
| `docs/01-安卓开发框架.md` / `android/README.md` | 安卓路线、工具链、真机验收要点 |
| `ios/README.md` / `ios/ROADMAP.md` | iOS 路线选择（WKWebView 壳先行 / SwiftUI 主力）与阶段计划 |
| `docs/regression-baseline-v2.json` | 算法数值基线（2026-09-18 实测 425 省对 / 987 条路线；iOS/RN 也必须对它跑） |
| `docs/11-数据与功能独立复核报告（2026-09-18）.md` | ★ 独立复核：1011 项数据核对 + 91 条功能发现，P0/P1/P2 修复清单与证据 |

区域价不含线损。区域损耗提供缺项/历史/手填情景，历史率当前适用性尚未核实。
