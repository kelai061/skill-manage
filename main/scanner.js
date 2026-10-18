'use strict';
/**
 * scanner.js — 路径驱动的自动发现引擎
 *
 * 输入：一个智能体产品的启动路径（.exe / 安装目录 / 任意目录）
 * 输出：该产品的全局 skill 根目录清单 + 已发现的 skill 列表
 *
 * 铁律：
 *   1. 只读。扫描过程不写任何文件到源目录。
 *   2. 判定唯一依据 = 目录内存在 SKILL.md。
 *   3. 深度上限 + 时间预算，绝不卡死 UI。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { identifyProduct, skillRoots } = require('./productIdentity');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '__pycache__', '.venv', 'venv', '.cache', '.next', '.nuxt', 'coverage',
  '.idea', '.vscode', 'vendor', 'bower_components', 'obj', 'bin'
]);

const MAX_DEPTH = 4;
const TIME_BUDGET_MS = 6000;
const MAX_SKILLS = 4000;

const SKILL_FILE = 'SKILL.md';

function norm(p) {
  const value = String(p || '').trim();
  if (!value) return '';
  try { return path.resolve(value); } catch { return ''; }
}

function key(p) {
  const n = norm(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function isDir(p) {
  const s = safeStat(p);
  return !!s && s.isDirectory();
}

function hasSkillFile(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some((e) => e.isFile() && e.name.toLowerCase() === SKILL_FILE.toLowerCase());
  } catch {
    return false;
  }
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function cap(s) {
  return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
}

function uid(p) {
  return crypto.createHash('sha1').update(key(p)).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* 1. 从启动路径推导候选根                                             */
/* ------------------------------------------------------------------ */

function candidateRoots(launchPath, options = {}) {
  const raw = norm(launchPath);
  if (!raw) return [];
  const st = safeStat(raw);
  const isFile = !!st && st.isFile();
  const installDir = isFile ? path.dirname(raw) : raw;
  const exeBase = isFile ? path.basename(raw, path.extname(raw)) : path.basename(installDir);
  const dirBase = path.basename(installDir);

  const home = options.home || os.homedir();
  const appdata = options.appdata === undefined ? (process.env.APPDATA || '') : options.appdata;
  const localappdata = options.localappdata === undefined ? (process.env.LOCALAPPDATA || '') : options.localappdata;
  const identity = identifyProduct(options.product || launchPath);

  const names = [...new Set([exeBase, dirBase].filter(Boolean))];
  const slugs = [...new Set(names.map(slugify).filter((s) => s.length > 1))];

  const out = [];
  const seen = new Set();
  const add = (root, label, kind = 'global', depth = MAX_DEPTH) => {
    if (!root) return;
    const n = norm(root);
    if (!n || seen.has(key(n))) return;
    seen.add(key(n));
    out.push({ root: n, label, kind, depth });
  };

  for (const root of skillRoots(identity, home)) add(root, '产品技能目录', 'global', 6);

  // Known products use their own documented skill locations. Broad data roots can
  // contain projects and other agents' files and must not become global skills.
  if (identity) {
    add(path.join(installDir, 'skills'), '安装目录/skills', 'global', 4);
    add(path.join(installDir, 'resources', 'skills'), '安装目录/resources/skills', 'global', 4);
    return out;
  }

  // 用户级隐藏目录：~/.claude 这类约定
  for (const s of slugs) {
    add(path.join(home, '.' + s), `~/.${s}`);
    add(path.join(home, '.' + s + '-ai'), `~/.${s}-ai`);
  }

  // 应用数据目录
  for (const nm of names) {
    if (appdata) add(path.join(appdata, nm), `%APPDATA%/${nm}`);
    if (localappdata) add(path.join(localappdata, nm), `%LOCALAPPDATA%/${nm}`);
    if (localappdata) add(path.join(localappdata, 'Programs', nm), `%LOCALAPPDATA%/Programs/${nm}`);
  }
  for (const s of slugs) {
    if (appdata) add(path.join(appdata, cap(s)), `%APPDATA%/${cap(s)}`);
  }

  // 统一配置根：Antigravity 这类把数据放在 ~/.gemini/<产品>/ 下
  for (const s of slugs) {
    add(path.join(home, '.gemini', s), `~/.gemini/${s}`, 'global', 4);
    add(path.join(home, '.gemini', s, 'builtin', 'skills'), `~/.gemini/${s}/builtin/skills`, 'global', 2);
    add(path.join(home, '.gemini', s, 'skills'), `~/.gemini/${s}/skills`, 'global', 3);
  }
  // 常见「用户级 skill 目录」写法：~/.<slug>/skills、~/.<slug>/builtin/skills
  for (const s of slugs) {
    add(path.join(home, '.' + s, 'skills'), `~/.${s}/skills`, 'global', 3);
    add(path.join(home, '.' + s, 'builtin', 'skills'), `~/.${s}/builtin/skills`, 'global', 2);
  }

  // 安装目录本体（浅扫）
  add(installDir, '安装目录', 'global', 3);
  add(path.join(installDir, 'skills'), '安装目录/skills', 'global', 2);
  add(path.join(installDir, 'resources'), '安装目录/resources', 'global', 3);
  add(path.join(installDir, 'resources', 'app'), '安装目录/resources/app', 'global', 3);

  return out;
}

const HIDDEN_SKILL_DIRS = new Set(['.claude', '.workbuddy-ai', '.cursor', '.codex', '.gemini', '.antigravity', '.agents', '.system', '.windsurf', '.codeium', '.continue']);
const PRODUCT_DIR = { '.claude': 'claude', '.workbuddy-ai': 'workbuddy', '.cursor': 'cursor', '.codex': 'codex', '.gemini': 'gemini', '.antigravity': 'antigravity', '.windsurf': 'windsurf', '.codeium': 'windsurf' };
function skipDirectory(name, identity = '') {
  const n = name.toLowerCase();
  if (SKIP_DIRS.has(n)) return true;
  if (n.startsWith('.') && !HIDDEN_SKILL_DIRS.has(n)) return true;
  if (!identity || !PRODUCT_DIR[n]) return false;
  return PRODUCT_DIR[n] !== identity && !(n === '.gemini' && identity === 'antigravity');
}

/* ------------------------------------------------------------------ */
/* 2. 扫描一个根，找出所有 skill 目录                                   */
/* ------------------------------------------------------------------ */

function walkForSkills(root, maxDepth = MAX_DEPTH) {
  const found = [];
  if (!norm(root)) return found;
  const started = Date.now();
  const visited = new Set();

  const walk = (dir, depth) => {
    if (found.length >= MAX_SKILLS) return;
    if (Date.now() - started > TIME_BUDGET_MS) return;
    if (depth > maxDepth) return;
    const k = key(dir);
    if (visited.has(k)) return;
    visited.add(k);

    if (hasSkillFile(dir)) {
      found.push(dir);
      return; // skill 根不再向下钻，避免把 references 里的 md 当 skill
    }

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const nm = e.name;
      if (skipDirectory(nm)) continue;
      walk(path.join(dir, nm), depth + 1);
    }
  };

  walk(norm(root), 0);
  return found;
}

/** 通用目录名：这些目录本身不构成「集合」，只是约定俗成的 skill 存放处 */
const GENERIC_DIRS = new Set([
  'skills', '.claude', '.workbuddy-ai', '.cursor', '.codex', '.gemini', '.antigravity', '.agents', '.system',
  'vendor', 'references', 'reference', 'scripts', 'assets', 'docs', 'examples', 'templates'
]);

/**
 * 收集一个根下**所有** SKILL.md 目录（遇到 skill 也继续往下钻）。
 * 只用于「项目根」——全局根用 walkForSkills 保持轻量。
 */
function walkAllSkillDirs(root, maxDepth = MAX_DEPTH, options = {}) {
  const found = [];
  if (!norm(root)) return found;
  const started = Date.now();
  const visited = new Set();

  const walk = (dir, depth) => {
    if (found.length >= MAX_SKILLS) return;
    if (Date.now() - started > TIME_BUDGET_MS) return;
    if (depth > maxDepth) return;
    const k = key(dir);
    if (visited.has(k)) return;
    visited.add(k);

    if (hasSkillFile(dir)) found.push(dir);

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const nm = e.name;
      if (skipDirectory(nm, options.identity)) continue;
      walk(path.join(dir, nm), depth + 1);
    }
  };

  walk(norm(root), 0);
  return found;
}

/**
 * 库存扫描（012 轮）：遇到父 SKILL.md **继续**向下找子/孙。
 *
 * 为什么不能直接改 walkForSkills：importer / organizer 用它判断「导入单元」
 * 与「归位单元」，一个父 skill 连同它的子 skill 是一个整体。库存要的则是
 * 「每一个可阅读的 skill」，两者语义不同，必须各留一份实现。
 *
 * @returns {{dirs:string[], truncated:boolean}} truncated = 因预算/上限没扫完
 */
function walkInventory(root, maxDepth = MAX_DEPTH, options = {}) {
  const found = [];
  let truncated = false;
  if (!norm(root)) return { dirs: found, truncated };
  const started = Date.now();
  const visited = new Set();

  const walk = (dir, depth) => {
    if (found.length >= MAX_SKILLS) { truncated = true; return; }
    if (Date.now() - started > TIME_BUDGET_MS) { truncated = true; return; }
    if (depth > maxDepth) return;
    const k = key(dir);
    if (visited.has(k)) return;
    visited.add(k);

    if (hasSkillFile(dir)) found.push(dir);

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (skipDirectory(e.name, options.identity)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  walk(norm(root), 0);
  return { dirs: found, truncated };
}

/**
 * 标注 skill 之间的嵌套关系。
 *
 * 现实里的两种嵌套：
 *   1. 父目录本身就是一个 skill，子目录里又有 SKILL.md（skill 里带 skill）
 *   2. 父目录不是 skill，但里面平铺了一堆 skill（技能集，如 agent-rules-books/）
 * 两种都算「嵌套」：默认收在父级里，需要时可以手动移出来。
 *
 * 013 轮修正（集合判定）：
 *   - 取**最近**的一层容器，找到即停。旧实现「继续向上找更浅的」会把
 *     media-capture/chubbyskills-workspace/chubbyskills 下的 14 个 skill
 *     一起吞进 media-capture，和它自己的 8 个混成一张 23 个的集合卡；
 *     而 chubbyskills 自己明明是个平铺了 14 个 skill 的目录。
 *   - 判定只看结构：直接子目录里有 ≥3 个 SKILL.md 就是集合。不要求目录
 *     「只装 skill」——真实的 skill 仓库往往同时有 docs/、tests/、README，
 *     按纯度筛会把它们排除掉，反而又并回上层。
 *   - 边界仍然是边界：用户登记的扫描根、以及 skills/ references/ 这类通用
 *     目录本身不算集合，否则一个根下平铺几个 skill 就会凭空长出一张集合卡。
 *   - 父级本身是 skill 的目录不兼作集合，避免同一层既当父级又当集合。
 */
function annotateNesting(metas, roots) {
  const list = Array.isArray(roots) ? roots : [roots];
  const rootKeys = list.filter(Boolean).map(key);
  const byKey = new Map(metas.map((m) => [key(m.dir), m]));
  const inside = (p) => {
    const k = key(p);
    return rootKeys.some((r) => k === r || k.startsWith(r + path.sep));
  };

  const directCount = new Map();
  for (const m of metas) {
    const parent = key(path.dirname(m.dir));
    directCount.set(parent, (directCount.get(parent) || 0) + 1);
  }

  for (const m of metas) {
    m.nested = false;
    m.parentId = '';
    m.parentName = '';
    m.collectionId = '';
    m.collectionName = '';
    m.collectionDir = '';

    let parentSkill = null;
    let collection = '';
    let cur = path.dirname(m.dir);
    let guard = 0;

    while (guard++ < 12) {
      if (!inside(cur)) break;
      const k = key(cur);
      const hit = byKey.get(k);
      if (hit && hit !== m && !parentSkill) parentSkill = hit;
      const isRoot = rootKeys.includes(k);
      const generic = GENERIC_DIRS.has(path.basename(cur).toLowerCase());
      // 边界（用户登记的扫描范围）和 skills/ 这类通用目录都不是集合，
      // 否则一个根下平铺 5 个 skill 就会凭空长出一张集合卡
      if (!collection && !isRoot && !generic && !hit && (directCount.get(k) || 0) >= 3) {
        collection = cur;                             // 最近的一层，找到即停
      }
      if (collection || isRoot || generic) break;
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }

    if (parentSkill) {
      m.nested = true;
      m.parentId = parentSkill.id;
      m.parentName = parentSkill.name;
    }
    if (collection) {
      m.nested = true;
      m.collectionId = uid(collection);
      m.collectionName = path.basename(collection);
      m.collectionDir = norm(collection);
    }
  }
  return metas;
}

/**
 * 从一组根收集库存：去重 → 读元数据 → 统一标注嵌套。
 * 全局根、项目根、旧 projectRoots、手工根全部走这一条路，
 * 保证同一目录范围在不同入口得到同一份结果。
 */
function collectRoots(roots, opts = {}) {
  const metas = [];
  const seen = new Set();
  const boundaries = [];
  let truncated = false;

  for (const r of roots || []) {
    if (!r || !r.root || !isDir(r.root)) continue;
    boundaries.push(r.root);
    const res = walkInventory(r.root, r.depth || MAX_DEPTH, { identity: opts.identity });
    if (res.truncated) truncated = true;
    for (const d of res.dirs) {
      if (opts.exclude && opts.exclude(d)) continue;
      const k = key(d);
      if (seen.has(k)) continue;
      seen.add(k);
      const meta = readSkillMeta(d, opts.scope || 'global', opts.productId || '', opts.projectId || '');
      if (meta) metas.push(meta);
    }
  }

  annotateNesting(metas, boundaries);
  return { metas, truncated, boundaries };
}

/* ------------------------------------------------------------------ */
/* 3. Frontmatter 解析                                                 */
/* ------------------------------------------------------------------ */

function parseFrontmatter(text) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = src.match(/^---\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { data: {}, body: src };
  const data = {};
  const lines = m[1].split('\n');
  let curKey = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (kv) {
      curKey = kv[1];
      let v = kv[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      data[curKey] = v;
    } else if (curKey && /^\s+/.test(line)) {
      // 折行续写
      data[curKey] = (data[curKey] ? data[curKey] + ' ' : '') + line.trim();
    }
  }
  // 数组型字段：tags: [a, b]
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' && v.startsWith('[') && v.endsWith(']')) {
      data[k] = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return { data, body: src.slice(m[0].length) };
}

function firstParagraph(body) {
  const lines = String(body || '').split('\n');
  const buf = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (buf.length) break; else continue; }
    if (/^#{1,6}\s/.test(t)) { if (buf.length) break; else continue; }
    if (/^(```|~~~|\||>|---)/.test(t)) { if (buf.length) break; else continue; }
    buf.push(t);
  }
  return buf.join(' ').replace(/[*_`\[\]]/g, '').trim();
}

function countWords(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
  const latin = (s.replace(/[\u3400-\u9FFF\uF900-\uFAFF]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  return cjk + latin;
}

/** 读取单个 skill 目录的元数据（只读） */
function readSkillMeta(dir, scope = 'global', productId = '', projectId = '') {
  const skillPath = path.join(dir, SKILL_FILE);
  let content = '';
  try { content = fs.readFileSync(skillPath, 'utf8'); } catch { return null; }

  const { data, body } = parseFrontmatter(content);
  const folder = path.basename(dir);
  const name = (typeof data.name === 'string' && data.name.trim()) || folder;
  const description = (typeof data.description === 'string' && data.description.trim()) || firstParagraph(body);

  let fileCount = 0;
  let totalBytes = content.length;
  const walkCount = (d, depth) => {
    if (depth > 3) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        walkCount(full, depth + 1);
      } else {
        fileCount++;
        try { totalBytes += fs.statSync(full).size; } catch { /* ignore */ }
      }
    }
  };
  walkCount(dir, 0);

  let mtime = 0;
  const st = safeStat(skillPath);
  if (st) mtime = st.mtimeMs;

  return {
    id: uid(dir),
    path: skillPath,
    dir: norm(dir),
    folder,
    name,
    description: description.slice(0, 600),
    version: typeof data.version === 'string' ? data.version : '',
    license: typeof data.license === 'string' ? data.license : '',
    tags: Array.isArray(data.tags) ? data.tags.slice(0, 8) : [],
    tools: typeof data['allowed-tools'] === 'string' ? data['allowed-tools'].slice(0, 200) : '',
    scope,
    productId,
    projectId,
    fileCount,
    bytes: totalBytes,
    words: countWords(content),
    mtime,
    raw: data
  };
}

/* ------------------------------------------------------------------ */
/* 4. 对外：探测（不落盘，先给用户看结果）                              */
/* ------------------------------------------------------------------ */

function probe(launchPath, options = {}) {
  const roots = candidateRoots(launchPath, options);
  const identity = identifyProduct(options.product || launchPath);
  const results = [];
  for (const r of roots) {
    if (!isDir(r.root)) continue;
    // 口径必须与库存扫描一致：父 skill 下的子/孙也要计入
    const dirs = walkInventory(r.root, r.depth, { identity }).dirs;
    results.push({
      root: r.root,
      label: r.label,
      kind: r.kind,
      exists: true,
      skillDirs: dirs
    });
  }

  const st = safeStat(norm(launchPath));
  const installDir = st && st.isFile() ? path.dirname(norm(launchPath)) : norm(launchPath);
  const exeBase = st && st.isFile()
    ? path.basename(norm(launchPath), path.extname(norm(launchPath)))
    : path.basename(installDir);

  return {
    launchPath: norm(launchPath),
    valid: !!st,
    isFile: !!(st && st.isFile()),
    suggestedName: exeBase || 'New Product',
    installDir,
    usedFallback: false,
    roots: results.map((r) => ({
      root: r.root,
      label: r.label,
      kind: r.kind,
      count: r.skillDirs.length
    })),
    totalSkills: new Set(results.flatMap((r) => r.skillDirs.map(key))).size
  };
}

/* ------------------------------------------------------------------ */
/* 5. 对外：完整扫描（返回可入库的 skill 列表）                          */
/* ------------------------------------------------------------------ */

function scanProduct(product, options = {}) {
  const productId = product.id;
  const identity = identifyProduct(product);
  const roots = [];
  const projects = [
    ...(product.projects || []).map((p) => ({ id: p.id, name: p.name, path: p.path })),
    ...(product.projectRoots || []).map((p) => ({ id: '', name: path.basename(p), path: p }))
  ];
  const projectPaths = projects.filter((pr) => pr.path && isDir(pr.path)).map((pr) => key(pr.path));
  const inProject = (dir) => {
    const candidate = key(dir);
    return projectPaths.some((base) => candidate === base || candidate.startsWith(base + path.sep));
  };

  // 自动推导
  for (const r of candidateRoots(product.launchPath, { ...options, product })) {
    if (isDir(r.root)) roots.push(r);
  }
  // 用户手工登记的根优先保留
  for (const mr of product.manualRoots || []) {
    if (isDir(mr.root)) roots.push({ ...mr, manual: true });
  }

  // 全局库存：父 skill 下的子/孙同样收录，且统一标注嵌套
  const global = collectRoots(roots, {
    scope: 'global',
    productId,
    identity,
    exclude: inProject
  });

  const collected = [];
  const seenDir = new Set();
  let truncated = global.truncated;
  for (const m of global.metas) {
    const k = key(m.dir);
    if (seenDir.has(k)) continue;
    seenDir.add(k);
    collected.push(m);
  }

  // 项目：新结构 projects[]，兼容旧的 projectRoots[]
  for (const pr of projects) {
    if (!pr.path || !isDir(pr.path)) continue;
    const res = collectRoots([{ root: pr.path, depth: 6 }], {
      scope: 'project',
      productId,
      projectId: pr.id,
      identity
    });
    if (res.truncated) truncated = true;
    for (const m of res.metas) {
      const k = key(m.dir);
      if (seenDir.has(k)) continue;
      seenDir.add(k);
      collected.push(m);
    }
  }

  return { skills: collected, usedFallback: false, truncated, roots: roots.map((r) => r.root) };
}

/** 单独重扫一个项目 —— 与完整产品扫描共用同一套库存与嵌套规则 */
function scanProject(product, project) {
  const res = collectRoots([{ root: project.path, depth: 6 }], {
    scope: 'project',
    productId: product.id,
    projectId: project.id,
    identity: identifyProduct(product)
  });
  return { skills: res.metas, truncated: res.truncated };
}

/** 单独重扫一个「额外项目根」（旧 projectRoots 入口） */
function scanProjectRoot(product, dir) {
  const res = collectRoots([{ root: dir, depth: 6 }], {
    scope: 'project',
    productId: product.id,
    projectId: '',
    identity: identifyProduct(product)
  });
  return { skills: res.metas, truncated: res.truncated };
}

/* ------------------------------------------------------------------ */
/* 6. 项目发现 / skill 新建                                            */
/* ------------------------------------------------------------------ */

const PROJECT_MARKERS = ['skills', '.claude', '.workbuddy-ai', '.cursor', '.codex', '.gemini', '.antigravity', '.agents'];

/** 在一个根目录下找出「像项目」的文件夹（含 skill 目录，或是 git 仓库） */
function discoverProjects(root, maxDepth = 2, includeAll = false) {
  const base = norm(root);
  const out = [];
  if (!isDir(base)) return out;

  const looksLikeProject = (dir) => {
    try {
      const names = fs.readdirSync(dir).map((n) => n.toLowerCase());
      if (names.includes('.git')) return true;
      for (const m of PROJECT_MARKERS) if (names.includes(m)) return true;
      if (names.includes('skill.md')) return true;
    } catch { /* ignore */ }
    return false;
  };

  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length > 300) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      const full = path.join(dir, e.name);
      const skills = walkInventory(full, 3).dirs;
      const isProject = !!skills.length || looksLikeProject(full);
      if (isProject) {
        out.push({ path: full, name: e.name, skillCount: skills.length, isProject: true });
      } else if (includeAll) {
        // 「列出所有项目文件夹」模式下，没有 skill 的空目录也照样列出来，标 0 个
        out.push({ path: full, name: e.name, skillCount: 0, isProject: false });
      } else if (depth < maxDepth) {
        walk(full, depth + 1);
      }
    }
  };

  walk(base, 1);
  out.sort((a, b) => b.skillCount - a.skillCount || a.name.localeCompare(b.name));
  return out;
}

/** 在指定目录下新建一个 skill（目录 + SKILL.md） */
function createSkill(parentDir, name, description = '') {
  if (!norm(parentDir)) throw new Error('请先选择 skill 所在目录');
  const safe = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-');
  if (!safe) throw new Error('skill 名称不能为空');
  const dir = path.join(norm(parentDir), safe);
  if (fs.existsSync(dir)) throw new Error('目录已存在：' + dir);
  fs.mkdirSync(dir, { recursive: true });
  const body = `---\nname: ${safe}\ndescription: ${(description || '').replace(/\n/g, ' ') || '待补充'}\n---\n\n# ${safe}\n\n${description || '（在这里写下这个 skill 做什么、什么时候用、边界在哪。）'}\n`;
  fs.writeFileSync(path.join(dir, SKILL_FILE), body, 'utf8');
  return dir;
}

module.exports = {
  probe,
  scanProduct,
  scanProject,
  scanProjectRoot,
  readSkillMeta,
  parseFrontmatter,
  walkForSkills,
  walkInventory,
  collectRoots,
  countWords,
  candidateRoots,
  discoverProjects,
  createSkill,
  walkAllSkillDirs,
  annotateNesting,
  norm,
  key,
  uid,
  isDir
};
