'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const scanner = require('../main/scanner');
const detector = require('../main/detectTools');
const sources = require('../main/agentSources');
const { identifyProduct } = require('../main/productIdentity');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-discovery-'));
const home = path.join(root, 'home');
const local = path.join(root, 'local');
const roaming = path.join(root, 'roaming');
const env = { home, localappdata: local, appdata: roaming, programFiles: '', packageBases: [], runtimePaths: [], shortcutPaths: [] };
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const mkdir = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
const json = (p, data) => { mkdir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(data)); };
const skill = (p) => { mkdir(p); fs.writeFileSync(path.join(p, 'SKILL.md'), '---\nname: fixture\ndescription: fixture skill\n---\n\nFixture only.\n'); return p; };
const snapshot = (p) => fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;

try {
  mkdir(home);
  test('五个启动入口按产品识别，WorkBuddy与WorkBuddyAI归属同一产品', () => {
    const apps = [['WorkBuddy.exe', 'workbuddy'], ['WorkBuddyAI.exe', 'workbuddy'], ['ZCode.exe', 'zcode'], ['MiniMax Code.exe', 'minimax'], ['Kimi Code.exe', 'kimi']];
    for (const [exe, id] of apps) assert.equal(identifyProduct({ name: 'Custom name', launchPath: path.join(root, 'Apps', exe) }), id);
    assert.equal(identifyProduct('C:\\Apps\\Kimi-Code\\Kimi Code.exe'), 'kimi');
  });
  test('桌面和开始菜单快捷方式可发现自定义安装位置，缺失目标不登记', () => {
    const targets = ['WorkBuddy.exe', 'WorkBuddyAI.exe', 'ZCode.exe', 'MiniMax Code.exe', 'Kimi Code.exe'].map((name) => {
      const target = path.join(mkdir(path.join(root, 'custom-install')), name);
      fs.writeFileSync(target, 'fixture');
      return target;
    });
    const items = detector.detect({ ...env, shortcutPaths: [...targets, ...targets, path.join(root, 'missing', 'Cursor.exe')] });
    assert.equal(items.length, 4);
    assert.ok(items.every((it) => it.hasApp && it.skills === 0));
    assert.ok(items.every((it) => targets.includes(it.launchPath)));
    assert.equal(items.filter((it) => it.id === 'workbuddy').length, 1);
  });
  test('手动EXE支持带引号、启动参数、环境变量与快捷方式，且不运行目标', () => {
    const { resolveLaunchPath } = require('../main/launchPath');
    const exe = path.join(mkdir(path.join(root, 'Custom Apps')), 'Kimi Code.exe');
    fs.writeFileSync(exe, 'fixture');
    for (const input of [exe, `"${exe}"`, `"${exe}" --profile test`, `${exe} --profile test`]) {
      assert.equal(scanner.probe(input, env).launchPath, exe);
      assert.equal(scanner.probe(input, env).valid, true);
    }
    const link = path.join(root, 'Kimi Code.lnk');
    fs.writeFileSync(link, 'fixture');
    assert.equal(resolveLaunchPath(link, { readShortcut: () => ({ target: exe }) }), exe);
    assert.throws(() => resolveLaunchPath(link, { readShortcut: () => { throw new Error('broken'); } }), /EXE/);
    if (process.platform === 'win32') {
      process.env.SA_TEST_LAUNCH = path.dirname(exe);
      try { assert.equal(resolveLaunchPath('%sa_test_launch%\\Kimi Code.exe'), exe); }
      finally { delete process.env.SA_TEST_LAUNCH; }
    }
  });
  test('新产品全局与项目技能均可扫描，探测与库存一致且不借用其他产品', () => {
    const profile = mkdir(path.join(root, 'new-products-home'));
    const workspace = mkdir(path.join(root, 'new-products-project'));
    const cases = [['WorkBuddy.exe', '.workbuddy'], ['WorkBuddyAI.exe', '.workbuddy-ai'], ['ZCode.exe', '.zcode'], ['MiniMax Code.exe', '.minimax'], ['Kimi Code.exe', '.kimi-code']];
    for (const [, dir] of cases) {
      skill(path.join(profile, dir, 'skills', 'global'));
      skill(path.join(workspace, dir, 'skills', 'project'));
    }
    const builtIn = skill(path.join(profile, '.minimax', '.builtin-skills', 'builtin'));
    const agentSkill = skill(path.join(profile, '.minimax', 'agents', 'worker', 'skills', 'agent'));
    for (const [exe, dir] of cases) {
      const launch = path.join(root, 'custom-install', exe);
      const context = { ...env, home: profile };
      const probe = scanner.probe(launch, context);
      const result = scanner.scanProduct({ id: 'new-product', launchPath: launch, projects: [{ id: 'pr', path: workspace }] }, context);
      const projectDirs = exe.startsWith('WorkBuddy') ? ['.workbuddy', '.workbuddy-ai'].map((d) => path.join(workspace, d, 'skills', 'project')) : [path.join(workspace, dir, 'skills', 'project')];
      assert.deepEqual(result.skills.filter((s) => s.scope === 'project').map((s) => s.dir).sort(), projectDirs.sort());
      assert.equal(probe.totalSkills, exe.startsWith('MiniMax') ? 3 : exe.startsWith('WorkBuddy') ? 2 : 1);
      assert.equal(result.skills.length, probe.totalSkills + projectDirs.length);
      if (exe.startsWith('MiniMax')) {
        assert.ok(result.skills.some((s) => s.dir === builtIn));
        assert.ok(result.skills.some((s) => s.dir === agentSkill));
      }
      // A skill directory whose ancestor already identifies the product is still scanned.
      assert.equal(scanner.probe(path.join(profile, dir, 'skills'), context).valid, true);
      assert.ok(scanner.probe(path.join(profile, dir, 'skills'), context).totalSkills > 0);
    }
  });
  const codexSkill = skill(path.join(home, '.codex', 'skills', '.system', 'builtin'));
  skill(path.join(home, '.claude', 'skills', 'claude-global'));
  skill(path.join(home, '.cursor', 'skills', 'cursor-global'));
  const shared = skill(path.join(home, '.agents', 'skills', 'shared'));
  const project = mkdir(path.join(root, 'project'));
  const empty = mkdir(path.join(root, 'empty-project'));
  const scratch = mkdir(path.join(root, '2026-10-18-01-02-03'));
  const codexProject = skill(path.join(project, '.codex', 'skills', 'codex-project'));
  const claudeProject = skill(path.join(project, '.claude', 'skills', 'claude-project'));
  skill(path.join(project, '.cursor', 'skills', 'cursor-project'));
  const projectShared = skill(path.join(project, '.agents', 'skills', 'shared-project'));
  skill(path.join(project, '.git', 'ignored'));

  test('空路径不会变成当前目录或被扫描', () => {
    assert.equal(scanner.norm(''), '');
    assert.equal(scanner.norm('   '), '');
    assert.deepEqual(scanner.walkForSkills(''), []);
    assert.deepEqual(scanner.walkAllSkillDirs(''), []);
    assert.equal(scanner.probe('', env).valid, false);
    assert.throws(() => scanner.createSkill('', 'new-skill'), /目录/);
  });
  test('隐藏的 .codex / .cursor / .agents / .system 技能会被找到', () => {
    assert.deepEqual(scanner.walkForSkills(path.join(home, '.codex', 'skills')), [codexSkill]);
    assert.equal(scanner.walkAllSkillDirs(project, 6).length, 4);
    assert.equal(detector.countSkills(path.join(home, '.codex', 'skills')), 1);
  });
  test('项目按产品隔离，Codex不会收进Claude或Cursor的项目技能', () => {
    const result = scanner.scanProduct({ id: 'fixture', name: 'Codex', launchPath: path.join(home, '.codex'), projects: [{ id: 'p', path: project }] }, env);
    assert.deepEqual(result.skills.filter((s) => s.scope === 'project').map((s) => s.dir).sort(), [codexProject, projectShared].sort());
    assert.ok(result.skills.some((s) => s.dir === codexSkill));
    assert.ok(result.skills.some((s) => s.dir === shared));
    assert.ok(!result.skills.some((s) => s.dir === claudeProject));
  });
  test('未知产品为空时不会借用其他智能体的全局技能', () => {
    const launch = mkdir(path.join(root, 'UnrelatedApp'));
    const result = scanner.scanProduct({ id: 'unknown', name: 'UnrelatedApp', launchPath: launch }, env);
    assert.equal(result.skills.length, 0);
    assert.equal(result.usedFallback, false);
    assert.equal(scanner.probe(launch, env).totalSkills, 0);
  });
  test('安装目录与skills子目录重叠时探测总数不会重复', () => {
    const launch = mkdir(path.join(root, 'CustomTool'));
    skill(path.join(launch, 'skills', 'one-skill'));
    assert.equal(scanner.probe(launch, env).totalSkills, 1);
  });
  test('已登记的项目技能优先归项目，不被全局浅扫吞掉', () => {
    const launch = mkdir(path.join(root, 'CustomWorkspace'));
    const globalDir = skill(path.join(launch, 'skills', 'global'));
    const projectRoot = mkdir(path.join(launch, 'project'));
    const projectDir = skill(path.join(projectRoot, 'skills', 'local'));
    const result = scanner.scanProduct({ id: 'custom', name: 'CustomWorkspace', launchPath: launch, projects: [{ id: 'local', path: projectRoot }] }, env);
    assert.deepEqual(result.skills.filter((s) => s.scope === 'global').map((s) => s.dir), [globalDir]);
    assert.deepEqual(result.skills.filter((s) => s.scope === 'project').map((s) => s.dir), [projectDir]);
    assert.equal(result.skills.find((s) => s.dir === projectDir).projectId, 'local');
  });
  const aliases = mkdir(path.join(local, 'Microsoft', 'WindowsApps'));
  const codexPackage = mkdir(path.join(aliases, 'OpenAI.Codex_2p2nqsd0c76g0'));
  test('Store包与ChatGPT进程名共同出现时保留Codex产品身份', () => {
    const executable = path.join(codexPackage, 'ChatGPT.exe');
    fs.writeFileSync(executable, 'fixture');
    assert.equal(identifyProduct({ name: 'ChatGPT', launchPath: executable }), 'codex');
    const items = detector.detect({ ...env, packageBases: [aliases], runtimePaths: [executable] });
    const item = items.find((it) => it.id === 'codex');
    assert.ok(item && item.hasApp);
    assert.match(item.name, /ChatGPT/);
    assert.equal(item.skills, 2);
    assert.equal(item.launchPath, executable);
    assert.ok(!items.some((it) => it.id === 'chatgpt'));
  });
  test('没有技能的桌面安装也能登记，独立ChatGPT不会借用Codex技能', () => {
    const chatgpt = mkdir(path.join(aliases, 'OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0'));
    const items = detector.detect({ ...env, packageBases: [aliases] });
    assert.equal(items.find((it) => it.id === 'chatgpt').launchPath, chatgpt);
    assert.equal(items.find((it) => it.id === 'chatgpt').skills, 0);
    assert.deepEqual(items.find((it) => it.id === 'chatgpt').roots, []);
    const zeroHome = mkdir(path.join(root, 'zero-home'));
    assert.ok(detector.detect({ ...env, home: zeroHome, packageBases: [aliases] }).some((it) => it.id === 'codex' && it.skills === 0 && it.hasApp));
  });
  json(path.join(home, '.claude.json'), { projects: { [project]: {} } });
  json(path.join(home, '.codex', '.codex-global-state.json'), {
    'local-projects': { first: { name: 'Named Codex Project', rootPaths: [empty, scratch], updatedAt: 42 } },
    'electron-persisted-atom-state': { 'electron-saved-workspace-roots': [empty] }
  });
  test('Codex使用自身项目登记，保留零技能项目和项目名称', () => {
    const result = sources.discoverProjects({ name: 'ChatGPT', launchPath: codexPackage }, env);
    assert.deepEqual(result.adapters, ['codex']);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].path, empty);
    assert.equal(result.items[0].name, 'Named Codex Project');
    assert.ok(!result.items.some((it) => it.path === project));
  });
  test('Claude项目适配器不再匹配Codex', () => {
    const result = sources.discoverProjects({ name: 'Claude Code', launchPath: path.join(home, '.claude') }, env);
    assert.deepEqual(result.adapters, ['claude']);
    assert.deepEqual(result.items.map((it) => it.path), [project]);
    assert.deepEqual(sources.discoverProjects({ name: 'ChatGPT', launchPath: path.join(aliases, 'OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0') }, env).items, []);
  });
  test('损坏Codex项目元数据不会触发其他产品或任意配置路径兜底', () => {
    fs.writeFileSync(path.join(home, '.codex', '.codex-global-state.json'), '{broken');
    json(path.join(home, '.codex', 'unrelated.json'), { path: project });
    assert.deepEqual(sources.discoverProjects({ name: 'Codex', launchPath: codexPackage }, env).items, []);
  });
  test('Cursor通过编辑器工作区登记发现零技能项目', () => {
    json(path.join(roaming, 'Cursor', 'User', 'workspaceStorage', 'fixture', 'workspace.json'), { folder: require('node:url').pathToFileURL(empty).href });
    const result = sources.discoverProjects({ name: 'Cursor', launchPath: path.join(home, '.cursor') }, env);
    assert.deepEqual(result.adapters, ['cursor']);
    assert.deepEqual(result.items.map((it) => it.path), [empty]);
  });
  test('隔离profile清单只写profile，并在项目更名或作用域变化时刷新', () => {
    const profile = mkdir(path.join(root, 'profile'));
    const programIndex = path.join(__dirname, '..', 'skills.index.md');
    const before = snapshot(programIndex);
    const state = { products: [{ id: 'p', name: 'Product', projects: [{ id: 'pr', name: 'Old Project' }] }], skills: [{ id: 's', dir: codexProject, name: 'Skill', scope: 'project', productId: 'p', projectId: 'pr' }] };
    const originalLoad = Module._load;
    const previousArgv = process.argv;
    const target = require.resolve('../main/workspace');
    delete require.cache[target];
    try {
      process.argv = [...previousArgv, `--profile=${profile}`];
      Module._load = function(request, parent, ...rest) {
        if (request === 'electron') return { app: { isPackaged: false } };
        if (request === './store' && parent && parent.filename === target) return { paths: { root: profile }, get: () => state };
        return originalLoad.call(this, request, parent, ...rest);
      };
      const workspace = require(target);
      assert.equal(workspace.sync(state).path, path.join(profile, workspace.INDEX_NAME));
      assert.equal(workspace.sync(state).written, false);
      state.products[0].projects[0].name = 'New Project';
      assert.equal(workspace.sync(state).written, true);
      assert.match(fs.readFileSync(path.join(profile, workspace.INDEX_NAME), 'utf8'), /New Project/);
      state.skills[0].scope = 'global';
      assert.equal(workspace.sync(state).written, true);
      assert.equal(workspace.brief().indexFile, path.join(profile, workspace.INDEX_NAME));
      assert.equal(snapshot(programIndex), before);
    } finally {
      Module._load = originalLoad;
      process.argv = previousArgv;
      delete require.cache[target];
    }
  });
  console.log(`[unit-discovery] ${passed} passed`);
} finally {
  // This is the exact fresh temp directory created by this suite.
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('sa-discovery-'));
  fs.rmSync(root, { recursive: true, force: true });
}
