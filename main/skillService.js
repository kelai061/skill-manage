'use strict';
/**
 * skillService.js — skill 文件读写、备份、差异、译文缓存
 *
 * 写权规则（授权门）：
 *   任何写入必须先经过 propose → approve 两步。
 *   approve 时强制先备份原件，再原子替换。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const scanner = require('./scanner');
const storage = require('./translationStorage');

const SKILL_FILE = 'SKILL.md';

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

/* ------------------------------ 读 ------------------------------ */

function readSkill(skillPath) {
  const p = scanner.norm(skillPath);
  if (!p || !fs.existsSync(p)) {
    return { ok: false, error: '文件不存在：' + p };
  }
  let content = '';
  try { content = fs.readFileSync(p, 'utf8'); } catch (e) {
    return { ok: false, error: '读取失败：' + e.message };
  }
  const st = fs.statSync(p);
  return {
    ok: true,
    path: p,
    dir: path.dirname(p),
    content,
    hash: sha1(content),
    mtime: st.mtimeMs,
    bytes: Buffer.byteLength(content, 'utf8')
  };
}

/** Accept files only when both their visible path and link target stay inside the skill. */
function resolveSkillFile(dir, file) {
  const root = scanner.norm(dir);
  const target = scanner.norm(file);
  const contained = (parent, child) => {
    const rel = path.relative(parent, child);
    return !!rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
  };
  if (!root || !target || !contained(root, target) ||
      !contained(fs.realpathSync(root), fs.realpathSync(target)) || !fs.statSync(target).isFile()) {
    throw new Error('该文件不在 skill 目录内，或不是普通文件。');
  }
  return target;
}

/** skill 目录内的附属文件（给阅读器侧栏用，最多 80 条） */
function listFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 2 || out.length >= 80) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      if (e.isSymbolicLink()) continue;
      if (scanner.key(path.join(d, e.name)) === '') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build'].includes(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        out.push({
          name: e.name,
          rel: path.relative(dir, full).split(path.sep).join('/'),
          size
        });
      }
      if (out.length >= 80) return;
    }
  };
  walk(dir, 0);
  out.sort((a, b) => (a.rel === SKILL_FILE ? -1 : b.rel === SKILL_FILE ? 1 : a.rel.localeCompare(b.rel)));
  return out;
}

/* ------------------------------ 备份 ------------------------------ */

function backupFile(filePath) {
  const s = store.get();
  const dir = store.paths.backups;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.basename(path.dirname(filePath)) || 'skill';
  const dest = path.join(dir, `${stamp}-${crypto.randomBytes(4).toString('hex')}__${base}__SKILL.md`);
  fs.copyFileSync(filePath, dest, fs.constants.COPYFILE_EXCL);

  // 只保留最近 N 份
  const max = Math.max(5, s.settings.maxBackups || 50);
  const all = fs.readdirSync(dir)
    .filter((f) => f.endsWith('__SKILL.md'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const extra of all.slice(max)) {
    try { fs.unlinkSync(path.join(dir, extra.f)); } catch { /* ignore */ }
  }
  return dest;
}

/* ------------------------------ 写 ------------------------------ */

function writeSkill(filePath, content, meta = {}) {
  const p = scanner.norm(filePath);
  if (!p || path.basename(p).toLowerCase() !== SKILL_FILE.toLowerCase()) {
    throw new Error('拒绝写入：目标必须是 SKILL.md');
  }
  if (!fs.lstatSync(p).isFile()) throw new Error('拒绝写入：目标必须是普通文件');
  const backup = backupFile(p);
  const tmp = p + `.atelier-${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, p);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already renamed or not created */ }
  }

  store.pushAudit({
    action: 'write',
    file: p,
    backup,
    model: meta.model || '',
    note: meta.note || '',
    size: Buffer.byteLength(content, 'utf8')
  });
  return { ok: true, backup, path: p };
}

/* ------------------------------ 差异 ------------------------------ */

function diffLines(a, b) {
  const A = String(a).replace(/\r\n?/g, '\n').split('\n');
  const B = String(b).replace(/\r\n?/g, '\n').split('\n');
  const n = A.length;
  const m = B.length;

  // LCS 动态规划（SKILL.md 体量下完全够用）
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { rows.push({ t: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ t: 'del', text: A[i] }); i++; }
    else { rows.push({ t: 'add', text: B[j] }); j++; }
  }
  while (i < n) { rows.push({ t: 'del', text: A[i] }); i++; }
  while (j < m) { rows.push({ t: 'add', text: B[j] }); j++; }

  // 折叠未变更的大段，只保留变更前后各 3 行上下文
  const KEEP = 3;
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, idx) => {
    if (r.t !== 'same') {
      for (let k = Math.max(0, idx - KEEP); k <= Math.min(rows.length - 1, idx + KEEP); k++) keep[k] = true;
    }
  });

  const out = [];
  let skipped = 0;
  rows.forEach((r, idx) => {
    if (keep[idx]) {
      if (skipped) { out.push({ t: 'skip', count: skipped }); skipped = 0; }
      out.push(r);
    } else skipped++;
  });
  if (skipped) out.push({ t: 'skip', count: skipped });

  const added = rows.filter((r) => r.t === 'add').length;
  const removed = rows.filter((r) => r.t === 'del').length;
  return { rows: out, added, removed };
}

/* ---------------------------- 译文缓存 ---------------------------- */

function safePart(value) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('缓存或批注标识无效');
  return text;
}

function writeJson(file, payload) {
  const tmp = file + `.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already renamed or not created */ }
  }
}

function cachePath(hash, lang, model) {
  return path.join(store.paths.translations, `${safePart(hash)}__${safePart(lang)}__${sha1(model).slice(0, 8)}.json`);
}

function readCache(hash, lang, model) {
  const p = cachePath(hash, lang, model);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeCache(hash, lang, model, payload) {
  fs.mkdirSync(store.paths.translations, { recursive: true });
  writeJson(cachePath(hash, lang, model), payload);
  return payload;
}

function clearCache() {
  const dir = store.paths.translations;
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of files) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
  return files.length;
}

/* ---------------------------- 段级译文缓存 ---------------------------- */
/**
 * 段级缓存：key = sha1(原文段落) + 语言 + 模型。
 * 作用：文件小改一次，只重译改动的那几段，其余直接命中。
 */
function segCachePath(lang, model) {
  return path.join(store.paths.translations, `seg-${safePart(lang)}-${sha1(model).slice(0, 8)}.json`);
}

function loadSegCache(lang, model) {
  try {
    const map = JSON.parse(fs.readFileSync(segCachePath(lang, model), 'utf8'));
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

function saveSegCache(lang, model, map) {
  fs.mkdirSync(store.paths.translations, { recursive: true });
  writeJson(segCachePath(lang, model), map);
}

/** 用段级缓存拼出整份译文；misses 交给调用方去调接口 */
function splitBySegCache(texts, lang, model) {
  if (model === storage.AGENT_MODEL) {
    const list = new Array(texts.length), missIdx = [], grouped = new Map();
    texts.forEach((text, index) => {
      const key = sha1(text), file = storage.agentFile(store.paths.translations, lang, key);
      if (!grouped.has(file)) grouped.set(file, []);
      grouped.get(file).push({ key, index });
    });
    for (const [file, entries] of grouped) {
      const map = storage.readMap(file);
      for (const { key, index } of entries) {
        if (typeof map[key] === 'string' && map[key].trim()) list[index] = map[key];
        else missIdx.push(index);
      }
    }
    missIdx.sort((a, b) => a - b);
    return { map: {}, list, missIdx };
  }
  const map = loadSegCache(lang, model);
  const list = new Array(texts.length);
  const missIdx = [];
  texts.forEach((t, i) => {
    const k = sha1(t);
    if (Object.prototype.hasOwnProperty.call(map, k) && typeof map[k] === 'string') list[i] = map[k];
    else missIdx.push(i);
  });
  return { map, list, missIdx };
}

function commitSegCache(map, lang, model, texts, translated) {
  if (model === storage.AGENT_MODEL) {
    return storage.withLock(store.paths.translations, () => {
      const grouped = new Map();
      texts.forEach((text, index) => {
        if (typeof translated[index] !== 'string' || !translated[index].trim()) return;
        const key = sha1(text), file = storage.agentFile(store.paths.translations, lang, key);
        if (!grouped.has(file)) grouped.set(file, {});
        grouped.get(file)[key] = translated[index];
      });
      for (const [file, values] of grouped) storage.writeJson(file, { ...storage.readMap(file), ...values });
    });
  }
  // Another translation can finish while this request is awaiting its response.
  map = { ...map, ...loadSegCache(lang, model) };
  for (let i = 0; i < texts.length; i++) {
    if (translated[i] !== undefined) map[sha1(texts[i])] = translated[i];
  }
  saveSegCache(lang, model, map);
}

function removeSegCache(texts, lang, model) {
  if (model === storage.AGENT_MODEL) {
    return storage.withLock(store.paths.translations, () => {
      const grouped = new Map();
      for (const text of texts) {
        const key = sha1(text), file = storage.agentFile(store.paths.translations, lang, key);
        if (!grouped.has(file)) grouped.set(file, []);
        grouped.get(file).push(key);
      }
      for (const [file, keys] of grouped) {
        const map = storage.readMap(file);
        for (const key of keys) delete map[key];
        storage.writeJson(file, map);
      }
    });
  }
  const map = loadSegCache(lang, model);
  for (const text of texts) delete map[sha1(text)];
  saveSegCache(lang, model, map);
}

/* ---------------------------- 词级对齐缓存 ---------------------------- */
/**
 * 对齐缓存与译文缓存同目录、同命名规则，只是前缀不同：
 *   align-<原文hash>__<lang>__<model>.json
 * 内容：{ v, hash, dstHash, lang, model, at, map: { "段落编号": [["源词","译词"], ...] } }
 *
 * 012 轮起缓存必须绑定「实际译文内容 + 算法版本」：
 *   - 原文没变、译文重译过 → 旧词对可能指向错位置，必须失效；
 *   - 算法升级 → 旧格式不再可信；
 *   - 只改译文而源文不变时，译文 hash 变化同样触发重建。
 */
const ALIGN_VERSION = 2;

function alignPath(hash, lang, model) {
  return path.join(store.paths.translations, `align-${safePart(hash)}__${safePart(lang)}__${sha1(model).slice(0, 8)}.json`);
}

function readAlign(hash, lang, model, dstHash) {
  try {
    const data = JSON.parse(fs.readFileSync(alignPath(hash, lang, model), 'utf8'));
    if (!data || data.v !== ALIGN_VERSION) return null;
    if (!data.map || typeof data.map !== 'object' || Array.isArray(data.map)) return null;
    if (dstHash && data.dstHash && data.dstHash !== dstHash) return null;
    return data;
  } catch {
    return null;
  }
}

function writeAlign(hash, lang, model, map, dstHash = '') {
  fs.mkdirSync(store.paths.translations, { recursive: true });
  const payload = { v: ALIGN_VERSION, hash, lang, model, dstHash, at: Date.now(), map };
  writeJson(alignPath(hash, lang, model), payload);
  return payload;
}

/* ---------------------------- 标记（高亮/批注） ---------------------------- */

function annotationPath(skillId) {
  return path.join(store.paths.annotations, `${safePart(skillId)}.json`);
}

function getAnnotations(skillId) {
  try { return JSON.parse(fs.readFileSync(annotationPath(skillId), 'utf8')); } catch { return []; }
}

function setAnnotations(skillId, list) {
  fs.mkdirSync(store.paths.annotations, { recursive: true });
  writeJson(annotationPath(skillId), list || []);
  return list || [];
}

/** Copy annotations to moved IDs, retaining the old files as a recovery copy. */
function remapAnnotations(pairs) {
  const warnings = [];
  for (const { oldId, newId, oldDir, newDir } of pairs || []) {
    if (!oldId || !newId || oldId === newId) continue;
    try {
      const source = annotationPath(oldId);
      if (!fs.existsSync(source)) continue;
      const old = JSON.parse(fs.readFileSync(source, 'utf8'));
      const target = annotationPath(newId);
      const current = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : [];
      if (!Array.isArray(old) || !Array.isArray(current)) throw new Error('批注数据格式异常');
      const ids = new Set(current.map((entry) => entry && entry.id).filter(Boolean));
      const combined = [...current];
      for (let entry of old) {
        if (entry && entry.id && ids.has(entry.id)) continue;
        if (entry && typeof entry.file === 'string' && path.isAbsolute(entry.file) && oldDir && newDir) {
          const rel = path.relative(oldDir, entry.file);
          if (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)) entry = { ...entry, file: path.join(newDir, rel) };
        }
        combined.push(entry);
        if (entry && entry.id) ids.add(entry.id);
      }
      setAnnotations(newId, combined);
    } catch (e) {
      warnings.push({ oldId, newId, error: e.message });
    }
  }
  return warnings;
}

module.exports = {
  readSkill, resolveSkillFile, listFiles, writeSkill, backupFile,
  diffLines, readCache, writeCache, clearCache,
  splitBySegCache, commitSegCache, removeSegCache, segCachePath,
  readAlign, writeAlign, ALIGN_VERSION,
  getAnnotations, setAnnotations, remapAnnotations, sha1
};
