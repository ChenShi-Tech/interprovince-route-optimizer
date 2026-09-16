// 一键打包安卓 APK：node android/build-apk.mjs
// 流程：重新构建 index.html → 拷入 WebView assets → gradle assembleDebug
// 产物：android/app/build/outputs/apk/debug/app-debug.apk
// 依赖：~/android-toolchain 下的便携版 JDK 17 与 Gradle 8.7（见 docs/01-安卓开发框架.md 的本地方案）
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tc = path.join(os.homedir(), 'android-toolchain');
const gradleBin = path.join(tc, 'gradle-8.7', 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle');
const jdkDir = fs.readdirSync(tc).find(d => /^jdk-17/.test(d));
if (!jdkDir) throw new Error('未找到 ~/android-toolchain/jdk-17*，请先按 android/README.md 安装工具链');
const javaHome = path.join(tc, jdkDir);

const env = { ...process.env, JAVA_HOME: javaHome, PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH}` };
const run = (cmd, cwd) => execSync(cmd, { cwd, env, stdio: 'inherit' });

console.log('① 构建自包含 index.html …');
run('node tools/build.mjs', root);

console.log('② 拷入 WebView assets …');
const assetDir = path.join(root, 'android', 'app', 'src', 'main', 'assets');
fs.mkdirSync(assetDir, { recursive: true });
fs.copyFileSync(path.join(root, 'index.html'), path.join(assetDir, 'index.html'));

console.log('③ gradle assembleDebug（首次运行会下载依赖，需数分钟）…');
run(`"${gradleBin}" clean assembleDebug --no-daemon`, path.join(root, 'android'));

const apk = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
console.log(`\n✅ APK 已生成: ${apk} (${(fs.statSync(apk).size / 1024 / 1024).toFixed(2)} MB)`);
