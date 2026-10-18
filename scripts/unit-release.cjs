'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, after } = require('node:test');
const { APP_FILES, assertInside, releasePaths, validatePackage, verifyPortable, writeChecksums } = require('./release-utils.cjs');
const { buildPortable } = require('./pack.cjs');
const { packRelease } = require('./pack-release.cjs');
const { publishRelease } = require('./publish-release.cjs');

const fixtureParent = path.join(__dirname, '..', '.cache');
fs.mkdirSync(fixtureParent, { recursive: true });
const temporary = fs.mkdtempSync(path.join(fixtureParent, 'unit-release-'));
after(() => { fs.rmSync(temporary, { recursive: true, force: true }); });

function write(root, relative, value = 'fixture') {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(temporary, 'case-'));
  const pkg = { name: 'skill-atelier', productName: 'Skill Atelier', version: '1.0.2', main: 'main/main.js', private: true, scripts: { secret: 'development only' } };
  write(root, 'package.json', JSON.stringify(pkg));
  write(root, 'package-lock.json', JSON.stringify({ version: pkg.version, packages: { '': { version: pkg.version } } }));
  for (const name of ['main/main.js', 'renderer/index.html', 'shared/helper.mjs', 'LICENSE']) write(root, name);
  // These bytes are copied only; no executable or build process runs in these tests.
  for (const name of ['electron.exe', 'resources/default_app.asar', 'locales/zh-CN.pak', 'locales/en-US.pak', 'locales/fr.pak']) {
    write(root, `node_modules/electron/dist/${name}`);
  }
  return root;
}

test('Portable packaging uses the app whitelist and strips development metadata', () => {
  const root = fixture();
  for (const name of ['scripts/private.cjs', 'docs/report.json', '.env', 'config.json', 'skills.index.md', 'SkillAtelier-data/config.json']) write(root, name, 'private fixture');
  const output = buildPortable(root);
  const app = path.join(output, 'resources/app');
  assert.deepEqual(fs.readdirSync(app).sort(), [...APP_FILES].sort());
  const pkg = verifyPortable(output, '1.0.2');
  assert.equal(pkg.scripts, undefined);
  assert.equal(pkg.private, undefined);
  assert.ok(fs.existsSync(path.join(output, 'resources/PORTABLE.txt')));
  assert.equal(fs.existsSync(path.join(output, 'locales/fr.pak')), false);
  assert.equal(fs.existsSync(path.join(output, 'SkillAtelier-data')), false);
});

test('Release packaging cannot fall back to a stale legacy portable directory', () => {
  const root = fixture();
  write(root, 'release/SkillAtelier/SkillAtelier.exe');
  assert.throws(() => packRelease(root), /ENOENT/);
  assert.equal(fs.existsSync(path.join(root, 'release/current')), false);
});

test('Portable version must match and private runtime data stops repacking', () => {
  const root = fixture();
  const portable = buildPortable(root);
  assert.throws(() => verifyPortable(portable, '1.0.3'), /版本/);
  write(portable, 'SkillAtelier-data/config.json', 'keep me');
  assert.throws(() => verifyPortable(portable, '1.0.2'), /运行数据/);
  assert.throws(() => buildPortable(root), /运行数据/);
  assert.equal(fs.readFileSync(path.join(portable, 'SkillAtelier-data/config.json'), 'utf8'), 'keep me');
});

test('Private files in application sources and mismatched lockfiles stop every build', () => {
  const root = fixture();
  write(root, 'main/config.json', 'private fixture');
  assert.throws(() => validatePackage(root), /运行数据/);
  fs.unlinkSync(path.join(root, 'main/config.json'));
  write(root, 'package-lock.json', JSON.stringify({ version: '1.7.0', packages: { '': { version: '1.7.0' } } }));
  assert.throws(() => buildPortable(root), /版本不一致/);
  assert.equal(fs.existsSync(path.join(root, 'release/build')), false);
});

test('Output paths reject parent escapes', () => {
  const root = fixture();
  assert.throws(() => assertInside(root, root), /边界/);
  assert.throws(() => assertInside(root, path.dirname(root)), /边界/);
  assert.throws(() => releasePaths(root, '../1.0.2'), /版本号/);
  assert.throws(() => releasePaths(root, '01.0.2'), /版本号/);
  if (process.platform === 'win32') {
    assert.equal(assertInside(root.toUpperCase(), path.join(root.toLowerCase(), 'child')), path.resolve(path.join(root.toLowerCase(), 'child')));
  }
});

test('Output paths reject directory junctions', (t) => {
  const root = fixture();
  const destination = path.join(root, 'outside');
  fs.mkdirSync(destination);
  const link = path.join(root, 'release');
  try { fs.symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('The current Windows sandbox cannot create junctions.');
    throw error;
  }
  assert.throws(() => releasePaths(root, '1.0.2'), /符号链接|目录联接/);
});

test('Final attachments are copied from the current build and SHA-256 covers each one', () => {
  const root = fixture();
  const names = ['SkillAtelier-Setup-1.0.2.exe', 'SkillAtelier-1.0.2.exe'];
  for (const name of names) write(root, `release/build/installer/${name}`, `payload:${name}`);
  const files = publishRelease(root);
  assert.equal(files.length, 2);
  for (const file of files) assert.equal(path.dirname(file), path.join(root, 'release/current'));
  const sums = fs.readFileSync(writeChecksums(root, '1.0.2'), 'utf8');
  for (const name of names) {
    const digest = crypto.createHash('sha256').update(`payload:${name}`).digest('hex');
    assert.ok(sums.includes(`${digest}  ${name}\n`));
  }
});

test('Missing targets and mixed old current artifacts are refused without deleting history', () => {
  const root = fixture();
  assert.throws(() => publishRelease(root), /缺少当前版本/);
  write(root, 'release/build/installer/SkillAtelier-1.0.2.exe');
  write(root, 'release/current/SkillAtelier-1.0.1.exe', 'keep history');
  assert.throws(() => publishRelease(root, 'portable'), /历史附件归档/);
  assert.equal(fs.readFileSync(path.join(root, 'release/current/SkillAtelier-1.0.1.exe'), 'utf8'), 'keep history');
});

test('Production builder uses the same whitelist and isolated portable extraction', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.build.directories.output, 'release/build/installer');
  assert.equal(pkg.build.portable.unpackDirName, undefined);
  assert.equal(pkg.build.beforePack, './scripts/before-pack.cjs');
  for (const name of APP_FILES) assert.ok(pkg.build.files.includes(['main', 'renderer', 'shared'].includes(name) ? `${name}/**/*` : name));
  assert.equal(pkg.build.files.includes('scripts/**/*'), false);
  assert.equal(pkg.version, require('../package-lock.json').packages[''].version);
});

test('electron-builder hook reads the app directory from its supported context', async () => {
  const root = fixture();
  const beforePack = require('./before-pack.cjs');
  await beforePack({ packager: { info: { appDir: root } } });
  write(root, 'main/config.json', 'private fixture');
  await assert.rejects(beforePack({ packager: { info: { appDir: root } } }), /运行数据/);
});
