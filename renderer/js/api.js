/* api.js — 渲染进程与主进程的唯一调用入口 */

export async function call(channel, payload = {}) {
  if (!window.atelier) throw new Error('预加载桥接缺失，客户端未正确启动。');
  const res = await window.atelier.call(channel, payload);
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || '操作失败');
  }
  return res.data;
}

export async function copy(text) {
  await call('clipboard:write', { text });
}

export const api = {
  /* 配置 */
  getConfig: () => call('config:get'),
  patchConfig: (patch) => call('config:patch', patch),
  applyTheme: (color, symbolColor) => call('theme:apply', { color, symbolColor }),

  /* 产品 */
  probe: (launchPath) => call('product:probe', { launchPath }),
  addProduct: (payload) => call('product:add', payload),
  removeProduct: (id) => call('product:remove', { id }),
  rescan: (id) => call('product:rescan', { id }),
  autoProjects: (id) => call('product:autoProjects', { id }),
  addProjectRoot: (id, dir) => call('product:addProjectRoot', { id, dir }),
  removeProjectRoot: (id, dir) => call('product:removeProjectRoot', { id, dir }),
  hideSkill: (productId, skillId, hidden) => call('product:hideSkill', { productId, skillId, hidden }),
  pickPath: (mode) => call('product:pickPath', { mode }),

  /* 项目 */
  discoverProjects: (root, all) => call('project:discover', { root, all }),
  addProject: (productId, path, name) => call('project:add', { productId, path, name }),
  removeProject: (productId, projectId) => call('project:remove', { productId, projectId }),
  rescanProject: (productId, projectId) => call('project:rescan', { productId, projectId }),

  /* 收藏 / 评价 */
  toggleFavorite: (id) => call('favorite:toggle', { id }),
  setRating: (id, stars, note) => call('rating:set', { id, stars, note }),

  /* 导入与归位 */
  staging: () => call('staging:get'),
  setStagingRoot: (root) => call('staging:setRoot', { root }),
  importUrl: (url) => call('import:url', { url }),
  organizePropose: (root) => call('organize:propose', { root }),
  organizeApply: (moves) => call('organize:apply', { moves }),

  /* 项目 skill 增删 */
  createSkill: (payload) => call('skill:create', payload),
  deleteSkill: (id) => call('skill:delete', { id }),
  detachSkill: (id, detach) => call('skill:detach', { id, detach }),

  /* skill */
  listSkills: () => call('skill:list'),
  readSkill: (id) => call('skill:read', { id }),
  skillFiles: (id) => call('skill:files', { id }),
  readFile: (p) => call('file:read', { p }),
  reveal: (p) => call('skill:reveal', { p }),

  /* 首次启动 / 分享 / 更新 */
  detectTools: () => call('app:detectTools'),
  copyBrief: () => call('app:copyBrief'),
  exportShare: (p) => call('share:export', { path: p }),
  importShare: (p) => call('share:import', { path: p }),
  comboText: (id) => call('share:comboText', { id }),
  checkUpdate: () => call('update:check'),
  openUpdate: (url) => call('update:open', { url }),
  setGroups: (skillId, groupIds) => call('skill:setGroups', { skillId, groupIds }),

  /* 分组 */
  createGroup: (name, color) => call('group:create', { name, color }),
  updateGroup: (id, patch) => call('group:update', { id, patch }),
  deleteGroup: (id) => call('group:delete', { id }),

  /* 组合 */
  createCombo: (name, skillIds, note) => call('combo:create', { name, skillIds, note }),
  updateCombo: (id, patch) => call('combo:update', { id, patch }),
  deleteCombo: (id) => call('combo:delete', { id }),
  copyCombo: (skillIds) => call('combo:copy', { skillIds }),
  comboText: (skillIds) => call('combo:text', { skillIds }),

  /* 临时组合 */
  getScratch: () => call('scratch:get'),
  setScratch: (skillIds) => call('scratch:set', { skillIds }),
  addScratch: (skillIds) => call('scratch:add', { skillIds }),
  removeScratch: (skillId) => call('scratch:remove', { skillId }),
  clearScratch: () => call('scratch:clear'),
  promoteScratch: (name) => call('scratch:promote', { name }),

  /* AI */
  testAI: (snapshot) => call('ai:test', snapshot ? { api: snapshot } : {}),
  translate: (id, force, p) => call('ai:translate', { id, force, path: p }),
  align: (id, force, p) => call('ai:align', { id, force, path: p }),
  propose: (id, instruction) => call('ai:propose', { id, instruction }),
  approve: (proposalId) => call('ai:approve', { proposalId }),
  reject: (proposalId) => call('ai:reject', { proposalId }),
  audit: () => call('ai:audit'),

  /* 标记 */
  getAnnotations: (id) => call('anno:get', { id }),
  setAnnotations: (id, list) => call('anno:set', { id, list }),

  /* 杂项 */
  openPath: (p) => call('shell:openPath', { p }),
  backups: () => call('backup:list'),
  clearCache: () => call('cache:clear')
};
