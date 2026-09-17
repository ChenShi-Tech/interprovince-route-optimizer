// 同步 Web 构建产物到 iOS 壳工程：node ios/sync-web.mjs
// 先重建 index.html（与安卓打包同一来源），再拷入 Xcode 工程资源目录。
// 出 .ipa 仍需在 Mac 上执行（见 ios/app/InterprovinceRoute/README.md）。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'index.html');
const dst = path.join(root, 'ios', 'app', 'InterprovinceRoute', 'InterprovinceRoute', 'index.html');

console.log('① 构建自包含 index.html …');
execSync('node tools/build.mjs', { cwd: root, stdio: 'inherit' });

console.log('② 拷入 iOS 壳工程资源 …');
fs.copyFileSync(src, dst);
const hash = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(dst)).digest('hex').slice(0, 16);
console.log(`✅ 已同步：ios/app/InterprovinceRoute/InterprovinceRoute/index.html（sha256 ${hash}…）`);
console.log('下一步（需 Mac + Xcode + 签名）：见 ios/app/InterprovinceRoute/README.md');
