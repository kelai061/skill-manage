'use strict';
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const scanner = require('../main/scanner');
const detector = require('../main/detectTools');
const sources = require('../main/productSources');
const { mergeWorkbuddy, sameWorkbuddy } = require('../main/productAliases');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-product-sources-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const mkdir = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
const write = (p, content) => { mkdir(path.dirname(p)); fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content)); return p; };
const skill = (dir, name = path.basename(dir)) => write(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture only\n---\n\n# ${name}\n`);
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function asar(file, script) {
  // Minimal ASAR header: size pickle + JSON header pickle + one file payload.
  const data = Buffer.from(script);
  const json = Buffer.from(JSON.stringify({ files: { 'main.cjs': { size: data.length, offset: '0' } } }));
  const headerSize = Math.ceil((json.length + 8) / 4) * 4;
  const prefix = Buffer.alloc(8 + headerSize);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(headerSize - 4, 8); prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16); mkdir(path.dirname(file)); fs.writeFileSync(file, Buffer.concat([prefix, data]));
}
const env = (home) => ({ home, localappdata: '', appdata: '', programFiles: '', packageBases: [], runtimePaths: [], shortcutPaths: [], cacheDir: path.join(root, 'owned-cache') });

test('ZCode plugin inventory selects one cache version and avoids installed mirrors', () => {
  const home = mkdir(path.join(root, 'zcode-home'));
  const install = mkdir(path.join(root, 'ZCode'));
  const exe = write(path.join(install, 'ZCode.exe'), 'fixture');
  const base = path.join(home, '.zcode/cli/plugins');
  const old = path.join(base, 'cache/official/browser/1.0.0');
  const selected = path.join(base, 'cache/official/browser/2.0.0');
  const stale = path.join(base, 'cache/official/browser/3.0.0');
  for (const dir of [old, selected, stale, path.join(install, 'resources/glm/packages/browser-plugin')]) {
    write(path.join(dir, '.zcode-plugin/plugin.json'), { name: 'browser', skills: 'skills' }); skill(path.join(dir, 'skills/control-browser'));
  }
  skill(path.join(install, 'resources/glm/packages/bundled-skills/skills/dynamic'));
  write(path.join(base, 'marketplaces/official/marketplace.json'), { plugins: [{ name: 'browser', cachePath: selected }] });
  assert.deepEqual(sources.zcodeRoots(home, exe).sort(), [path.join(selected, 'skills'), path.join(install, 'resources/glm/packages/bundled-skills/skills')].sort());
  const probe = scanner.probe(exe, env(home));
  const scan = scanner.scanProduct({ id: 'zcode', launchPath: exe }, env(home));
  assert.equal(probe.totalSkills, 2); assert.equal(scan.skills.length, 2);
  assert.ok(scan.skills.some((s) => s.dir === path.join(selected, 'skills/control-browser')));
  assert.equal(detector.detect({ ...env(home), runtimePaths: [exe] }).find((x) => x.id === 'zcode').skills, 2);
});
test('Kimi bundled Markdown is decoded as data, visible in every scan, and source archive stays unchanged', () => {
  const home = mkdir(path.join(root, 'kimi-home'));
  const install = mkdir(path.join(root, 'Kimi Code'));
  const exe = write(path.join(install, 'Kimi Code.exe'), 'fixture');
  const archive = path.join(install, 'resources/app.asar');
  const body = '---\nname: help\ndescription: Builtin fixture\n---\n\nKeep this as plain text.\n';
  asar(archive, `//#region raw:/features/skill/catalog/builtin/help.md\nvar help_default = ${JSON.stringify(body)};\n//#endregion\nthrow new Error('Archive must never execute');`);
  const before = hash(archive);
  const probe = scanner.probe(exe, env(home));
  const indexed = scanner.scanProduct({ id: 'kimi', launchPath: exe }, env(home));
  assert.equal(probe.totalSkills, 1); assert.equal(probe.roots[0].virtual, true);
  assert.equal(indexed.skills.length, 1);
  const sk = indexed.skills[0]; assert.equal(sk.readOnly, true); assert.equal(sk.sourceKind, 'embedded');
  assert.ok(sk.sourcePath.startsWith(archive + '#builtin://'));
  assert.equal(fs.readFileSync(sk.path, 'utf8'), body);
  assert.ok(sk.path.startsWith(env(home).cacheDir)); assert.equal(hash(archive), before);
  const detected = detector.detect({ ...env(home), runtimePaths: [exe] }).find((x) => x.id === 'kimi');
  assert.equal(detected.skills, 1); assert.deepEqual(detected.roots, []);
});
test('Malformed archives and nonliteral Markdown imports are ignored without eval', () => {
  const install = mkdir(path.join(root, 'Broken Kimi'));
  const exe = write(path.join(install, 'Kimi Code.exe'), 'fixture');
  const archive = path.join(install, 'resources/app.asar');
  write(archive, 'not asar'); assert.deepEqual(sources.embeddedSkills({ launchPath: exe }), []);
  asar(archive, '//#region raw:/features/skill/catalog/builtin/help.md\nvar help_default = require("fs").readFileSync("private");');
  assert.deepEqual(sources.embeddedSkills({ launchPath: exe }), []);
});
test('WorkBuddy duplicate merge preserves projects, manual roots, favorites and combinations', () => {
  const installation = path.join(root, 'WorkBuddy-install');
  const project = path.join(root, 'shared-project');
  const a = { id: 'old', name: 'WorkBuddy', launchPath: path.join(installation, 'WorkBuddy.exe'), manualRoots: [{ root: '/root-a' }], projects: [{ id: 'project-old', path: project }], hidden: ['hidden'] };
  const b = { id: 'new', name: 'WorkBuddy AI', launchPath: path.join(installation, 'WorkBuddyAI.exe'), manualRoots: [{ root: '/root-b' }], projects: [{ id: 'project-new', path: project }] };
  const state = { products: [a, b], skills: [{ id: 's', productId: 'new', projectId: 'project-new' }], favorites: ['s'], ratings: { s: 5 }, combos: [{ skillIds: ['s'] }] };
  assert.equal(sameWorkbuddy(a, b), true); assert.equal(mergeWorkbuddy(state).merged, 1);
  assert.equal(state.products.length, 1); assert.equal(a.manualRoots.length, 2); assert.equal(a.projects.length, 1);
  assert.equal(state.skills[0].productId, 'old'); assert.equal(state.skills[0].projectId, 'project-old');
  assert.deepEqual(state.favorites, ['s']); assert.equal(state.ratings.s, 5); assert.deepEqual(state.combos[0].skillIds, ['s']);
  assert.equal(sameWorkbuddy(a, { launchPath: path.join(root, 'Other-install/WorkBuddy.exe') }), false);
});
