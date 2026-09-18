# AGENTS.md

本文件是给所有 AI 编码代理（Claude Code / Codex / CodeBuddy 等）与团队成员的项目协作约定。项目背景、架构与计价模型详见 [README.md](./README.md) 与 [CODEBUDDY.md](./CODEBUDDY.md)。

## 协作纪律（必须遵守）

### 大改动完成后同步 Slack

- 任何**大的改动**（功能落地、数据/费率更新、发版、重要修复、阶段收尾）**完成且验证通过后**，必须向 Slack 频道 **#跨省电力小程序** 发送一条通知，不等用户催。
- 频道 ID：`C0C23DYR0S0`（私有频道，频道搜索搜不到，直接用 ID 发送）。
- 格式：**list 列表、简洁**——每条一句话说清干了什么，不展开细节、不写长段落，用中文。

### 数据准确性优先

- 数据分支先审、先修、先合并；数据链路被阻塞时不推进界面功能。
- 费率必须带 `tier` 分档（gov / grid / region / est）与文号溯源；报备价与发改委核定价不得混为一谈。

## 工程红线

- **不要直接改 `index.html`**（构建产物）：改价 → `data/fixed-prices.json`；站点/断面/经纬度 → `src/extra.json`；界面 → `src/template.html` 与 `src/app/`。
- 只用监管白名单底图（腾讯 / 天地图 / 高德 / 百度），代码不得内嵌任何有效地图密钥；`_TMapSecurityConfig` 的占位符须原样保留；本应用不自行绘制行政区划。
- 改费率或通道数据后先跑 `node tools/baseline2.mjs` 重建基线；完成标准是 `node tools/baseline-check.mjs` 全部通过。
- 提交信息用中文 conventional commits；不在 `main` 直接提交，先切特性分支。

## 验证

```bash
node tools/baseline-check.mjs    # 基线全通过才算完成（条数以脚本输出为准）
node tools/baseline2.mjs         # 重建基线 + 渲染冒烟 + 底图合规检查
node tools/test-data-share.mjs   # Web 与安卓端数据一致性
```
