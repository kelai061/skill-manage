'use strict';
/**
 * store.js — 本地配置与索引的唯一持久化层
 *
 * 配置与批注保存在 userData；持久译文和任务保存在软件根目录。
 * 独立测试 profile 完全隔离，绝不写进用户的 skill 源目录。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');

let _dir = null;
let translationDirectory = null;

function storageHome() {
  // Test profiles must never read or write the installed application's data.
  if (!process.versions.electron || process.argv.some(a => a.startsWith('--profile='))) return path.join(dataDir(), 'app-root');
  return app.isPackaged ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)) : path.join(__dirname, '..');
}

function translationsDir() {
  if (!translationDirectory) {
    const storage = require('./translationStorage');
    const destination = path.join(storageHome(), 'translations');
    fs.mkdirSync(destination, { recursive: true });
    storage.migrate(path.join(dataDir(), 'translations'), destination);
    storage.withLock(destination, () => storage.upgradeAgent(destination));
    storage.migrate(path.join(dataDir(), 'agent-translation'), path.join(storageHome(), 'translation-tasks', 'legacy'));
    translationDirectory = destination;
  }
  return translationDirectory;
}

function dataDir() {
  if (!_dir) {
    _dir = app.getPath('userData');
    fs.mkdirSync(_dir, { recursive: true });
  }
  return _dir;
}

const paths = {
  get config() { return path.join(dataDir(), 'config.json'); },
  get translations() { return translationsDir(); },
  get translationTasks() { return path.join(storageHome(), 'translation-tasks'); },
  get annotations() { return path.join(dataDir(), 'annotations'); },
  get backups() { return path.join(dataDir(), 'backups'); },
  get root() { return dataDir(); }
};

function ensureDirs() {
  for (const d of [paths.translations, paths.annotations, paths.backups]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function defaults() {
  return {
    version: 2,
    products: [],
    skills: [],
    groups: [],
    skillGroups: {},
    combos: [],
    scratch: { skillIds: [], updatedAt: 0 },
    favorites: [],
    ratings: {},
    detachedSkills: [],
    staging: { root: '', threshold: 6, lastOrganized: 0 },
    settings: {
      theme: 'light',
      api: {
        baseUrl: 'https://api.deepseek.com',
        key: '',
        model: 'deepseek-chat',
        temperature: 0.3
      },
      tts: { rate: 0.95, lang: 'en-US', voice: '' },
      reader: { fontSize: 16, measure: 720, mode: 'off', spacing: false, toc: true },
      translate: { target: 'zh-CN', selectionLive: false },
      onboarded: { detect: false, help: false },
      update: { repo: 'kelai061/skill-manage', auto: true, lastCheckAt: 0 },
      maxBackups: 50
    },
    audit: []
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = Array.isArray(base) ? base : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = merge(out[k], v);
    else out[k] = v;
  }
  return out;
}

let state = null;

function load() {
  ensureDirs();
  let raw;
  try {
    raw = fs.readFileSync(paths.config, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    state = defaults();
    save();
    return state;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('配置必须是对象');
    state = merge(defaults(), parsed);
  } catch {
    // Preserve the original before recovering; failed preservation must not overwrite it.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const recovery = path.join(dataDir(), `config.corrupt-${stamp}-${require('node:crypto').randomBytes(3).toString('hex')}.json`);
    fs.copyFileSync(paths.config, recovery, fs.constants.COPYFILE_EXCL);
    state = defaults();
    save();
  }
  return state;
}

function get() {
  if (!state) load();
  return state;
}

function save() {
  if (!state) return;
  const tmp = paths.config + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, paths.config);
  // 顺手刷新程序目录里的 skill 清单（内容没变时内部会跳过写入）
  try { require('./workspace').sync(state); } catch { /* 导出失败不影响配置落盘 */ }
}

function patch(p) {
  state = merge(get(), p);
  save();
  return state;
}

/** 覆盖式替换某个顶层数组/对象（用于组合、分组等整体写回） */
function set(key, value) {
  get()[key] = value;
  save();
  return get();
}

function pushAudit(entry) {
  const s = get();
  s.audit.unshift({ at: Date.now(), ...entry });
  if (s.audit.length > 200) s.audit.length = 200;
  save();
  return s.audit;
}

/**
 * 目录被移动后，把引用旧 skill id 的分组/收藏/评分/组合/暂存全部改指新 id。
 * 不做这一步，用户攒的分组和评分会在归位后凭空消失。
 */
function remapSkillIds(pairs) {
  if (!pairs || !pairs.length) return 0;
  const s = get();
  const map = new Map(pairs.filter((p) => p.oldId && p.newId && p.oldId !== p.newId).map((p) => [p.oldId, p.newId]));
  if (!map.size) return 0;

  let touched = 0;

  for (const [oldId, newId] of map) {
    if (s.skillGroups[oldId]) {
      s.skillGroups[newId] = [...new Set([...(s.skillGroups[newId] || []), ...s.skillGroups[oldId]])];
      delete s.skillGroups[oldId];
      touched++;
    }
    if (s.ratings[oldId]) {
      s.ratings[newId] = s.ratings[oldId];
      delete s.ratings[oldId];
      touched++;
    }
  }

  const fix = (arr) => (arr || []).map((id) => map.get(id) || id);
  s.favorites = [...new Set(fix(s.favorites))];
  s.detachedSkills = [...new Set(fix(s.detachedSkills))];
  for (const product of s.products || []) product.hidden = [...new Set(fix(product.hidden))];
  s.combos = s.combos.map((c) => ({ ...c, skillIds: [...new Set(fix(c.skillIds))] }));
  s.scratch = { ...s.scratch, skillIds: [...new Set(fix(s.scratch.skillIds))] };

  save();
  return touched;
}

function homeInfo() {
  return {
    home: os.homedir(),
    appdata: process.env.APPDATA || '',
    localappdata: process.env.LOCALAPPDATA || '',
    platform: process.platform
  };
}

module.exports = { paths, load, get, save, patch, set, pushAudit, remapSkillIds, dataDir, ensureDirs, defaults, homeInfo };
