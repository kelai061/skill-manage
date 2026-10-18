'use strict';
/**
 * unit-files.cjs — 附属文件分类的离线单测（不启动 Electron）
 *
 * 重点验证：图片不会被当文本读、docx 能抽出正文、二进制不会变成乱码。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const preview = require('../main/filePreview');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-files-'));
let pass = 0;
const fails = [];

function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fails.push(name); console.log(`  ✗ ${name}\n    ${e.message}`); }
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return ~c >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const cds = [];
  let off = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, n, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(n.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(off, 42);
    cds.push(cd, n);
    off += 30 + n.length + comp.length;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
fs.writeFileSync(path.join(dir, 'dot.png'), PNG);
fs.writeFileSync(path.join(dir, 'main.py'), 'print("hi")\n# 中文注释\n');
fs.writeFileSync(path.join(dir, 'notes.md'), '# 标题\n\n正文\n');
fs.writeFileSync(path.join(dir, 'raw.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
fs.writeFileSync(path.join(dir, 'book.xlsx'), makeZip([['xl/workbook.xml', Buffer.from('<x/>')]]));
fs.writeFileSync(path.join(dir, 'doc.docx'), makeZip([['word/document.xml', Buffer.from(
  '<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>'
)]]));

console.log('\n[unit] 附属文件分类');

t('图片 → image + data URL', () => {
  const r = preview.classify(path.join(dir, 'dot.png'));
  assert.equal(r.kind, 'image');
  assert.ok(r.dataUrl.startsWith('data:image/png;base64,'));
});

t('Python → code', () => {
  const r = preview.classify(path.join(dir, 'main.py'));
  assert.equal(r.kind, 'code');
  assert.ok(r.lines >= 2);
});

t('Markdown → md', () => {
  assert.equal(preview.classify(path.join(dir, 'notes.md')).kind, 'md');
});

t('含 NUL 的文件 → binary，不返回内容', () => {
  const r = preview.classify(path.join(dir, 'raw.bin'));
  assert.equal(r.kind, 'binary');
  assert.equal(r.content, undefined);
});

t('xlsx → binary 且给出原因', () => {
  const r = preview.classify(path.join(dir, 'book.xlsx'));
  assert.equal(r.kind, 'binary');
  assert.ok(/Excel/.test(r.hint || ''), r.hint);
});

t('docx → 抽出正文', () => {
  const r = preview.classify(path.join(dir, 'doc.docx'));
  assert.equal(r.kind, 'docx');
  assert.ok(r.content.includes('第一段') && r.content.includes('第二段'), r.content);
});

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n[unit] ${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
