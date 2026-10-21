'use strict';
const path = require('node:path');
const { identifyProduct } = require('./productIdentity');
const key = (value) => path.resolve(String(value || '')).toLowerCase();
function workbuddyInstall(product) {
  const launch = String(product.launchPath || '');
  if (/[/\\]\.workbuddy(?:-ai)?(?:[/\\]|$)/i.test(launch)) return 'legacy-data';
  return key(/\.exe$/i.test(launch) ? path.dirname(launch) : launch);
}
function sameWorkbuddy(a, b) {
  if (identifyProduct(a) !== 'workbuddy' || identifyProduct(b) !== 'workbuddy') return false;
  const x = workbuddyInstall(a), y = workbuddyInstall(b);
  return x === y || x === 'legacy-data' || y === 'legacy-data';
}
function mergeWorkbuddy(state) {
  const groups = new Map();
  const items = (state.products || []).filter((p) => identifyProduct(p) === 'workbuddy');
  const real = items.map(workbuddyInstall).find((k) => k !== 'legacy-data');
  const productMap = new Map(), projectMap = new Map();
  for (const product of items) {
    const install = workbuddyInstall(product);
    const group = install === 'legacy-data' && real ? real : install;
    let primary = groups.get(group);
    if (!primary) { groups.set(group, product); primary = product; }
    productMap.set(product.id, primary.id);
    if (primary !== product) {
      if (workbuddyInstall(primary) === 'legacy-data' && install !== 'legacy-data') primary.launchPath = product.launchPath;
      for (const field of ['manualRoots', 'projectRoots']) {
        const merged = new Map();
        for (const item of [...(primary[field] || []), ...(product[field] || [])]) merged.set(key(typeof item === 'string' ? item : item.root), item);
        primary[field] = [...merged.values()];
      }
      primary.hidden = [...new Set([...(primary.hidden || []), ...(product.hidden || [])])];
    }
    const projects = primary === product ? [...(product.projects || [])] : [...(primary.projects || []), ...(product.projects || [])];
    const unique = new Map();
    for (const project of projects) {
      const k = key(project.path);
      const previous = unique.get(k);
      if (previous) projectMap.set(project.id, previous.id);
      else unique.set(k, project);
    }
    primary.projects = [...unique.values()];
    if (/^workbuddy(?:[\s_-]*ai)?$/i.test(primary.name || '')) primary.name = 'WorkBuddy';
  }
  state.products = (state.products || []).filter((p) => !productMap.has(p.id) || productMap.get(p.id) === p.id);
  const unique = new Map();
  for (const skill of state.skills || []) {
    if (productMap.has(skill.productId)) {
      skill.productId = productMap.get(skill.productId);
      if (projectMap.has(skill.projectId)) skill.projectId = projectMap.get(skill.projectId);
    }
    unique.set(`${skill.productId}:${skill.id}`, skill);
  }
  state.skills = [...unique.values()];
  return { merged: items.length - groups.size };
}
module.exports = { sameWorkbuddy, mergeWorkbuddy };
