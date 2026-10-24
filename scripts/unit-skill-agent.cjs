'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-skill-agent-'));
process.argv.push('--profile=' + root);
const handlers = new Map();
const originalLoad = Module._load;
Module._load = function(name, parent, main) {
  if (name === 'electron') return { app: { getPath: () => root, getVersion: () => 'test' },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: { getAllWindows: () => [] } };
  return originalLoad.call(this, name, parent, main);
};
const store = require('../main/store');
const scanner = require('../main/scanner');
const agentModule = require('../main/skillAgent');
const ai = require('../main/aiService');
const staging = path.join(root, 'library', 'AAA-new');
fs.mkdirSync(staging, { recursive: true });
function add(dir, name, description) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${'PRIVATE BODY '.repeat(10000)}`);
  return { id: scanner.uid(dir), dir, path: path.join(dir, 'SKILL.md'), name, description, productId: 'p', scope: 'global' };
}
const first = add(path.join(root, 'external', 'agent'), 'agent-designer', '智能体设计与工具编排');
const second = add(path.join(staging, 'pdf'), 'pdf-reader', 'Read PDF documents');
const third = add(path.join(staging, 'writer'), 'writer', '写作助手');
store.patch({ skills: [first], staging: { root: staging }, settings: { api: { key: 'fixture', model: 'test' } } });
require('../main/ipc').register();
const invoke = (channel, payload) => handlers.get(channel)(null, payload);
const exec = (name, args, ctx) => agentModule.execute(name, args, ctx);
const tc = (name, args, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
let requestHandler;
let networkRequests = 0;
const server = http.createServer(async (req, res) => {
  networkRequests++;
  if (req.method === 'GET') { res.writeHead(200); res.end('---\nname: downloaded\ndescription: Downloaded brief\n---\n# Downloaded\n'); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { await requestHandler(JSON.parse(Buffer.concat(chunks)), res); }
  catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: { message: e.message } })); }
});
const respond = (res, message) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ model: 'fixture', choices: [{ message }] })); };

async function main() {
  // Indexed search must not open the source; unindexed staging uses only 8KB.
  const readFile = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (String(file).endsWith('SKILL.md')) throw new Error('Full source read forbidden');
    return readFile.call(this, file, ...args);
  };
  try {
    const result = await exec('search_skills', { queries: ['智能体', 'agent'] });
    assert.equal(result.items[0].id, first.id);
    assert.equal(result.total, 1);
    assert(!JSON.stringify(result).includes('PRIVATE BODY'));
    const all = await exec('search_skills', { queries: [], limit: 1 });
    assert.equal(all.total, 3); assert.equal(all.nextOffset, 1);
    const briefs = await exec('skill_summaries', { skillIds: [second.id, third.id] });
    assert.equal(briefs.items.length, 2); assert.equal(briefs.items[0].description, second.description);
  } finally { fs.readFileSync = readFile; }
  console.log('[PASS] metadata search, pagination, and bounded staging descriptions; no full source read');
  const distractor = add(path.join(root, 'external', 'reagent'), 'reagent-kit', 'Laboratory reagent handling');
  store.get().skills.push(distractor);
  const exact = await exec('search_skills', { queries: ['agent', 'agent'] });
  assert.deepEqual(exact.items.map(s => s.id), [first.id], 'English substrings must not suggest reagent for agent');
  assert.deepEqual(exact.items[0].matchedQueries, ['agent']);
  await assert.rejects(exec('present_skills', { skillIds: [distractor.id] }, { seen: new Set([first.id]) }), /本轮/);
  await assert.rejects(exec('present_skills', { skillIds: [first.id], reasons: [{ skillId: first.id, reason: 'x'.repeat(121) }] }), /理由/);
  const shown = await exec('present_skills', { skillIds: [second.id, first.id] });
  assert.deepEqual(shown.items.map(s => s.id), [second.id, first.id]);
  assert(store.get().skills.some(s => s.id === second.id));
  await assert.rejects(exec('present_skills', { skillIds: ['missing'] }), /不存在/);
  const handoff = require('../main/workspace').brief().text;
  assert(handoff.includes('VibeSkills 4.1.1'));
  assert(handoff.includes('分组只改软件标签'));

  const grouped = await exec('group_skills', { assignments: [
    { skillIds: [first.id, second.id], groups: ['研究', '工具'] },
    { skillIds: ['missing'], groups: ['无效组'] }
  ] });
  assert.deepEqual(grouped.results.map(r => r.ok), [true, false]);
  assert.equal(store.get().groups.length, 2);
  await exec('group_skills', { assignments: [{ skillIds: [first.id], groups: ['研究', '工具'] }] });
  assert.equal(store.get().groups.length, 2);
  await exec('group_skills', { assignments: [{ skillIds: [first.id], groups: ['工具'], mode: 'remove' }] });
  assert.equal(store.get().skillGroups[first.id].length, 1);
  assert.equal(store.get().skillGroups[second.id].length, 2);
  await exec('group_skills', { assignments: [{ skillIds: [first.id], groups: [], mode: 'set' }] });
  assert.equal(store.get().skillGroups[first.id].length, 0);
  console.log('[PASS] batch groups, partial failures, reuse, add/remove/set');

  const organize = payload => invoke('organize:apply', payload);
  await assert.rejects(() => exec('categorize_skills', { assignments: [{ skillId: first.id, category: 'escape' }] }, { organize }), /只能归档/);
  await assert.rejects(() => exec('categorize_skills', { assignments: [{ skillId: second.id, category: '../escape' }] }, { organize }), /分类名/);
  const moved = await exec('categorize_skills', { assignments: [{ skillId: second.id, category: 'documents' }] }, { organize });
  assert.equal(moved.okCount, 1);
  const newDir = path.join(root, 'library', 'documents', 'pdf');
  const newId = scanner.uid(newDir);
  assert(fs.existsSync(path.join(newDir, 'SKILL.md')));
  assert.equal(store.get().skillGroups[newId].length, 2);
  assert(!store.get().skills.some(k => k.id === second.id));
  assert(moved.items.some(k => k.id === newId));
  console.log('[PASS] staging-only categorization, traversal rejection, index and group remapping');

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  store.patch({ settings: { api: { baseUrl } } });
  const url = baseUrl + '/download/SKILL.md';
  await assert.rejects(() => exec('download_skills', { urls: [url] }, { urls: new Set() }), /明确提供/);
  const context = { urls: new Set([url]), completed: new Map() };
  const downloads = await exec('download_skills', { urls: [url] }, context);
  assert.equal(downloads.results[0].ok, true);
  assert(downloads.items[0].id);
  assert(store.get().skills.some(s => s.id === downloads.items[0].id));
  const before = networkRequests;
  await exec('download_skills', { urls: [url] }, context);
  assert.equal(networkRequests, before);
  console.log('[PASS] authorized download, immediate indexing, same-turn deduplication');

  let turn = 0;
  requestHandler = async (body, res) => {
    assert(Array.isArray(body.tools));
    assert(!JSON.stringify(body.messages).includes('PRIVATE BODY'));
    assert(!JSON.stringify(body.messages).includes('Bearer fixture'));
    if (!turn++) respond(res, { content: null, tool_calls: [tc('search_skills', { queries: ['agent'] })] });
    else { assert.equal(body.messages.at(-1).role, 'tool'); respond(res, { content: '找到了 agent-designer。' }); }
  };
  const agent = agentModule.createAgent({ organize });
  const result = await agent.send('找智能体设计 skill');
  assert.match(result.text, /agent-designer/);
  assert.equal(result.refs.length, 0, 'search observations must not be shown as recommendations');
  assert.equal(result.trace[0].state, 'done');
  assert.equal(agentModule.createAgent().status().messages.length, 2);
  console.log('[PASS] real HTTP function calling, null tool-call content, observations, history restoration');

  let selectionTurn = 0;
  requestHandler = async (body, res) => {
    assert(body.messages[0].content.includes('120字以内'));
    const steps = [
      tc('present_skills', { skillIds: [distractor.id] }), // Known in catalog, unseen this turn.
      tc('search_skills', { queries: ['agent', 'writer'] }),
      tc('present_skills', { skillIds: [first.id], reasons: [{ skillId: first.id, reason: '负责智能体设计与工具编排' }] }),
      tc('skill_summaries', { skillIds: [third.id] }) // Must not pollute the selected list.
    ];
    if (selectionTurn === 1) assert.match(JSON.parse(body.messages.at(-1).content).error, /本轮/);
    respond(res, selectionTurn < steps.length ? { content: null, tool_calls: [steps[selectionTurn++]] } : { content: '推荐 agent-designer，负责智能体设计。' });
  };
  const selected = await agent.send('按任务挑选智能体设计 skill');
  assert.deepEqual(selected.refs.map(r => r.id), [first.id]);
  assert.equal(selected.refs[0].reason, '负责智能体设计与工具编排');
  assert.equal(selected.trace[0].state, 'error');
  assert(selected.text.length <= 120);
  console.log('[PASS] explicit selection only, unseen IDs rejected, later summaries do not pollute recommendations, per-skill reasons');

  let malformed = 0;
  requestHandler = async (_body, res) => respond(res, !malformed++ ? { content: null, tool_calls: [{ ...tc('group_skills', {}), function: { name: 'group_skills', arguments: '{bad' } }] } : { content: '参数有误，未执行。' });
  const bad = await agent.send('错误参数测试');
  assert.equal(bad.trace[0].state, 'error');
  assert.match(bad.text, /未执行/);

  requestHandler = async (_body, res) => respond(res, { content: null, tool_calls: [tc('library_overview', {})] });
  const bounded = await agent.send('循环测试');
  assert.equal(bounded.trace.length, agentModule.MAX_ROUNDS);
  assert.match(bounded.text, /上限/);
  console.log('[PASS] malformed arguments reach the model as errors; execution loop is bounded');

  let started;
  const ready = new Promise(resolve => { started = resolve; });
  requestHandler = async () => started();
  const running = agent.send('停止测试');
  await ready;
  await assert.rejects(() => agent.send('同时发送'), /上一条/);
  assert.throws(() => agent.clear(), /先停止/);
  agent.cancel();
  assert.match((await running).text, /任务已停止/);
  assert.equal(agent.status().busy, false);
  agent.clear(); assert.equal(agent.status().messages.length, 0);
  store.patch({ settings: { api: { key: '' } } });
  await assert.rejects(() => agent.send('缺少配置'), /API Key/);
  assert.equal(agent.status().messages.length, 0);
  assert.equal(agent.status().busy, false);
  console.log('[PASS] cancellation, concurrent request guard, clearing, missing configuration');
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  server.closeAllConnections?.();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  Module._load = originalLoad;
  // The temp root is owned by this fixture and has a verified prefix.
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('atelier-skill-agent-')) fs.rmSync(root, { recursive: true, force: true });
});
