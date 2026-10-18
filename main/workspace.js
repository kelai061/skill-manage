'use strict';
/**
 * workspace.js — 程序自身位置 · skill 清单导出 · 给智能体的交接话术
 *
 * 为什么要有这个文件：
 *   右上角那颗「复制给智能体」按钮要复制的不是选中项，而是「软件在哪 + 去哪读清单」。
 *   清单必须真的存在、且随索引自动更新，那句话才不是空话。
 *
 * 落点规则：
 *   绿色版 / 单文件 exe → 程序所在目录（PORTABLE_EXECUTABLE_DIR 优先）
 *   开发态            → 仓库根目录
 *   目录不可写        → 退回数据目录，并把真实路径告诉调用方
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');
const INDEX_NAME = 'skills.index.md';

let _sig = '';
let _lastPath = '';

/** 程序所在目录：单文件便携版取 exe 旁边，而不是解压出来的临时目录 */
function appHome() {
  if (!app.isPackaged) return ROOT;
  const portable = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portable && fs.existsSync(portable)) return portable;
  return path.dirname(process.execPath);
}

function indexCandidates() {
  const list = [path.join(appHome(), INDEX_NAME)];
  try {
    const store = require('./store');
    list.push(path.join(store.paths.root, INDEX_NAME));
  } catch { /* store 未就绪时只试程序目录 */ }
  return list;
}

function clean(s, max = 160) {
  return String(s == null ? '' : s)
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function stamp(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 生成清单正文（纯函数，方便单测） */
function buildIndex(state) {
  const skills = (state.skills || []).filter((s) => s && s.dir);
  const products = state.products || [];
  const pname = new Map(products.map((p) => [p.id, p.name || '未命名产品']));
  const projName = new Map();
  for (const p of products) {
    for (const pr of p.projects || []) projName.set(pr.id, pr.name || path.basename(pr.path || '') || '项目');
  }

  const globals = skills.filter((s) => s.scope !== 'project');
  const projects = skills.filter((s) => s.scope === 'project');

  const lines = [];
  lines.push('# Skill Atelier · Skill 索引');
  lines.push('');
  lines.push('> 本文件由 Skill Atelier 自动生成，索引变化时整份重写。');
  lines.push('> 智能体可直接读取本文件，按「名称 / 作用」挑出需要的 skill，再按「路径」加载。');
  lines.push('');
  lines.push(`- 生成时间：${stamp()}`);
  lines.push(`- 收录：${skills.length} 个 skill（全局 ${globals.length} · 项目 ${projects.length}）`);
  lines.push(`- 产品：${products.length} 个${products.length ? '（' + products.map((p) => clean(p.name, 40)).join(' · ') + '）' : ''}`);
  lines.push('');

  const row = (s) => `| ${clean(s.name || path.basename(s.dir), 60)} | ${clean(s.description || s.desc || '', 120) || '—'} | \`${clean(s.dir, 400)}\` |`;

  lines.push('## 全局 skill');
  lines.push('');
  if (globals.length) {
    lines.push('| 名称 | 作用 | 路径 |');
    lines.push('|---|---|---|');
    for (const s of globals.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))) lines.push(row(s));
  } else {
    lines.push('_（暂无）_');
  }
  lines.push('');

  lines.push('## 项目 skill');
  lines.push('');
  if (projects.length) {
    const byProject = new Map();
    for (const s of projects) {
      const key = s.projectId || 'unknown';
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(s);
    }
    for (const [pid, arr] of byProject) {
      const title = [pname.get(arr[0].productId) || '未知产品', projName.get(pid) || '未命名项目'].join(' · ');
      lines.push(`### ${clean(title, 120)}（${arr.length}）`);
      lines.push('');
      lines.push('| 名称 | 作用 | 路径 |');
      lines.push('|---|---|---|');
      for (const s of arr.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))) lines.push(row(s));
      lines.push('');
    }
  } else {
    lines.push('_（暂无）_');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('由 Skill Atelier 生成。源 skill 目录只读，本文件不含任何密钥或用户配置。');
  lines.push('');
  return lines.join('\n');
}

/**
 * 把清单写到磁盘。内容没变就跳过（每次 config 保存都会调到这里）。
 * @returns {{path:string, count:number, written:boolean}}
 */
function sync(state) {
  const s = state || (() => { try { return require('./store').get(); } catch { return {}; } })();
  const skills = (s.skills || []).filter((x) => x && x.dir);
  const sig = JSON.stringify([
    skills.length,
    skills.map((x) => [x.id, x.dir, x.name, x.description || x.desc || '']).sort()
  ]);
  if (sig === _sig && _lastPath && fs.existsSync(_lastPath)) {
    return { path: _lastPath, count: skills.length, written: false };
  }

  const body = buildIndex(s);
  for (const target of indexCandidates()) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, 'utf8');
      _sig = sig;
      _lastPath = target;
      return { path: target, count: skills.length, written: true };
    } catch { /* 换下一个落点 */ }
  }
  return { path: _lastPath || '', count: skills.length, written: false };
}

/** 给智能体的交接话术：软件在哪 + 去读哪份清单 */
function brief() {
  let res = { path: '', count: 0 };
  try { res = sync(); } catch { /* 写不进去也要给出话术 */ }
  const home = appHome();
  const lines = [];
  lines.push('Skill Atelier（本地 Skill 管理器）所在目录：');
  lines.push(home);
  lines.push('');
  if (res.path) {
    lines.push(`已收录 ${res.count} 个 skill，清单在：`);
    lines.push(res.path);
    lines.push('');
    lines.push('请先读这份清单，按当前任务挑出相关的 skill，再按清单里写的绝对路径去加载。');
  } else {
    lines.push('清单暂时写不出来（程序目录不可写），请直接在 Skill Atelier 界面里用「组合 → 复制路径」。');
  }
  return { text: lines.join('\n'), home, indexFile: res.path, count: res.count };
}

module.exports = { appHome, buildIndex, sync, brief, INDEX_NAME };
