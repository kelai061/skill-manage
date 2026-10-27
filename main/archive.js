'use strict';
// Portable product archives contain skill files, never machine-specific paths or API settings.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const scanner = require('./scanner');
const importer = require('./importer');
const KIND = 'skill-atelier-product';
const manifestName = 'skill-atelier-product.json';
const clean = (s) => {
  const name = String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[ .]+$/g, '').slice(0, 120) || 'skills';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) ? '_' + name : name;
};
function withTemp(fn) { const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-archive-')); try { return fn(temp); } finally { fs.rmSync(temp, { recursive: true, force: true }); } }
function copyTree(src, dest) {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) throw new Error('技能包含符号链接，无法安全打包');
  if (stat.isDirectory()) { fs.mkdirSync(dest, { recursive: true }); for (const e of fs.readdirSync(src)) { if (e !== '.git' && e !== 'node_modules') copyTree(path.join(src, e), path.join(dest, e)); } }
  else if (stat.isFile()) fs.copyFileSync(src, dest);
}
function reserve(parent, name) {
  for (let i = 1; ; i++) {
    const dest = path.join(parent, clean(name) + (i === 1 ? '' : `-${i}`));
    try { fs.mkdirSync(dest); return dest; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}
function zipDirectory(dir, zipPath) {
  const quote = (s) => String(s).replace(/'/g, "''");
  // Windows PowerShell uses .NET Framework: ordinary paths are limited to
  // MAX_PATH even when Node can read the files. Extended paths keep deeply
  // nested skill assets intact without requiring a system-wide setting.
  const source = path.toNamespacedPath(path.resolve(dir));
  const dest = path.toNamespacedPath(path.resolve(zipPath));
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${quote(source)}', '${quote(dest)}')`;
  try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe', timeout: 120000 }); }
  catch (error) { throw new Error('创建 ZIP 失败，请检查技能文件是否可读及磁盘空间是否充足。', { cause: error }); }
}
function exportProduct(product, skills, file) {
  if (!product) throw new Error('请选择要导出的产品');
  return withTemp((temp) => {
    const payload = path.join(temp, 'payload'); const content = path.join(payload, 'skills'); fs.mkdirSync(content, { recursive: true });
    const selected = (skills || []).filter(s => s.productId === product.id && s.dir);
    if (selected.some(s => !fs.existsSync(s.dir))) throw new Error('部分技能目录不存在，请重新扫描产品后再导出。');
    const dirs = [...new Set(selected.map(s => path.resolve(s.dir)))];
    // Copy top-level skills only; nested skills travel inside their parent.
    const top = dirs.filter(d => !dirs.some(p => p !== d && d.toLowerCase().startsWith(p.toLowerCase() + path.sep)));
    const roots = (product.manualRoots || []).map(x => path.resolve(x.root)).filter(x => fs.existsSync(x));
    for (const dir of top) {
      const root = roots.find(r => dir.toLowerCase().startsWith(r.toLowerCase() + path.sep));
      let rel = root ? path.relative(root, dir) : path.basename(dir);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) rel = path.basename(dir);
      let dest = path.join(content, rel); fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) dest = reserve(path.dirname(dest), path.basename(dest));
      copyTree(dir, dest);
    }
    fs.writeFileSync(path.join(payload, manifestName), JSON.stringify({ kind: KIND, version: 1, name: product.name || '技能产品', skillCount: dirs.length }, null, 2));
    const temporaryZip = path.join(temp, 'product.zip'); zipDirectory(payload, temporaryZip);
    fs.copyFileSync(temporaryZip, file); return { skills: dirs.length, path: file };
  });
}
function inspectExtracted(out) {
  const mf = path.join(out, manifestName);
  if (fs.existsSync(mf)) {
    const data = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (data.kind !== KIND || data.version !== 1 || typeof data.name !== 'string') throw new Error('产品压缩包格式无效');
    const content = path.join(out, 'skills');
    if (!fs.existsSync(content) || !fs.statSync(content).isDirectory()) throw new Error('产品压缩包缺少技能目录');
    return { kind: 'product', name: data.name, skillCount: scanner.walkAllSkillDirs(content, 12).length, content };
  }
  const dirs = scanner.walkAllSkillDirs(out, 12);
  if (!dirs.length) throw new Error('压缩包中没有发现 SKILL.md');
  return { kind: 'skills', skillCount: dirs.length, dirs };
}
function inspect(file) { return withTemp(temp => { const out = path.join(temp, 'out'); importer.unzip(file, out); const r = inspectExtracted(out); return { kind: r.kind, name: r.name || '', skillCount: r.skillCount }; }); }
function importZip(file, parent, expectedKind) {
  if (!parent || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error('请先选择有效的目标目录');
  return withTemp(temp => {
    const out = path.join(temp, 'out'); importer.unzip(file, out); const info = inspectExtracted(out);
    if (expectedKind && expectedKind !== info.kind) throw new Error('压缩包内容已变化，请重新识别');
    const created = [];
    try {
      if (info.kind === 'product') {
        const dest = reserve(parent, info.name); created.push(dest); copyTree(info.content, dest);
        return { kind: info.kind, name: info.name, root: dest, skillCount: info.skillCount };
      }
      // Keep nested skills together rather than importing the same files twice.
      const dirs = info.dirs.filter(d => !info.dirs.some(p => p !== d && d.startsWith(p + path.sep)));
      for (const dir of dirs) { const dest = reserve(parent, path.basename(dir)); created.push(dest); copyTree(dir, dest); }
      return { kind: info.kind, root: parent, skillCount: info.skillCount, imported: created };
    } catch (e) { for (const p of created) fs.rmSync(p, { recursive: true, force: true }); throw e; }
  });
}
module.exports = { exportProduct, inspect, importZip, KIND };
