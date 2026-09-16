# InterprovinceRoute · WKWebView 壳工程（路线 A）

> 把自包含 `index.html` 装进 WKWebView 的壳。与安卓壳同构：本地加载、离线可用、无远程依赖。
> 按钮文案、Bundle ID、工程名均按 `ios/app/README.md` 的创建规范执行。
> **工程在 Windows 侧编写，未经 xcodebuild 实际编译**——首次在 Mac 打开如有告警，见下方「兜底方案」。

## 工程结构

```
InterprovinceRoute/
├── InterprovinceRoute.xcodeproj/project.pbxproj   手写工程（objectVersion 56 / Xcode 14+）
├── project.yml                                    xcodegen 兜底配置（重新生成 pbxproj 用）
└── InterprovinceRoute/
    ├── ShellView.swift                            WKWebView 壳 + @main 入口（仅 ~30 行）
    └── index.html                                 Web 构建产物（node ios/sync-web.mjs 同步）
```

关键取值：Bundle ID `com.chenshi.iproute` · 显示名「省间路径优选」· 最低 iOS 17 · 仅 iPhone 竖屏 · 版本 1.1。

## 更新 Web 内容（任何平台）

改完 `src/` 后在本仓库根目录执行：

```bash
node ios/sync-web.mjs     # 重建 index.html 并拷入壳工程
```

## 在 Mac 上出 .ipa

前提：macOS + Xcode 15+、Apple Developer 账号并已在 Xcode 登录（账号类型待 ROADMAP D1 拍板前可先用个人账号出开发包）。

```bash
cd ios/app/InterprovinceRoute

# 1) 归档（真机目标；首次会要求在 Xcode 里选择 Team 签名）
xcodebuild -project InterprovinceRoute.xcodeproj -scheme InterprovinceRoute \
  -configuration Release -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates archive -archivePath build/InterprovinceRoute.xcarchive

# 2) 导出 .ipa（Ad Hoc / 开发者直装示例；TestFlight 用 app-store-connect 方法）
cat > build/ExportOptions.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>ad-hoc</string>
  <key>teamID</key><string>你的TeamID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>stripSwiftSymbols</key><true/>
</dict></plist>
EOF
xcodebuild -exportArchive -archivePath build/InterprovinceRoute.xcarchive \
  -exportOptionsPlist build/ExportOptions.plist -exportPath build/

# 产物：build/InterprovinceRoute.ipa
```

或直接双击 `InterprovinceRoute.xcodeproj` 用 Xcode 图形界面：选 Team → Product ▸ Archive → Distribute App。

## 兜底方案（pbxproj 打不开时）

本工程的 `project.pbxproj` 为手写。若 Xcode 提示格式问题，装 [xcodegen](https://github.com/yonaskolb/XcodeGen) 后在本目录执行 `xcodegen generate`，即由 `project.yml` 重新生成等价工程（文件清单一致）。

## 已知边界（与安卓壳一致的合规设计）

- **代码中不内嵌任何地图密钥**；天地图 tk 由用户在应用内自行粘贴（仅存本机 localStorage）。
- file:// 环境无腾讯地图本地代理，底图自动降级为内置 SVG 拓扑图——这是应用内既定设计，不是缺陷。
- WKWebView 的 file:// 源下 localStorage 一般可用；应用所有持久化均有 try/catch 兜底，异常时不影响测算。
- 无 App Icon 资产目录，出包用默认图标；上架前需补（阶段 4）。
