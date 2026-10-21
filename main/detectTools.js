'use strict';
/** Read-only discovery. No product configuration or skill files are modified. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { identifyProduct, skillRoots } = require('./productIdentity');

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };
const firstExisting = (list) => list.find(exists) || '';
const SKIP = new Set(['node_modules', '.git', '.cache', 'sessions', 'logs']);
const HIDDEN = new Set(['.system', '.agents', '.codex', '.cursor', '.claude', '.workbuddy', '.workbuddy-ai', '.gemini', '.zcode', '.minimax', '.kimi-code', '.builtin-skills']);

function shortcutPaths() {
  if (process.platform !== 'win32') return [];
  const windows = process.env.SystemRoot || process.env.WINDIR;
  if (!windows) return [];
  try {
    // Read only matching links in Windows' own known folders. No drive-wide scan.
    const command = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      $shell = New-Object -ComObject WScript.Shell
      $paths = foreach ($folder in @('Desktop','CommonDesktopDirectory','StartMenu','CommonStartMenu')) {
        $base = [Environment]::GetFolderPath($folder)
        if ($base -and (Test-Path -LiteralPath $base)) {
          Get-ChildItem -LiteralPath $base -Filter *.lnk -Recurse -ErrorAction SilentlyContinue |
            Where-Object Name -Match 'WorkBuddy|ZCode|MiniMax|Kimi|Codex|ChatGPT|Cursor|Claude|Antigravity|Windsurf' |
            Select-Object -First 100 | ForEach-Object { $shell.CreateShortcut($_.FullName).TargetPath }
        }
      }
      @($paths) | ConvertTo-Json -Compress
    `;
    const raw = require('node:child_process').execFileSync(path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 6000, maxBuffer: 131072, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '').trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((p) => typeof p === 'string' && exists(p));
  } catch { return []; }
}

function runningPaths() {
  if (process.platform !== 'win32') return [];
  const windows = process.env.SystemRoot || process.env.WINDIR;
  if (!windows) return [];
  try {
    const executable = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // A fixed, bounded query. Never interpolate product paths or user input here.
    const command = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Process -Name ChatGPT,Codex,Cursor,Claude,WorkBuddy,WorkBuddyAI,ZCode,'MiniMax Code','Kimi Code',Antigravity,Windsurf -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -ErrorAction SilentlyContinue | ConvertTo-Json -Compress";
    const raw = require('node:child_process').execFileSync(executable,
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 65536, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '').trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((p) => typeof p === 'string' && exists(p));
  } catch { return []; }
}

function countSkills(root, seen = new Set()) {
  if (!exists(root)) return 0;
  let n = 0;
  const started = Date.now();
  const walk = (dir, depth) => {
    if (depth > 6 || n >= 4000 || Date.now() - started > 3000) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // 命中父 skill 后仍然继续向下：库存口径必须包含子/孙，
    // 否则「探测说 3 个、库里 7 个」，用户只会觉得数字乱跳。
    if (ents.some((e) => e.isFile() && e.name.toLowerCase() === 'skill.md')) {
      const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
      if (!seen.has(key)) { seen.add(key); n++; }
    }
    for (const e of ents) {
      if (!e.isDirectory() || SKIP.has(e.name.toLowerCase())) continue;
      if (e.name.startsWith('.') && !HIDDEN.has(e.name.toLowerCase())) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return n;
}

/** Injectable paths make detection reproducible without opening real user files. */
function detect(options = {}) {
  const home = options.home || os.homedir();
  const local = options.localappdata === undefined ? (process.env.LOCALAPPDATA || '') : options.localappdata;
  const programFiles = options.programFiles === undefined ? (process.env.ProgramFiles || '') : options.programFiles;
  const joinLocal = (...parts) => local ? path.join(local, ...parts) : '';
  const joinProgram = (...parts) => programFiles ? path.join(programFiles, ...parts) : '';
  const tools = [
    { id: 'workbuddy', name: 'WorkBuddy', exe: [joinLocal('Programs', 'WorkBuddy', 'WorkBuddy.exe'), joinLocal('WorkBuddy', 'WorkBuddy.exe')], probe: [path.join(home, '.workbuddy')] },
    { id: 'workbuddy-ai', name: 'WorkBuddy AI', exe: [joinLocal('Programs', 'WorkBuddy', 'WorkBuddyAI.exe'), joinLocal('WorkBuddy', 'WorkBuddyAI.exe')], probe: [path.join(home, '.workbuddy-ai')] },
    { id: 'zcode', name: 'ZCode', exe: [joinLocal('Programs', 'ZCode', 'ZCode.exe')], probe: [path.join(home, '.zcode')] },
    { id: 'minimax', name: 'MiniMax Code', exe: [joinLocal('Programs', 'MiniMax Code', 'MiniMax Code.exe')], probe: [path.join(home, '.minimax')] },
    { id: 'kimi', name: 'Kimi Code', exe: [joinLocal('Programs', 'Kimi Code', 'Kimi Code.exe')], probe: [path.join(home, '.kimi-code')] },
    { id: 'antigravity', name: 'Antigravity', exe: [joinLocal('Programs', 'Antigravity', 'Antigravity.exe'), joinLocal('Programs', 'Antigravity IDE', 'Antigravity.exe')], probe: [path.join(home, '.gemini', 'antigravity')] },
    { id: 'claude', name: 'Claude Code', exe: [joinLocal('Programs', 'Claude', 'Claude.exe'), path.join(home, '.local', 'bin', 'claude.exe')], probe: [path.join(home, '.claude.json'), path.join(home, '.claude')] },
    { id: 'cursor', name: 'Cursor', exe: [joinLocal('Programs', 'cursor', 'Cursor.exe'), joinLocal('Programs', 'Cursor', 'Cursor.exe')], probe: [path.join(home, '.cursor')] },
    { id: 'codex', name: 'Codex', exe: [joinLocal('Programs', 'Codex', 'Codex.exe'), joinLocal('Programs', 'ChatGPT', 'Codex.exe')], probe: [path.join(home, '.codex')] },
    { id: 'chatgpt', name: 'ChatGPT', exe: [joinLocal('Programs', 'ChatGPT', 'ChatGPT.exe'), joinProgram('ChatGPT', 'ChatGPT.exe')], probe: [] },
    { id: 'gemini', name: 'Gemini CLI', exe: [], probe: [path.join(home, '.gemini', 'skills')] },
    { id: 'windsurf', name: 'Windsurf', exe: [joinLocal('Programs', 'Windsurf', 'Windsurf.exe')], probe: [path.join(home, '.codeium', 'windsurf'), path.join(home, '.windsurf')] }
  ];

  // Microsoft Store apps are not installed under LocalAppData/Programs.
  // Prefer executable aliases / install folders; package data can remain after uninstall.
  const packageDirs = [];
  const packageBases = options.packageBases || [joinLocal('Microsoft', 'WindowsApps'), joinProgram('WindowsApps')];
  for (const base of packageBases.filter(Boolean)) {
    let ents = [];
    try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (/^OpenAI\.(?:Codex|ChatGPT(?:-Desktop)?)_.*2p2nqsd0c76g0$/i.test(e.name)) packageDirs.push(path.join(base, e.name));
    }
  }
  for (const entry of options.packageDirs || []) if (exists(entry)) packageDirs.push(entry);
  const runtimePaths = (options.runtimePaths === undefined ? runningPaths() : options.runtimePaths).filter(exists);
  const shortcuts = (options.shortcutPaths === undefined ? shortcutPaths() : options.shortcutPaths).filter(exists);

  const items = [];
  for (const t of tools) {
    const packaged = packageDirs.find((p) => identifyProduct(p) === t.id) || '';
    const running = runtimePaths.find((p) => identifyProduct(p) === t.id
      && !(t.id === 'codex' && /[\\/]bin[\\/]/i.test(p) && /[\\/]codex\.exe$/i.test(p))) || '';
    const executable = firstExisting(t.exe);
    const shortcut = shortcuts.find((p) => identifyProduct(p) === t.id) || '';
    const launchPath = running || executable || shortcut || packaged || firstExisting(t.probe);
    if (!launchPath) continue;
    const roots = skillRoots(t.id, home).filter(exists);
    const seen = new Set();
    const skills = roots.reduce((sum, r) => sum + countSkills(r, seen), 0);
    const hasApp = !!(running || executable || shortcut || packaged);
    if (!hasApp && !skills) continue;
    items.push({ id: t.id, name: t.id === 'codex' && hasApp ? 'Codex / ChatGPT 桌面版' : t.name,
      launchPath, roots, skills, hasApp, source: packaged ? 'store-package' : hasApp ? 'application' : 'skills' });
  }
  return items;
}

module.exports = { detect, countSkills };
