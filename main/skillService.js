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

/** skill 目录内的附属文件（给阅读器侧栏用，最多 80 条） */
function listFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 2 || out.length > 80) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      if (scanner.key(path.join(d, e.name)) === '') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build'].includes(e.name)) continue;
        walk(full, depth + 1);
      } else {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        out.push({
          name: e.name,
          rel: path.relative(dir, full).split(path.sep).join('/'),
          size
        });
      }
      if (out.length > 80) return;
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
  const dest = path.join(dir, `${stamp}__${base}__SKILL.md`);
  fs.copyFileSync(filePath, dest);

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
  const backup = backupFile(p);
  const tmp = p + '.atelier.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);

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

function cachePath(hash, lang, model) {
  return path.join(store.paths.translations, `${hash}__${lang}__${sha1(model).slice(0, 8)}.json`);
}

function readCache(hash, lang, model) {
  const p = cachePath(hash, lang, model);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeCache(hash, lang, model, payload) {
  fs.mkdirSync(store.paths.translations, { recursive: true });
  fs.writeFileSync(cachePath(hash, lang, model), JSON.stringify(payload), 'utf8');
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
  return path.join(store.paths.translations, `seg-${lang}-${sha1(model).slice(0, 8)}.json`);
}

function loadSegCache(lang, model) {
  try {
    return JSON.parse(fs.readFileSync(segCachePath(lang, model), 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveSegCache(lang, model, map) {
  fs.mkdirSync(store.paths.translations, { recursive: true });
  fs.writeFileSync(segCachePath(lang, model), JSON.stringify(map), 'utf8');
}

/** 用段级缓存拼出整份译文；misses 交给调用方去调接口 */
function splitBySegCache(texts, lang, model) {
  const map = loadSegCache(lang, model);
  const list = new Array(texts.length);
  const missIdx = [];
  texts.forEach((t, i) => {
    const k = sha1(t);
    if (Object.prototype.hasOwnProperty.call(map, k)) list[i] = map[k];
    else missIdx.push(i);
  });
  return { map, list, missIdx };
}

function commitSegCache(map, lang, model, texts, translated) {
  for (let i = 0; i < texts.length; i++) {
    if (translated[i] !== undefined) map[sha1(texts[i])] = translated[i];
  }
  saveSegCache(lang, model, map);
}

/* ---------------------------- 词级对齐缓存 ---------------------------- */
/**
 * 对齐缓存与译文缓存同目录、同命名规则，只是前缀不同：
 *   align-<原文hash>__<lang>__<model>.json
 * 内容：{ hash, lang, model, at, map: { "段落编号": [["源词","译词"], ...] } }
 */
function alignPath(hash, lang, model) {
  return path.join(store.paths.translations, `align-${hash}__${lang}__${sha1(model).slice(0, 8)}.json`);
}

function readAlign(hash, lang, model) {
  try { return JSON.parse(fs.readFileSync(alignPath(hash, lang, model), 'utf8')); } catch { return null; }
}

function writeAlign(hash, lang, model, map) {
  fs.mkdirSync(store.paths.translations, { recursive: true });
  const payload = { hash, lang, model, at: Date.now(), map };
  fs.writeFileSync(alignPath(hash, lang, model), JSON.stringify(payload), 'utf8');
  return payload;
}

/* ---------------------------- 标记（高亮/批注） ---------------------------- */

function annotationPath(skillId) {
  return path.join(store.paths.annotations, `${skillId}.json`);
}

function getAnnotations(skillId) {
  try { return JSON.parse(fs.readFileSync(annotationPath(skillId), 'utf8')); } catch { return []; }
}

function setAnnotations(skillId, list) {
  fs.mkdirSync(store.paths.annotations, { recursive: true });
  fs.writeFileSync(annotationPath(skillId), JSON.stringify(list || [], null, 2), 'utf8');
  return list || [];
}

module.exports = {
  readSkill, listFiles, writeSkill, backupFile,
  diffLines, readCache, writeCache, clearCache,
  splitBySegCache, commitSegCache,
  readAlign, writeAlign,
  getAnnotations, setAnnotations, sha1
};
