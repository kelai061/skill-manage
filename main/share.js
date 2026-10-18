'use strict';
/**
 * share.js — 把「整理成果」变成可分享的东西
 *
 * 导出：产品 / 项目 / 分组 / 组合 / 收藏 / 评分 → 一份 JSON，换台电脑导入即可复用。
 * 导入：按 id / 名称去重合并，绝不删除本地已有的东西。
 * 组合分享：一份 Markdown 清单，贴给同事就能照着装。
 */

const EXPORT_KIND = 'skill-atelier-share';

function buildExport(cfg) {
  const products = (cfg.products || []).map((p) => ({
    id: p.id,
    name: p.name,
    launchPath: p.launchPath,
    projects: (p.projects || []).map((pr) => ({
      id: pr.id,
      name: pr.name,
      path: pr.path,
      auto: !!pr.auto
    })),
    hidden: p.hidden || []
  }));

  return {
    kind: EXPORT_KIND,
    version: 1,
    exportedAt: new Date().toISOString(),
    products,
    groups: (cfg.groups || []).map((g) => ({ id: g.id, name: g.name, color: g.color })),
    combos: (cfg.combos || []).map((c) => ({ id: c.id, name: c.name, note: c.note || '', skillIds: c.skillIds || [] })),
    skillGroups: cfg.skillGroups || {},
    favorites: cfg.favorites || [],
    ratings: cfg.ratings || {},
    skillCount: (cfg.skills || []).length
  };
}

/**
 * 合并导入。返回统计；不删除任何本地数据。
 * 产品按 id 去重（id 是路径哈希），分组/组合按名称去重。
 */
function mergeImport(cfg, data) {
  if (!data || data.kind !== EXPORT_KIND) throw new Error('不是 Skill Atelier 的分享文件。');
  for (const key of ['products', 'groups', 'combos', 'favorites']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(`分享文件字段 ${key} 必须是数组。`);
  }
  for (const product of data.products || []) {
    if (product && product.projects !== undefined && !Array.isArray(product.projects)) throw new Error('分享文件的 projects 必须是数组。');
  }
  for (const combo of data.combos || []) {
    if (combo && combo.skillIds !== undefined && !Array.isArray(combo.skillIds)) throw new Error('分享文件的 skillIds 必须是数组。');
  }
  for (const key of ['skillGroups', 'ratings']) {
    if (data[key] !== undefined && (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key]))) throw new Error(`分享文件字段 ${key} 必须是对象。`);
  }
  for (const gids of Object.values(data.skillGroups || {})) {
    if (!Array.isArray(gids)) throw new Error('分享文件的分组归属必须是数组。');
  }

  const stat = { products: 0, groups: 0, combos: 0, favorites: 0 };
  cfg.products = cfg.products || [];
  cfg.groups = cfg.groups || [];
  cfg.combos = cfg.combos || [];
  cfg.skillGroups = cfg.skillGroups || {};
  cfg.favorites = cfg.favorites || [];

  for (const p of (data.products || [])) {
    if (!p || !p.id) continue;
    let local = cfg.products.find((x) => x.id === p.id);
    if (!local) {
      local = {
        id: p.id,
        name: p.name || '未命名产品',
        launchPath: p.launchPath || '',
        manualRoots: [],
        projectRoots: [],
        projects: [],
        hidden: [],
        createdAt: Date.now()
      };
      cfg.products.push(local);
      stat.products++;
    }
    local.projects = local.projects || [];
    for (const pr of (p.projects || [])) {
      if (!pr || !pr.id) continue;
      if (!local.projects.some((x) => x.id === pr.id)) {
        local.projects.push({ ...pr, addedAt: Date.now() });
      }
    }
  }

  const groupIds = new Map();
  const unusedId = (prefix, existing) => {
    let id;
    do { id = prefix + require('node:crypto').randomBytes(8).toString('hex'); } while (existing.some((x) => x.id === id));
    return id;
  };
  for (const g of (data.groups || [])) {
    if (!g || !g.name) continue;
    let local = cfg.groups.find((x) => x.name === g.name);
    if (!local) {
      const id = g.id && !cfg.groups.some((x) => x.id === g.id) ? g.id : unusedId('g', cfg.groups);
      local = { id, name: g.name, color: g.color || 'primary', createdAt: Date.now() };
      cfg.groups.push(local);
      stat.groups++;
    }
    if (g.id) groupIds.set(g.id, local.id);
  }

  for (const c of (data.combos || [])) {
    if (!c || !c.name) continue;
    if (!cfg.combos.some((x) => x.name === c.name)) {
      const id = c.id && !cfg.combos.some((x) => x.id === c.id) ? c.id : unusedId('c', cfg.combos);
      cfg.combos.push({ id, name: c.name, note: c.note || '', skillIds: c.skillIds || [], createdAt: Date.now() });
      stat.combos++;
    }
  }

  for (const [sid, gids] of Object.entries(data.skillGroups || {})) {
    if (['__proto__', 'constructor', 'prototype'].includes(sid)) continue;
    if (!Object.prototype.hasOwnProperty.call(cfg.skillGroups, sid)) cfg.skillGroups[sid] = [];
    for (const gid of (gids || [])) {
      const mapped = groupIds.get(gid) || gid;
      if (cfg.groups.some((g) => g.id === mapped) && !cfg.skillGroups[sid].includes(mapped)) cfg.skillGroups[sid].push(mapped);
    }
  }

  const fav = new Set(cfg.favorites);
  for (const id of (data.favorites || [])) {
    if (!fav.has(id)) { cfg.favorites.push(id); fav.add(id); stat.favorites++; }
  }

  cfg.ratings = cfg.ratings || {};
  for (const [id, r] of Object.entries(data.ratings || {})) {
    if (['__proto__', 'constructor', 'prototype'].includes(id)) continue;
    if (!cfg.ratings[id]) cfg.ratings[id] = r;
  }

  return stat;
}

/** 组合 → 可直接粘贴的 Markdown 清单 */
function comboMarkdown(cfg, combo) {
  const byId = new Map((cfg.skills || []).map((s) => [s.id, s]));
  const lines = [`# ${combo.name || '未命名组合'}`, ''];
  if (combo.note) lines.push(`> ${combo.note}`, '');

  let i = 0;
  for (const id of (combo.skillIds || [])) {
    const s = byId.get(id);
    i++;
    if (!s) {
      lines.push(`${i}. \`${id}\`（本地未收录）`);
      continue;
    }
    lines.push(`${i}. **${s.name}** — ${s.description || '（无描述）'}`);
    lines.push('   `' + s.dir + '`');
  }
  if (!i) lines.push('（这个组合还没有成员）');
  return lines.join('\n');
}

module.exports = { buildExport, mergeImport, comboMarkdown, EXPORT_KIND };
