'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('original-fs');
module.exports = async ({ app, win, delay, shot }) => {
  const base = path.join(app.getPath('userData'), 'source-fixtures');
  fs.mkdirSync(path.join(base, 'Kimi Code/resources'), { recursive: true });
  const exe = path.join(base, 'Kimi Code/Kimi Code.exe'); fs.writeFileSync(exe, 'fixture only');
  const text = '---\nname: kimi-fixture\ndescription: Kimi builtin fixture\n---\n\n# Builtin\n\nReadonly plain Markdown.\n';
  const script = Buffer.from(`//#region raw:/features/skill/catalog/builtin/help.md\nvar help_default = ${JSON.stringify(text)};\nthrow new Error('Never execute');`);
  const tree = Buffer.from(JSON.stringify({ files: { 'main.cjs': { size: script.length, offset: '0' } } }));
  const size = Math.ceil((tree.length + 8) / 4) * 4;
  const prefix = Buffer.alloc(8 + size); prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(size, 4);
  prefix.writeUInt32LE(size - 4, 8); prefix.writeUInt32LE(tree.length, 12); tree.copy(prefix, 16);
  const archive = path.join(base, 'Kimi Code/resources/app.asar'); fs.writeFileSync(archive, Buffer.concat([prefix, script]));
  const scanner = require(path.join(app.getAppPath(), 'main/scanner'));
  const store = require(path.join(app.getAppPath(), 'main/store'));
  const options = { home: path.join(base, 'home'), cacheDir: app.getPath('userData') };
  const product = { id: 'kimi-fixture-product', name: 'Kimi Code', launchPath: exe, projects: [] };
  assert.equal(scanner.probe(exe, options).totalSkills, 1);
  const scanned = scanner.scanProduct(product, options);
  assert.equal(scanned.skills.length, 1); assert.equal(scanned.skills[0].readOnly, true);
  store.get().products.push(product); store.get().skills.push(...scanned.skills); store.save();
  const id = scanned.skills[0].id;
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const read = await js(`window.atelier.call('skill:read',{id:${JSON.stringify(id)}})`);
  assert.equal(read.ok, true);
  for (const channel of ['ai:propose', 'skill:delete']) {
    const result = await js(`window.atelier.call(${JSON.stringify(channel)},{id:${JSON.stringify(id)},instruction:'test'})`);
    assert.equal(result.ok, false); assert.match(result.error, /只读/);
  }
  await js(`(async()=>{const {refresh,state}=await import('app://local/js/state.js');await refresh('data');state.productId='kimi-fixture-product';window.__goto('skills');return true;})()`);
  await delay(350);
  assert.match(await js('document.body.textContent'), /内置 · 只读/);
  await shot('kimi-builtin-readonly');
  assert.equal(fs.readFileSync(scanned.skills[0].path, 'utf8'), text);
  console.log('[PASS] Electron raw ASAR inventory, readable builtin cache, readonly write/delete gates and card badge');
  return { ok: true };
};
