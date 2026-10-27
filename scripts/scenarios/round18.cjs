'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('original-fs');
const { clipboard, dialog } = require('electron');
const { execFileSync } = require('node:child_process');

module.exports = async ({ app, win, delay }) => {
  const previousClipboard = await clipboard.readText();
  try {
  const js = code => win.webContents.executeJavaScript(code, true);
  const store = require(path.join(app.getAppPath(), 'main/store'));
  const base = path.join(app.getPath('userData'), 'round18');
  const source = path.join(base, 'source'); const skill = path.join(source, 'example');
  const destination = path.join(base, 'destination');
  fs.mkdirSync(skill, { recursive: true }); fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: round18\ndescription: local fixture\n---\n');
  const zip = path.join(base, 'skill.zip');
  execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:ATELIER_TEST_SOURCE,$env:ATELIER_TEST_ZIP)'], {env:{...process.env, ATELIER_TEST_SOURCE:source, ATELIER_TEST_ZIP:zip}});
  await js(`window.__goto('skills')`); await delay(250);
  await js(`document.querySelector('[data-organize-collections]').click()`); await delay(150);
  assert.match(await clipboard.readText(), /共同父目录/);
  assert.match(await clipboard.readText(), /不要读取或分享 API 密钥/);
  assert.equal(await js(`!!document.querySelector('.description-flip__back [data-description-edit]')`), true);
  await js(`document.querySelector('.description-flip__back [data-description-edit]').click()`); await delay(150);
  assert.equal(await js(`!!document.querySelector('#customDescription')`), true);
  await js(`document.querySelector('.scrim [data-close]').click()`);
  await js(`window.__goto('groups')`); await delay(150);
  await js(`document.querySelector('#organizeGroups').click()`); await delay(150);
  assert.match(await clipboard.readText(), /尚未分类的全局技能/);
  assert.match(await clipboard.readText(), /不删除、不覆盖/);
  const shots = path.join(app.getPath('userData'), 'shots'); fs.mkdirSync(shots, { recursive:true });
  store.get().groups.push({ id:'round18-group', name:'示例分组', color:'blue' }); store.save();
  await js(`(async()=>{await window.__refreshAll(); window.__goto('groups')})()`); await delay(150);
  fs.writeFileSync(path.join(shots, 'groups.png'), (await win.capturePage()).toPNG());
  await js(`window.__goto('products')`); await delay(150);
  fs.writeFileSync(path.join(shots, 'products.png'), (await win.capturePage()).toPNG());
  await js(`window.__goto('settings')`); await delay(200);
  assert.equal(await js(`[...document.querySelectorAll('[data-settings-jump]')].every(b => [...document.querySelectorAll('[data-settings-section]')].some(s => s.dataset.settingsSection === b.dataset.settingsJump))`), true);
  fs.writeFileSync(path.join(shots, 'settings.png'), (await win.capturePage()).toPNG());
  const originalOpen = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
  try {
    store.get().thirdPartyDefaultProductId = '';
    await js(`(async()=>{await window.__refreshAll(); const m=await import('app://local/js/archive-import.js'); await m.importArchiveFile(${JSON.stringify(zip)});})()`);
    await delay(200);
    await js(`[...document.querySelectorAll('.dialog__foot button')].find(b=>b.textContent.trim()==='导入').click()`); await delay(200);
    assert.equal(await js(`[...document.querySelectorAll('.dialog__head h3')].at(-1).textContent`), '设置默认 Skill 目录');
    await js(`[...document.querySelectorAll('.dialog__foot button')].find(b=>b.textContent.trim()==='选择目录').click()`);
    for(let i=0;i<50&&!store.get().skills.some(s=>s.name==='round18');i++) await delay(100);
    assert.ok(store.get().products.some(p => p.id === store.get().thirdPartyDefaultProductId && p.launchPath === destination));
    assert.ok(store.get().skills.some(s => s.name === 'round18'));
  } finally { dialog.showOpenDialog = originalOpen; }
  console.log('[PASS] Agent prompts, empty description edit, settings navigation, default directory guidance and ZIP import');
  return { ok:true };
  } finally { await clipboard.writeText(previousClipboard); }
};
