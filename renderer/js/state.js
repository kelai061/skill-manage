/* state.js — 极简响应式状态 */

import { api } from './api.js';

const listeners = new Set();

export const state = {
  config: null,
  view: 'skills',
  query: '',
  agentResultIds: null,
  scope: 'all',      // all | global | project | ungrouped
  groupId: null,
  productId: null,
  projectId: null,   // 只看某个项目
  collectionId: null, // 只看某个技能集
  parentId: null,     // 只看某个父 skill 下的嵌套
  showNested: false,  // 把嵌套 skill 也平铺出来
  onlyFav: false,
  showHidden: false,
  sort: 'recent',    // recent | name | size | rating
  selection: new Set(),
  scratchDirty: false
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(reason = '') {
  for (const fn of listeners) fn(reason);
}

export async function reload() {
  state.config = await api.getConfig();
  window.__HOME__ = state.config.meta.home || '';
  return state.config;
}

/** 重新拉取配置并通知重绘 */
export async function refresh(reason = 'data') {
  await reload();
  notify(reason);
  return state.config;
}

export function skills() {
  return (state.config && state.config.skills) || [];
}

// A single on-disk skill can be indexed by several products. Keep those
// memberships in storage, but present the same path-based identity once in a
// given view. Distinct directories have distinct IDs even when names match.
export function uniqueSkills(list) {
  const seen = new Set();
  return (list || []).filter((s) => {
    if (!s || !s.id || seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

export function groups() {
  return (state.config && state.config.groups) || [];
}

export function products() {
  return (state.config && state.config.products) || [];
}

export function combos() {
  return (state.config && state.config.combos) || [];
}

export function scratch() {
  return (state.config && state.config.scratch) || { skillIds: [] };
}

export function groupsOf(skillId) {
  const map = (state.config && state.config.skillGroups) || {};
  const ids = map[skillId] || [];
  return groups().filter((g) => ids.includes(g.id));
}

export function productName(id) {
  const p = products().find((x) => x.id === id);
  return p ? p.name : '未知产品';
}

export function skillById(id) {
  return skills().find((s) => s.id === id) || null;
}

/* ---------------- 嵌套 / 技能集 ---------------- */

/** 被用户手动「移出」父级的嵌套 skill */
export function detachedSet() {
  return new Set((state.config && state.config.detachedSkills) || []);
}

/**
 * 嵌套 skill 默认收在父级里，不铺到卡片墙上。
 * 三种情况会露出来：用户手动移出、打开「显示嵌套」、正在下钻该父级/集合。
 */
export function isNestedHidden(s) {
  if (!s || !s.nested) return false;
  if (detachedSet().has(s.id)) return false;
  if (state.showNested) return false;
  if (state.parentId && s.parentId === state.parentId) return false;
  if (state.collectionId && s.collectionId === state.collectionId) return false;
  return true;
}

/* ---------------- 收藏 / 评价 / 项目 ---------------- */

export function favorites() {
  return (state.config && state.config.favorites) || [];
}

export function isFavorite(id) {
  return favorites().includes(id);
}

export function ratingOf(id) {
  const r = (state.config && state.config.ratings) || {};
  return r[id] || null;
}

export function activeProduct() {
  return products().find((p) => p.id === state.productId) || null;
}

export function hiddenSet() {
  const p = activeProduct();
  return new Set((p && p.hidden) || []);
}

export function projectOf(skill) {
  if (!skill || !skill.projectId) return null;
  for (const p of products()) {
    const hit = (p.projects || []).find((x) => x.id === skill.projectId);
    if (hit) return hit;
  }
  return null;
}

export function projectName(skill) {
  const p = projectOf(skill);
  return p ? p.name : '';
}

/** 应用筛选 + 排序 */
export function visibleSkills({ deduplicate = true } = {}) {
  let list = skills().slice();
  if (state.agentResultIds) {
    const byId = new Map(list.map(s => [s.id, s]));
    return uniqueSkills(state.agentResultIds.map(id => byId.get(id)).filter(Boolean));
  }
  const q = state.query.trim().toLowerCase();
  const hidden = state.showHidden ? new Set() : hiddenSet();

  if (state.productId) list = list.filter((s) => s.productId === state.productId);
  if (hidden.size) list = list.filter((s) => !hidden.has(s.id));

  if (state.scope === 'global') list = list.filter((s) => s.scope === 'global');
  else if (state.scope === 'project') list = list.filter((s) => s.scope === 'project');
  else if (state.scope === 'ungrouped') list = list.filter((s) => groupsOf(s.id).length === 0);

  if (state.projectId) list = list.filter((s) => s.projectId === state.projectId);
  if (state.parentId) list = list.filter((s) => s.parentId === state.parentId);
  if (state.collectionId) list = list.filter((s) => s.collectionId === state.collectionId);

  if (state.onlyFav) list = list.filter((s) => isFavorite(s.id));
  if (state.groupId) list = list.filter((s) => groupsOf(s.id).some((g) => g.id === state.groupId));

  // 先匹配、再折叠：006 轮先折叠后搜索，导致「搜子 skill 的名字」永远
  // 得到「没有匹配」。有搜索词时把嵌套项一起拿出来，命中才可能被看见。
  if (!state.parentId && !state.collectionId && !q) list = list.filter((s) => !isNestedHidden(s));

  if (q) {
    list = list.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q) ||
      s.dir.toLowerCase().includes(q) ||
      (s.tags || []).some((t) => String(t).toLowerCase().includes(q))
    );
  }

  // Deduplicate after product/project/scope filters so every product retains
  // access to its own membership of a shared skill.
  if (deduplicate) list = uniqueSkills(list);

  if (state.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  else if (state.sort === 'size') list.sort((a, b) => b.bytes - a.bytes);
  else if (state.sort === 'rating') {
    list.sort((a, b) => (ratingOf(b.id)?.stars || 0) - (ratingOf(a.id)?.stars || 0));
  } else list.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

  return list;
}

export function setView(v) {
  state.view = v;
  state.selection.clear();
  notify('view');
}
