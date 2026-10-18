'use strict';
/**
 * agentSources.js — 从「智能体工具自己」的数据里读出它的项目 / 工作区列表
 *
 * 为什么不靠扫盘：用户要的不是「磁盘上像项目的文件夹」，
 * 而是「这个 agent 里真的存在的项目」。这两个集合差别很大 ——
 * 工具里可能挂着一个空项目（0 个 skill），磁盘扫描永远看不见它。
 *
 * 每个适配器只做两件事：定位该工具的元数据文件 → 读出绝对路径。
 * 全程只读，不改动任何外部文件；读不到就返回空数组，绝不抛错。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const home = os.homedir();
const appdata = process.env.APPDATA || '';
const localappdata = process.env.LOCALAPPDATA || '';

/* ------------------------------ 小工具 ------------------------------ */

/** file:///d%3A/AI/x → D:\AI\x */
function uriToPath(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^file:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      let p = decodeURIComponent(url.pathname || '');
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      return path.normalize(p);
    } catch {
      return '';
    }
  }
  return path.isAbsolute(s) ? path.normalize(s) : '';
}

/** 只读打开 sqlite；失败（被占用 / 无 node:sqlite）返回 null */
function openDb(file) {
  try {
    // eslint-disable-next-line global-require
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

/**
 * 读 sqlite。**绝不直接打开源库**。
 *
 * 原因：源库多半是 WAL 模式，而且工具正在运行。即使 `readOnly: true`，
 * SQLite 仍会去创建 / 触碰 `-shm`、`-wal` 两个边车文件 —— 那就是在用户的
 * 数据目录里写东西，违反「全程只读」。
 *
 * 做法：把主库和边车一起复制到临时目录，读副本；读完连临时目录一起删。
 * 复制失败（被独占锁）时返回空数组，宁可少发现几个项目，也不碰源文件。
 */
function sqliteRows(file, sql) {
  if (!file || !fs.existsSync(file)) return [];
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-db-'));
    const copy = path.join(dir, path.basename(file));
    fs.copyFileSync(file, copy);
    for (const ext of ['-wal', '-shm']) {
      const src = file + ext;
      if (fs.existsSync(src)) {
        try { fs.copyFileSync(src, copy + ext); } catch { /* 边车复制失败不致命 */ }
      }
    }
    const db = openDb(copy);
    if (!db) return [];
    try {
      return db.prepare(sql).all();
    } catch {
      return [];
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    return [];
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

/** 读 JSON（大文件也只读一次），失败返回 null */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 自动生成的时间戳目录名（2026-09-25-16-40-22）不是项目 */
function isScratchName(p) {
  return /\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(String(p || ''));
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/* ------------------------------ 适配器 ------------------------------ */

/** WorkBuddy：~/.workbuddy-ai/workbuddy.db 的 sessions.cwd + workspaces.path */
function readWorkBuddy() {
  const out = [];
  const db = path.join(home, '.workbuddy-ai', 'workbuddy.db');

  for (const r of sqliteRows(db,
    'select cwd as p, max(last_activity_at) as t from sessions where cwd is not null and cwd != "" group by cwd')) {
    out.push({ path: r.p, lastOpened: Number(r.t) || 0, source: 'WorkBuddy 空间' });
  }
  for (const r of sqliteRows(db, 'select path as p, last_opened_at as t from workspaces')) {
    out.push({ path: r.p, lastOpened: Number(r.t) || 0, source: 'WorkBuddy 工作区' });
  }
  return out;
}

/** Antigravity：会话库里的 workspace_uris + VS Code 式 workspaceStorage */
function readAntigravity() {
  const out = [];
  const db = path.join(home, '.gemini', 'antigravity', 'conversation_summaries.db');
  for (const r of sqliteRows(db,
    "select distinct workspace_uris as w from conversation_summaries where workspace_uris is not null and workspace_uris != ''")) {
    let arr = [];
    try { arr = JSON.parse(r.w); } catch { arr = [r.w]; }
    for (const u of (Array.isArray(arr) ? arr : [arr])) {
      const p = uriToPath(u);
      if (p) out.push({ path: p, lastOpened: 0, source: 'Antigravity 项目' });
    }
  }
  for (const base of ['Antigravity IDE', 'Antigravity']) {
    out.push(...readWorkspaceStorage(path.join(appdata, base, 'User', 'workspaceStorage')));
  }
  return out;
}

/** VS Code 系通用：<userData>/User/workspaceStorage/<id>/workspace.json */
function readWorkspaceStorage(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const f = path.join(dir, e.name, 'workspace.json');
    const j = readJson(f);
    if (!j) continue;
    const p = uriToPath(j.folder || j.workspace || j.configuration || '');
    if (p) out.push({ path: p, lastOpened: 0, source: '编辑器工作区' });
  }
  return out;
}

/** Claude Code：~/.claude.json 的 projects 键 */
function readClaude() {
  const out = [];
  const j = readJson(path.join(home, '.claude.json'));
  if (j && j.projects && typeof j.projects === 'object') {
    for (const k of Object.keys(j.projects)) {
      if (path.isAbsolute(k)) out.push({ path: k, lastOpened: 0, source: 'Claude 项目' });
    }
  }
  return out;
}

/** 通用：从产品的用户数据目录里翻出「看起来是绝对路径且真实存在」的字符串 */
function readPathsFromJson(product) {
  const out = [];
  const roots = [];
  const slug = String(product.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (slug) {
    roots.push(path.join(home, '.' + slug));
    roots.push(path.join(appdata, product.name || ''));
    roots.push(path.join(localappdata, product.name || ''));
  }
  const seen = new Set();
  const visit = (node, depth) => {
    if (depth > 3 || out.length > 300) return;
    if (typeof node === 'string') {
      if (node.length > 3 && /^[A-Za-z]:[\\/]/.test(node) && !seen.has(node)) {
        seen.add(node);
        if (isDir(node)) out.push({ path: node, lastOpened: 0, source: '配置中的路径' });
      }
      return;
    }
    if (Array.isArray(node)) { for (const v of node) visit(v, depth + 1); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        // 对象键也可能是路径（Claude 风格）
        if (/^[A-Za-z]:[\\/]/.test(k) && isDir(k) && !seen.has(k)) {
          seen.add(k);
          out.push({ path: k, lastOpened: 0, source: '配置中的路径' });
        }
        visit(v, depth + 1);
      }
    }
  };

  for (const root of roots) {
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isFile() || !/\.json$/i.test(e.name)) continue;
      const f = path.join(root, e.name);
      try {
        if (fs.statSync(f).size > 4 * 1024 * 1024) continue;
      } catch { continue; }
      visit(readJson(f), 0);
      if (out.length > 300) break;
    }
  }
  return out;
}

/* ------------------------------ 对外 ------------------------------ */

const ADAPTERS = [
  { id: 'workbuddy', match: /workbuddy|buddy/i, read: readWorkBuddy },
  { id: 'antigravity', match: /antigravity/i, read: readAntigravity },
  { id: 'claude', match: /claude|codex/i, read: readClaude }
];

/**
 * 找出某个产品在它自己内部登记过的项目 / 工作区。
 * @param {object} product { name, launchPath }
 * @returns {{items: Array<{path:string,name:string,lastOpened:number,source:string}>, adapters: string[]}}
 */
function discoverProjects(product) {
  const name = String((product && product.name) || '');
  const launch = String((product && product.launchPath) || '');
  const bag = [];
  const used = [];

  for (const a of ADAPTERS) {
    if (!a.match.test(name) && !a.match.test(launch)) continue;
    try {
      const rows = a.read(product) || [];
      if (rows.length) { used.push(a.id); bag.push(...rows); }
    } catch { /* 适配器失败不影响其它来源 */ }
  }

  // 通用兜底：产品数据目录里的 JSON 出现的绝对路径
  if (!bag.length) {
    try {
      const rows = readPathsFromJson(product) || [];
      if (rows.length) { used.push('config-paths'); bag.push(...rows); }
    } catch { /* ignore */ }
  }

  const byKey = new Map();
  for (const it of bag) {
    const p = it.path ? path.normalize(it.path) : '';
    if (!p || !isDir(p)) continue;
    if (isScratchName(p)) continue;
    const k = process.platform === 'win32' ? p.toLowerCase() : p;
    const prev = byKey.get(k);
    if (!prev || (it.lastOpened || 0) > (prev.lastOpened || 0)) {
      byKey.set(k, {
        path: p,
        name: path.basename(p) || p,
        parent: path.basename(path.dirname(p)),
        lastOpened: Number(it.lastOpened) || 0,
        source: it.source || ''
      });
    }
  }

  const items = [...byKey.values()].sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0) || a.name.localeCompare(b.name));
  return { items, adapters: used };
}

module.exports = { discoverProjects, uriToPath, sqliteRows, isScratchName };
