'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha1 = value => crypto.createHash('sha1').update(value).digest('hex');
const AGENT_MODEL = '__agent__';

function readMap(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('译文存储格式无效：' + file);
  return data;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, JSON.stringify(data), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function agentFile(root, lang, key) {
  if (!/^[a-zA-Z0-9_-]+$/.test(lang) || !/^[a-f0-9]{40}$/.test(key)) throw new Error('译文标识无效');
  return path.join(root, 'agent', lang, key.slice(0, 2) + '.json');
}

function withLock(root, fn) {
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, '.agent-write.lock');
  const ownerFile = path.join(lock, 'owner.json');
  const owner = JSON.stringify({ pid: process.pid, token: crypto.randomUUID() });
  try { fs.mkdirSync(lock); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let raw = null, stale = false;
    try {
      raw = fs.readFileSync(ownerFile, 'utf8');
      const previous = JSON.parse(raw);
      if (Number.isInteger(previous.pid) && previous.pid > 0) {
        try { process.kill(previous.pid, 0); } catch (error) { stale = error.code === 'ESRCH'; }
      }
    } catch { stale = Date.now() - fs.statSync(lock).mtimeMs > 60000; }
    if (!stale) throw new Error('另一个任务正在保存译文，请稍后重试');
    const current = fs.existsSync(ownerFile) ? fs.readFileSync(ownerFile, 'utf8') : null;
    if (current !== raw) throw new Error('译文锁已变化，请重试');
    if (current !== null) fs.unlinkSync(ownerFile);
    fs.rmdirSync(lock);
    fs.mkdirSync(lock);
  }
  fs.writeFileSync(ownerFile, owner, { flag: 'wx' });
  try { return fn(); } finally {
    if (fs.readFileSync(ownerFile, 'utf8') === owner) { fs.unlinkSync(ownerFile); fs.rmdirSync(lock); }
  }
}

/** Move verified files, retaining collisions as recoverable backups. */
function migrate(source, target) {
  if (path.resolve(source) === path.resolve(target) || !fs.existsSync(source)) return 0;
  fs.mkdirSync(target, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const from = path.join(source, entry.name);
    const to = entry.name.endsWith('.json') ? path.join(target, entry.name) : path.join(target, 'migration-backups', entry.name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (!fs.existsSync(to)) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    const original = fs.readFileSync(from);
    if (sha1(original) !== sha1(fs.readFileSync(to))) {
      const backup = path.join(target, 'migration-backups', crypto.randomUUID() + '-' + entry.name);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(from, backup, fs.constants.COPYFILE_EXCL);
      if (sha1(original) !== sha1(fs.readFileSync(backup))) throw new Error('译文迁移校验失败');
      // Segment stores are maps; preserve entries from both locations.
      if (entry.name.startsWith('seg-') && entry.name.endsWith('.json')) writeJson(to, { ...readMap(from), ...readMap(to) });
    }
    fs.unlinkSync(from);
    count++;
  }
  if (!fs.readdirSync(source).length) fs.rmdirSync(source);
  return count;
}

function upgradeAgent(root) {
  for (const name of fs.readdirSync(root)) {
    const match = name.match(new RegExp('^seg-([a-zA-Z0-9_-]+)-' + sha1(AGENT_MODEL).slice(0, 8) + '\\.json$'));
    if (!match) continue;
    const file = path.join(root, name), grouped = new Map();
    for (const [key, value] of Object.entries(readMap(file))) {
      if (!/^[a-f0-9]{40}$/.test(key) || typeof value !== 'string' || !value.trim()) continue;
      const dest = agentFile(root, match[1], key);
      if (!grouped.has(dest)) grouped.set(dest, {});
      grouped.get(dest)[key] = value;
    }
    for (const [dest, values] of grouped) writeJson(dest, { ...values, ...readMap(dest) });
    const backup = path.join(root, 'migration-backups', name);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    if (fs.existsSync(backup)) fs.renameSync(file, backup + '.' + crypto.randomUUID());
    else fs.renameSync(file, backup);
  }
}

module.exports = { readMap, writeJson, agentFile, withLock, migrate, upgradeAgent, sha1, AGENT_MODEL };
