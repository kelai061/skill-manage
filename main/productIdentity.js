'use strict';

// Package / executable identity takes precedence over a user-editable display name.
function identifyProduct(product) {
  const item = typeof product === 'string' ? { launchPath: product } : (product || {});
  const rules = [
    ['workbuddy', /workbuddy/i],
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
    workbuddy: ['.workbuddy-ai/skills', '.workbuddy-ai/builtin/skills'],
    antigravity: ['.gemini/antigravity/builtin/skills', '.gemini/antigravity/skills'],
    claude: ['.claude/skills'],
    cursor: ['.cursor/skills'],
    codex: ['.codex/skills', '.agents/skills'],
    // A separate ChatGPT installation is not evidence that it owns Codex data.
    chatgpt: [],
    gemini: ['.gemini/skills'],
    windsurf: ['.codeium/windsurf/skills', '.windsurf/skills']
  };
  return (rels[id] || []).map((p) => path.join(home, ...p.split('/')));
}

module.exports = { identifyProduct, skillRoots };
