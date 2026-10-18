'use strict';

// Offline portable directory. Build files stay separate from shareable attachments.
const fs = require('node:fs');
const path = require('node:path');
const { APP_FILES, assertInside, copyTree, releasePaths, validatePackage, verifyPortable, renameWithRetry } = require('./release-utils.cjs');

function buildPortable(root = path.join(__dirname, '..')) {
  const pkg = validatePackage(root);
  const paths = releasePaths(root, pkg.version);
  const runtime = path.join(root, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(path.join(runtime, 'electron.exe'))) throw new Error('找不到 Electron 运行时，请先执行 npm install。');
  // A previous build might have been used directly. Preserve its data instead of deleting it.
  if (fs.existsSync(paths.portable)) verifyPortable(paths.portable);
  const stage = `${paths.portable}.tmp-${process.pid}`;
  assertInside(paths.build, stage);
  if (fs.existsSync(stage)) throw new Error('本次构建临时目录已存在，请先检查是否仍有构建在运行。');
  fs.mkdirSync(stage, { recursive: true });
  try {
    copyTree(runtime, stage);
    const app = path.join(stage, 'resources', 'app');
    // A runtime accidentally modified by development must never carry an old app.
    if (fs.existsSync(app) || fs.existsSync(path.join(stage, 'resources', 'app.asar'))) {
      throw new Error('Electron 运行时中已包含应用，请重新安装干净的 Electron 依赖。');
    }
    for (const name of APP_FILES) {
      const source = path.join(root, name);
      if (name === 'LICENSE' && !fs.existsSync(source)) continue;
      copyTree(source, path.join(app, name), { privateNames: true });
    }
    const runtimePkg = { name: pkg.name, productName: pkg.productName, version: pkg.version, main: pkg.main,
      description: pkg.description, author: pkg.author, license: pkg.license };
    fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify(runtimePkg, null, 2)}\n`, 'utf8');
    fs.renameSync(path.join(stage, 'electron.exe'), path.join(stage, 'SkillAtelier.exe'));
    const locales = path.join(stage, 'locales');
    if (fs.existsSync(locales)) {
      for (const name of fs.readdirSync(locales)) {
        if (/\.pak$/i.test(name) && !/^(zh-CN|en-US)\.pak$/.test(name)) fs.unlinkSync(path.join(locales, name));
      }
    }
    fs.mkdirSync(path.join(stage, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'resources', 'PORTABLE.txt'),
      '便携版：双击 SkillAtelier.exe。用户数据保存在同目录 SkillAtelier-data 中；分享前请使用重新构建的干净发行包。\n', 'utf8');
    verifyPortable(stage, pkg.version);
    assertInside(paths.build, paths.portable);
    if (fs.existsSync(paths.portable)) fs.rmSync(paths.portable, { recursive: true, force: true, maxRetries: 3 });
    renameWithRetry(stage, paths.portable);
    return paths.portable;
  } finally {
    assertInside(paths.build, stage);
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (require.main === module) {
  try { console.log(`绿色版构建完成：${path.join(buildPortable(), 'SkillAtelier.exe')}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { buildPortable };
