'use strict';
/**
 * unit-nesting.cjs — 012 轮「嵌套库存」单测（不启动 Electron）
 *
 * 覆盖《要求.md》5.2 的 N01–N05 / N08 与 B1（导入单元语义不被破坏）。
 * 全部在临时目录里造 fixture，home / appdata 全部注入，绝不读真实用户目录。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scanner = require('../main/scanner');
const detectTools = require('../main/detectTools');

let pass = 0;
const fails = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fails.push({ name, message: e.message });
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-nesting-'));
const home = path.join(root, 'home');
const skillsRoot = path.join(home, '.codex', 'skills');
const project = path.join(root, 'project');
const emptyProject = path.join(root, 'empty-project');
const exe = path.join(home, '.codex', 'Codex.exe');

function mkSkill(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: fixture ${name}\n---\n\n# ${name}\n\nFixture body for ${name}.\n`,
    'utf8'
  );
  return dir;
}

mkSkill(path.join(skillsRoot, 'outer'), 'outer');
mkSkill(path.join(skillsRoot, 'outer', 'child'), 'child');
mkSkill(path.join(skillsRoot, 'outer', 'child', 'grand'), 'grand');
fs.mkdirSync(path.join(skillsRoot, 'outer', 'references'), { recursive: true });
fs.writeFileSync(path.join(skillsRoot, 'outer', 'references', 'readme.md'), '# references\n', 'utf8');
mkSkill(path.join(skillsRoot, 'outer', 'node_modules', 'fake'), 'fake');
mkSkill(path.join(skillsRoot, 'loose'), 'loose');
for (const n of ['a', 'b', 'c']) mkSkill(path.join(skillsRoot, 'team', n), n);
mkSkill(path.join(project, '.agents', 'skills', 'parent'), 'parent');
mkSkill(path.join(project, '.agents', 'skills', 'parent', 'child'), 'pchild');
fs.mkdirSync(emptyProject, { recursive: true });
fs.writeFileSync(exe, '', 'utf8');

/* ---- 013 轮：真实形状的工作区（上层容器 + 下层仓库各有一堆 skill） ---- */
const wsRoot = path.join(root, 'Agent-harness');
const mediaRoot = path.join(wsRoot, 'media-capture');
for (const n of ['agent-reach', 'ai-news-radar', 'crawling-social-media']) {
  mkSkill(path.join(mediaRoot, n), n);
}
const chubbyRoot = path.join(mediaRoot, 'chubbyskills-workspace', 'chubbyskills');
for (const n of ['bilibili-transcribe', 'content-enrich', 'douyin-transcribe', 'x-ingest']) {
  mkSkill(path.join(chubbyRoot, n), n);
}
mkSkill(path.join(mediaRoot, 'chubbyskills-workspace', 'skills', 'one-off'), 'one-off');
// 工作区里混着脚本、输出目录和虚拟环境——它是工程，不是技能集
for (const f of ['run.py', 'export_deliverables.py', 'README.md']) {
  fs.writeFileSync(path.join(mediaRoot, 'chubbyskills-workspace', f), 'x\n', 'utf8');
}
for (const d of ['output', 'runs', '.venv']) {
  fs.mkdirSync(path.join(mediaRoot, 'chubbyskills-workspace', d), { recursive: true });
}

const opts = { home, appdata: '', localappdata: '' };
const product = {
  id: 'p1',
  name: 'Codex',
  launchPath: exe,
  manualRoots: [],
  projects: [
    { id: 'pr1', name: 'proj', path: project },
    { id: 'pr2', name: 'empty', path: emptyProject }
  ],
  hidden: []
};

const namesOf = (list) => list.map((s) => s.name).sort();
const byName = (list) => Object.fromEntries(list.map((s) => [s.name, s]));

console.log('\n[unit] 库存扫描（N01）');

const scan = scanner.scanProduct(product, opts);
const global = scan.skills.filter((s) => s.scope === 'global');
const proj1 = scan.skills.filter((s) => s.projectId === 'pr1');
const proj2 = scan.skills.filter((s) => s.projectId === 'pr2');

t('自动全局根精确 7 项（父/子/孙 + loose + team 三项）', () => {
  assert.equal(global.length, 7);
  assert.deepEqual(namesOf(global), ['a', 'b', 'c', 'child', 'grand', 'loose', 'outer']);
});
t('ID 唯一', () => {
  assert.equal(new Set(scan.skills.map((s) => s.id)).size, scan.skills.length);
});
t('node_modules 里的假技能与普通文档不计入', () => {
  assert.ok(!global.some((s) => /node_modules|fake/.test(s.dir)));
  assert.ok(!global.some((s) => /readme/i.test(s.dir)));
});
t('子/孙挂到最近的父 skill', () => {
  const m = byName(global);
  assert.equal(m.child.parentId, m.outer.id);
  assert.equal(m.grand.parentId, m.child.id);
  assert.equal(m.grand.parentName, 'child');
});
t('顶层入口 = outer / loose + team 技能集（3 张卡，库存 7）', () => {
  const top = global.filter((s) => !s.nested).map((s) => s.name).sort();
  assert.deepEqual(top, ['loose', 'outer']);
  const cols = [...new Set(global.filter((s) => s.collectionId).map((s) => s.collectionName))];
  assert.deepEqual(cols, ['team']);
  assert.equal(new Set(global.filter((s) => s.collectionId).map((s) => s.collectionDir)).size, 1);
});
t('项目 2 项、空项目 0 项', () => {
  assert.equal(proj1.length, 2);
  assert.equal(proj2.length, 0);
  const m = byName(proj1);
  assert.equal(m.pchild.parentId, m.parent.id);
});

console.log('\n[unit] 013 集合判定（R013）');

const ws = scanner.collectRoots([{ root: wsRoot, kind: 'global' }], { scope: 'global', productId: 'p9' });
const wsSkills = ws.metas;
const inMedia = wsSkills.filter((s) => /media-capture/i.test(s.dir));
const colCount = (list) => {
  const m = {};
  for (const s of list) {
    const k = s.collectionName || '(none)';
    m[k] = (m[k] || 0) + 1;
  }
  return m;
};
const find = (name) => wsSkills.find((s) => s.name === name);

t('R013-1 上层容器不吞下层集合：media-capture 只含自己的 3 个', () => {
  const c = colCount(inMedia);
  assert.equal(c['media-capture'], 3);
  assert.equal(inMedia.length, 8);
});

t('R013-2 仓库自己的 skill 归到它自己（chubbyskills 4 个）', () => {
  const c = colCount(inMedia);
  assert.equal(c.chubbyskills, 4);
});

t('R013-3 通用 skills/ 是边界，单挂的 skill 不并入上层', () => {
  const one = find('one-off');
  assert.equal(one.collectionId, '');
  assert.equal(one.nested, false);
});

t('R013-4 工作区本身不是集合', () => {
  assert.ok(!wsSkills.some((s) => s.collectionName === 'chubbyskills-workspace'));
});

t('R013-5 成员一定是容器的直接子项，不跨层', () => {
  for (const s of wsSkills) {
    if (!s.collectionDir) continue;
    assert.equal(path.dirname(s.dir), s.collectionDir, s.name + ' 不在集合目录的下一层');
  }
});

t('R013-6 扫描根不是集合（根下平铺不会凭空长出集合卡）', () => {
  assert.ok(!global.some((s) => s.collectionName === 'skills'));
  assert.ok(!wsSkills.some((s) => s.collectionName === 'Agent-harness'));
});

console.log('\n[unit] 手工根与去重（N02 / N03）');
t('N02 直接登记 outer/ → 精确 3 项，根自身保留', () => {
  const r = scanner.scanProjectRoot(product, path.join(skillsRoot, 'outer'));
  assert.equal(r.skills.length, 3);
  const m = byName(r.skills);
  assert.equal(m.outer.nested, false);
  assert.equal(m.child.parentId, m.outer.id);
  assert.equal(m.grand.parentId, m.child.id);
});

t('N03 自动根 + skills 根 + outer 根，连续两次结果稳定', () => {
  const p2 = {
    ...product,
    manualRoots: [
      { root: skillsRoot, kind: 'global' },
      { root: path.join(skillsRoot, 'outer'), kind: 'global' }
    ]
  };
  const a = scanner.scanProduct(p2, opts).skills.filter((s) => s.scope === 'global');
  const b = scanner.scanProduct(p2, opts).skills.filter((s) => s.scope === 'global');
  assert.equal(a.length, 7);
  assert.equal(b.length, 7);
  assert.deepEqual(a.map((s) => s.dir).sort(), b.map((s) => s.dir).sort());
  const ma = byName(a);
  const mb = byName(b);
  for (const k of Object.keys(ma)) {
    assert.equal(ma[k].parentId, mb[k].parentId, k + ' 的父级不稳定');
    assert.equal(ma[k].nested, mb[k].nested, k + ' 的嵌套状态不稳定');
  }
});

console.log('\n[unit] 各入口口径一致（N05 / N08）');

t('N05 项目扫描：完整重扫 / 单独重扫 / 旧 projectRoots 结果一致', () => {
  const single = scanner.scanProject(product, { id: 'pr1', path: project });
  const dirsA = proj1.map((s) => s.dir).sort();
  const dirsB = single.skills.map((s) => s.dir).sort();
  assert.deepEqual(dirsA, dirsB);
  const m = byName(single.skills);
  assert.equal(m.pchild.parentId, m.parent.id);

  const legacy = scanner.scanProduct({ ...product, projects: [], projectRoots: [project] }, opts);
  const legacyDirs = legacy.skills.filter((s) => s.scope === 'project').map((s) => s.dir).sort();
  assert.deepEqual(legacyDirs, dirsA);
});

t('N08 countSkills / probe / scanProduct 原始总数一致（7）', () => {
  assert.equal(detectTools.countSkills(skillsRoot), 7);
  const probe = scanner.probe(exe, { ...opts, product });
  assert.equal(probe.totalSkills, 7);
  assert.equal(global.length, 7);
});

console.log('\n[unit] 导入单元语义（B1）');

t('walkForSkills 仍在父 skill 处停住（导入/归位按整单元处理）', () => {
  const units = scanner.walkForSkills(path.join(skillsRoot, 'outer'), 6);
  assert.equal(units.length, 1);
  assert.equal(path.basename(units[0]), 'outer');
});

t('walkInventory 收录父/子/孙', () => {
  const inv = scanner.walkInventory(path.join(skillsRoot, 'outer'), 6);
  assert.equal(inv.dirs.length, 3);
  assert.equal(inv.truncated, false);
});

t('根目录本身是 skill 时，子项能找到父级', () => {
  const inv = scanner.collectRoots([{ root: path.join(skillsRoot, 'outer'), depth: 6 }], {
    scope: 'project', productId: 'p1', projectId: 'x'
  });
  const m = byName(inv.metas);
  assert.equal(m.outer.nested, false);
  assert.equal(m.child.parentId, m.outer.id);
  assert.equal(m.grand.parentId, m.child.id);
});

console.log(`\n[unit] ${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f.name}: ${f.message}`);
}

// 只删本用例自己创建的临时目录
assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
assert.ok(path.basename(root).startsWith('sa-nesting-'));
fs.rmSync(root, { recursive: true, force: true });

if (fails.length) process.exit(1);
