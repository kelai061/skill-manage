'use strict';
/**
 * detectTools.js — 首次启动时「这台电脑上装了哪些智能体工具」
 *
 * 只读探测：看已知安装路径与用户数据目录是否存在，数一下各自有多少 SKILL.md。
 * 不执行任何外部程序，不改任何文件；探测不到就返回空。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const home = os.homedir();
const appdata = process.env.APPDATA || '';
const local = process.env.LOCALAPPDATA || '';

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const firstExisting = (list) => list.find(exists) || '';

const TOOLS = [
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    exe: [
      path.join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
      path.join(local, 'WorkBuddy', 'WorkBuddy.exe')
    ],
    roots: [path.join(home, '.workbuddy-ai', 'skills'), path.join(home, '.workbuddy-ai')],
    probe: [path.join(home, '.workbuddy-ai')]
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    exe: [
      path.join(local, 'Programs', 'Antigravity', 'Antigravity.exe'),
      path.join(local, 'Programs', 'Antigravity IDE', 'Antigravity.exe')
    ],
    roots: [
      path.join(home, '.gemini', 'antigravity', 'builtin', 'skills'),
      path.join(home, '.gemini', 'antigravity')
    ],
    probe: [path.join(home, '.gemini', 'antigravity')]
  },
  {
    id: 'claude',
    name: 'Claude Code',
    exe: [],
    roots: [path.join(home, '.claude', 'skills'), path.join(home, '.claude')],
    probe: [path.join(home, '.claude.json'), path.join(home, '.claude')],
    minSkills: 1
  },
  {
    id: 'cursor',
    name: 'Cursor',
    exe: [
      path.join(local, 'Programs', 'cursor', 'Cursor.exe'),
      path.join(local, 'Programs', 'Cursor', 'Cursor.exe')
    ],
    roots: [path.join(home, '.cursor', 'skills'), path.join(home, '.cursor')],
    probe: [path.join(home, '.cursor')]
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    exe: [],
    roots: [path.join(home, '.codex', 'skills'), path.join(home, '.codex')],
    probe: [path.join(home, '.codex')],
    minSkills: 1
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    exe: [],
    roots: [path.join(home, '.gemini', 'skills')],
    probe: [path.join(home, '.gemini', 'skills')],
    minSkills: 1
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    exe: [path.join(local, 'Programs', 'Windsurf', 'Windsurf.exe')],
    roots: [path.join(home, '.codeium', 'windsurf', 'skills'), path.join(home, '.codeium')],
    probe: [path.join(home, '.codeium')]
  }
];

/** 数一个根下有多少个含 SKILL.md 的目录（深度 ≤4，最多 500） */
function countSkills(root) {
  if (!root || !exists(root)) return 0;
  let n = 0;
  const walk = (dir, depth) => {
    if (depth > 4 || n >= 500) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.isFile() && e.name.toLowerCase() === 'skill.md')) n++;
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return n;
}

function detect() {
  const items = [];
  for (const t of TOOLS) {
    const launchPath = firstExisting(t.exe) || firstExisting(t.probe) || '';
    if (!launchPath) continue;
    const roots = t.roots.filter(exists);
    if (!roots.length && !t.exe.length) continue;
    const skills = roots.reduce((sum, r) => sum + countSkills(r), 0);
    // 纯 CLI 工具（没有 exe）只有真的带 skill 才值得登记，否则只会给产品列表添噪音
    if (!firstExisting(t.exe) && skills < (t.minSkills || 1)) continue;
    items.push({
      id: t.id,
      name: t.name,
      launchPath,
      roots,
      skills,
      hasApp: !!firstExisting(t.exe)
    });
  }
  return items;
}

module.exports = { detect, countSkills };
