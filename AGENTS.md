# AGENTS.md

跨工具协作纪律入口（Claude Code / Codex / CodeBuddy 等通用）。深度指南见 [CLAUDE.md](./CLAUDE.md)（架构、高频陷阱、完整命令）与 [CODEBUDDY.md](./CODEBUDDY.md)（背景长文）。**三份文件同一套口径，改事实性内容须互相同步。**

## 协作纪律（最高优先级）

1. **不得编造费率数值**：找不到就写 `null` 并记录已检索路径；价格只有一处来源 `data/fixed-prices.json`；费率必须分档标注（`tier`），报备价与发改委核定价不得混为一谈。
2. **数据准确性优先于界面与新功能**：数据分支阻塞时先审、先修、先合并，再动功能。
3. **大改动完成后同步 Slack**：功能落地、数据/费率更新、发版、重要修复、阶段收尾等大改动**完成且验证通过后**，向 Slack 频道 **#跨省电力小程序**（channel_id `C0C23DYR0S0`，私有频道，搜索不到，用 ID 直发）发一条通知——**消息第一行带用户名前缀**（如 `【daiding】`；用户名优先问用户，确认不到取 `git config user.name`），**list 列表、简洁，每条一句话说清干了什么**，中文，不等用户催；**先问后发（硬规则）：任何消息发出前必须先把拟发全文给用户过目、得到明确同意后才能发，没有例外，每次发送前都要重新确认，用户未回应或拒绝就不发**。
4. **新功能开新 worktree + 新分支**，不在 `main` 工作区直接改：放在 `.claude/worktrees/<分支名把/换成->`（旧的 `.worktrees/` 约定作废）；不在功能分支上跑 `release.mjs`（其推送目标写死 `main`）。
5. **界面改动守设计系统纪律**（这是手机为主的 app，Web 只作辅助），规范见 `docs/12-设计系统与界面规范.md`。

## 工程红线（速览，详见 CLAUDE.md）

- **不要手改构建产物**：`index.html`、`shared/app-data.json(.min)`。改价 → `data/fixed-prices.json`；站点/断面 → `src/extra.json`；界面 → `src/template.html` 与 `src/app/`。
- `src/app/*.js` 非 ES 模块，按 `build.mjs` 的 `APP_FILES` 顺序拼接，`boot.js` 必须最后；`src/app/algo/*` 必须是纯函数，不得引用界面全局。
- 底图只用监管白名单（腾讯 / 天地图 / 高德 / 百度），代码不得内嵌任何有效地图密钥，`_TMapSecurityConfig` 占位符原样保留，不自行绘制行政区划。
- 提交用中文 conventional commits。

## 界面红线（速览，详见 docs/12-设计系统与界面规范.md）

- **手机优先**：先在 390px 宽度下设计和验收；600 / 900 / 1280px 断点只向上覆盖。
- **只用令牌**：颜色 / 阴影 / 圆角只在 `src/tokens.css` 写值，样式与脚本一律 `var(--x)`；不认变量的地方（地图 SDK、data: URI、canvas）用 `ui/theme.js` 的 `tokenColor()`。`tools/test-design-tokens.mjs` 守住这条。
- **三套主题都要过**：`clear`（默认）/ `clear-dark` / `tech`（科技·调度大屏）。新颜色令牌三套都给值；文字 ≥4.5:1、控件边框 ≥3:1、最小字号 10.5px、可点区域 ≥44px。
- **不随手加字号 / 颜色**：先进设计系统，再改守卫白名单。
- **改界面要出截图**：`node tools/ui-shots.mjs <目录> --theme <主题>` 截改前改后，`--compare` 比较；纯重构必须零像素差异。
- **文案**：缺数显示「—」不写 0；来源档次四个固定说法；不用 emoji；免责声明原文不动。
- **安卓桥 `IPRouteShell.setSystemBars` 只准改颜色**，不得扩展其它能力。

## 验证

```bash
node tools/build.mjs               # 构建
node tools/baseline-check.mjs      # 基线全绿才算完成（条数以脚本输出为准；基线变更用 baseline2.mjs --accept 显式接受）
node tools/release.mjs "提交信息"   # 一键发版：构建 → 8 组测试 → 审计 → 提交推送（仅 main 上跑）
node tools/test-design-tokens.mjs  # 设计令牌守卫（含三套主题对比度）
node tools/ui-shots.mjs <目录> --theme clear   # 界面截图（390px@2x 与 1280px）；--compare <A> <B> 逐像素比较
```
