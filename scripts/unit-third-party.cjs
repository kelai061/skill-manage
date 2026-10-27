'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scanner = require('../main/scanner');

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-third-party-'));
try {
  // The root name deliberately resembles an agent, as real user directories can.
  const root = path.join(parent, 'codex-archive');
  const paths = ['.codex/skills/first', '.claude/skills/second', '.cursor/skills/third', 'a/b/c/d/deep-skill'];
  for (const rel of paths) {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${path.basename(dir)}\ndescription: test\n---\n`);
  }
  const outside = path.join(parent, 'outside', 'should-not-appear');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: outside\ndescription: test\n---\n');
  const result = scanner.scanProduct({ id: 'third-party', name: 'Codex archive', launchPath: root,
    thirdParty: true, manualRoots: [{ root, kind: 'global' }], projects: [] });
  assert.deepEqual(result.skills.map(s => scanner.key(s.dir)).sort(), paths.map(p => scanner.key(path.join(root, p))).sort());
  assert.deepEqual(result.roots.map(scanner.key), [scanner.key(root)]);
  assert.equal(result.truncated, false);
  const beyond = path.join(root, ...Array(13).fill('nested'), 'not-reached');
  fs.mkdirSync(beyond, { recursive: true });
  fs.writeFileSync(path.join(beyond, 'SKILL.md'), '---\nname: too-deep\ndescription: test\n---\n');
  const limited = scanner.scanProduct({ id: 'third-party', name: 'Codex archive', launchPath: root,
    thirdParty: true, manualRoots: [{ root, kind: 'global' }], projects: [] });
  assert.equal(limited.truncated, true, 'depth-limited scans must be reported as incomplete');
  assert.equal(limited.skills.some(s => scanner.key(s.dir) === scanner.key(beyond)), false);
  console.log('[PASS] Third-party root keeps skills from different agents without scanning outside the selected directory');
} finally {
  fs.rmSync(parent, { recursive: true, force: true });
}
