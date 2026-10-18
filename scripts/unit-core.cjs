'use strict';

// Every module uses this temporary profile; no installed config or real API is read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const zlib = require('node:zlib');
const cache = path.join(__dirname, '..', '.cache');
fs.mkdirSync(cache, { recursive: true });
const root = fs.mkdtempSync(path.join(cache, 'atelier-core-'));
const handlers = new Map();
const profile = path.join(root, 'profile');
fs.mkdirSync(profile);
const electron = {
  app: { getPath: () => profile, getVersion: () => 'fixture' },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  shell: {}, clipboard: {}, dialog: {}, BrowserWindow: {}
};
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === 'electron') return electron;
  if (name === './workspace' && parent?.filename.startsWith(path.join(__dirname, '..', 'main'))) {
    return { sync: () => ({ path: path.join(profile, 'skills.index.md') }), appHome: () => root, brief: () => ({ indexFile: path.join(profile, 'skills.index.md') }) };
  }
  return originalLoad.call(this, name, parent, isMain);
};
const store = require('../main/store');
const skills = require('../main/skillService');
const share = require('../main/share');
const organizer = require('../main/organizer');
const importer = require('../main/importer');
const ai = require('../main/aiService');
const docx = require('../main/docx');
const preview = require('../main/filePreview');
const ipc = require('../main/ipc');
const scanner = require('../main/scanner');
const originalFetch = global.fetch;
let passed = 0;
let failed = 0;
let skipped = 0;
const SKIP = Symbol('environment skip');

async function t(name, fn) {
  try {
    if (await fn() === SKIP) { skipped++; console.log(`  ↷ ${name}: this Windows environment blocks fixture junction creation`); }
    else { passed++; console.log(`  ✓ ${name}`); }
  }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
function junction(target, link) {
  try { fs.symlinkSync(target, link, 'junction'); return true; }
  catch (e) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) return false;
    throw e;
  }
}
function makeSkill(relative, text = '# Fixture\n\nOriginal fixture content.\n') {
  const dir = path.join(root, relative);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  return dir;
}
function zip(name, content, size = content.length) {
  const filename = Buffer.from(name);
  const packed = zlib.deflateRawSync(content);
  let crc = ~0;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  crc = ~crc >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + packed.length, 16);
  return Buffer.concat([local, filename, packed, central, filename, end]);
}

async function main() {
  console.log('\n[unit] Core storage, import, movement, and IPC boundaries');
  await t('Corrupt config is preserved before defaults are written', () => {
    const corrupt = '{broken fixture';
    fs.writeFileSync(store.paths.config, corrupt);
    store.load();
    const saved = fs.readdirSync(profile).filter((x) => x.startsWith('config.corrupt-'));
    assert.equal(saved.length, 1);
    assert.equal(fs.readFileSync(path.join(profile, saved[0]), 'utf8'), corrupt);
    assert.deepEqual(JSON.parse(fs.readFileSync(store.paths.config)).skills, []);
  });
  await t('A failed recovery backup never overwrites the corrupt config', () => {
    const copy = fs.copyFileSync;
    const original = '{another broken fixture';
    fs.writeFileSync(store.paths.config, original);
    fs.copyFileSync = () => { throw Object.assign(new Error('fixture permission failure'), { code: 'EACCES' }); };
    try { assert.throws(() => store.load(), /permission failure/); }
    finally { fs.copyFileSync = copy; }
    assert.equal(fs.readFileSync(store.paths.config, 'utf8'), original);
    store.load();
  });
  await t('Writing a skill preserves the original backup and rejects other filenames', () => {
    const dir = makeSkill('write-example');
    const file = path.join(dir, 'SKILL.md');
    const before = fs.readFileSync(file, 'utf8');
    const result = skills.writeSkill(file, '# Changed fixture');
    assert.equal(fs.readFileSync(result.backup, 'utf8'), before);
    assert.equal(fs.readFileSync(file, 'utf8'), '# Changed fixture');
    assert.throws(() => skills.writeSkill(path.join(dir, 'other.md'), 'bad'), /SKILL/);
  });
  await t('Cache and annotation identifiers reject traversal; concurrent segments survive', () => {
    assert.throws(() => skills.writeCache('../escape', 'zh-CN', 'fixture', {}), /标识/);
    assert.throws(() => skills.setAnnotations('../escape', []), /标识/);
    skills.commitSegCache({}, 'zh-CN', 'fixture', ['first'], ['第一']);
    skills.commitSegCache({}, 'zh-CN', 'fixture', ['second'], ['第二']);
    assert.deepEqual(skills.splitBySegCache(['first', 'second'], 'zh-CN', 'fixture').list, ['第一', '第二']);
  });
  await t('Shared group names remap imported memberships and avoid ID collisions', () => {
    const cfg = { groups: [{ id: 'local', name: 'Existing' }, { id: 'collision', name: 'Other' }], ratings: { a: { stars: 5 } } };
    share.mergeImport(cfg, { kind: share.EXPORT_KIND, groups: [{ id: 'remote', name: 'Existing' }, { id: 'collision', name: 'New' }], skillGroups: { s: ['remote', 'collision', 'missing'] }, ratings: { a: { stars: 1 } } });
    assert.equal(cfg.groups.length, 3);
    assert.equal(cfg.skillGroups.s[0], 'local');
    assert.equal(new Set(cfg.groups.map((g) => g.id)).size, 3);
    assert.equal(cfg.skillGroups.s.length, 2);
    assert.equal(cfg.ratings.a.stars, 5);
    const before = JSON.stringify(cfg);
    assert.throws(() => share.mergeImport(cfg, { kind: share.EXPORT_KIND, products: [{ id: 'bad', projects: {} }] }), /projects/);
    assert.equal(JSON.stringify(cfg), before);
  });
  await t('Organizer rejects relative categories and source subtrees', () => {
    const dir = makeSkill('moves/inbox/one');
    const base = path.join(root, 'moves');
    for (const category of ['..', '../escape', 'a/b', '.']) {
      assert.equal(organizer.apply([{ from: dir, category }], base)[0].ok, false);
    }
    assert.equal(organizer.apply([{ from: dir, category: 'inside' }], dir)[0].ok, false);
    assert.equal(fs.existsSync(path.join(dir, 'SKILL.md')), true);
  });
  await t('Organizer rejects a category link outside the target root', () => {
    const dir = path.join(root, 'moves', 'inbox', 'one');
    const base = path.join(root, 'moves');
    const outside = path.join(root, 'outside-category');
    fs.mkdirSync(outside);
    if (!junction(outside, path.join(base, 'linked'))) return SKIP;
    assert.equal(organizer.apply([{ from: dir, category: 'linked' }], base)[0].ok, false);
    assert.equal(fs.existsSync(path.join(dir, 'SKILL.md')), true);
  });
  await t('Permission errors do not trigger copy/delete; EXDEV preserves collisions', () => {
    const dir = makeSkill('rename/inbox/one');
    const target = path.join(root, 'rename');
    const rename = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); };
    try { assert.equal(organizer.apply([{ from: dir, category: 'cat' }], target)[0].ok, false); }
    finally { fs.renameSync = rename; }
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.existsSync(path.join(target, 'cat', 'one')), false);
    makeSkill('rename/cat/one', 'existing');
    fs.renameSync = () => { throw Object.assign(new Error('fixture cross device'), { code: 'EXDEV' }); };
    let result;
    try { result = organizer.apply([{ from: dir, category: 'cat' }], target)[0]; }
    finally { fs.renameSync = rename; }
    assert.equal(result.ok, true);
    assert.equal(path.basename(result.to), 'one-2');
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.readFileSync(path.join(target, 'cat', 'one', 'SKILL.md'), 'utf8'), 'existing');
  });
  await t('Repeated imports keep existing source contents and reject escaped names', async () => {
    const staging = path.join(root, 'imports');
    global.fetch = async () => ({ ok: true, text: async () => '# Downloaded fixture\n\nAt least twenty characters.' });
    const a = await importer.importUrl('https://fixture.invalid/repeated.md', staging);
    const b = await importer.importUrl('https://fixture.invalid/repeated.md', staging);
    assert.equal(a.imported[0].name, 'repeated');
    assert.equal(b.imported[0].name, 'repeated-2');
    assert.equal(fs.existsSync(path.join(a.imported[0].dir, 'SKILL.md')), true);
    await assert.rejects(importer.importUrl('https://fixture.invalid/..%2fescape.md', staging), /目录名称/);
    assert.throws(() => importer.plan('https://github.com/example/repo/tree/main/%2e%2e/secrets'), /子目录/);
  });
  await t('ZIP traversal is rejected before extracting files', async () => {
    const packed = zip('../escape/SKILL.md', Buffer.from('# Unsafe fixture\n\nNo output outside extraction root.'));
    global.fetch = async () => ({ ok: true, arrayBuffer: async () => packed });
    const staging = path.join(root, 'zip-imports');
    await assert.rejects(importer.importUrl('https://fixture.invalid/unsafe.zip', staging), /Archive path escapes|Invalid archive/);
    assert.deepEqual(fs.readdirSync(staging), []);
  });
  await t('A valid ZIP imports its SKILL.md successfully', async () => {
    const text = '# ZIP fixture\n\nThis document is safe to import.';
    const packed = zip('one/SKILL.md', Buffer.from(text));
    global.fetch = async () => ({ ok: true, arrayBuffer: async () => packed });
    const result = await importer.importUrl('https://fixture.invalid/safe.zip', path.join(root, 'valid-zip'));
    assert.equal(result.imported.length, 1);
    assert.equal(fs.readFileSync(path.join(result.imported[0].dir, 'SKILL.md'), 'utf8'), text);
  });
  await t('Failed imports remove only their own new directory', async () => {
    const staging = path.join(root, 'failed-imports');
    makeSkill('failed-imports/example', 'existing source');
    const write = fs.writeFileSync;
    global.fetch = async () => ({ ok: true, text: async () => '# Downloaded fixture content of sufficient length.' });
    fs.writeFileSync = function (file, ...args) {
      if (String(file).startsWith(path.join(staging, 'example-2'))) throw new Error('fixture write failure');
      return write.call(this, file, ...args);
    };
    try { await assert.rejects(importer.importUrl('https://fixture.invalid/example.md', staging), /write failure/); }
    finally { fs.writeFileSync = write; }
    assert.deepEqual(fs.readdirSync(staging), ['example']);
    assert.equal(fs.readFileSync(path.join(staging, 'example', 'SKILL.md'), 'utf8'), 'existing source');
  });
  await t('AI timeout includes a delayed successful response body', async () => {
    store.patch({ settings: { api: { key: 'fixture-only', baseUrl: 'http://fixture.invalid', model: 'fixture-model' } } });
    global.fetch = async (_url, { signal }) => ({ ok: true, json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
    await assert.rejects(ai.chat([{ role: 'user', content: 'fixture' }], { timeout: 15 }), /超时/);
  });
  await t('Malformed and oversized DOCX entries fail without throwing', () => {
    const normal = zip('word/document.xml', Buffer.from('<w:p><w:r><w:t>&#x1F642; &#99999999;</w:t></w:r></w:p>'));
    const file = path.join(root, 'entity.docx');
    fs.writeFileSync(file, normal);
    assert.equal(docx.extract(file).ok, true);
    assert.ok(docx.extract(file).text.includes('🙂'));
    const bad = Buffer.from(normal);
    const central = bad.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bad.writeUInt32LE(0xfffffff0, central + 42);
    fs.writeFileSync(file, bad);
    assert.equal(docx.extract(file).ok, false);
    assert.equal(preview.classify(file).kind, 'binary');
    fs.writeFileSync(file, zip('word/document.xml', Buffer.from('tiny'), 17 * 1024 * 1024));
    assert.equal(docx.extract(file).ok, false);
    fs.writeFileSync(file, zip('word/document.xml', Buffer.alloc(16 * 1024 * 1024 + 1, 65), 5));
    assert.equal(docx.extract(file).ok, false);
    assert.equal(preview.classify(root).kind, 'binary');
  });
  await t('IPC accepts safe filenames and preserves sibling and overlapping project roots', async () => {
    ipc.register();
    const dir = makeSkill('ipc/skill');
    fs.writeFileSync(path.join(dir, '..notes.md'), '# Allowed filename');
    const projectRoot = path.join(root, 'ipc', 'project');
    const sibling = path.join(root, 'ipc', 'project-sibling');
    const child = path.join(projectRoot, 'nested');
    fs.mkdirSync(child, { recursive: true });
    store.patch({ products: [{ id: 'p', projectRoots: [projectRoot, child] }], skills: [
      { id: 'read', dir, path: path.join(dir, 'SKILL.md') },
      { id: 'remove', productId: 'p', scope: 'project', dir: path.join(projectRoot, 'one') },
      { id: 'sibling', productId: 'p', scope: 'project', dir: sibling },
      { id: 'nested', productId: 'p', scope: 'project', dir: path.join(child, 'two') },
      { id: 'global', productId: 'p', scope: 'global', dir: path.join(projectRoot, 'global') },
      { id: 'registered', productId: 'p', projectId: 'proj', scope: 'project', dir: path.join(projectRoot, 'registered') }
    ] });
    const invoke = (name, args) => handlers.get(name)({}, args);
    assert.equal(invoke('file:read', { p: path.join(dir, '..notes.md') }).ok, true);
    assert.equal(invoke('file:read', { p: dir }).ok, false);
    assert.equal(invoke('product:removeProjectRoot', { id: 'p', dir: projectRoot }).ok, true);
    assert.deepEqual(store.get().skills.map((s) => s.id), ['read', 'sibling', 'nested', 'global', 'registered']);
    assert.equal(invoke('config:get').data.meta.indexFile, path.join(profile, 'skills.index.md'));
  });
  await t('IPC file reading and AI translation reject physical link escapes', async () => {
    const dir = path.join(root, 'ipc', 'skill');
    const outside = makeSkill('ipc/outside', 'private fixture');
    if (!junction(outside, path.join(dir, 'linked'))) return SKIP;
    const invoke = (name, args) => handlers.get(name)({}, args);
    assert.equal(invoke('file:read', { p: path.join(dir, 'linked', 'SKILL.md') }).ok, false);
    const listed = invoke('skill:files', { id: 'read' }).data;
    assert.equal(listed.some((x) => x.rel.startsWith('linked')), false);
    assert.equal((await invoke('ai:translate', { id: 'read', path: path.join(dir, 'linked', 'SKILL.md') })).ok, false);
  });
  await t('Forced translation bypasses both cache layers and invalidates old alignment', async () => {
    const translate = ai.translateSegments;
    let requests = 0;
    ai.translateSegments = async (texts) => { requests++; return texts.map((text) => `Translated ${requests}: ${text}`); };
    const invoke = (args) => handlers.get('ai:translate')({}, args);
    try {
      const first = await invoke({ id: 'read' });
      assert.equal(first.ok, true, first.error);
      assert.equal(requests, 1);
      const cached = await invoke({ id: 'read' });
      assert.equal(cached.data.cached, true);
      assert.equal(requests, 1);
      const source = skills.readSkill(store.get().skills.find((s) => s.id === 'read').path);
      const lang = store.get().settings.translate.target;
      const model = ai.cfg().model;
      skills.writeAlign(source.hash, lang, model, { 1: [['old', '旧']] });
      const forced = await invoke({ id: 'read', force: true });
      assert.equal(forced.ok, true, forced.error);
      assert.equal(requests, 2);
      assert.equal(forced.data.cached, false);
      assert.ok(Object.values(forced.data.translations).every((text) => text.startsWith('Translated 2:')));
      assert.deepEqual(skills.readAlign(source.hash, lang, model).map, {});
      await invoke({ id: 'read' });
      assert.equal(requests, 2);
    } finally { ai.translateSegments = translate; }
  });
  await t('Organizing preserves nested indexes, references, hidden flags, and annotations', () => {
    const dir = makeSkill('organized/inbox/outer');
    const child = makeSkill('organized/inbox/outer/nested');
    const oldId = scanner.uid(dir);
    const oldChildId = scanner.uid(child);
    const first = scanner.readSkillMeta(dir, 'global', 'organized-product');
    const second = scanner.readSkillMeta(child, 'global', 'organized-product');
    store.patch({ products: [{ id: 'organized-product', hidden: [oldChildId] }], skills: [first, second],
      skillGroups: { [oldChildId]: ['group'] }, ratings: { [oldChildId]: { stars: 5 } },
      favorites: [oldId, oldChildId], detachedSkills: [oldChildId], combos: [{ id: 'combo', skillIds: [oldId] }], scratch: { skillIds: [oldChildId] }
    });
    skills.setAnnotations(oldId, [{ id: 'outer-note', file: 'SKILL.md', text: 'keep outer' }]);
    skills.setAnnotations(oldChildId, [{ id: 'child-note', file: path.join(child, 'reference.md'), text: 'keep child' }]);
    const response = handlers.get('organize:apply')({}, { moves: [{ from: dir, category: 'category' }], targetRoot: path.join(root, 'organized') });
    assert.equal(response.ok, true, response.error);
    assert.equal(response.data.okCount, 1);
    assert.deepEqual(response.data.annotationWarnings, []);
    const newDir = path.join(root, 'organized', 'category', 'outer');
    const newChild = path.join(newDir, 'nested');
    const newId = scanner.uid(newDir);
    const newChildId = scanner.uid(newChild);
    const state = store.get();
    assert.deepEqual(state.skills.map((s) => s.id), [newId, newChildId]);
    assert.equal(state.skills[1].path, path.join(newChild, 'SKILL.md'));
    assert.deepEqual(state.favorites, [newId, newChildId]);
    assert.deepEqual(state.detachedSkills, [newChildId]);
    assert.deepEqual(state.products[0].hidden, [newChildId]);
    assert.deepEqual(state.skillGroups[newChildId], ['group']);
    assert.equal(state.ratings[newChildId].stars, 5);
    assert.deepEqual(state.combos[0].skillIds, [newId]);
    assert.deepEqual(state.scratch.skillIds, [newChildId]);
    assert.equal(skills.getAnnotations(newId)[0].text, 'keep outer');
    assert.equal(skills.getAnnotations(newChildId)[0].file, path.join(newChild, 'reference.md'));
    assert.equal(skills.getAnnotations(oldChildId)[0].text, 'keep child');
  });
}

main().catch((e) => { failed++; console.error(e.message); }).finally(() => {
  Module._load = originalLoad;
  global.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n[unit] ${passed}/${passed + failed} verified; ${skipped} environment skips`);
  process.exitCode = failed ? 1 : 0;
});
