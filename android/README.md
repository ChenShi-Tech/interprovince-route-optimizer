# 安卓壳工程（WebView 打包）

把根目录的自包含 `index.html` 原样打包为安卓应用，不改动任何网页代码。
对应 `docs/01-安卓开发框架.md` 的"WebView 复用"路线（一期快速分发用）；RN 重写按该文档迁移路径另起工程。

## 打包（本机已配置便携工具链）

```bash
node android/build-apk.mjs        # 构建 index.html → 拷入 assets → gradle assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`（本机自测用；对外分发的包由发版流水线产出，见下节）。

工具链位置：`~/android-toolchain/`（便携版 JDK 17 + Gradle 8.7 + Android SDK，免安装、免管理员，
`build-apk.mjs` 自动探测并注入 `JAVA_HOME`，不依赖系统环境变量）。

在新机器上重建工具链：
1. 下载 Temurin JDK 17 / Gradle 8.7 / Android cmdline-tools 三个 zip 解压到 `~/android-toolchain/`
   （cmdline-tools 需布成 `sdk/cmdline-tools/latest/`）；
2. `echo 24333f8a63b6825ea9c5514f83c2829b004d1fee > sdk/licenses/android-sdk-license`；
3. `sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"`；
4. 修改 `local.properties` 的 `sdk.dir` 指向本机 SDK。

## 发版自动打包（南洋 CI）

对外分发的 APK **只在发布 GitHub Release 时打包**，普通提交与合并请求不打包。
工作流 `.github/workflows/android-release.yml`，跑在南洋自托管 runner `irp-nanyang-1`（label `irp-linux`）。

发版步骤：

1. 发版提交里改 `android/app/build.gradle`：`versionName` 与标签一致（去掉 `v`），`versionCode` +1，合入 `main`；
2. 发布 Release，标签 `vX.Y.Z`：`gh release create vX.Y.Z --target main --title "…" --notes "…"`
   （网页上只保存草稿不触发，点「Publish release」才触发）；
3. 工作流依次：标签与 `versionName` 一致性 → 工具链检查 → 构建 + 7 组测试 → 打包 → 签名核验 →
   把 `iproute-vX.Y.Z-debug.apk` 与 `.sha256` 挂到该 Release（同名文件覆盖）；
4. 失败后补打包：Actions → android-release → Run workflow，填已发布的标签；
   勾选 `dry_run` 则只打包、在运行摘要里给出签名指纹，不改动 Release 附件（验证流水线或核对签名时用）。

注意：

- **不要再在本机打包后手动上传**——同名文件会被 CI 覆盖，且各机器的 debug 签名密钥不同。
- **签名连续性**：仓库变量 `ANDROID_SIGNER_SHA256` 设为约定签名证书的 SHA-256 指纹后，签名对不上的 APK 会被拦下不上传
  （手机上已装旧版的无法覆盖升级，只能卸载重装并丢失本地数据）；未设置时只告警。
  指纹写 apksigner 输出的 64 位十六进制即可，keytool 的大写带冒号写法也兼容。
- ⚠️ **v1.1.0～v1.1.5 是协作者本机 debug 密钥签的，与南洋密钥不同。** 签名方案拍板并设好上面的变量之前不要发新版；
  若决定改用新密钥，首个 CI 版本的 Release 说明里必须写明「已装用户需卸载重装（本地费率修改、地图与模型密钥会丢）」。
- 标签只支持 `vX.Y.Z`；预发布（pre-release / rc 标签）发布时工作流会报格式错误、不出包。
- **补打包已有附件的标签会覆盖原 APK**：签名不同就等于换包，先用 `dry_run` 核对签名。
- 用 `GITHUB_TOKEN` 在别的工作流里创建的 Release 不会触发本工作流（GitHub 防递归），发版须由人发布。

南洋工具链位于 runner 用户 `irp-runner` 的 `~/android-toolchain/`（Temurin JDK 17 + Gradle 8.7 +
SDK `platform-tools` / `platforms;android-34` / `build-tools;34.0.0`），签名密钥为该用户的 `~/.android/debug.keystore`。
重装按上面「在新机器上重建工具链」前三步以 `irp-runner` 身份执行；SDK 路径由工作流注入 `ANDROID_HOME`，无需 `local.properties`。

## 安装到手机

APK 为 debug 签名（首次构建自动生成于 `~/.android/debug.keystore`），可直接侧载：
从 GitHub Release 下载 `iproute-vX.Y.Z-debug.apk`（本机自测则用 `app-debug.apk`）发到手机（钉钉/微信/数据线），
点开安装（需允许"安装未知应用"）。无 adb 依赖；如已开 USB 调试也可 `adb install iproute-vX.Y.Z-debug.apk`。

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
