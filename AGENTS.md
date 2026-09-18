# AGENTS.md

跨工具协作纪律入口（Claude Code / Codex / CodeBuddy 等通用）。深度指南见 [CLAUDE.md](./CLAUDE.md)（架构、高频陷阱、完整命令）与 [CODEBUDDY.md](./CODEBUDDY.md)（背景长文）。**三份文件同一套口径，改事实性内容须互相同步。**

## 协作纪律（最高优先级）

1. **不得编造费率数值**：找不到就写 `null` 并记录已检索路径；价格只有一处来源 `data/fixed-prices.json`；费率必须分档标注（`tier`），报备价与发改委核定价不得混为一谈。
2. **数据准确性优先于界面与新功能**：数据分支阻塞时先审、先修、先合并，再动功能。
3. **大改动完成后同步 Slack**：功能落地、数据/费率更新、发版、重要修复、阶段收尾等大改动**完成且验证通过后**，向 Slack 频道 **#跨省电力小程序**（channel_id `C0C23DYR0S0`，私有频道，搜索不到，用 ID 直发）发一条通知——**list 列表、简洁，每条一句话说清干了什么**，中文，不等用户催。
4. **新功能开新 worktree + 新分支**，不在 `main` 工作区直接改；不在功能分支上跑 `release.mjs`（其推送目标写死 `main`）。

## 工程红线（速览，详见 CLAUDE.md）

- **不要手改构建产物**：`index.html`、`shared/app-data.json(.min)`。改价 → `data/fixed-prices.json`；站点/断面 → `src/extra.json`；界面 → `src/template.html` 与 `src/app/`。
- `src/app/*.js` 非 ES 模块，按 `build.mjs` 的 `APP_FILES` 顺序拼接，`boot.js` 必须最后；`src/app/algo/*` 必须是纯函数，不得引用界面全局。
- 底图只用监管白名单（腾讯 / 天地图 / 高德 / 百度），代码不得内嵌任何有效地图密钥，`_TMapSecurityConfig` 占位符原样保留，不自行绘制行政区划。
- 提交用中文 conventional commits。

## 验证

```bash
node tools/build.mjs               # 构建
node tools/baseline-check.mjs      # 基线全绿才算完成（条数以脚本输出为准；基线变更用 baseline2.mjs --accept 显式接受）
node tools/release.mjs "提交信息"   # 一键发版：构建 → 8 组测试 → 审计 → 提交推送（仅 main 上跑）
```
