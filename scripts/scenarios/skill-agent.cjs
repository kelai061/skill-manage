'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ win, delay, shot }) => {
  const js = code => win.webContents.executeJavaScript(code, true);
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert(body.tools?.length === 7);
    assert(body.messages[0].content.includes('VibeSkills 4.1.1'));
    calls.push(body);
    const user = body.messages.findLast(m => m.role === 'user').content;
    let message;
    if (user.includes('LONG_REPLY')) message = { content: '这是用户要求的详细说明。'.repeat(35) + '\n失败项：示例下载未成功，需要重试。' };
    else if (user.includes('MANY_SKILLS')) {
      const last = body.messages.at(-1);
      const call = (name, args) => ({ content: null, tool_calls: [{ id: 'many-' + calls.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      if (last.role === 'user') message = call('search_skills', { queries: ['paging-skill'], limit: 50 });
      else {
        const result = JSON.parse(last.content);
        if (result.presented) message = { content: '已按要求列出全部 100 个候选，可筛选或翻页查看。' };
        else if (result.nextOffset !== null) message = call('search_skills', { queries: ['paging-skill'], limit: 50, offset: result.nextOffset });
        else {
          const ids = body.messages.filter(m => m.role === 'tool').flatMap(m => JSON.parse(m.content).items || []).map(s => s.id);
          message = call('present_skills', { skillIds: ids, reasons: ids.map(skillId => ({ skillId, reason: '按用户要求展示的分页候选，适用于界面验证' })) });
        }
      }
    }
    else if (user.includes('SIDEBAR_SLOW')) { await delay(5000); message = { content: '慢响应完成' }; }
    else {
      const last = body.messages.at(-1);
      const call = (name, args) => ({ content: null, tool_calls: [{ id: 'ui-' + calls.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      if (last.role === 'user') message = call('search_skills', { queries: ['follow-builders'] });
      else if (last.role === 'tool') {
        const result = JSON.parse(last.content);
        if (result.presented) message = { content: '已找到 follow-builders，并加入「侧栏测试组」。' };
        else if (result.items) message = call('group_skills', { assignments: [{ skillIds: [result.items[0].id], groups: ['侧栏测试组'] }] });
        else message = call('present_skills', { skillIds: result.results[0].skillIds });
      }
    }
    if (!res.destroyed) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'sidebar-fixture', choices: [{ message }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function until(code, timeout = 12000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await js(code)) return; await delay(100); }
    throw new Error('等待界面超时：' + code);
  }
  const submit = text => js(`(() => { const input = document.querySelector('#agentInput'); input.value = ${JSON.stringify(text)}; input.closest('form').requestSubmit(); return true; })()`);
  try {
    await until("!!document.querySelector('#agentToggle')");
    await js(`window.atelier.call('config:patch', { settings: { api: { baseUrl: ${JSON.stringify(baseUrl)}, key: 'fixture-only', model: 'sidebar-fixture' } } })`);
    await js("document.querySelector('#agentToggle').click(); true");
    assert.equal(await js("document.querySelector('#agentToggle').getAttribute('aria-expanded')"), 'true');
    assert(await js("!document.querySelector('#skillAgent').hidden"));
    await shot('skill-agent-empty');
    await submit('SIDEBAR_GROUP 找到相关 skill 并放入侧栏测试组');
    await until("document.querySelector('#agentMessages').textContent.includes('已找到 follow-builders')");
    await until("!document.querySelector('#agentSend').disabled");
    const config = (await js("window.atelier.call('config:get')")).data;
    const group = config.groups.find(g => g.name === '侧栏测试组');
    assert(group);
    assert(Object.values(config.skillGroups).some(ids => ids.includes(group.id)));
    assert.equal(calls.length, 4, 'search + batch group + present + answer needs four model requests');
    assert.equal(await js("document.querySelectorAll('.agent__message').length"), 2);
    assert(await js("document.querySelector('.agent__trace').textContent.includes('批量更新分组')"));
    assert(await js("!document.querySelector('#agentResults').hidden"));
    await js("document.querySelector('.agent__dismiss-results').click(); true");
    assert(await js("document.querySelector('#agentResults').hidden"));
    assert.equal(await js("document.querySelectorAll('.agent__message').length"),2,'dismissing results preserves the conversation');
    await js("document.querySelector('.agent__history-results').click(); true");
    assert(await js("!document.querySelector('#agentResults').hidden"),'dismissed results can be reopened');
    await shot('skill-agent-result');
    await js("document.querySelector('.agent__show-results').click(); true");
    await until("!!document.querySelector('.agent-results')");
    assert.equal(await js("document.querySelectorAll('#grid [data-id]').length"), 1);
    assert(await js("document.querySelector('#grid').textContent.includes('follow-builders')"));
    await shot('skill-agent-located');
    await js("document.querySelector('#exitAgentResults').click(); true");
    assert(await js("!document.querySelector('.agent-results')"));

    // Navigation must not destroy the conversation or typed drafts.
    await js("document.querySelector('#agentInput').value='保留草稿'; document.querySelector('#agentSettings').click(); true");
    assert.equal(await js("document.querySelector('#agentInput').value"), '保留草稿');
    assert.equal(await js("document.querySelectorAll('.agent__message').length"), 2);
    await js("document.querySelector('#agentClose').click(); true");
    assert(await js("document.querySelector('#skillAgent').hidden"));
    await js("document.querySelector('#agentToggle').click(); true");
    assert.equal(await js("document.querySelector('#agentInput').value"), '保留草稿');

    // A renderer reload restores disk history and the assistant stays usable.
    win.webContents.reload();
    await until("document.querySelectorAll('.agent__message').length === 2");
    await js("document.querySelector('#agentToggle').click(); true");
    const requestCount = calls.length;
    await submit('SIDEBAR_SLOW 请执行慢任务');
    await until("document.querySelector('#agentSend').disabled");
    const deadline = Date.now() + 4000;
    while (calls.length === requestCount && Date.now() < deadline) await delay(100);
    assert(calls.length > requestCount);
    await js("document.querySelector('#agentStop').click(); true");
    await until("document.querySelector('#agentMessages').textContent.includes('任务已停止')");
    assert(await js("!document.querySelector('#agentSend').disabled"));

    // Use real catalog metadata so all 100 selected results remain reachable.
    const root = path.join(require('electron').app.getPath('userData'), 'many-results');
    const appRoot = require('electron').app.getAppPath();
    const scanner = require(path.join(appRoot, 'main', 'scanner'));
    const store = require(path.join(appRoot, 'main', 'store'));
    const many = [];
    for (let i = 0; i < 100; i++) {
      const name = 'paging-skill-' + String(i).padStart(3, '0');
      const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Pagination fixture ${i}\n---\n# ${name}\n`);
      many.push(scanner.readSkillMeta(dir, 'global', 'fixture-product'));
    }
    store.patch({ skills: [...store.get().skills, ...many] });
    await submit('MANY_SKILLS 列出全部分页候选');
    await until("!document.querySelector('#agentSend').disabled && document.querySelector('#agentResults').textContent.includes('100')");
    assert.equal(await js("document.querySelectorAll('.agent__ref').length"), 3);
    assert(await js("document.querySelector('#agentResults').scrollWidth <= document.querySelector('#agentResults').clientWidth + 1"));
    assert.equal((await js("window.atelier.call('agent:status')")).data.messages.at(-1).refs.length, 100);
    assert(await js("document.querySelector('.agent__pagination').textContent.includes('1 / 34')"));
    await shot('skill-agent-many-light');
    for (let i = 1; i < 34; i++) await js("document.querySelector('[aria-label=\"下一页候选\"]').click(); true");
    assert.equal(await js("document.querySelectorAll('.agent__ref').length"), 1);
    assert(await js("document.querySelector('.agent__ref').textContent.includes('paging-skill-099')"));
    assert(await js("document.querySelector('[aria-label=\"下一页候选\"]').disabled"));
    await js("document.querySelector('.agent__filter').value='paging-skill-099'; document.querySelector('.agent__filter').dispatchEvent(new Event('input')); true");
    assert.equal(await js("document.querySelectorAll('.agent__ref').length"), 1);
    await js("document.querySelector('.agent__filter').value='NO_MATCH'; document.querySelector('.agent__filter').dispatchEvent(new Event('input')); true");
    assert(await js("document.querySelector('#agentResults').textContent.includes('没有匹配候选')"));
    await js("document.querySelector('.agent__filter').value=''; document.querySelector('.agent__filter').dispatchEvent(new Event('input')); true");

    // At the smallest supported height, all three rows and the composer fit.
    win.setSize(1000, 660);
    await js("(async () => { await window.atelier.call('config:patch', {settings:{theme:'dark'}}); window.__applyTheme('dark'); })()");
    await until("getComputedStyle(document.querySelector('.agent__identity strong')).color === 'rgb(224, 237, 245)'");
    await delay(300);
    const fit = await js(`(() => {
      const panel = document.querySelector('#skillAgent').getBoundingClientRect();
      const refs = document.querySelector('#agentResults');
      const send = document.querySelector('#agentSend').getBoundingClientRect();
      return { panelFits: panel.top >= 64 && panel.bottom <= innerHeight && panel.right <= innerWidth,
        rowsFit: refs.scrollHeight <= refs.clientHeight + 1, sendFits: send.bottom <= panel.bottom,
        horizontal: document.querySelector('#skillAgent').scrollWidth <= document.querySelector('#skillAgent').clientWidth + 1,
        textColor: getComputedStyle(document.querySelector('.agent__ref strong')).color };
    })()`);
    await shot('skill-agent-many-dark-compact');
    assert(fit.panelFits && fit.rowsFit && fit.sendFits && fit.horizontal, JSON.stringify(fit));
    assert.equal(fit.textColor, 'rgb(224, 237, 245)', 'dark results must retain readable light text');
    await js("document.querySelector('.agent__show-results').click(); true");
    await until("document.querySelectorAll('#grid [data-id]').length === 100");
    assert(await js("document.querySelector('#skillAgent').hidden"), 'compact locate closes the overlay');
    await js("document.querySelector('#agentToggle').click(); true");
    await js("document.querySelector('.agent__read').click(); true");
    await until("!!document.querySelector('#proseSrc')");
    assert(await js("document.querySelector('#proseSrc').textContent.includes('paging-skill-000')"));
    await js("(async () => { const { closeReader }=await import('./js/views/reader.js'); closeReader(); })()");
    win.webContents.reload();
    await until("document.querySelector('.agent__results-head')?.textContent.includes('100')");
    await js("document.querySelector('#agentToggle').click(); true");
    await submit('LONG_REPLY 详细说明并保留失败项');
    await until("!!document.querySelector('.agent__long-reply')");
    assert(await js("!document.querySelector('.agent__long-reply').open"));
    await js("document.querySelector('.agent__long-reply > summary').click(); true");
    assert(await js("document.querySelector('.agent__long-reply').open && document.querySelector('.agent__long-reply').textContent.includes('失败项：示例下载未成功')"));

    await js("document.querySelector('#agentClear').click(); true");
    await until("document.querySelectorAll('.agent__message').length === 0");
    await js("window.atelier.call('config:patch', { settings: { api: { key: '' } } })");
    await submit('没有 API Key 时提示设置');
    await until("!document.querySelector('#agentSend').disabled");
    assert.equal(await js("document.querySelector('#agentInput').value"), '没有 API Key 时提示设置');
    assert.equal((await js("window.atelier.call('agent:status')")).data.messages.length, 0);

    win.setSize(960, 760);
    await js("document.documentElement.dataset.theme='dark'; true");
    await delay(250);
    const bounds = await js("(() => { const r=document.querySelector('#skillAgent').getBoundingClientRect(); return {left:r.left,right:r.right,width:innerWidth}; })()");
    assert(bounds.left >= 0 && bounds.right <= bounds.width);
    await shot('skill-agent-dark-compact');
    console.log('[PASS] sidebar management and recovery; 100 results / 34 pages; filtering, empty filter, main-area locate, reading; dark minimum-height layout; all 100 refs restored; long reply expansion retains failure details');
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
};
