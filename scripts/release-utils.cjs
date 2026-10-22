'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const APP_FILES = Object.freeze(['main', 'renderer', 'shared', 'package.json', 'LICENSE']);
const PRIVATE_NAME = /^(?:SkillAtelier-data|config\.json|translations|translation-tasks|annotations|backups|\.cache|\.git|\.env(?:\..*)?|skills\.index\.md)$/i;
const { parseVer } = require('../main/updater');

function renameWithRetry(source, destination) {
  // Windows scanners can briefly hold newly copied executables open.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, destination); return; }
    catch (error) {
      if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
    }
  }
}

function assertInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('拒绝访问发行目录边界之外的路径。');
  }
  // A junction anywhere in the output path could redirect a recursive delete.
  let current = path.resolve(target);
  const boundary = path.resolve(base);
  while (true) {
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new Error('发行目录不能包含符号链接或目录联接。');
    // path.relative compares Windows paths without case sensitivity.
    if (!path.relative(boundary, current)) break;
    current = path.dirname(current);
  }
  return path.resolve(target);
}

function releasePaths(root, version) {
  if (!parseVer(version) || /^v/i.test(version)) {
    throw new Error('发行版本号必须使用语义化版本。');
  }
  const release = path.join(root, 'release');
  const build = path.join(release, 'build');
  const current = path.join(release, 'current');
  const portable = path.join(build, 'portable', 'SkillAtelier');
  assertInside(root, portable);
  assertInside(root, current);
  return { release, build, current, portable, installer: path.join(build, 'installer'), version };
}

function validatePackage(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  releasePaths(root, pkg.version);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('package.json 与 package-lock.json 版本不一致，已中止发行。');
  }
  for (const name of APP_FILES) {
    const source = path.join(root, name);
    if (name === 'LICENSE' && !fs.existsSync(source)) continue;
    inspectTree(source, true);
  }
  return pkg;
}

function inspectTree(source, privateNames = false) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('发行文件中包含符号链接或目录联接，已中止。');
  if (privateNames && PRIVATE_NAME.test(path.basename(source))) {
    throw new Error('发行文件中包含运行数据，请重新构建干净发行包。');
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(source)) inspectTree(path.join(source, name), privateNames);
  } else if (!stat.isFile()) {
    throw new Error('发行文件类型不受支持。');
  }
}

function copyTree(source, destination, { privateNames = false } = {}) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('发行源文件中包含符号链接，已中止。');
  if (privateNames && PRIVATE_NAME.test(path.basename(source))) {
    throw new Error('发行源文件中混入运行数据，已中止。');
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(destination, name), { privateNames });
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  } else {
    throw new Error('发行源文件类型不受支持。');
  }
}

function verifyPortable(directory, expectedVersion) {
  inspectTree(directory, true);
  if (!fs.existsSync(path.join(directory, 'SkillAtelier.exe'))) throw new Error('绿色版缺少 SkillAtelier.exe。');
  const app = path.join(directory, 'resources', 'app');
  const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  if (expectedVersion && pkg.version !== expectedVersion) throw new Error('绿色版版本与当前项目不一致，请重新运行 npm run pack。');
  if (!fs.existsSync(path.join(directory, 'resources', 'PORTABLE.txt'))) throw new Error('绿色版缺少数据隔离标记。');
  for (const name of fs.readdirSync(app)) {
    if (!APP_FILES.includes(name)) throw new Error('绿色版应用目录包含非发行文件，请重新构建。');
  }
  return pkg;
}

function attachmentNames(version) {
  return [`SkillAtelier-${version}.exe`, `SkillAtelier-Setup-${version}.exe`, `SkillAtelier-${version}-win-x64.zip`];
}

function verifyCurrent(root, version) {
  const { current } = releasePaths(root, version);
  if (!fs.existsSync(current)) return current;
  const allowed = new Set([...attachmentNames(version), 'SHA256SUMS.txt']);
  for (const name of fs.readdirSync(current)) {
    const file = assertInside(current, path.join(current, name));
    if (!allowed.has(name) || !fs.lstatSync(file).isFile()) {
      throw new Error('release/current 中存在其他版本或非发行文件，请先将历史附件归档到 release/archive。');
    }
  }
  return current;
}

function writeChecksums(root, version) {
  const current = verifyCurrent(root, version);
  fs.mkdirSync(current, { recursive: true });
  const accepted = new Set(attachmentNames(version));
  const lines = fs.readdirSync(current).filter((name) => accepted.has(name)).sort().map((name) => {
    const file = path.join(current, name);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('发行附件不能是符号链接。');
    return `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${name}`;
  });
  if (!lines.length) throw new Error('没有当前版本的发行附件可生成校验值。');
  const output = assertInside(current, path.join(current, 'SHA256SUMS.txt'));
  fs.writeFileSync(output, `${lines.join('\n')}\n`, 'utf8');
  return output;
}

module.exports = { APP_FILES, assertInside, copyTree, releasePaths, validatePackage, verifyPortable, verifyCurrent, writeChecksums, renameWithRetry };
