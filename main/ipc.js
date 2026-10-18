'use strict';
/**
 * ipc.js — 渲染进程与主进程之间唯一的通道
 *
 * 所有写操作集中在这里，便于审计与授权门控制。
 */

const path = require('node:path');
const fs = require('node:fs');
const { ipcMain, shell, clipboard, BrowserWindow, dialog, app } = require('electron');
const { pathToFileURL } = require('node:url');

const store = require('./store');
const scanner = require('./scanner');
const skills = require('./skillService');
const ai = require('./aiService');
const importer = require('./importer');
const organizer = require('./organizer');
const agentSources = require('./agentSources');
const filePreview = require('./filePreview');
const detectTools = require('./detectTools');
const share = require('./share');
const updater = require('./updater');

/* mdseg 是 ESM，主进程按需动态载入并缓存 */
let _mdseg = null;
async function mdseg() {
  if (!_mdseg) {
    _mdseg = await import(pathToFileURL(path.join(__dirname, '..', 'shared', 'mdseg.mjs')).href);
  }
  return _mdseg;
}

/* 待批准的改写提案：proposalId → {…} */
const proposals = new Map();
let proposalSeq = 0;

function ok(data) { return { ok: true, data }; }
function fail(e) { return { ok: false, error: ai.friendly(e) }; }

function findSkill(id) {
  return (store.get().skills || []).find((s) => s.id === id) || null;
}

/**
 * 把 agent 工具内部登记的项目并进产品。
 * 只增不删：自动发现的标 auto:true，用户手动加的不会被覆盖或移除。
 */
function mergeAutoProjects(product) {
  let found = { items: [], adapters: [] };
  try { found = agentSources.discoverProjects(product); } catch { /* ignore */ }

  product.projects = product.projects || [];
  let added = 0;
  for (const it of found.items) {
    const hit = product.projects.find((x) => scanner.key(x.path) === scanner.key(it.path));
    if (hit) {
      hit.auto = true;
      hit.lastSeen = Date.now();
      if (!hit.name && it.name) hit.name = it.name;
    } else {
      product.projects.push({
        id: scanner.uid(it.path),
        name: it.name,
        path: it.path,
        addedAt: Date.now(),
        auto: true,
        source: it.source,
        lastSeen: Date.now()
      });
      added++;
    }
  }
  return { added, total: product.projects.length, found: found.items.length, adapters: found.adapters };
}

/** 重新扫描一个产品并把结果写回索引（产品页 / 自动发现项目共用） */
function scanInto(product) {
  const s = store.get();
  const scan = scanner.scanProduct(product);
  s.skills = s.skills.filter((k) => k.productId !== product.id);
  const existing = new Set(s.skills.map((k) => k.id));
  let added = 0;
  for (const sk of scan.skills) {
    if (!existing.has(sk.id)) { s.skills.push(sk); added++; }
  }
  product.lastScan = Date.now();
  product.skillCount = scan.skills.length;
  product.usedFallback = scan.usedFallback;
  const alive = new Set(scan.skills.map((k) => k.id));
  product.hidden = (product.hidden || []).filter((x) => alive.has(x));
  store.save();
  return { added, total: scan.skills.length, skills: scan.skills };
}

function comboText(skillIds) {
  const s = store.get();
  const lines = [];
  for (const id of skillIds || []) {
    const sk = s.skills.find((x) => x.id === id);
    if (sk) lines.push(sk.dir);
  }
  return lines.join('\n');
}

function register() {
  store.load();

  /* ----------------------------- 配置 ----------------------------- */

  ipcMain.handle('config:get', () => ok({
    ...store.get(),
    meta: {
      dataDir: store.paths.root,
      backupsDir: store.paths.backups,
      version: require('../package.json').version,
      platform: process.platform,
      home: require('node:os').homedir()
    }
  }));

  ipcMain.handle('config:patch', (_e, patch) => {
    try { return ok(store.patch(patch)); } catch (e) { return fail(e); }
  });

  /* 让原生标题栏按钮跟随主题换色，避免深色下出现一块白 */
  ipcMain.handle('theme:apply', (e, { color, symbolColor }) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (win && typeof win.setTitleBarOverlay === 'function') {
        win.setTitleBarOverlay({
          color: color || '#FEF7FF',
          symbolColor: symbolColor || '#1D1B20',
          height: 64
        });
      }
      return ok({});
    } catch (err) { return fail(err); }
  });

  /* ----------------------------- 产品 ----------------------------- */

  ipcMain.handle('product:probe', (_e, { launchPath }) => {
    try {
      const r = scanner.probe(launchPath);
      return ok(r);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('product:add', (_e, { launchPath, name, roots }) => {
    try {
      const st = scanner.norm(launchPath);
      if (!st || !fs.existsSync(st)) throw new Error('路径不存在：' + launchPath);

      const s = store.get();
      const id = scanner.uid(st);
      let product = s.products.find((p) => p.id === id);
      if (!product) {
        product = {
          id,
          name: (name || path.basename(st)).trim(),
          launchPath: st,
          manualRoots: (roots || []).map((r) => ({ root: r, kind: 'global' })),
          projectRoots: [],
          projects: [],
          hidden: [],
          createdAt: Date.now()
        };
        s.products.push(product);
      } else {
        product.name = (name || product.name).trim();
        product.manualRoots = (roots || product.manualRoots || []).map((r) =>
          typeof r === 'string' ? { root: r, kind: 'global' } : r
        );
        product.projects = product.projects || [];
        product.hidden = product.hidden || [];
      }
      store.save();

      // 先把 agent 工具内部登记的项目收进来，再统一扫描
      const auto = mergeAutoProjects(product);
      const result = scanInto(product);

      return ok({ product, skills: result.skills, usedFallback: product.usedFallback, autoProjects: auto });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('product:remove', (_e, { id }) => {
    try {
      const s = store.get();
      s.products = s.products.filter((p) => p.id !== id);
      const removed = new Set(s.skills.filter((k) => k.productId === id).map((k) => k.id));
      s.skills = s.skills.filter((k) => k.productId !== id);
      // 清理指向已消失 skill 的组合引用
      s.combos = s.combos.map((c) => ({ ...c, skillIds: (c.skillIds || []).filter((x) => !removed.has(x)) }));
      s.scratch.skillIds = (s.scratch.skillIds || []).filter((x) => !removed.has(x));
      store.save();
      return ok({ removed: removed.size });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('product:rescan', (_e, { id }) => {
    try {
      const s = store.get();
      const product = s.products.find((p) => p.id === id);
      if (!product) throw new Error('产品不存在');
      const auto = mergeAutoProjects(product);
      const result = scanInto(product);
      return ok({ added: result.added, total: result.total, skills: result.skills, autoProjects: auto });
    } catch (e) { return fail(e); }
  });

  /** 只做「从 agent 工具里发现项目」，然后把新项目一并扫进索引 */
  ipcMain.handle('product:autoProjects', (_e, { id }) => {
    try {
      const s = store.get();
      const product = s.products.find((p) => p.id === id);
      if (!product) throw new Error('产品不存在');
      const auto = mergeAutoProjects(product);
      const result = scanInto(product);
      return ok({ ...auto, added: auto.added, skillTotal: result.total });
    } catch (e) { return fail(e); }
  });

  /* ----------------------------- 项目 ----------------------------- */

  ipcMain.handle('project:discover', (_e, { root, all }) => {
    try {
      const list = scanner.discoverProjects(root, 2, !!all);
      return ok({ root: scanner.norm(root), list });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('project:add', (_e, { productId, path: dir, name }) => {
    try {
      const s = store.get();
      const p = s.products.find((x) => x.id === productId);
      if (!p) throw new Error('产品不存在');
      const d = scanner.norm(dir);
      if (!fs.existsSync(d)) throw new Error('目录不存在：' + d);
      p.projects = p.projects || [];
      if (p.projects.some((x) => scanner.key(x.path) === scanner.key(d))) {
        throw new Error('该项目已登记');
      }
      const proj = {
        id: 'pr' + Date.now().toString(36),
        name: (name || path.basename(d)).trim(),
        path: d,
        addedAt: Date.now()
      };
      p.projects.push(proj);

      const found = scanner.walkForSkills(d, 6);
      const existing = new Set(s.skills.map((k) => k.id));
      let added = 0;
      for (const dp of found) {
        const meta = scanner.readSkillMeta(dp, 'project', productId, proj.id);
        if (meta && !existing.has(meta.id)) { s.skills.push(meta); added++; }
      }
      store.save();
      return ok({ project: proj, added, total: found.length });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('project:remove', (_e, { productId, projectId }) => {
    try {
      const s = store.get();
      const p = s.products.find((x) => x.id === productId);
      if (!p) throw new Error('产品不存在');
      p.projects = (p.projects || []).filter((x) => x.id !== projectId);
      const removed = new Set(
        s.skills.filter((k) => k.projectId === projectId).map((k) => k.id)
      );
      s.skills = s.skills.filter((k) => k.projectId !== projectId);
      s.combos = s.combos.map((c) => ({ ...c, skillIds: (c.skillIds || []).filter((x) => !removed.has(x)) }));
      s.scratch.skillIds = (s.scratch.skillIds || []).filter((x) => !removed.has(x));
      s.favorites = (s.favorites || []).filter((x) => !removed.has(x));
      store.save();
      return ok({ removed: removed.size });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('project:rescan', (_e, { productId, projectId }) => {
    try {
      const s = store.get();
      const p = s.products.find((x) => x.id === productId);
      if (!p) throw new Error('产品不存在');
      const proj = (p.projects || []).find((x) => x.id === projectId);
      if (!proj) throw new Error('项目不存在');
      const found = scanner.walkForSkills(proj.path, 6);
      s.skills = s.skills.filter((k) => k.projectId !== projectId);
      const existing = new Set(s.skills.map((k) => k.id));
      let added = 0;
      for (const dp of found) {
        const meta = scanner.readSkillMeta(dp, 'project', productId, projectId);
        if (meta && !existing.has(meta.id)) { s.skills.push(meta); added++; }
      }
      store.save();
      return ok({ added, total: found.length });
    } catch (e) { return fail(e); }
  });

  /* 新建 / 删除 skill（项目 skill 的增删） */
  ipcMain.handle('skill:create', (_e, { parentDir, name, description, productId, projectId }) => {
    try {
      const s = store.get();
      const dir = scanner.createSkill(parentDir, name, description);
      const meta = scanner.readSkillMeta(dir, projectId ? 'project' : 'global', productId || '', projectId || '');
      if (meta) s.skills.push(meta);
      store.save();
      return ok({ dir, skill: meta });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('skill:delete', async (_e, { id }) => {
    try {
      const s = store.get();
      const sk = s.skills.find((x) => x.id === id);
      if (!sk) throw new Error('skill 不存在');
      // 移入回收站，可恢复；绝不直接删除
      await shell.trashItem(sk.dir);
      s.skills = s.skills.filter((x) => x.id !== id);
      s.combos = s.combos.map((c) => ({ ...c, skillIds: (c.skillIds || []).filter((x) => x !== id) }));
      s.scratch.skillIds = (s.scratch.skillIds || []).filter((x) => x !== id);
      s.favorites = (s.favorites || []).filter((x) => x !== id);
      delete s.ratings[id];
      store.save();
      store.pushAudit({ action: 'trash', file: sk.dir, note: 'skill 移入回收站' });
      return ok({ trashed: sk.dir });
    } catch (e) { return fail(e); }
  });

  /* 收藏 / 评价 */
  ipcMain.handle('favorite:toggle', (_e, { id }) => {
    try {
      const s = store.get();
      s.favorites = s.favorites || [];
      const i = s.favorites.indexOf(id);
      if (i >= 0) s.favorites.splice(i, 1);
      else s.favorites.unshift(id);
      store.save();
      return ok({ favorites: s.favorites });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('rating:set', (_e, { id, stars, note }) => {
    try {
      const s = store.get();
      s.ratings = s.ratings || {};
      if (!stars && !note) delete s.ratings[id];
      else s.ratings[id] = { stars: Number(stars) || 0, note: String(note || ''), at: Date.now() };
      store.save();
      return ok({ ratings: s.ratings });
    } catch (e) { return fail(e); }
  });

  /* 产品内隐藏 */
  ipcMain.handle('product:hideSkill', (_e, { productId, skillId, hidden }) => {
    try {
      const s = store.get();
      const p = s.products.find((x) => x.id === productId);
      if (!p) throw new Error('产品不存在');
      p.hidden = p.hidden || [];
      if (hidden) {
        if (!p.hidden.includes(skillId)) p.hidden.push(skillId);
      } else {
        p.hidden = p.hidden.filter((x) => x !== skillId);
      }
      store.save();
      return ok({ hidden: p.hidden });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('product:addProjectRoot', (_e, { id, dir }) => {
    try {
      const s = store.get();
      const p = s.products.find((x) => x.id === id);
      if (!p) throw new Error('产品不存在');
      const d = scanner.norm(dir);
      if (!fs.existsSync(d)) throw new Error('目录不存在：' + d);
      p.projectRoots = [...new Set([...(p.projectRoots || []), d])];
      store.save();
      const found = scanner.walkForSkills(d, 6);
      const existing = new Set(s.skills.map((k) => k.id));
      let added = 0;
      for (const dirPath of found) {
        const meta = scanner.readSkillMeta(dirPath, 'project', id);
        if (meta && !existing.has(meta.id)) { s.skills.push(meta); added++; }
      }
      store.save();
      return ok({ added, total: found.length });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('product:removeProjectRoot', (_e, { id, dir }) => {
    try {
      const s = store.get();
      const p = s.products.find((x) => x.id === id);
      if (!p) throw new Error('产品不存在');
      const d = scanner.key(dir);
      p.projectRoots = (p.projectRoots || []).filter((x) => scanner.key(x) !== d);
      s.skills = s.skills.filter((k) => !(k.productId === id && scanner.key(k.dir).startsWith(d)));
      store.save();
      return ok({});
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('product:pickPath', async (e, { mode }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (mode === 'dir') {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      return ok({ path: r.canceled ? '' : r.filePaths[0] });
    }
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: '可执行文件', extensions: ['exe', 'bat', 'cmd', 'app'] }, { name: '全部文件', extensions: ['*'] }]
    });
    return ok({ path: r.canceled ? '' : r.filePaths[0] });
  });

  /* ----------------------------- skill ----------------------------- */

  /** 把嵌套 skill 移出父级 / 收回父级 */
  ipcMain.handle('skill:detach', (_e, { id, detach }) => {
    try {
      const s = store.get();
      const set = new Set(s.detachedSkills || []);
      if (detach) set.add(id); else set.delete(id);
      s.detachedSkills = [...set];
      store.save();
      return ok({ detached: s.detachedSkills.length });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('skill:list', () => ok({
    skills: store.get().skills,
    groups: store.get().groups,
    skillGroups: store.get().skillGroups,
    products: store.get().products.map((p) => ({ id: p.id, name: p.name, launchPath: p.launchPath }))
  }));

  ipcMain.handle('skill:read', (_e, { id }) => {
    try {
      const sk = findSkill(id);
      if (!sk) throw new Error('skill 索引已失效，请重新扫描。');
      const r = skills.readSkill(sk.path);
      if (!r.ok) throw new Error(r.error);
      return ok({ ...r, kind: 'md', meta: sk });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('skill:files', (_e, { id }) => {
    try {
      const sk = findSkill(id);
      if (!sk) throw new Error('skill 不存在');
      return ok(skills.listFiles(sk.dir));
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('skill:reveal', (_e, { p }) => {
    try { shell.showItemInFolder(scanner.norm(p)); return ok({}); } catch (e) { return fail(e); }
  });

  /* 读取 skill 目录内的附属文件（references/ 等），越界一律拒绝 */
  ipcMain.handle('file:read', (_e, { p }) => {
    try {
      const target = scanner.norm(p);
      const s = store.get();
      const inside = (s.skills || []).some((k) => {
        const rel = path.relative(k.dir, target);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!inside) throw new Error('拒绝读取：该文件不在任何已索引的 skill 目录内。');
      const info = filePreview.classify(target);
      return ok(info);
    } catch (e) { return fail(e); }
  });

  /* --------------------- 首次启动 / 分享 / 更新 --------------------- */

  ipcMain.handle('app:detectTools', () => {
    try { return ok({ items: detectTools.detect() }); } catch (e) { return fail(e); }
  });

  ipcMain.handle('share:export', async (e, { path: target } = {}) => {
    try {
      let file = target;
      if (!file) {
        const win = BrowserWindow.fromWebContents(e.sender);
        const r = await dialog.showSaveDialog(win, {
          title: '导出分享包',
          defaultPath: path.join(app.getPath('documents'), 'skill-atelier-share.json'),
          filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (r.canceled || !r.filePath) return ok({ canceled: true });
        file = r.filePath;
      }
      const data = share.buildExport(store.get());
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      return ok({
        path: file,
        products: data.products.length,
        groups: data.groups.length,
        combos: data.combos.length,
        skills: data.skillCount
      });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('share:import', async (e, { path: target } = {}) => {
    try {
      let file = target;
      if (!file) {
        const win = BrowserWindow.fromWebContents(e.sender);
        const r = await dialog.showOpenDialog(win, {
          title: '导入分享包',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (r.canceled || !r.filePaths.length) return ok({ canceled: true });
        file = r.filePaths[0];
      }
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const s = store.get();
      const stat = share.mergeImport(s, data);
      store.save();
      return ok({ path: file, ...stat });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('share:comboText', (_e, { id }) => {
    try {
      const s = store.get();
      const c = (s.combos || []).find((x) => x.id === id);
      if (!c) throw new Error('组合不存在');
      return ok({ text: share.comboMarkdown(s, c), name: c.name });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('update:check', async () => {
    try {
      const repo = (store.get().settings.update || {}).repo || '';
      return ok(await updater.check(repo, app.getVersion()));
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('update:open', (_e, { url }) => {
    try {
      if (!/^https:\/\//i.test(String(url || ''))) throw new Error('拒绝打开非 https 链接');
      shell.openExternal(url);
      return ok({});
    } catch (e) { return fail(e); }
  });

  /* ----------------------------- 分组 ----------------------------- */

  ipcMain.handle('group:create', (_e, { name, color }) => {
    try {
      const s = store.get();
      const g = {
        id: 'g' + Date.now().toString(36),
        name: String(name || '未命名分组').trim(),
        color: color || 'primary',
        createdAt: Date.now()
      };
      s.groups.push(g);
      store.save();
      return ok(g);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('group:update', (_e, { id, patch }) => {
    try {
      const s = store.get();
      const g = s.groups.find((x) => x.id === id);
      if (!g) throw new Error('分组不存在');
      Object.assign(g, patch);
      store.save();
      return ok(g);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('group:delete', (_e, { id }) => {
    try {
      const s = store.get();
      s.groups = s.groups.filter((g) => g.id !== id);
      for (const k of Object.keys(s.skillGroups)) {
        s.skillGroups[k] = (s.skillGroups[k] || []).filter((g) => g !== id);
        if (!s.skillGroups[k].length) delete s.skillGroups[k];
      }
      store.save();
      return ok({});
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('skill:setGroups', (_e, { skillId, groupIds }) => {
    try {
      const s = store.get();
      if (groupIds && groupIds.length) s.skillGroups[skillId] = groupIds;
      else delete s.skillGroups[skillId];
      store.save();
      return ok({});
    } catch (e) { return fail(e); }
  });

  /* ----------------------------- 组合 ----------------------------- */

  ipcMain.handle('combo:create', (_e, { name, skillIds, note }) => {
    try {
      const s = store.get();
      const c = {
        id: 'c' + Date.now().toString(36),
        name: String(name || '未命名组合').trim(),
        note: note || '',
        skillIds: [...new Set(skillIds || [])],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      s.combos.push(c);
      store.save();
      return ok(c);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('combo:update', (_e, { id, patch }) => {
    try {
      const s = store.get();
      const c = s.combos.find((x) => x.id === id);
      if (!c) throw new Error('组合不存在');
      if (patch.skillIds) patch.skillIds = [...new Set(patch.skillIds)];
      Object.assign(c, patch, { updatedAt: Date.now() });
      store.save();
      return ok(c);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('combo:delete', (_e, { id }) => {
    try {
      const s = store.get();
      s.combos = s.combos.filter((c) => c.id !== id);
      store.save();
      return ok({});
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('combo:text', (_e, { skillIds }) => {
    try { return ok({ text: comboText(skillIds) }); } catch (e) { return fail(e); }
  });

  ipcMain.handle('combo:copy', (_e, { skillIds }) => {
    try {
      const text = comboText(skillIds);
      clipboard.writeText(text);
      return ok({ text, count: text ? text.split('\n').length : 0 });
    } catch (e) { return fail(e); }
  });

  /* -------------------------- 临时组合 -------------------------- */

  ipcMain.handle('scratch:get', () => ok(store.get().scratch));

  ipcMain.handle('scratch:set', (_e, { skillIds }) => {
    try {
      const s = store.get();
      s.scratch = { skillIds: [...new Set(skillIds || [])], updatedAt: Date.now() };
      store.save();
      return ok(s.scratch);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('scratch:add', (_e, { skillIds }) => {
    try {
      const s = store.get();
      s.scratch.skillIds = [...new Set([...(s.scratch.skillIds || []), ...(skillIds || [])])];
      s.scratch.updatedAt = Date.now();
      store.save();
      return ok(s.scratch);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('scratch:remove', (_e, { skillId }) => {
    try {
      const s = store.get();
      s.scratch.skillIds = (s.scratch.skillIds || []).filter((x) => x !== skillId);
      s.scratch.updatedAt = Date.now();
      store.save();
      return ok(s.scratch);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('scratch:clear', () => {
    try {
      const s = store.get();
      s.scratch = { skillIds: [], updatedAt: Date.now() };
      store.save();
      return ok(s.scratch);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('scratch:promote', (_e, { name }) => {
    try {
      const s = store.get();
      const c = {
        id: 'c' + Date.now().toString(36),
        name: String(name || '临时组合').trim(),
        note: '由临时组合提升',
        skillIds: [...(s.scratch.skillIds || [])],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      s.combos.push(c);
      s.scratch = { skillIds: [], updatedAt: Date.now() };
      store.save();
      return ok(c);
    } catch (e) { return fail(e); }
  });

  /* ------------------------------ AI ------------------------------ */

  ipcMain.handle('ai:test', async () => {
    try { return ok(await ai.testConnection()); } catch (e) { return fail(e); }
  });

  ipcMain.handle('ai:translate', async (_e, { id, force, path: filePath }) => {
    try {
      const sk = findSkill(id);
      if (!sk) throw new Error('skill 不存在');

      let target = sk.path;
      if (filePath) {
        target = scanner.norm(filePath);
        const rel = path.relative(sk.dir, target);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error('拒绝翻译：该文件不在该 skill 目录内。');
        }
      }

      const r = skills.readSkill(target);
      if (!r.ok) throw new Error(r.error);

      const { segmentMarkdown, translatableOf } = await mdseg();
      const blocks = segmentMarkdown(r.content);
      const { ids, texts } = translatableOf(blocks);

      const lang = store.get().settings.translate?.target || 'zh-CN';
      const model = ai.cfg().model;

      let cached = null;
      if (!force) cached = skills.readCache(r.hash, lang, model);

      let list;
      let fromCache = false;
      let missed = 0;

      if (cached && Array.isArray(cached.list) && cached.list.length === texts.length) {
        // 整份命中，连分段都不用
        list = cached.list;
        fromCache = true;
      } else {
        // 段级命中：只把没译过的段落发给模型
        const { map, list: partial, missIdx } = skills.splitBySegCache(texts, lang, model);
        if (missIdx.length === 0) {
          list = partial;
          fromCache = true;
        } else {
          const missTexts = missIdx.map((i) => texts[i]);
          const translated = await ai.translateSegments(missTexts, lang);
          missIdx.forEach((idx, k) => { partial[idx] = translated[k]; });
          skills.commitSegCache(map, lang, model, missTexts, translated);
          list = partial;
          missed = missIdx.length;
        }
        skills.writeCache(r.hash, lang, model, { hash: r.hash, lang, model, list, at: Date.now() });
      }

      const translations = {};
      ids.forEach((sid, i) => { translations[sid] = list[i]; });

      return ok({
        blocks, translations, cached: fromCache, model, lang,
        count: texts.length, missed,
        reused: texts.length - missed
      });
    } catch (e) { return fail(e); }
  });

  /**
   * 词级对齐：给已翻译的段落生成可字面定位的词对。
   * 前端在进入并排/行间后异步调用，结果落盘缓存；同一份文件同一模型只算一次。
   */
  ipcMain.handle('ai:align', async (_e, { id, force, path: filePath }) => {
    try {
      const sk = findSkill(id);
      if (!sk) throw new Error('skill 不存在');

      let target = sk.path;
      if (filePath) {
        target = scanner.norm(filePath);
        const rel = path.relative(sk.dir, target);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error('拒绝对齐：该文件不在该 skill 目录内。');
        }
      }

      const r = skills.readSkill(target);
      if (!r.ok) throw new Error(r.error);

      const lang = store.get().settings.translate?.target || 'zh-CN';
      const model = ai.cfg().model;

      const tr = skills.readCache(r.hash, lang, model);
      if (!tr || !Array.isArray(tr.list)) {
        throw new Error('还没有译文缓存。请先进入「并排」或「行间」完成一次翻译。');
      }

      const { segmentMarkdown, translatableOf } = await mdseg();
      const blocks = segmentMarkdown(r.content);
      const { ids, texts } = translatableOf(blocks);
      const srcBySeg = new Map(ids.map((sid, i) => [sid, texts[i]]));
      const dstBySeg = new Map(ids.map((sid, i) => [sid, tr.list[i] || '']));

      const cached = force ? null : skills.readAlign(r.hash, lang, model);
      const map = (cached && cached.map) || {};

      const todo = ids
        .filter((sid) => String(dstBySeg.get(sid) || '').trim())
        .filter((sid) => !map[sid] && !map[String(sid)])
        .map((sid) => ({ i: sid, s: String(srcBySeg.get(sid) || ''), d: String(dstBySeg.get(sid) || '') }));

      let missed = 0;
      if (todo.length) {
        const got = await ai.alignSegments(todo, lang);
        for (const [k, v] of Object.entries(got)) map[k] = v;
        missed = Object.keys(got).length;
        skills.writeAlign(r.hash, lang, model, map);
      }

      return ok({ map, model, lang, count: Object.keys(map).length, missed, cached: !todo.length });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('ai:propose', async (_e, { id, instruction }) => {
    try {
      const sk = findSkill(id);
      if (!sk) throw new Error('skill 不存在');
      const r = skills.readSkill(sk.path);
      if (!r.ok) throw new Error(r.error);
      if (!instruction || !instruction.trim()) throw new Error('请先写下修改要求。');

      const res = await ai.rewriteSkill(r.content, instruction.trim());
      if (res.content.trim() === r.content.trim()) {
        throw new Error('模型没有产生任何改动，请把要求写得更具体。');
      }
      const diff = skills.diffLines(r.content, res.content);

      const proposalId = 'p' + (++proposalSeq) + '-' + Date.now().toString(36);
      proposals.set(proposalId, {
        id: proposalId,
        skillId: id,
        path: r.path,
        hash: r.hash,
        original: r.content,
        proposed: res.content,
        instruction: instruction.trim(),
        model: res.model,
        createdAt: Date.now()
      });

      return ok({
        proposalId,
        diff: diff.rows,
        added: diff.added,
        removed: diff.removed,
        model: res.model,
        bytesBefore: Buffer.byteLength(r.content, 'utf8'),
        bytesAfter: Buffer.byteLength(res.content, 'utf8')
      });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('ai:approve', (_e, { proposalId }) => {
    try {
      const p = proposals.get(proposalId);
      if (!p) throw new Error('提案已失效，请重新生成。');
      // 批准时再次确认磁盘内容没被别人改过
      const cur = skills.readSkill(p.path);
      if (!cur.ok) throw new Error(cur.error);
      if (cur.hash !== p.hash) {
        proposals.delete(proposalId);
        throw new Error('文件在提案生成后被外部修改过，已中止写入。请重新生成提案。');
      }
      const w = skills.writeSkill(p.path, p.proposed, { model: p.model, note: p.instruction.slice(0, 120) });
      proposals.delete(proposalId);

      // 更新索引里的字数/时间
      const s = store.get();
      const sk = s.skills.find((x) => x.id === p.skillId);
      if (sk) {
        const meta = scanner.readSkillMeta(sk.dir, sk.scope, sk.productId);
        if (meta) Object.assign(sk, { words: meta.words, bytes: meta.bytes, mtime: meta.mtime });
        store.save();
      }
      return ok({ backup: w.backup, path: w.path });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('ai:reject', (_e, { proposalId }) => {
    proposals.delete(proposalId);
    return ok({});
  });

  ipcMain.handle('ai:audit', () => ok(store.get().audit || []));

  /* ----------------------------- 标记 ----------------------------- */

  ipcMain.handle('anno:get', (_e, { id }) => {
    try { return ok(skills.getAnnotations(id)); } catch (e) { return fail(e); }
  });

  ipcMain.handle('anno:set', (_e, { id, list }) => {
    try { return ok(skills.setAnnotations(id, list)); } catch (e) { return fail(e); }
  });

  /* --------------------------- 导入与归位 --------------------------- */

  const stagingRoot = () => {
    const s = store.get();
    return s.staging && s.staging.root ? s.staging.root : '';
  };

  ipcMain.handle('staging:get', () => {
    try {
      const root = stagingRoot();
      const state = root ? importer.stagingState(root) : { root: '', exists: false, items: [], skillCount: 0, other: [] };
      return ok({
        ...state,
        threshold: (store.get().staging || {}).threshold || 6,
        categories: root ? organizer.categories(root).list : []
      });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('staging:setRoot', (_e, { root }) => {
    try {
      const s = store.get();
      s.staging = { ...(s.staging || {}), root: scanner.norm(root), threshold: (s.staging || {}).threshold || 6 };
      store.save();
      return ok(s.staging);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('import:url', async (_e, { url }) => {
    try {
      const root = stagingRoot();
      if (!root) throw new Error('还没有设置暂存目录（建议指向 AAA-new）');
      const r = await importer.importUrl(url, root);
      const st = importer.stagingState(root);
      const threshold = (store.get().staging || {}).threshold || 6;
      store.pushAudit({ action: 'import', file: r.imported.map((x) => x.dir).join(' | '), note: url });
      return ok({
        imported: r.imported,
        skillCount: st.skillCount,
        threshold,
        reached: st.skillCount >= threshold,
        items: st.items
      });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('organize:propose', async (_e, { root }) => {
    try {
      const r = await organizer.propose(root || stagingRoot());
      return ok(r);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('organize:apply', (_e, { moves, targetRoot }) => {
    try {
      const results = organizer.apply(moves, targetRoot || path.dirname(stagingRoot()));

      // 目录换了位置 → skill id 也变了，把分组/收藏/评分/组合里的引用一起改指
      const pairs = results
        .filter((r) => r.ok)
        .map((r) => ({ oldId: scanner.uid(r.from), newId: scanner.uid(r.to) }));
      store.remapSkillIds(pairs);

      // 索引里把旧路径的条目换成新路径
      const s = store.get();
      for (const r of results.filter((x) => x.ok)) {
        const oldId = scanner.uid(r.from);
        const sk = s.skills.find((x) => x.id === oldId);
        if (sk) {
          s.skills = s.skills.filter((x) => x.id !== oldId);
        }
      }
      store.save();

      const okCount = results.filter((r) => r.ok).length;
      s.staging = { ...(s.staging || {}), lastOrganized: Date.now() };
      store.save();
      store.pushAudit({
        action: 'organize',
        file: results.filter((r) => r.ok).map((r) => r.to).join(' | '),
        note: `归位 ${okCount}/${results.length}`
      });
      return ok({ results, okCount, failed: results.length - okCount });
    } catch (e) { return fail(e); }
  });

  /* --------------------------- 系统杂项 --------------------------- */

  ipcMain.handle('clipboard:write', (_e, { text }) => {
    clipboard.writeText(String(text || ''));
    return ok({});
  });

  ipcMain.handle('shell:openPath', (_e, { p }) => {
    try { shell.openPath(scanner.norm(p)); return ok({}); } catch (e) { return fail(e); }
  });

  ipcMain.handle('backup:list', () => {
    try {
      const dir = store.paths.backups;
      if (!fs.existsSync(dir)) return ok([]);
      const list = fs.readdirSync(dir)
        .filter((f) => f.endsWith('__SKILL.md'))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, path: path.join(dir, f), size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return ok(list);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('cache:clear', () => {
    try { return ok({ removed: skills.clearCache() }); } catch (e) { return fail(e); }
  });
}

module.exports = { register };
