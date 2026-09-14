# 安卓壳工程（WebView 打包）

把根目录的自包含 `index.html` 原样打包为安卓应用，不改动任何网页代码。
对应 `docs/01-安卓开发框架.md` 的"WebView 复用"路线（一期快速分发用）；RN 重写按该文档迁移路径另起工程。

## 打包（本机已配置便携工具链）

```bash
node android/build-apk.mjs        # 构建 index.html → 拷入 assets → gradle assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`（同时复制一份 `android/省间路径优选-v1.0-debug.apk` 便于分发）。

工具链位置：`~/android-toolchain/`（便携版 JDK 17 + Gradle 8.7 + Android SDK，免安装、免管理员，
`build-apk.mjs` 自动探测并注入 `JAVA_HOME`，不依赖系统环境变量）。

在新机器上重建工具链：
1. 下载 Temurin JDK 17 / Gradle 8.7 / Android cmdline-tools 三个 zip 解压到 `~/android-toolchain/`
   （cmdline-tools 需布成 `sdk/cmdline-tools/latest/`）；
2. `echo 24333f8a63b6825ea9c5514f83c2829b004d1fee > sdk/licenses/android-sdk-license`；
3. `sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"`；
4. 修改 `local.properties` 的 `sdk.dir` 指向本机 SDK。

## 安装到手机

APK 为 debug 签名（首次构建自动生成于 `~/.android/debug.keystore`），可直接侧载：
把 `省间路径优选-v1.0-debug.apk` 发到手机（钉钉/微信/数据线），点开安装（需允许"安装未知应用"）。
无 adb 依赖；如已开 USB 调试也可 `adb install android/省间路径优选-v1.0-debug.apk`。

### 真机验收要点

1. 桌面出现"省间路径优选"图标（蓝底输电塔），点击全屏打开即出测算页（四川→江苏，14 条路线卡片）；
2. 切换出发地/目的地立即重算；点卡片切换方案；
3. 费率库改价 → 徽标变"费率已本地修改"→ 杀进程重开仍保留（DOM Storage 生效的证据）；
4. 网架图 Tab 降级为文本清单属预期（无本地代理）；切天地图粘贴自己的 tk 可出真地图；
5. 完全断网（飞行模式）下前四条照常。

## 模拟器（已搭建，当前机器暂不可用）

工具链已装好：`~/android-toolchain/sdk` 下的 emulator + AVD `smoke`（API 34 x86_64）+ AEHD 驱动 2.2.0。
启动：`~/android-toolchain/sdk/emulator/emulator.exe -avd smoke -no-window -gpu swiftshader_indirect`。

**2026-09-14 排查记录**：本机 AEHD 驱动服务注册成功但无法启动（`sc start aehd` 报 -95），
模拟器软件模拟（`-no-accel`）18 分钟未完成 API 34 启动。症状指向 BIOS 未开 Intel VT-x
（`VirtualizationFirmwareEnabled=False` 且 `HypervisorPresent=False`；AEHD 不与任何运行中
hypervisor 冲突）。在 BIOS（Lenovo 开机 F1 → Security → Virtualization）确认
`Intel (R) Virtualization Technology` 为 Enabled 后，上述启动命令即可硬件加速运行（约 1 分钟）。
若 AEHD 仍失败，可改用 WHPX：管理员执行
`dism /online /enable-feature /featurename:HypervisorPlatform` 后重启。

## 边界与说明

- 应用内就是 `file:///android_asset/index.html`，WebView 已开启 JS 与 DOM Storage（费率库的 localStorage 依赖它）
- 图标为自适应图标（API 26+），故 minSdk=26（Android 8.0，2017 年起设备）
- 保留 INTERNET 权限仅为底图（天地图自备 tk）；断网时测算/费率库完全可用
- 腾讯地图的本地代理不在包内，网架图会按设计降级为文本清单；天地图路径在手机上可用
- release 正式签名、应用商店上架（需软著/备案）属于后续工作，见 `docs/01-安卓开发框架.md` 第六节
