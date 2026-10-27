'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const archive = require('../main/archive');
const scanner = require('../main/scanner');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-zip-test-'));
const quote = s => s.replace(/'/g, "''");
function zipFile(dest, entries) {
  const lines = entries.map(([name, data, attr]) => `$e=$z.CreateEntry('${quote(name)}'); ${attr == null ? '' : `$e.ExternalAttributes=${attr};`} $w=New-Object System.IO.StreamWriter($e.Open()); $w.Write('${quote(data)}'); $w.Dispose()`);
  execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', `Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::Open('${quote(dest)}',[System.IO.Compression.ZipArchiveMode]::Create); try { ${lines.join('; ')} } finally { $z.Dispose() }`], {stdio:'pipe'});
}
try {
  const source = path.join(root, 'source'), target = path.join(root, 'target'); fs.mkdirSync(source); fs.mkdirSync(target);
  const dir = path.join(source, 'collection', 'alpha'); fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: alpha\ndescription: test\n---\n');
  fs.writeFileSync(path.join(dir, 'extra.txt'), 'content');
  const nested = path.join(dir, 'nested'); fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'SKILL.md'), 'nested');
  const product = {id:'p', name:'示例', manualRoots:[{root:source}]};
  const productZip = path.join(root, 'product.zip');
  const exported = archive.exportProduct(product, [{productId:'p',dir}, {productId:'p',dir:nested}], productZip);
  assert.equal(exported.skills, 2);
  assert.deepEqual(archive.inspect(productZip), {kind:'product', name:'示例', skillCount:2});
  let imported = archive.importZip(productZip, target, 'product');
  assert.equal(fs.readFileSync(path.join(imported.root, 'collection','alpha','extra.txt'),'utf8'), 'content');
  assert.ok(fs.existsSync(path.join(imported.root, 'collection','alpha','nested','SKILL.md')));
  const scan = scanner.scanProduct({id:'imported', thirdParty:true, launchPath:imported.root, manualRoots:[{root:imported.root,kind:'global'}]});
  assert.equal(scan.skills.length, 2);
  const second = archive.importZip(productZip, target, 'product'); assert.notEqual(second.root, imported.root);
  assert.throws(() => archive.importZip(productZip, target, 'skills'), /变化/);
  // The Windows PowerShell ZIP implementation must handle deep asset paths,
  // not only the much shorter skill directories in the index.
  let deep = dir;
  for (let i = 0; i < 9; i++) { deep = path.join(deep, `proof-${i}-abcdefghijklmnopqrst`); fs.mkdirSync(deep); }
  const deepFile = path.join(deep, 'receipt-中文.json');
  fs.writeFileSync(deepFile, 'long path content');
  if (process.platform === 'win32') assert.ok(deepFile.length > 260);
  const deepZip = path.join(root, 'long.zip');
  archive.exportProduct(product, [{productId:'p',dir}], deepZip);
  assert.equal(archive.inspect(deepZip).skillCount, 2);
  const deepImported = archive.importZip(deepZip, target, 'product');
  assert.equal(fs.readFileSync(path.join(deepImported.root, 'collection', 'alpha', path.relative(dir, deepFile)), 'utf8'), 'long path content');
  assert.throws(() => archive.exportProduct(product, [{productId:'p',dir:path.join(root,'missing')}], path.join(root,'missing.zip')), /不存在/);
  const singleZip = path.join(root, 'single.zip'); zipFile(singleZip, [['alpha/SKILL.md','test'], ['alpha/readme.txt','original']]);
  const single = archive.importZip(singleZip, target, 'skills');
  assert.equal(fs.readFileSync(path.join(single.imported[0], 'readme.txt'),'utf8'), 'original');
  const again = archive.importZip(singleZip, target, 'skills'); assert.notEqual(single.imported[0], again.imported[0]);
  assert.equal(fs.readFileSync(path.join(single.imported[0], 'readme.txt'),'utf8'), 'original');
  const evil = path.join(root,'evil.zip'); zipFile(evil, [['../escaped.txt','bad'], ['x/SKILL.md','bad']]);
  const before = fs.readdirSync(target).sort(); assert.throws(() => archive.importZip(evil, target));
  assert.deepEqual(fs.readdirSync(target).sort(), before); assert.equal(fs.existsSync(path.join(root,'escaped.txt')), false);
  const link = path.join(root,'link.zip'); zipFile(link, [['x/SKILL.md','test'], ['x/link','target', -1610612736]]);
  assert.throws(() => archive.importZip(link, target)); assert.deepEqual(fs.readdirSync(target).sort(), before);
  const invalid = path.join(root,'invalid.zip'); fs.writeFileSync(invalid, 'not a zip'); assert.throws(() => archive.importZip(invalid, target));
  assert.deepEqual(fs.readdirSync(target).sort(), before);
  console.log('archive tests passed');
} finally { fs.rmSync(root, {recursive:true, force:true}); }
