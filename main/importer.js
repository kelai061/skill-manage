'use strict';
/**
 * importer.js — 粘贴一个链接，把 skill 抓到本地暂存区
 *
 * 支持的链接形态：
 *   1. GitHub 仓库      https://github.com/owner/repo
 *   2. GitHub 子目录    https://github.com/owner/repo/tree/main/skills/xxx
 *   3. 直链 zip         https://…/xxx.zip
 *   4. 直链 md          https://raw.githubusercontent.com/…/SKILL.md
 *
 * 抓下来的东西一律先落在暂存区（默认 AAA-new），不做任何归位动作。
 * 归位（分类）是另一个需要授权的步骤。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const scanner = require('./scanner');

/* GitHub 直连在本机不通，按顺序试代理 */
const PROXIES = [
  (u) => u,
  (u) => 'https://ghproxy.net/' + u,
  (u) => 'https://gh-proxy.com/' + u
];

function tmpDir(tag = 'atelier') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function fetchWithFallback(url, asText, timeoutMs = 25000) {
  let lastErr = null;
  for (const wrap of PROXIES) {
    const target = wrap(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(target, { redirect: 'follow', signal: ctrl.signal });
      if (!res.ok) { lastErr = new Error(`${res.status}`); continue; }
      const body = asText ? await res.text() : Buffer.from(await res.arrayBuffer());
      clearTimeout(timer);
      return body;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('下载失败：' + (lastErr ? lastErr.message : '所有通道均不可用'));
}

function unzip(zipPath, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const zip = zipPath.replace(/'/g, "''");
  const target = dest.replace(/'/g, "''");
  // Check the entire archive before extraction; relative paths must stay inside its temporary root.
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead('${zip}')
try {
  $root = [System.IO.Path]::GetFullPath('${target}').TrimEnd([char[]]'\\/') + [System.IO.Path]::DirectorySeparatorChar
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName.Contains(':')) { throw 'Invalid archive path' }
    $entryPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $entry.FullName))
    if (-not $entryPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes destination' }
  }
} finally { $archive.Dispose() }
[System.IO.Compression.ZipFile]::ExtractToDirectory('${zip}', '${target}')`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'pipe',
    timeout: 120000
  });
}

/** 解析链接 → 下载计划 */
function plan(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('链接必须以 http:// 或 https:// 开头');

  const gh = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/tree\/([^/?#]+)(?:\/([^?#]+))?)?\/?$/i);
  if (gh) {
    const [, owner, repo, branch, sub] = gh;
    const parts = sub ? sub.split('/').filter(Boolean).map(decodeURIComponent) : [];
    if (parts.some((part) => !safeName(part))) throw new Error('GitHub 子目录路径无效');
    return { kind: 'zip', owner, repo, sub: parts.join('/'), branch: branch || '', url: u };
  }
  if (/\.zip(\?|$)/i.test(u)) return { kind: 'zip', url: u };
  if (/\.(md|markdown|txt)(\?|$)/i.test(u)) return { kind: 'file', url: u };
  return { kind: 'zip', url: u, guess: true };
}

async function downloadZipUrl(p) {
  const candidates = [];
  if (p.owner && p.repo) {
    const base = `https://github.com/${p.owner}/${p.repo}/archive/refs/heads`;
    const branch = p.branch || 'main';
    candidates.push(`${base}/${branch}.zip`);
    if (!p.branch) candidates.push(`${base}/master.zip`);
  }
  candidates.push(p.url);

  let lastErr = null;
  for (const c of candidates) {
    try {
      const buf = await fetchWithFallback(c, false);
      if (buf.length < 100) throw new Error('文件过小，可能不是压缩包');
      return buf;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('压缩包下载失败');
}

function safeName(name) {
  return !!name && name !== '.' && name !== '..' && !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[ .]$/.test(name);
}

function pickName(p) {
  const base = p.repo || decodeURIComponent(new URL(p.url).pathname.split('/').pop() || 'imported-skill');
  const name = base.replace(/\.(zip|md|markdown|txt)$/i, '') || 'imported-skill';
  if (!safeName(name)) throw new Error('下载链接中的目录名称无效');
  return name;
}

// Importing a second skill with the same name must never replace the first one.
function reserveDir(staging, name) {
  if (!safeName(name)) throw new Error('skill 目录名称无效');
  for (let n = 1; ; n++) {
    const actual = n === 1 ? name : `${name}-${n}`;
    const dir = path.join(staging, actual);
    try {
      fs.mkdirSync(dir);
      return { name: actual, dir };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

/**
 * 导入一个链接
 * @returns {Promise<{imported: Array<{name,dir,kind}>, note:string}>}
 */
async function importUrl(url, stagingRoot) {
  const p = plan(url);
  if (!String(stagingRoot || '').trim()) throw new Error('暂存区未配置');
  const staging = scanner.norm(stagingRoot);
  if (!staging) throw new Error('暂存区未配置');
  fs.mkdirSync(staging, { recursive: true });

  const imported = [];
  const allocated = [];
  const reserve = (name) => {
    const result = reserveDir(staging, name);
    allocated.push(result.dir);
    return result;
  };
  const tmp = tmpDir('atelier-import');

  try {
    if (p.kind === 'file') {
      const text = await fetchWithFallback(p.url, true);
      if (!text || text.length < 20) throw new Error('下载内容为空');
      const { name, dir } = reserve(pickName(p));
      fs.writeFileSync(path.join(dir, 'SKILL.md'), text, 'utf8');
      imported.push({ name, dir, kind: 'file' });
    } else {
      const buf = await downloadZipUrl(p);
      const zipPath = path.join(tmp, 'pkg.zip');
      fs.writeFileSync(zipPath, buf);

      const out = path.join(tmp, 'out');
      unzip(zipPath, out);

      // 解压后可能有一层 <repo>-main/ 外壳
      let roots = fs.readdirSync(out, { withFileTypes: true }).filter((e) => e.isDirectory());
      let base = out;
      if (roots.length === 1 && fs.readdirSync(out).length === 1) base = path.join(out, roots[0].name);

      // 指定了子目录就只取那一层
      if (p.sub) {
        const subDir = path.join(base, ...p.sub.split('/').filter(Boolean));
        if (!fs.existsSync(subDir) || !fs.statSync(subDir).isDirectory()) throw new Error('仓库中不存在指定的子目录');
        base = subDir;
      }

      let skillDirs = scanner.walkForSkills(base, 3);
      if (!skillDirs.length && fs.existsSync(path.join(base, 'SKILL.md'))) skillDirs = [base];

      if (!skillDirs.length) {
        // 认不出 skill，整体搬进暂存区，交给人工判断
        const { name, dir } = reserve(pickName(p));
        copyDir(base, dir);
        imported.push({ name, dir, kind: 'raw' });
      } else {
        for (const sd of skillDirs) {
          const { name, dir } = reserve(path.basename(sd));
          copyDir(sd, dir);
          imported.push({ name, dir, kind: 'skill' });
        }
      }
    }
  } catch (e) {
    for (const dir of allocated) rmrf(dir);
    throw e;
  } finally {
    rmrf(tmp);
  }

  return { imported, staging };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    if (e.isSymbolicLink()) throw new Error('下载内容包含符号链接，已中止导入');
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 暂存区现状 */
function stagingState(stagingRoot) {
  const root = scanner.norm(stagingRoot);
  if (!root || !fs.existsSync(root)) {
    return { root, exists: false, items: [], skillCount: 0, other: [] };
  }
  const items = [];
  const other = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) {
      if (!e.name.startsWith('.')) other.push(e.name);
      continue;
    }
    const dir = path.join(root, e.name);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
      const meta = scanner.readSkillMeta(dir, 'global', '', '');
      items.push({
        name: e.name,
        dir,
        description: meta ? meta.description : '',
        words: meta ? meta.words : 0
      });
    } else {
      const inner = scanner.walkForSkills(dir, 3);
      other.push(`${e.name}/（内含 ${inner.length} 个 skill，未展开）`);
    }
  }
  return { root, exists: true, items, skillCount: items.length, other };
}

module.exports = { importUrl, stagingState, plan };
