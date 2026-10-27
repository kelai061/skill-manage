'use strict';
const assert = require('node:assert/strict');
const fs = require('original-fs');
const path = require('node:path');

module.exports = async ({ app, win, delay }) => {
  const store = require(path.join(app.getAppPath(), 'main/store'));
  const scanner = require(path.join(app.getAppPath(), 'main/scanner'));
  const root = path.join(app.getPath('userData'), 'round17-duplicates');
  const first = path.join(root, 'first');
  const other = path.join(root, 'different');
  for (const dir of [first, other]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: shared-unique-test\ndescription: fixture\n---\n\n# Fixture\n');
  }
  const one = scanner.readSkillMeta(first, 'global', 'dup-product-a');
  const two = scanner.readSkillMeta(first, 'global', 'dup-product-b');
  const distinct = scanner.readSkillMeta(other, 'global', 'dup-product-b');
  assert.equal(one.id, two.id);
  assert.notEqual(one.id, distinct.id);
  const config = store.get();
  config.products.push({id:'dup-product-a',name:'A',launchPath:root,projects:[]}, {id:'dup-product-b',name:'B',launchPath:root,projects:[]});
  config.skills.push(one, two, distinct);
  config.favorites.push(one.id);
  config.ratings[one.id] = {stars: 4, note:'kept'};
  store.save();
  const js = code => win.webContents.executeJavaScript(code, true);
  await js(`(async()=>{const {state,refresh}=await import('app://local/js/state.js');state.productId=null;state.scope='all';state.query='shared-unique-test';await refresh('data');window.__goto('skills');})()`);
  await delay(300);
  assert.equal(await js(`document.querySelectorAll('#grid .card[data-id]').length`), 2);
  assert.equal(await js(`document.querySelectorAll('#grid [data-id="${one.id}"]').length`), 1);
  for (const product of ['dup-product-a', 'dup-product-b']) {
    await js(`(async()=>{const {state,refresh}=await import('app://local/js/state.js');state.productId=${JSON.stringify(product)};await refresh('data');})()`);
    await delay(200);
    assert.equal(await js(`document.querySelectorAll('#grid [data-id="${one.id}"]').length`), 1);
  }
  assert.equal(store.get().skills.filter(s => s.id === one.id).length, 2);
  assert.ok(store.get().favorites.includes(one.id));
  assert.equal(store.get().ratings[one.id].note, 'kept');
  assert.ok(fs.existsSync(path.join(first, 'SKILL.md')) && fs.existsSync(path.join(other, 'SKILL.md')));
  const sharedProject = path.join(root, 'shared-project');
  const favoriteDir = path.join(sharedProject, 'favorite');
  const plainDir = path.join(sharedProject, 'plain');
  for (const dir of [favoriteDir, plainDir]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: project-fixture\ndescription: fixture\n---\n# Fixture\n');
  }
  const favorite = scanner.readSkillMeta(favoriteDir, 'project', 'dup-product-a', 'shared-project');
  const favoriteB = scanner.readSkillMeta(favoriteDir, 'project', 'dup-product-b', 'shared-project');
  const plain = scanner.readSkillMeta(plainDir, 'project', 'dup-product-a', 'shared-project');
  config.products.find(p => p.id === 'dup-product-a').projects.push({id:'shared-project',name:'A project',path:sharedProject});
  config.products.find(p => p.id === 'dup-product-b').projects.push({id:'shared-project',name:'B project',path:sharedProject});
  config.skills.push(favorite, favoriteB, plain);
  config.favorites.push(favorite.id);
  config.groups.push({id:'dup-group',name:'Fixture group',color:'blue'});
  config.skillGroups[favorite.id] = ['dup-group'];
  store.save();
  for (const filter of ['favorite', 'group']) {
    await js(`(async()=>{const {state,refresh}=await import('app://local/js/state.js');state.query='';state.productId=null;state.projectId=null;state.scope='project';state.onlyFav=${filter === 'favorite'};state.groupId=${JSON.stringify(filter === 'group' ? 'dup-group' : null)};await refresh('data');})()`);
    await delay(200);
    const counts = await js(`Array.from(document.querySelectorAll('[data-projcard="shared-project"] .projcard__meta .badge:first-child'), e => e.textContent.trim())`);
    assert.deepEqual(counts, ['1 个 skill', '1 个 skill']);
  }
  console.log('[PASS] Shared path appears once across products; product membership, ratings, separate paths and source files remain intact');
  return {ok:true};
};
