'use strict';
// Optional real-provider semantic check. Never part of npm test.
// Set SKILL_AGENT_CREDENTIAL_FILE to an explicitly authorized local note, or
// DEEPSEEK_API_KEY. Credentials stay in memory; only synthetic metadata is sent.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-agent-benchmark-'));
process.argv.push('--profile=' + root);
const originalLoad = Module._load;
Module._load = function(name, parent, main) {
  if (name === 'electron') return { app: { getPath: () => root, getVersion: () => 'benchmark' } };
  return originalLoad.call(this, name, parent, main);
};
let key = '';
async function main() {
  key = process.env.DEEPSEEK_API_KEY || '';
  if (!key && process.env.SKILL_AGENT_CREDENTIAL_FILE) {
    const note = fs.readFileSync(process.env.SKILL_AGENT_CREDENTIAL_FILE, 'utf8');
    key = note.match(/deepseek-api[：:]\s*(sk-[a-zA-Z0-9_-]+)/i)?.[1] || '';
  }
  if (!key) throw new Error('Provide a credential through the documented environment variables.');
  const store = require('../main/store');
  const scanner = require('../main/scanner');
  const fixtures = [
    ['agent-architect', '设计AI智能体架构，规划角色、工具接口、记忆与执行边界。Design AI agents and tool contracts. 不用于视觉设计。'],
    ['agent-evaluation', '评测智能体的工具调用与任务成功率。Evaluate AI agent behavior.'],
    ['workflow-orchestrator', '规划多个智能体的任务依赖和工具编排。Multi agent workflow orchestration.'],
    ['glass-ui-designer', '设计桌面应用的玻璃态视觉、颜色与布局。Glass UI visual design with HTML CSS. 不负责AI智能体架构。'],
    ['desktop-components', '用HTML CSS实现桌面应用的组件、响应式布局与键盘交互。Desktop UI components.'],
    ['pdf-tables', '从PDF提取表格、检查跨页合并与字段。Extract PDF tables into structured rows.'],
    ['spreadsheet-export', '将结构化数据导出Excel XLSX，支持表头、数字格式和工作表。Spreadsheet export.'],
    ['reagent-lab', '实验室试剂管理。Laboratory reagent inventory.'],
    ['presentation-design', '制作演示文稿与幻灯片。Presentation design.'],
    ['game-agent', '为游戏设计非玩家角色行为。Game NPC agent behavior.']
  ];
  const skills = fixtures.map(([name, description]) => {
    const dir = path.join(root, name); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);
    return { id: scanner.uid(dir), name, description, dir };
  });
  store.patch({ skills, settings: { api: { key: 'benchmark-placeholder', model: 'deepseek-chat' } } });
  const ai = require('../main/aiService');
  const realChat = ai.chat;
  let calls = 0;
  ai.chat = (messages, options) => { calls++; return realChat(messages, { ...options, api: { baseUrl: 'https://api.deepseek.com', key, model: 'deepseek-chat' } }); };
  const { createAgent } = require('../main/skillAgent');
  const cases = [
    { name: 'agent architecture', text: '我要设计一个可以调用工具的智能体，重点是角色和工具接口；推荐不超过3个，别给我视觉UI设计。', required: ['agent-architect'], allowed: ['agent-architect', 'agent-evaluation', 'workflow-orchestrator'], max: 3 },
    { name: 'glass UI', text: '我要给桌面软件做玻璃态界面，使用HTML和CSS；推荐2个以内，只需视觉与组件，不做智能体架构。', required: ['glass-ui-designer'], allowed: ['glass-ui-designer', 'desktop-components'], max: 2 },
    { name: 'PDF to Excel', text: '从PDF提取表格并导出Excel，推荐最少互补的skill。', required: ['pdf-tables', 'spreadsheet-export'], allowed: ['pdf-tables', 'spreadsheet-export'], max: 2 }
  ];
  const report = [];
  for (const test of cases) {
    const agent = createAgent(); agent.clear();
    const before = calls;
    const start = Date.now();
    const result = await agent.send(test.text);
    const names = result.refs.map(r => r.name);
    const errors = [];
    if (!test.required.every(n => names.includes(n))) errors.push('missing required skill');
    if (!names.every(n => test.allowed.includes(n))) errors.push('irrelevant selection');
    if (names.length > test.max) errors.push('too many recommendations');
    if (result.text.length > 120) errors.push('reply longer than 120 characters');
    if (!result.refs.every(r => r.reason?.length)) errors.push('missing selection reason');
    const row = { case: test.name, passed: !errors.length, selected: names, reply: result.text, reasons: result.refs.map(r => r.reason), calls: calls - before, ms: Date.now() - start, errors };
    report.push(row);
    console.log(JSON.stringify(row));
  }
  const reportDir = path.join(__dirname, '..', '.cache', 'test-artifacts'); fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'skill-agent-live-benchmark.json'), JSON.stringify({ date: '2026-10-24', model: 'deepseek-chat', synthetic: true, report }, null, 2));
  // Prove the credential never reached this isolated profile or report.
  for (const file of fs.readdirSync(root).filter(n => n.endsWith('.json'))) assert(!fs.readFileSync(path.join(root, file), 'utf8').includes(key));
  assert(report.every(r => r.passed), 'Semantic benchmark did not pass every case');
}
main().catch(e => { console.error(String(e.message).replaceAll(key || '\0', '[redacted]')); process.exitCode = 1; }).finally(() => {
  key = ''; Module._load = originalLoad;
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('atelier-agent-benchmark-')) fs.rmSync(root, { recursive: true, force: true });
});
