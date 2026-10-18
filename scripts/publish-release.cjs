'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { releasePaths, validatePackage, assertInside, verifyCurrent, writeChecksums } = require('./release-utils.cjs');

function publishRelease(root = path.join(__dirname, '..'), target = 'all') {
  const { version } = validatePackage(root);
  const { installer, current } = releasePaths(root, version);
  const names = {
    setup: [`SkillAtelier-Setup-${version}.exe`],
    portable: [`SkillAtelier-${version}.exe`],
    all: [`SkillAtelier-Setup-${version}.exe`, `SkillAtelier-${version}.exe`]
  }[target];
  if (!names) throw new Error('未知发行目标。');
  verifyCurrent(root, version);
  for (const name of names) {
    const source = assertInside(root, path.join(installer, name));
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`缺少当前版本附件：${name}`);
  }
  fs.mkdirSync(current, { recursive: true });
  for (const name of names) {
    const destination = assertInside(current, path.join(current, name));
    fs.copyFileSync(path.join(installer, name), destination);
  }
  writeChecksums(root, version);
  return names.map((name) => path.join(current, name));
}

if (require.main === module) {
  try { console.log(publishRelease(undefined, process.argv[2]).join('\n')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { publishRelease };
