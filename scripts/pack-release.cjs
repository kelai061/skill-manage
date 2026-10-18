'use strict';
/**
 * pack-release.cjs — 把绿色版打成一个可分发的 zip，并生成 SHA256
 *
 * 产物：
 *   dist/SkillAtelier-<version>-win-x64.zip
 *   dist/SHA256SUMS.txt
 *
 * 注意：zip 不进 git（.gitignore 已排除 dist/），它只是 GitHub Release 的附件。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const src = path.join(root, 'release', 'SkillAtelier');
const exe = path.join(src, 'SkillAtelier.exe');

if (!fs.existsSync(exe)) {
  console.error('找不到 release\\SkillAtelier\\SkillAtelier.exe');
  console.error('先执行：npm run pack');
  process.exit(1);
}

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const name = `SkillAtelier-${pkg.version}-win-x64.zip`;
const out = path.join(dist, name);
if (fs.existsSync(out)) fs.unlinkSync(out);

console.log(`压缩 ${src} → ${out}`);
const ps = spawnSync('powershell', [
  '-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -Path '${src}\\*' -DestinationPath '${out}' -Force`
], { stdio: 'inherit' });

if (ps.status !== 0) {
  console.error('压缩失败（PowerShell Compress-Archive 返回非 0）');
  process.exit(ps.status || 1);
}

const buf = fs.readFileSync(out);
const hash = crypto.createHash('sha256').update(buf).digest('hex');
const sums = path.join(dist, 'SHA256SUMS.txt');
fs.writeFileSync(sums, `${hash}  ${name}\n`, 'utf8');

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
console.log(`\n完成：${name}（${mb(buf.length)}）`);
console.log(`SHA256：${hash}`);
console.log(`校验文件：${sums}`);
console.log('\n下一步：GitHub → Releases → Draft a new release → tag v' + pkg.version + ' → 上传这个 zip');
