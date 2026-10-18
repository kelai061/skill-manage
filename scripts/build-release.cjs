'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validatePackage, verifyCurrent } = require('./release-utils.cjs');
const { publishRelease } = require('./publish-release.cjs');

function buildRelease(target = 'all', root = path.join(__dirname, '..')) {
  const targets = { all: ['nsis', 'portable'], setup: ['nsis'], portable: ['portable'] }[target];
  if (!targets) throw new Error('未知发行目标。');
  const pkg = validatePackage(root);
  verifyCurrent(root, pkg.version);
  const cli = require.resolve('electron-builder/cli.js', { paths: [root] });
  const result = spawnSync(process.execPath, [cli, '--win', ...targets, '--x64', '--publish', 'never'], {
    cwd: root, stdio: 'inherit'
  });
  if (result.error || result.status !== 0) throw new Error('发行构建失败，没有复制附件。');
  return publishRelease(root, target);
}

if (require.main === module) {
  try { console.log(buildRelease(process.argv[2]).join('\n')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { buildRelease };
