'use strict';
// Local disk helper. It never calls an agent or translation API.
const fs = require('node:fs');
const path = require('node:path');
const storage = require('./translationStorage');

function readTask(index) {
  const task = JSON.parse(fs.readFileSync(index, 'utf8'));
  if (task.version !== 2 || !Array.isArray(task.batches) || !path.isAbsolute(task.storageDirectory)) throw new Error('任务格式无效');
  return task;
}

function batchFile(index, name) {
  if (!/^batch-\d+\.json$/.test(name)) throw new Error('批次路径无效');
  return path.join(path.dirname(index), name);
}

function entries(index, info) {
  const batch = JSON.parse(fs.readFileSync(batchFile(index, info.file), 'utf8'));
  if (!Array.isArray(batch.items) || batch.items.length !== info.count) throw new Error('批次内容缺失');
  return batch.items;
}

function inspect(task, items) {
  const sourceHashes = new Map(), maps = new Map();
  return items.map(item => {
    if (storage.sha1(item.text) !== item.key) throw new Error('片段原文校验失败');
    if (!sourceHashes.has(item.source)) {
      try { sourceHashes.set(item.source, storage.sha1(fs.readFileSync(item.source))); }
      catch { sourceHashes.set(item.source, null); }
    }
    if (sourceHashes.get(item.source) !== item.sourceHash) return { item, state: 'changed' };
    const file = storage.agentFile(task.storageDirectory, task.lang, item.key);
    if (!maps.has(file)) maps.set(file, storage.readMap(file));
    const value = maps.get(file)[item.key];
    return { item, state: typeof value === 'string' && value.trim() ? 'saved' : 'pending' };
  });
}

function status(index) {
  const task = readTask(index);
  let saved = 0, pending = 0, changed = 0, total = 0;
  const unfinished = [];
  for (const info of task.batches) {
    let missing = 0;
    for (const entry of inspect(task, entries(index, info))) {
      total++;
      if (entry.state === 'saved') saved++;
      else if (entry.state === 'changed') changed++;
      else { pending++; missing++; }
    }
    if (missing) unfinished.push({ file: info.file, pending: missing });
  }
  if (total !== task.total) throw new Error('任务总数校验失败，不能标记完成');
  const report = { total, saved, pending, changed, complete: pending === 0 && changed === 0, unfinished, checkedAt: Date.now() };
  storage.writeJson(path.join(path.dirname(index), 'progress.json'), report);
  return report;
}

function next(index) {
  const task = readTask(index);
  for (const info of task.batches) {
    const pending = inspect(task, entries(index, info)).filter(entry => entry.state === 'pending').map(entry => entry.item);
    if (pending.length) return { file: info.file, items: pending };
  }
  return status(index);
}

function commit(index, name, resultFile) {
  const task = readTask(index);
  const info = task.batches.find(info => info.file === name);
  if (!info) throw new Error('未知批次');
  if (fs.statSync(resultFile).size > 4 * 1024 * 1024) throw new Error('结果文件过大');
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  if (!Array.isArray(result.translations)) throw new Error('结果需要 translations 数组');
  return storage.withLock(task.storageDirectory, () => {
    const checked = inspect(task, entries(index, info));
    if (checked.some(entry => entry.state === 'changed')) throw new Error('原文已变化，请重新生成指令；本批尚未保存');
    const allowed = new Map(checked.map(entry => [entry.item.key, entry]));
    const values = new Map();
    for (const entry of result.translations) {
      if (!entry || !allowed.has(entry.key) || values.has(entry.key) || typeof entry.text !== 'string' || !entry.text.trim()) throw new Error('译文包含未知、重复或空条目');
      values.set(entry.key, entry.text);
    }
    const missing = checked.filter(entry => entry.state === 'pending' && !values.has(entry.item.key));
    if (missing.length) throw new Error(`本批缺少 ${missing.length} 段译文，未保存；请补全后重试`);
    const grouped = new Map();
    let saved = 0;
    for (const { item, state } of checked) {
      if (state !== 'pending') continue;
      const file = storage.agentFile(task.storageDirectory, task.lang, item.key);
      if (!grouped.has(file)) grouped.set(file, storage.readMap(file));
      grouped.get(file)[item.key] = values.get(item.key);
      saved++;
    }
    for (const [file, map] of grouped) {
      if (fs.existsSync(file)) {
        const backup = path.join(path.dirname(index), 'backups', path.basename(file));
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        if (!fs.existsSync(backup)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      }
      storage.writeJson(file, map);
      const persisted = storage.readMap(file);
      for (const [key, text] of Object.entries(map)) if (persisted[key] !== text) throw new Error('磁盘译文校验失败');
    }
    const progressFile = path.join(path.dirname(index), 'progress.json');
    const progress = storage.readMap(progressFile);
    progress.batchSaved = progress.batchSaved || {};
    progress.batchSaved[name] = { count: checked.length, verifiedAt: Date.now() };
    progress.complete = false; // Only a full disk scan may mark the task complete.
    storage.writeJson(progressFile, progress);
    return { saved };
  });
}

module.exports = { status, next, commit };

if (require.main === module) {
  try {
    const [operation, index, name, resultFile] = process.argv.slice(2);
    if (!['status', 'next', 'commit'].includes(operation) || !index) throw new Error('用法：node translationTasks.js status|next <任务索引>；commit <任务索引> <批次名> <结果文件>');
    const result = operation === 'commit' ? commit(index, name, resultFile) : module.exports[operation](index);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (operation === 'status' && !result.complete) process.exitCode = 2;
  } catch (e) { process.stderr.write(e.message + '\n'); process.exitCode = 1; }
}
