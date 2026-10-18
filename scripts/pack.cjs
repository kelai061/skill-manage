'use strict';
/**
 * pack.cjs — 零依赖打包：产出一个双击即用的绿色版目录
 *
 * 思路：Electron 运行时本来就躺在 node_modules/electron/dist 里，
 * 把它整个复制一份，再把应用代码塞进 resources/app/，最后改名可执行文件即可。
 * 不联网、不依赖 electron-builder，适合内网或离线环境。
 *
 * 用法：npm run pack
 * 产物：release/SkillAtelier/SkillAtelier.exe
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'node_modules', 'electron', 'dist');
const outDir = path.join(root, 'release', 'SkillAtelier');
const appDir = path.join(outDir, 'resources', 'app');

const APP_FILES = ['main', 'renderer', 'shared', 'scripts', 'package.json'];

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
    return;
  } catch { /* 某些环境会拦截删除，退化为改名后再删 */ }
  try {
    const aside = `${p}.old-${Date.now()}`;
    fs.renameSync(p, aside);
    try { fs.rmSync(aside, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 留给系统清理 */ }
  } catch (e) {
    console.warn('  警告：旧产物未能清理（' + e.message + '），将直接覆盖写入。');
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(dist)) {
  console.error('找不到 Electron 运行时：' + dist);
  console.error('请先执行 npm install。');
  process.exit(1);
}

console.log('清理旧产物…');
rmrf(path.join(root, 'release'));
fs.mkdirSync(outDir, { recursive: true });

console.log('复制 Electron 运行时…');
copyDir(dist, outDir);

console.log('写入应用代码…');
fs.mkdirSync(appDir, { recursive: true });
for (const f of APP_FILES) {
  const s = path.join(root, f);
  if (!fs.existsSync(s)) continue;
  const d = path.join(appDir, f);
  if (fs.statSync(s).isDirectory()) copyDir(s, d);
  else fs.copyFileSync(s, d);
}

// 绿色版里不需要开发依赖声明
const pkgPath = path.join(appDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
delete pkg.devDependencies;
delete pkg.build;
pkg.scripts = { start: 'node scripts/launch.cjs' };
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');

console.log('重命名可执行文件…');
const exe = path.join(outDir, 'electron.exe');
if (fs.existsSync(exe)) fs.renameSync(exe, path.join(outDir, 'SkillAtelier.exe'));

// 瘦身：只保留中英文语言包
const locales = path.join(outDir, 'locales');
if (fs.existsSync(locales)) {
  for (const f of fs.readdirSync(locales)) {
    if (!/^(zh-CN|en-US)\.pak$/.test(f)) {
      try { fs.unlinkSync(path.join(locales, f)); } catch { /* ignore */ }
    }
  }
}

// 绿色版默认以「便携」模式运行，用户数据仍落在 %APPDATA%
const marker = path.join(outDir, 'resources', 'PORTABLE.txt');
fs.writeFileSync(marker, '便携版目录。双击 SkillAtelier.exe 运行；用户数据位于 %APPDATA%\\Skill Atelier\n', 'utf8');

const size = (() => {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(outDir);
  return (total / 1024 / 1024).toFixed(0);
})();

console.log(`\n完成 → ${path.join(outDir, 'SkillAtelier.exe')}`);
console.log(`体积约 ${size} MB`);
