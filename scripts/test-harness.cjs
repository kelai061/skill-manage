'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const scanner = require('../main/scanner');
const ROOT = path.join(__dirname, '..');

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-atelier-fixture-'));
  const profile = path.join(root, 'profile');
  const sources = path.join(root, 'sources');
  fs.mkdirSync(profile, { recursive: true });
  const srcPara = 'Builders preserve the original skill while reviewing every proposed change. The reader keeps both columns aligned and highlights the matching sentence when a phrase is selected. This isolated example checks scrolling, selection, translation caching, and local annotations without reading any personal files or contacting a real AI service.';
  const dstPara = '构建者在审阅每一项修改提案时保留原始技能文件，并且清楚地区分查看与写入操作。阅读器会保持两栏内容对齐，在选择一个词语时高亮另一栏对应的句子，使读者能够准确理解上下文含义。这个隔离示例用于检查滚动、选择、翻译缓存与本地批注，所有文件都来自临时目录，不会读取个人配置，也不会连接真实人工智能服务；重复打开文档时应当复用已经保存的翻译结果。';
  const sections = [];
  for (let i = 1; i <= 24; i++) {
    sections.push(`## Review step ${i}\n\n${srcPara}\n\n- Preserve source files and verify the proposal.\n- Keep the reader aligned and reuse cached translations.`);
    if (i % 6 === 0) sections.push('---');
    if (i % 8 === 0) sections.push('```python\nprint("read only")\n```');
  }
  const content = `---\nname: follow-builders\ndescription: Isolated reader fixture\n---\n\n# Follow builders\n\n${sections.join('\n\n')}\n`;

  /* ---- 012 轮：双语 fixture（截图语义）与慢响应 fixture ---- */
  const BI_LINES = [
    "The pill toggles the aux pane. DO NOT output a plugin link, if the plugin isn't enabled/running.",
    "Deduce relevance from the description, not guesswork. If no enabled UI plugin's description matches the conversation, don't force a pill.",
    'Send the plugin link only after the plugin is running. A blink means the pane is loading.'
  ];
  const BI_DST_LINES = [
    '胶囊按钮用于切换辅助窗格。如果插件未启用或未运行，不要输出插件链接。',
    '根据描述推断相关性，而不是猜测。如果没有已启用插件的描述与对话匹配，不要强行输出胶囊按钮。',
    '只有在插件运行后才发送插件链接。闪烁表示窗格正在加载。'
  ];
  const BI_PARA_SRC = 'Click the link, ignore the blink, and open the links panel.';
  const BI_PARA_DST = '点击链接，忽略闪烁，然后打开链接面板。';
  const BI_PAIRS = [
    ['plugin link', '插件链接'],
    ['aux pane', '辅助窗格'],
    ['Deduce relevance from the description, not guesswork.', '根据描述推断相关性，而不是猜测。'],
    ['blink', '闪烁']
  ];
  const BI_PARA_PAIRS = [['link', '链接'], ['blink', '闪烁'], ['links', '链接']];
  const biContent = `---\nname: bilingual-fixture\ndescription: Bilingual selection fixture\n---\n\n# Bilingual fixture\n\n${BI_LINES.map((l) => '- ' + l).join('\n')}\n\n${BI_PARA_SRC}\n`;
  const hangContent = `---\nname: hang-fixture\ndescription: Slow response fixture\n---\n\n# Hang fixture\n\nHANGME slow response fixture body. The request for this document is answered late on purpose.\n`;

  function translate(text) {
    if (text === srcPara) return dstPara;
    if (/^#+ /.test(text)) return text.replace(/Review step/, '审阅步骤').replace(/Follow builders/, '跟随构建者').replace(/Bilingual fixture/, '双语样例').replace(/Hang fixture/, '慢响应样例');
    if (text.includes('The pill toggles the aux pane')) return BI_DST_LINES.map((l) => '- ' + l).join('\n');
    if (text.includes('Click the link')) return BI_PARA_DST;
    if (/^- /.test(text)) return '- 保留源文件并检查修改提案。\n- 保持阅读器对齐并复用缓存译文。';
    return text;
  }
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat/completions') { res.writeHead(404).end(); return; }
    requests++;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const user = body.messages.at(-1).content;
      let output = 'ok';
      if (user.includes('\nsegments: ')) {
        // 慢响应：故意晚 4.5 秒返回，用来验证「旧请求不得污染新文档」
        if (user.includes('HANGME')) await new Promise((r) => setTimeout(r, 4500));
        output = JSON.stringify({ t: JSON.parse(user.split('\nsegments: ')[1]).map(translate) });
      } else if (user.includes('\nitems: ')) {
        output = JSON.stringify({
          a: JSON.parse(user.split('\nitems: ')[1]).map((it) => {
            if (it.s.includes('The pill toggles')) return BI_PAIRS;
            if (it.s.includes('Click the link')) return BI_PARA_PAIRS;
            return it.s.includes('Builders') && it.d.includes('构建者') ? [['Builders', '构建者']] : [];
          })
        });
      } else if (user.includes('CURRENT FILE:\n')) {
        output = user.split('CURRENT FILE:\n')[1] + '\n\n## Reviewed\n\nApproved fixture change.\n';
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'fixture-model', choices: [{ message: { content: output } }] }));
    } catch { res.writeHead(400).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const productId = 'fixture-product';
  const project = path.join(sources, 'project-with-skills');
  const emptyProject = path.join(sources, 'empty-project');
  fs.mkdirSync(emptyProject, { recursive: true });
  const skills = [];
  function add(rel, name, scope = 'global', projectId = '', body = '') {
    const dir = path.join(sources, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      body || (name === 'follow-builders'
        ? content
        : `---\nname: ${name}\ndescription: Isolated fixture\n---\n\n# ${name}\n\n${srcPara}\n`)
    );
    if (scope === 'project') skills.push(scanner.readSkillMeta(dir, scope, productId, projectId));
    return dir;
  }
  const first = add('global/follow-builders', 'follow-builders');
  add('global/preview-files', 'preview-files');
  add('global/bilingual-fixture', 'bilingual-fixture', 'global', '', biContent);
  add('global/hang-fixture', 'hang-fixture', 'global', '', hangContent);

  /* 012 轮：真实嵌套树（父/子/孙 + 平铺技能集），由 scanner 自己算出嵌套字段 */
  add('global/nest-parent', 'nest-parent');
  add('global/nest-parent/nest-child', 'nest-child');
  add('global/nest-parent/nest-child/nest-grand', 'nest-grand');
  add('global/loose-two', 'loose-two');
  for (const n of ['set-a', 'set-b', 'set-c']) add(`global/teamset/${n}`, n);

  add('project-with-skills/.agents/skills/project-example', 'project-example', 'project', 'fixture-project');

  // 全局部分直接取真实库存扫描结果，UI 拿到的 nested / parentId / collectionId 都是生产逻辑算的
  const globalMetas = scanner.collectRoots(
    [{ root: path.join(sources, 'global'), depth: 6 }],
    { scope: 'global', productId, identity: '' }
  ).metas;
  skills.unshift(...globalMetas);

  fs.writeFileSync(path.join(first, 'sample.py'), 'print("fixture")\n');
  fs.writeFileSync(path.join(first, 'sample.txt'), 'Local fixture text.\n');
  fs.writeFileSync(path.join(first, 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    products: [{ id: productId, name: 'Fixture Agent', launchPath: sources, manualRoots: [{ root: path.join(sources, 'global'), scope: 'global' }], projects: [{ id: 'fixture-project', name: 'Project with skills', path: project }, { id: 'fixture-empty', name: 'Empty project', path: emptyProject }], hidden: [] }],
    skills, groups: [], skillGroups: {}, combos: [], favorites: [], ratings: {},
    settings: { api: { baseUrl: `http://127.0.0.1:${server.address().port}`, key: 'fixture-only', model: 'fixture-model' }, update: { auto: false }, onboarded: { detect: true, help: true } }
  }, null, 2));
  return { root, profile, sources, server, requests: () => requests };
}

async function runScenario(target, { executable, packaged = false, label = packaged ? 'packaged' : 'source' } = {}) {
  const scenario = path.resolve(ROOT, target);
  if (!fs.existsSync(scenario)) throw new Error('场景文件不存在');
  const fixture = await createFixture();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const bin = executable || require('electron');
  const args = [...(packaged ? [] : ['.']), `--profile=${fixture.profile}`, `--scenario=${scenario}`];
  let timer;
  try {
    const status = await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
      timer = setTimeout(() => { child.kill(); reject(new Error('场景测试超时（180秒）')); }, 180000);
    });
    console.log(`[test] 隔离场景完成；本地模拟接口请求 ${fixture.requests()} 次`);
    return status;
  } finally {
    clearTimeout(timer);
    // 慢响应 fixture 可能还挂着连接，先断开再 close，否则收尾会一直等
    if (typeof fixture.server.closeAllConnections === 'function') fixture.server.closeAllConnections();
    await new Promise((resolve) => fixture.server.close(resolve));
    const artifacts = path.join(ROOT, '.cache', 'test-artifacts', `${label}-${path.basename(scenario, '.cjs')}`);
    fs.mkdirSync(artifacts, { recursive: true });
    for (const name of ['shots', 'scenario.log']) {
      const source = path.join(fixture.profile, name);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(artifacts, name), { recursive: true });
    }
    const suiteName = path.basename(scenario, '.cjs');
    const report = path.join(ROOT, 'docs', suiteName === 'reader' ? 'test-report.json' : `test-report-${suiteName}.json`);
    if (fs.existsSync(report)) fs.copyFileSync(report, path.join(artifacts, 'report.json'));
    fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

module.exports = { createFixture, runScenario };
