'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Treat pasted Windows paths as data. Never run the selected application.
function resolveLaunchPath(value, options = {}) {
  let input = String(value || '').trim();
  if (!input) return '';
  if (process.platform === 'win32') input = input.replace(/%([^%]+)%/g, (match, name) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? process.env[key] : match;
  });
  if (/^(?:"[^"]*"|'[^']*')$/.test(input)) input = input.slice(1, -1);
  // Preserve existing paths (including spaces); otherwise accept shortcut Target text.
  if (!fs.existsSync(input)) {
    const target = input.match(/^"([^"]+\.(?:exe|cmd|bat))"(?:\s+.*)?$/i)
      || input.match(/^(.+?\.(?:exe|cmd|bat))(?:\s+.*)$/i);
    if (target) input = target[1];
  }
  let result = path.resolve(input);
  if (/\.lnk$/i.test(result) && fs.existsSync(result)) {
    try {
      const read = options.readShortcut || require('electron').shell.readShortcutLink;
      const shortcut = read(result);
      if (!shortcut.target || /\.lnk$/i.test(shortcut.target)) return '';
      result = resolveLaunchPath(shortcut.target);
    } catch { throw new Error('无法读取快捷方式，请选择它指向的 EXE 文件。'); }
  }
  return result;
}

module.exports = { resolveLaunchPath };
