# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本文件、`CODEBUDDY.md`（更长、含更多背景）与 `AGENTS.md`（跨工具精简纪律版）是同一套口径的入口。**改了其中一份的事实性内容，其余要同步。**

## 这是什么

省间中长期交易的**交付成本与报价测算工具**（现货仅预留入口）。输入送端省、受端省、节点交付电量与送端报价，枚举候选输电路径，逐段拆解费用并按成本排序。

- **以手机为主**：安卓 `android/` WebView 壳是主要形态；iOS `ios/` WebView 壳开发中（已有 Xcode 工程与 `ios-build` CI）。设计与验收一律先看 390px 手机宽度（见「界面与设计系统」）
- Web：`index.html` 自包含单文件、离线可用，线上 `https://interprovince-route.app.workbuddy.host/`；与两端壳加载的是同一页面，作辅助
- **是测算与比选辅助，不构成交易建议，不能替代交易系统。** 实际可用路径须在交易中心公布的路径集合内；本工具按全网拓扑枚举

## 常用命令

```bash
node tools/build.mjs               # 构建：src/ + data/ → index.html + shared/app-data.json(.min)
node tools/baseline-check.mjs      # 算法回归基线，全绿才算通过（条数随数据修正变化，2026-09-18 实测 425 省对 / 987 条）
node tools/baseline2.mjs           # 重生成基线 + 渲染冒烟 + 底图合规检查（改了费率/通道数据后先跑这个）
node tools/release.mjs "提交信息"   # 一键发版：构建 → 8 组测试 → 数据审计 → 提交 → 推送（任一不过即中止）
node tools/release.mjs "提交信息" --no-push

# 发版必跑的 8 组，可单独执行
node tools/test-modules.mjs          # 模块结构 + 算法层纯度守卫
node tools/test-data-share.mjs       # Web 与端侧数据一致性
node tools/baseline-check.mjs        # 数值回归基线
node tools/test-model-audit.mjs      # 全模型独立公式与适用期
node tools/test-regional-billing.mjs # 全国区域计费回归
node tools/test-prefill.mjs          # 受端参数预填行为
node tools/test-interaction.mjs      # 交互与计价口径回归
node tools/test-design-tokens.mjs    # 设计令牌守卫：颜色/圆角字面值只在 src/tokens.css、令牌引用有定义、字号在允许集合内

node tools/baseline-check.mjs <你的引擎.js>   # 校验外部引擎（RN/Swift 移植后包装成同名接口即可）
node tests/dev-server.mjs            # 仓库根挂到 http://127.0.0.1:8734/（需另开终端常驻）
node tests/e2e.mjs                   # Playwright 端到端（需先在 tests/ 下 npm install）
node tools/ui-shots.mjs [目录]       # 界面截图（390×844@2x 与 1280×900，默认存 .runtime/ui-shots/）；--theme <名字> 设 data-theme
node tools/ui-shots.mjs --compare <A> <B>   # 两套截图逐像素比较，有差异退出码非 0（改样式/令牌后验「像素零变化」）
node tools/audit-fees.mjs            # 费率库内部审计：单位换算、数值合理性、来源可追溯
node tools/audit-voltage-tariffs.mjs .   # 用 pdftotext 逐值回对 S11 原件（不在发版必跑列表）
node android/build-apk.mjs           # 安卓 APK（工具链在 ~/android-toolchain）
node tools/restore-from-remote.mjs <commit_sha> [文件...]   # 从历史提交恢复误删文件
```

## 架构

### 构建管线：四进一出

| 输入 | 职责 |
|---|---|
| `data/fixed-prices.json` | **所有价格数值的唯一来源**（改价只改这里） |
| `src/extra.json` | 非价格数据：站点、断面、经纬度、容量、线路长度 |
| `src/template.html` | 页面骨架 + 样式 + 三处注入占位符（`__TOKENS__` / `__DATA__` / `__APP__`） |
| `src/tokens.css` | 设计令牌（`:root` 变量）：全站唯一允许写颜色 / 阴影 / 圆角字面值的地方，构建时注入 `<style>` 开头 |

产出 `index.html`（Web，数据内联）、`shared/app-data.json`（端侧，含 `schema`/`priceVersion`/`dataHash`/`counts`）、`shared/app-data.min.json`。**这三个都是构建产物，不要手改。** `docs/tariff.json` 是采集档案，不参与构建。

### 单文件拼接顺序

`src/app/*.js` **不是 ES 模块**，构建时按 `build.mjs` 的 `APP_FILES` 顺序字符串拼接进一个 `<script>`，共享全局作用域。顺序有硬约束：

```
config → format → data → state → algo/{network,cost,paths,solve} → ui/{theme,calc,lib,map,ai} → boot
```

- `boot.js` **必须最后**——它是唯一含顶层执行语句的模块
- `src/template.html` 的 `/*__TOKENS__*/`、`/*__DATA__*/` 与 `/*__APP__*/` **必须各自独占一行**，残留文字会变成悬空代码
- 样式与界面脚本**只写 `var(--令牌)`**，不写颜色 / 圆角字面值（`tools/test-design-tokens.mjs` 守住）；腾讯地图 / 天地图样式对象、data: URI、canvas 这类不认 CSS 变量的地方用 `ui/theme.js` 的 `tokenColor('--x')` 在绘制时取实际值
- 新增模块要同步改 `build.mjs` 的 `APP_FILES` 和 `tools/test-modules.mjs` 的同一份列表

### 算法层必须是纯函数

`src/app/algo/*` **不得引用任何界面全局**（`state` / `PV` / `CH` / `DATA` / DOM）。数据经 `data` 传入、用户参数经 `input` 传入，目的是让安卓/iOS 原样复用同一份算法。`tools/test-modules.mjs` 守住这条。

```js
solve(input, data)                                 // 算法层唯一入口 → {rows,byA,byB,byC,...} 或 {err}
enumPaths(adj, src, dst, maxHops, cap, weightOf)   // 展开顺序由调用方给权重函数
tariffOf(e, fromCode) / sendFeeOf(e, fromCode)     // 按行进方向取值（反向取 tRev / sendFeeRev）
```

界面层用 `algoData()`（`src/app/data.js`）组装 `{CH, PV, SEC, RG, REGION_OF, geo, name}`。

### 计价模型

```
D = 工程计费通过率 × 所选区域环节通过率（每区域一次）
E = 省内网损另计时 1/D × ρ送/(1−ρ送)，否则 0
A = 1 + lossBearer × (1/D − 1) + E
F = 未含的起点送出费 × 首段入口系数 + Σ 工程价 × 工程出口系数 + Σ 区域价 × 区域出口系数
border = pGen × A + F
landed = includeDstCost ? border/(1−ρ受) + pNet + fund (+cap +sysOp) : border
maxSourceQuote = (pDst − F)/A            // 别名 senderNet，语义是「可接受送端报价」，不是利润
```

⚠️ **界面默认口径与算法层缺省不同，改任何一侧都要想清楚**：界面默认 `originLossMode=separate`、`regionLossMode=historical`（2026-09-17 起，依据长三角 2026 细则第三十六条）；算法层未传字段时仍为 `included` / `exclude`，回归基线也固定在后者生成，所以改界面默认值不会动基线数字。

- 每段输电费按**段后电量**计（现货规则 4.3.1），本段自身损耗不放大本段费用
- 共用交流接口不单独收费、不逐接口计损；区域费与区域网损按区域归集一次；`incLoss=true` 的工程不重复计损；送出省费只在交易起点计一次
- `qty` 是节点交付量；到户时 `consumerQty = qty×(1−ρ受)`，`yuan.total/amountQty = landed`，**不能把到户单价直接乘节点电量**
- 业务侧完整讲解见 `docs/10-跨省交易费用计算教程.md`，公式与算例可逐项复算

### 数据契约里的三个坑

`shared/app-data.json` 顶层键：`ST` `CH` `SEC` `PV` `RG` `RGOF` `RLOSS` `VALIDITY` `CAP` `VT` `SRCX` `NIC`，完整定义见 `docs/03-数据接口说明.md`。

1. **`CH[].pricePending`（南网 5 条物理直流）建边但一律不参与路径枚举**——纳入会按 0 元过网费产出价格虚低的错误方案。端侧必须同样处理，不能当免费通道
2. **`PV[].fund` 可能为 `null`**（当前仅西藏）。必须按「缺失」提示用户，**不要静默当 0**，那会低估落地成本
3. **两端 `priceVersion` 不一致时不要混用数据**；`dataHash` 校验完整性

`CH[].tier` 分 `gov`（发改委核定）/ `grid`（国网披露）/ `region`（区域或送出省口径），路径含非 `gov` 段时界面要主动告警。

## 高频陷阱

1. **网损是乘法项，不能直接当边权。** 送达系数 `D = Π(1−ηᵢ)`，所以分两步：先用线性近似权重枚举候选，再按乘性公式精确重算并重排。
2. **路径唯一标识用节点序列** `nodes.join('>')`，不能用边的 `from`/`to`——反向通行的联络线存储方向与行进方向相反，用边拼键会把 `A→B→C` 与 `C→B→A` 误判为同一条。
3. **通道方向逐条由数据 `bidir` 给定，用到方向的地方都要按实际行进方向取值。** 单向直流只按核定方向；德宝、青藏、长南荆、辛洹、灵宝、高岭、云霄经公开报道证实双向；联络线双向。曾经「全部双向」和「专项工程全部单向」两种做法都出过错，必须逐条核对。
4. **枚举要逐层加深，不能单次深度优先。** 跳数上限 `MAX_HOPS=10`（界面固定取上限），绕行不限。单次 DFS 在 `ENUM_CAP=800` 处会被零费用的区域联络线排列占满，直达专项工程反而进不了候选集（2026-09-17 四川→江苏漏掉锦苏直流，"最低价"排出 7 省绕行）。
5. **输出目录不能用 `dist/`**——发布工具把它当构建产物排除，站点会 404。本项目用 `shared/`。
6. **842 号附件的单位是「元/千千瓦时」**，数值上等于 元/MWh，不要误按「分/千瓦时」再乘 10。
7. **两栏布局（900–1279px）下 `.col-side` 必须 `grid-row:1/3`**，三栏断点（≥1280px）复位为 `1`；改 `.layout` 后跑 `tests/e2e.mjs` 的 `R-04`。

## 界面与设计系统（移动端优先）

**这是以手机为主的 app**：安卓 WebView 壳是主要形态，Web 只作辅助。完整规范见 `docs/12-设计系统与界面规范.md`，可视化设计系统（色板、组件预览、品牌书）见 <https://claude.ai/artifact/AnZvVZEak5xQW2uPqGuZMp>。两者冲突时，以规范文档和 `src/tokens.css` 为准。

- **390px 先行。** 基础 CSS 就是手机形态，600 / 900 / 1280px 只向上覆盖；验收先看 390px 截图。
- **只用令牌。** 颜色、阴影、圆角只在 `src/tokens.css` 写值，样式与脚本写 `var(--x)`。地图 SDK 样式、data: URI、canvas、快照这些不认变量的地方，在绘制时用 `ui/theme.js` 的 `tokenColor()` 取值，切主题后要重绘（`renderMap()`）。
- **三套主题。** `<html data-theme>` 取 `clear`（默认，浅）/ `clear-dark` / `tech`（科技·调度大屏，固定深色）。页头「外观」切换，存 `iproute.v2.ui`；`<head>` 内联脚本首帧设定，避免闪白。新主题 = `src/tokens.css` 里一个覆盖块，**每个颜色令牌都要给值**；组件样式不改，但 `ui/theme.js` 的主题解析、`<head>` 内联脚本、`ui-shots.mjs` 的主题表、外观面板选项也要同步（清单见规范 §2.2）。
- **可读性底线（守卫会检查三套主题）：**
  - 文字 ≥4.5:1，输入框边框 ≥3:1；登记在案的例外只有清晰浅色的两个源码原值：`map-label`（2.66:1）和 `region-arrow`（2.94:1，箭头字形）。
  - CSS 最小字号 10.5px。
  - 可点区域 ≥44px，外观小的控件用透明伪元素扩大点击区。
  - 状态不能只靠颜色表达。
- **新字号、新颜色先进设计系统。** 先定语义名、三套主题都给值，再改守卫的白名单；不要为了让守卫变绿直接加值。
- **改界面必须出截图。** 用 `tools/ui-shots.mjs` 截改前改后：纯重构必须 `--compare` 零像素差异；有意的改动要逐张看三套主题（`--theme clear|clear-dark|tech`）。
- **文案规则**（详见规范第 9 节）：缺数显示「—」，绝不写 0；来源档次只用四个固定说法（`TIER`）；不用 emoji；免责声明原文不动。
- **平台壳。** 安卓用 `values-night` 跟随系统明暗；app 内切风格时通过 `IPRouteShell.setSystemBars(hex, lightIcons)` 同步系统栏，这个桥**只允许改颜色**（页面会加载第三方地图脚本）。iOS 跟随系统，同名桥接待补（见 `ios/ROADMAP.md`）。
- **底图限制。** 深色主题下，腾讯地图 / 天地图的底图本身仍是浅色（要改需在平台侧配个性化样式）；内置拓扑图完全跟随主题。

## 纪律（最高优先级）

1. **不得编造费率数值。** 找不到就写 `null` 并记录已检索路径。一个编造的费率比一个缺失的费率危害大得多。容量同理——ATC 我国不公开，宁可标「未获取」。
2. **价格只有一处来源**：`data/fixed-prices.json`，改完跑 `node tools/build.mjs`。
3. **费率必须分档标注来源**，不得把国网报备价与发改委核定价混为一谈。
4. **改动算法后必须跑基线**，`node tools/baseline-check.mjs` 全绿才算完成（条数以脚本输出为准）。基线只证明实现未漂移、不证明费率数值正确——校验前会用基线快照覆盖 `CH`；费率正确性靠 `audit-fees.mjs` / `audit-voltage-tariffs.mjs` 与一手原件。基线变更须 `node tools/baseline2.mjs --accept` 显式接受。
5. **新功能开新 worktree + 新分支**，不在 `main` 工作区直接改：`git worktree add .claude/worktrees/<分支名把/换成-> -b feat/<名字> origin/main`（`.claude/worktrees/` 已在 `.gitignore`；旧的 `.worktrees/` 约定作废，存量随各自 PR 合并自然消亡；该目录多会话共享，收尾只 `git worktree remove` 自己那一个）。多个 worktree 同时跑 e2e 时 8734 端口会冲突，用 `E2E_BASE=http://127.0.0.1:<私有端口>/` 指向自己的静态服务。**不在功能分支上跑 `release.mjs`**——`tools/push-github.mjs` 把分支写死为 `main`，会把未合并的改动推到远端。
6. **数据准确性优先于界面与新功能。** 数据分支阻塞时先审、先修、先合并，再动功能。
7. **大改动完成后同步 Slack。** 功能落地、数据/费率更新、发版、重要修复、阶段收尾等大改动**完成且验证通过后**，向 Slack 频道 **#跨省电力小程序**（channel_id `C0C23DYR0S0`，私有频道，用 ID 直发）发一条通知：**list 列表、简洁，每条一句话说清干了什么**，中文，不等用户催。详见 `AGENTS.md`。
8. **界面改动按设计系统纪律走**：只用令牌、390px 截图验收、三套主题过对比度，流程与 PR 自查清单见 `docs/12-设计系统与界面规范.md` 第 13–14 节；合并后同步设计系统 Artifact（在 Claude Code 里说「按最新代码重新同步设计系统」）。

## 底图与合规

只用监管白名单内的底图：**腾讯地图**（默认，走本地代理、免密钥）与**天地图**（用户自行粘贴 tk）。

- 代码中不内嵌任何有效地图密钥；`_TMapSecurityConfig` 的 `__WB_HTTP_PORT__` / `__WB_TMAP_SECRET__` 占位符原样保留
- 不使用 Google / Apple / Bing 海外版 / OpenStreetMap / Mapbox / Leaflet；省界由底图负责，应用不自绘行政区划
- 腾讯地图依赖预览环境注入的本地代理，安卓/iOS 里不存在该代理，网架图**按设计降级为内置 SVG 拓扑图**
- `tools/baseline2.mjs` 末尾的「底图合规检查」守住这些约束

## 推送与远端

`git fetch` / `pull` / `ls-remote` / `push` 当前可直接使用（本机代理已放行 `github.com`；2026-07-16 之前只能走 API，`CODEBUDDY.md` 里"git push 不可用"的说法已过时）。`tools/push-github.mjs` 仍保留，走 GitHub Git Data API：

- 它用 `base_tree` **在远端现有树上叠加**本地文件，而不是重建整棵树——后者在多会话并行时会删掉别人推送的内容（2026-09-14 真实误删过 18 个文件）
- **改文件名 = 新增 + 遗留旧文件**，确认新旧 blob sha 相同后用 `--allow-delete` 清理
- `git ls-files` 默认对中文路径做八进制转义，脚本读文件会 ENOENT，**必须用 `git -c core.quotepath=false ls-files`**

线上部署是本机目录的**快照**、且是**叠加式**的：改完要重新发布才生效，仓库里删掉的文件线上可能仍有残留。偶发「3000 端口未就绪」直接重试一次。

## 已知缺口（不要假装它们不存在）

ATC、省内重要输电通道清单与限额、交易路径集合、西藏基金及附加均未获取；断面限额来自公开报道与文献、不是运行限额；省间联络线一律不填估算容量（`cap=null`，界面显示"容量待补"、不做容量校验）。完整清单与检索路径见 `docs/gaps.md`，未实现的想法见 `docs/改进计划.md`。

## 文档地图

| 文档 | 内容 |
|---|---|
| `docs/开发约定与操作手册.md` | ★ 接手必读：纪律、踩坑清单、推送机制 |
| `docs/12-设计系统与界面规范.md` | ★ 改界面必读：令牌与三套主题、可读性底线、文案规则、平台壳、改界面标准流程与 PR 自查清单 |
| `docs/10-跨省交易费用计算教程.md`（含 PDF） | ★ 业务侧必读：七层费用、统一公式、现货折算与出清，含可复算算例 |
| `docs/03-数据接口说明.md` | ★ Web/端侧共用的数据契约与字段定义 |
| `docs/09-算法模型与收费标准审计.md` | 公式来源、全国审查、可复算数字与不可认证范围 |
| `docs/gaps.md` / `docs/sources.md` / `docs/费率核实报告.md` | 数据缺口、来源清单、逐条核实结论 |
| `docs/原始文件/` | S01～S34 一手原件，可离线核对每一个费率 |
| `docs/regression-baseline-v2.json` | 算法数值基线（2026-09-18 实测 425 省对 / 987 条；端侧移植也必须对它跑） |
| `docs/11-数据与功能独立复核报告（2026-09-18）.md` | 独立复核：1011 项数据核对 + 91 条功能发现，P0/P1/P2 修复清单 |
| `docs/01-安卓开发框架.md` / `ios/README.md` | 端侧路线与工具链 |

**定价规则谱系**：`〔2017〕2269号` → `〔2021〕1455号` → **`〔2025〕1490号`（现行）**。引用条款要用现行版本，1455 号已废止。
