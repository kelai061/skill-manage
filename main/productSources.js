'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { identifyProduct } = require('./productIdentity');
const { cmp } = require('./updater');
// Electron patches fs to treat .asar as a directory. Read the archive bytes via
// original-fs, otherwise desktop detection can differ from Node regression tests.
let archiveFs = fs;
try { archiveFs = require('original-fs'); } catch { /* plain Node */ }

function dirs(base) {
  try { return fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).slice(0, 500).map((e) => path.join(base, e.name)); }
  catch { return []; }
}
function json(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function within(base, file) {
  const relative = path.relative(path.resolve(base), path.resolve(file));
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function installDir(launch) {
  try { return fs.statSync(launch).isFile() ? path.dirname(launch) : launch; } catch { return ''; }
}

function zcodeRoots(home, launch) {
  const plugins = new Map();
  const cache = path.join(home, '.zcode', 'cli', 'plugins', 'cache');
  const add = (dir, cached) => {
    const manifest = json(path.join(dir, '.zcode-plugin', 'plugin.json'));
    const id = manifest?.name || path.basename(dir).replace(/-plugin$/, '');
    const skillPaths = typeof manifest?.skills === 'string' ? [manifest.skills] : Array.isArray(manifest?.skills) ? manifest.skills : ['skills'];
    const roots = skillPaths.filter((s) => typeof s === 'string').map((s) => path.resolve(dir, s))
      .filter((r) => within(dir, r) && fs.existsSync(r));
    if (!roots.length) return;
    const previous = plugins.get(id);
    if (!previous || (cached && !previous.cached)) plugins.set(id, { roots, cached });
  };
  // A marketplace records its selected cache version. Do not index stale versions.
  const referenced = new Set();
  for (const market of dirs(path.join(home, '.zcode', 'cli', 'plugins', 'marketplaces'))) {
    const catalog = json(path.join(market, 'marketplace.json'));
    for (const plugin of Array.isArray(catalog?.plugins) ? catalog.plugins : []) {
      if (typeof plugin.cachePath !== 'string' || !within(cache, plugin.cachePath)) continue;
      if (!fs.existsSync(plugin.cachePath)) continue;
      referenced.add(path.dirname(plugin.cachePath).toLowerCase());
      add(plugin.cachePath, true);
    }
  }
  // Locally installed marketplaces may not contain a catalog; take one version.
  for (const market of dirs(cache)) for (const plugin of dirs(market)) {
    if (referenced.has(plugin.toLowerCase())) continue;
    const versions = dirs(plugin).sort((a, b) => {
      try { return cmp(path.basename(b), path.basename(a)); } catch { return path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }); }
    });
    if (versions[0]) add(versions[0], true);
  }
  const install = installDir(launch);
  if (install) for (const plugin of dirs(path.join(install, 'resources', 'glm', 'packages'))) add(plugin, false);
  return [...plugins.values()].flatMap((p) => p.roots);
}

/** Read only bounded archive entries. Never load or execute another app's code. */
function readAsarScripts(archive) {
  let fd;
  try {
    fd = archiveFs.openSync(archive, 'r');
    const prefix = Buffer.alloc(16);
    if (archiveFs.readSync(fd, prefix, 0, 16, 0) !== 16) return [];
    const size = prefix.readUInt32LE(12);
    if (size < 2 || size > 16 * 1024 * 1024) return [];
    const header = Buffer.alloc(size);
    if (archiveFs.readSync(fd, header, 0, size, 16) !== size) return [];
    const tree = JSON.parse(header.toString('utf8'));
    const base = 8 + prefix.readUInt32LE(4);
    const results = [];
    let total = 0;
    const visit = (node, dir = '') => {
      if (results.length >= 100) return;
      for (const [name, entry] of Object.entries(node.files || {})) {
        const file = dir ? dir + '/' + name : name;
        if (name === 'node_modules' || entry.link || entry.unpacked) continue;
        if (entry.files) { visit(entry, file); continue; }
        const bytes = Number(entry.size), offset = Number(entry.offset);
        if (!/\.(?:c?js|mjs)$/.test(name) || !(bytes > 0 && bytes <= 24 * 1024 * 1024) || !Number.isSafeInteger(offset) || offset < 0) continue;
        if ((total += bytes) > 48 * 1024 * 1024) return;
        const data = Buffer.alloc(bytes);
        if (archiveFs.readSync(fd, data, 0, bytes, base + offset) === bytes) results.push({ file, text: data.toString('utf8') });
      }
    };
    visit(tree);
    return results;
  } catch { return []; }
  finally { if (fd !== undefined) archiveFs.closeSync(fd); }
}

function embeddedKimi(launch) {
  const install = installDir(launch);
  if (!install) return [];
  const archive = path.join(install, 'resources', 'app.asar');
  let stat;
  try { stat = archiveFs.statSync(archive); } catch { return []; }
  const signature = `${archive}|${stat.size}|${stat.mtimeMs}`;
  if (embeddedKimi.cached?.signature === signature) return embeddedKimi.cached.skills;
  const skills = new Map();
  for (const script of readAsarScripts(archive)) {
    const variables = new Map();
    // Rollup/rolldown raw Markdown imports are JSON string literals in known regions.
    const raw = /\/\/#region [^\r\n]*[\\/]features[\\/]skill[\\/]catalog[\\/]builtin[\\/]([^\r\n]+\.md)\r?\n(?:var|const)\s+([\w$]+)\s*=\s*("(?:\\[\s\S]|[^"\\])*")\s*;/g;
    for (const match of script.text.matchAll(raw)) {
      if (match[3].length > 2 * 1024 * 1024) continue;
      try {
        const content = JSON.parse(match[3]);
        if (typeof content === 'string' && /^---\r?\n/.test(content)) variables.set(match[2], { content, rawPath: match[1].replace(/\\/g, '/') });
      } catch { /* unsupported literal; never eval */ }
    }
    for (const [variable, item] of variables) {
      const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const sub = new RegExp(`makeBuiltin\\(\\s*${escaped}\\s*,\\s*"([a-z0-9._-]+)"\\s*,\\s*"(builtin:\\/\\/[^\"]+)"`, 'i').exec(script.text);
      const name = sub?.[1] || /^name:\s*["']?([^\r\n"']+)/m.exec(item.content)?.[1]?.trim();
      if (!name || !/^[a-z0-9._-]+$/i.test(name)) continue;
      skills.set(name, { name, content: item.content, sourcePath: `${archive}#${sub?.[2] || 'builtin://' + name}`, archive,
        sourceLabel: 'Kimi 内置技能（程序包）', readOnly: true });
    }
  }
  const result = [...skills.values()];
  embeddedKimi.cached = { signature, skills: result };
  return result;
}

function materialize(skill, cacheDir) {
  const id = crypto.createHash('sha256').update(skill.sourcePath).digest('hex').slice(0, 24);
  const dir = path.join(cacheDir, 'embedded-skills', 'kimi', id);
  const file = path.join(dir, 'SKILL.md');
  fs.mkdirSync(dir, { recursive: true });
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* new cache entry */ }
  if (current !== skill.content) fs.writeFileSync(file, skill.content, 'utf8');
  return dir;
}

function embeddedSkills(product) { return identifyProduct(product) === 'kimi' ? embeddedKimi(product.launchPath) : []; }
module.exports = { zcodeRoots, embeddedSkills, materialize, readAsarScripts };
