# tools/ · iOS 侧脚本

> **当前为空。** 脚本在阶段 4 落地。

---

## 与安卓侧对称

| 本目录脚本 | 安卓侧对应 | 作用 | 阶段 |
|---|---|---|---|
| `build-ipa.mjs` | `android/build-apk.mjs` | archive + export，出 `.ipa` | 4 |
| `baseline-check.mjs` | `tools/baseline-check.mjs` | 比对 iOS 输出与回归基线 | 2 |
| `compare-cross-platform.mjs` | — | Web / 安卓 / iOS 三端输出比对 | 2 |
| `gen-icon.mjs` | — | 生成各尺寸 AppIcon | 3 |

---

## 脚本纪律

1. **复杂命令一律写成 `.mjs` 文件再执行。** 不要在 `node -e` 里嵌套多层引号——本仓库已有多次因引号转义失败而返工的先例。

2. **构建脚本必须打印并可复现以下信息**：

   ```
   Xcode 版本与完整 build 号
   iOS SDK 版本
   swift --version
   使用的 ExportOptions 与签名类型
   ```

   同名镜像更新后，光看版本号是无法复现的——**完整 build 号是唯一可靠的标识**。

3. **Archive / Export / 安装 / 上传是四个不同环节**，脚本要能分别执行。本地 Debug 成功不足以证明发布链路完整。

4. **脚本失败时不要用"关闭警告"或"跳过步骤"把红灯变绿。** 先判断是编译器诊断变化、SDK API 变化、脚本路径变化，还是第三方二进制不兼容。

---

## 出包脚本骨架

```bash
# 1. Archive
xcodebuild archive \
  -project app/InterprovinceRoute.xcodeproj \
  -scheme InterprovinceRoute \
  -configuration Release \
  -archivePath build/InterprovinceRoute.xcarchive

# 2. Export（method 决定签名类型：ad-hoc / app-store / development）
xcodebuild -exportArchive \
  -archivePath build/InterprovinceRoute.xcarchive \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath build/ipa
```

**多 Xcode 版本并存时，用 `DEVELOPER_DIR` 单次指定，不要做全局切换**——否则会突然影响另一条仍在发版的链路。

---

## 回归对照脚本

iOS 侧的回归与 Web 侧用同一组输入、同一个预期结果：

- 输入：`docs/regression-baseline-v2.json`（503 省对 / 1739 路线）
- 比对字段：路径节点序列（**完全一致**）、落地成本 / 过网费 / 送端净收益 / 送达系数（容差 `1e-4`）
- 输出：不一致项的清单，含省对、路径、字段、期望值、实际值、偏差

**差异报告要能直接定位到"从哪一段开始分歧"**，只报"不一致"等于没报。
