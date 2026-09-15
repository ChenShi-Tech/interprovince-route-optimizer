# 阶段 0 · 环境与基线

> 周期：1–3 天 ｜ 里程碑：**M0 · 可跑** ｜ 前置：无

---

## 一、核心目标

把三件现在还是"感觉应该没问题"的事，变成今天就有结论：**能不能编译、能不能出包、能不能装上真机。**

阶段 0 不写业务代码。它的产出是**一条可回退的工具链基线**，以及一个能在真机上冷启动成功的空白工程。这一步做完，后面所有工作才有参照物。

---

## 二、关键技术点与所需技能

### 2.1 Xcode 工具链管理

| 技能 | 具体要求 |
|---|---|
| 版本并存 | 保留 Xcode 26.6 作为可发布基线，Xcode 27 并行安装，各自独立 DerivedData |
| 版本核验 | `xcode-select -p`、`xcodebuild -version`、`xcrun --sdk iphoneos --show-sdk-version`、`swift --version` 四条命令必须都会用并能解释输出 |
| 单次指定 | `DEVELOPER_DIR=/Applications/Xcode-27.app/Contents/Developer xcodebuild ...`——避免全局切换影响另一条仍在发版的链路 |
| 门槛认知 | Xcode 27 要求 macOS Tahoe 26.6+；Xcode 27 支持对 iOS 17+ 设备真机调试 |

### 2.2 签名三件套

必须理解这三者如何组合，否则后面所有分发环节都会卡住：

| 组件 | 作用 |
|---|---|
| **Certificate**（证书） | 标识开发者或组织身份，分 Development / Distribution 两类 |
| **App ID**（Bundle ID） | 应用的唯一标识，绑定服务与配置 |
| **Provisioning Profile**（描述文件） | 把证书 + App ID + 设备 UDID 组合成一个文件。Ad Hoc 与 Development 的描述文件列出允许运行的设备 |

**Bundle ID 规划**：安卓端用 `com.iproute.calc`。iOS 建议 `com.chenshi.iproute`（若走组织账号则须体现组织域名）。两端不必相同，但若将来做 App 备案，需在备案表中分别填报各自的包名 / Bundle ID。

### 2.3 Apple Developer 账号（见总纲 D1）

零成本起步的做法：**普通 Apple ID 也能真机调试**，只是签名 7 天失效、且不能用推送等能力。**先用免费账号把"空白工程上真机"跑通，再决定是否入会**——这样组织账号的 1–4 周审核期不会阻塞你熟悉环境。

### 2.4 磁盘与工具准备

本机可用 91 GB。Xcode 27 的 dmg 是 2.85 GB，安装后带模拟器 runtime 约 30–40 GB。

**只装需要的那一个 iOS 模拟器 runtime，不要装全家桶**（watchOS / tvOS / visionOS 对本项目无意义）。

---

## 三、交付物

1. **一份工具链留档**——记录并存档以下命令的原始输出：
   ```bash
   xcode-select -p
   xcodebuild -version
   xcrun --sdk iphoneos --show-sdk-version
   swift --version
   sw_vers
   ```
2. **一个空白 SwiftUI 工程**，落在 `ios/app/`，包含：正确的 Bundle ID、Team、签名配置，能在模拟器与真机各冷启动一次。
3. **关于 Apple Developer 账号类型的书面决议**（个人 or 组织），若选组织则同步启动 D-U-N-S 申请。

---

## 四、验收标准

| 项 | 判定 |
|---|---|
| 工具链可复现 | 上述四条命令输出已验证并存档，版本号与本文档一致 |
| 真机可跑 | 空白工程在真机冷启动成功，有截图 |
| 可回退 | Xcode 26.6 仍可正常 `archive`（不被 Xcode 27 的安装破坏） |
| 账号决议落地 | 账号类型已确定；若选组织，D-U-N-S 申请已提交 |

---

## 五、风险

| 风险 | 应对 |
|---|---|
| 升级 macOS 后旧 Xcode 行为变化 | 升级自成一步，不与业务代码改动混做；升级前先确认 Xcode 26.6 的可发布归档已被保留 |
| 磁盘不足导致安装中断 | 升级前清理，预留 40 GB；只装单个模拟器 runtime |
| 组织账号审核超期 | 先用免费 Apple ID 推进阶段 1–2 的编码，审核并行 |
| 证书绑在个人 Apple ID 上 | 一开始就用组织账号，避免后期迁移 |

---

## 六、下一步

进入 [阶段 1 · Swift 与界面基础](./phase-1-Swift与界面基础.md)。
