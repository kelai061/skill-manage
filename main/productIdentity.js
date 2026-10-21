'use strict';

// Package / executable identity takes precedence over a user-editable display name.
function identifyProduct(product) {
  const item = typeof product === 'string' ? { launchPath: product } : (product || {});
  const rules = [
    ['workbuddy', /workbuddy/i],
    ['zcode', /zcode/i],
    ['minimax', /minimax(?:[\s._-]*code)?/i],
    ['kimi', /kimi(?:[\s._-]*code)?/i],
    ['antigravity', /antigravity/i],
    ['codex', /(?:^|[\\/._\s-])codex(?:$|[\\/._\s-])/i],
    ['chatgpt', /chatgpt/i],
    ['claude', /claude/i],
    ['cursor', /cursor/i],
    ['windsurf', /windsurf/i],
    ['gemini', /gemini/i]
  ];
  const launch = String(item.launchPath || '');
  if (/OpenAI\.Codex_/i.test(launch)) return 'codex';
  if (/OpenAI\.ChatGPT(?:-Desktop)?_/i.test(launch)) return 'chatgpt';
  for (const value of [...launch.split(/[\\/]/).reverse(), item.toolId, item.name]) {
    if (!value) continue;
    for (const [id, pattern] of rules) if (pattern.test(String(value))) return id;
  }
  return '';
}

function skillRoots(id, home) {
  const path = require('node:path');
  const rels = {
    workbuddy: ['.workbuddy-ai/skills', '.workbuddy-ai/builtin/skills', '.workbuddy/skills', '.workbuddy/builtin/skills'],
    'workbuddy-ai': ['.workbuddy-ai/skills', '.workbuddy-ai/builtin/skills'],
    zcode: ['.zcode/skills'],
    minimax: ['.minimax/skills', '.minimax/.builtin-skills'],
    kimi: ['.kimi-code/skills', '.agents/skills'],
    antigravity: ['.gemini/antigravity/builtin/skills', '.gemini/antigravity/skills'],
    claude: ['.claude/skills'],
    cursor: ['.cursor/skills'],
    codex: ['.codex/skills', '.agents/skills'],
    // A separate ChatGPT installation is not evidence that it owns Codex data.
    chatgpt: [],
    gemini: ['.gemini/skills'],
    windsurf: ['.codeium/windsurf/skills', '.windsurf/skills']
  };
  const roots = (rels[id] || []).map((p) => path.join(home, ...p.split('/')));
  if (id === 'minimax') {
    // Agent-specific skills live one level below agents; do not scan sessions/config.
    const fs = require('node:fs');
    const base = path.join(home, '.minimax', 'agents');
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true }).slice(0, 300)) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) roots.push(path.join(base, entry.name, 'skills'));
      }
    } catch { /* not installed */ }
  }
  return roots;
}

module.exports = { identifyProduct, skillRoots };
