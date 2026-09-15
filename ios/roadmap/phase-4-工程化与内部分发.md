# 阶段 4 · 工程化与内部分发

> 周期：1–2 周 ｜ 里程碑：**M4 · 可用** ｜ 前置：阶段 3 完成

---

## 一、核心目标

让交易员在 iPhone 上**装得上、用得着、能升级**。

安卓那边一条 `node android/build-apk.mjs` 出个 APK 就能侧载，iOS 没有这么便宜的事——**必须过签名与分发渠道**。这一阶段的全部技术含量都在这里。

---

## 二、关键技术点与所需技能

### 2.1 出包链路

```bash
xcodebuild archive -project app/InterprovinceRoute.xcodeproj \
  -scheme InterprovinceRoute -configuration Release \
  -archivePath build/InterprovinceRoute.xcarchive

xcodebuild -exportArchive -archivePath build/InterprovinceRoute.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/ipa
```

要点：

- `ExportOptions.plist` 里的 `method` 决定签名类型（`ad-hoc` / `app-store` / `development`）；
- **Archive、Export、安装、上传是不同的环节**，本地 Debug 成功不足以证明发布链路完整——每一环都要单独验证；
- 脚本落在 `ios/tools/`，与 `android/build-apk.mjs` 对称。

### 2.2 分发方式对比（已核准事实）

| 方式 | 规模上限 | 有效期 | 需审核 | 成本 |
|---|---|---|---|---|
| **Ad Hoc** | **100 台 / 产品家族 / 年** | 1 年 | 无 | $99/年 |
| **TestFlight 内部** | **100 人**（App Store Connect 成员） | 90 天 / 构建 | **无需审核** | $99/年 |
| **TestFlight 外部** | 10,000 人 | 90 天 / 构建 | 首个构建需 Beta 审核 | $99/年 |
| **企业证书 In-House** | 不限设备 | 1 年 | 无 | **$299/年**，仅限内部员工，滥用即吊销 |

**推荐：TestFlight 内部测试为主，Ad Hoc 兜底。**

理由：

- TestFlight 内部**不需要收集 UDID**，也不需要审核，交易员在手机上装个 TestFlight 就能收到更新——这是 Ad Hoc 做不到的体验；
- Ad Hoc 的 100 台限额是**按产品家族每年重置**，一旦用满，年内无法再加设备，且每次加设备都要重新出包。它适合"几个核心用户先试"，不适合推广；
- **企业证书不要碰。** $299/年买的是"不限设备"，代价是 Apple 明确要求只能发给员工或正式合作方。一旦被判定分发到组织外，**证书会被吊销，所有装了的设备上的 App 立刻全部失效**——对一个要拿去和交易对手谈判的工具，这是不可接受的风险。

### 2.3 OTA 安装（Ad Hoc 兜底用）

需要一份 HTTPS 托管的 `manifest.plist`，安装链接形如 `itms-services://?action=download-manifest&url=...`。iOS 会要求用户手动信任描述文件，**安装说明必须写清这一步的点击路径**，否则会被当成"装不上"。

### 2.4 隐私清单

`PrivacyInfo.xcprivacy`：**自 2024-05-01 起，触碰 Apple "required reason" API（含 `UserDefaults`、文件时间戳等常见项）而缺失隐私清单，上传会直接失败。** 自 2025-02-12 起，涉及隐私的第三方 SDK 也必须自带清单。

### 2.5 升级提示

启动时比对版本号，提示升级。与安卓侧同一套逻辑。

---

## 三、交付物

1. **`ios/tools/build-ipa.mjs`**（或 shell 脚本）：一键 archive + export；
2. **`.ipa` 产物** + 分发渠道配置；
3. **安装说明文档**：含 TestFlight 邀请路径、Ad Hoc 描述文件信任路径，配截图；
4. **升级提示逻辑**；
5. **`PrivacyInfo.xcprivacy`**。

---

## 四、验收标准

| 项 | 判定 |
|---|---|
| **真实用户可装** | 找一个**非开发者身份**的同事，按说明在 5 分钟内装上并打开成功 |
| 离线 | 开飞行模式启动，路径测算与费率库完全正常 |
| 地图降级 | 地图页不得空白（回落内置拓扑图） |
| 版本一致 | 费率库页显示的 `priceVersion` 与 Web 版一致 |
| 升级 | 出一个新版本，旧版本能收到升级提示 |
| 链路完整 | Archive / Export / 安装 / 上传四个环节各有一次成功记录 |

---

## 五、风险

| 风险 | 应对 |
|---|---|
| Ad Hoc 100 台限额用满 | 以 TestFlight 内部为主渠道；Ad Hoc 只给核心用户 |
| 描述文件过期导致 App 打不开 | 提前 30 天续签；Ad Hoc 描述文件有效期 1 年 |
| TestFlight 构建 90 天过期 | 建立定期重新上传的节奏，不要等过期再出包 |
| 企业证书风险 | **不使用** |
| 隐私清单缺失导致上传失败 | 阶段 4 一并补齐；用到 `UserDefaults` 就要写 |
| 安装说明不清导致"装不上" | 验收标准就是"非开发者按说明能装上" |

---

## 六、下一步

进入 [阶段 5 · 原生化与长期演进](./phase-5-原生化与长期演进.md)。
