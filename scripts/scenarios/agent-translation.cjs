'use strict';
const assert = require('node:assert/strict');
module.exports = async function({ win, delay, shot }) {
  const js = code => win.webContents.executeJavaScript(code, true);
  await js(`(async () => {
    const { state } = await import('./js/state.js');
    const { api } = await import('./js/api.js');
    const { openReader } = await import('./js/views/reader.js');
    const skill = state.config.skills.find(s => s.name === 'bilingual-fixture');
    window.agentTestId = skill.id;
    await api.patchConfig({ settings: { api: { key: '' } } });
    await openReader(skill.id);
    document.querySelector('#agentTranslationBtn').click();
  })()`);
  await delay(600);
  assert(await js(`!document.querySelector('.scrim') && !document.querySelector('#agentResult')`), 'copy instruction requires no import dialog');
  const fs = require('node:fs');
  const path = require('node:path');
  async function readTask() {
    const prompt = await require('electron').clipboard.readText();
    assert(prompt.includes('不要求我粘贴或导入结果'));
    assert(prompt.includes('complete=true'));
    const file = prompt.match(/任务索引：([^\n]+)/)[1].trim();
    return { file, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  function externalWrite(task) {
    const helper = require(path.join(require('electron').app.getAppPath(), 'main', 'translationTasks.js'));
    const resultFile = path.join(path.dirname(task.file), 'result.json');
    for (let batch = helper.next(task.file); batch.items; batch = helper.next(task.file)) {
      fs.writeFileSync(resultFile, JSON.stringify({ translations: batch.items.map(item => ({ key: item.key, text: '智能体直接保存译文 ' + item.key.slice(0, 6) })) }));
      helper.commit(task.file, batch.file, resultFile);
    }
    assert.equal(helper.status(task.file).complete, true);
  }
  externalWrite(await readTask());
  await js(`document.querySelector('[data-mode="side"]').click()`);
  await delay(600);
  assert(await js(`document.querySelector('#proseDst')?.textContent.includes('智能体直接保存译文')`), 'agent-written cache is read without importing or configuring an API key');
  await shot('agent-direct-reading');
  assert(await js(`(async () => {
    const { api } = await import('./js/api.js');
    return (await api.agentInstruction(window.agentTestId)).count === 0;
  })()`), 'directly saved translations excluded on repeat');
  await js(`(async () => {
    const { closeReader } = await import('./js/views/reader.js');
    const { renderSettings } = await import('./js/views/settings.js');
    const { state, refresh } = await import('./js/state.js');
    closeReader();
    await refresh('data');
    const host = document.createElement('div'); host.id='agentSettingsFixture'; document.body.appendChild(host);
    renderSettings(host);
  })()`);
  assert(await js(`document.querySelector('#selectionLive').checked === false`), 'experimental option defaults off');
  await js(`document.querySelector('#selectionLive').click()`);
  await delay(250);
  assert(await js(`(async () => (await window.atelier.call('config:get')).data.settings.translate.selectionLive)()`), 'setting persists');
  await js(`(async () => {
    document.querySelector('#agentSettingsFixture').remove();
    const { api } = await import('./js/api.js');
    const { openReader } = await import('./js/views/reader.js');
    await api.patchConfig({ settings: { api: { key: 'fixture-only' } } });
    await openReader(window.agentTestId);
    window.selectAgentWord = () => {
      const el = document.querySelector('#proseSrc h1');
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode();
      const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, Math.min(9, text.length));
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    };
    window.selectAgentWord();
  })()`);
  await delay(1000);
  console.log('word selection', await js(`(async () => ({ live: (await import('./js/state.js')).state.config.settings.translate.selectionLive, selected: String(window.getSelection()), tool: !!document.querySelector('.seltool'), tip: document.querySelector('.wordtip')?.textContent }))()`));
  assert(await js(`!!document.querySelector('.wordtip') && !document.querySelector('.wordtip').textContent.includes('翻译中')`), 'enabled word translation resolves in a tooltip');
  await shot('experimental-word-translation');
  await js(`window.getSelection().removeAllRanges()`);
  await delay(150);
  assert(await js(`!document.querySelector('.wordtip')`), 'clearing selection removes word result');
  await js(`window.selectAgentWord(); window.getSelection().removeAllRanges()`);
  await delay(800);
  assert(await js(`!document.querySelector('.wordtip')`), 'abandoned selection cannot show a late tooltip');
  await js(`(async () => { (await import('./js/views/reader.js')).closeReader(); document.querySelector('#agentTranslateBtn').click(); })()`);
  await delay(700);
  assert(await js(`!document.querySelector('.scrim') && !document.querySelector('#batchResult')`), 'top-right copies direct instruction without import UI');
  const completeTask = await readTask();
  assert(completeTask.manifest.batches.length > 0);
  externalWrite(completeTask);
  await shot('topbar-direct-agent-translation');
  const next = await js(`(async () => (await import('./js/api.js')).api.copyTranslation())()`);
  assert.equal(next.count, 0, 'all externally saved translations are excluded from next instruction');
  console.log('PASS direct agent translation UI: copy only, external cache writes visible offline, full task filtering, opt-in word translation');
};
