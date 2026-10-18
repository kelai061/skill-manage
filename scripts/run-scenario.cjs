'use strict';
/**
 * run-scenario.cjs — 跑单个端到端场景（临时 profile 隔离）
 *
 * 用法：node scripts/run-scenario.cjs scripts/scenarios/v13.cjs
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const target = process.argv[2];
if (!target) {
  console.error('用法：node scripts/run-scenario.cjs <scenario.cjs>');
  process.exit(1);
}
const scenario = path.resolve(root, target);
if (!fs.existsSync(scenario)) {
  console.error('场景文件不存在：' + scenario);
  process.exit(1);
}

const bin = require('electron');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const realConfig = path.join(appData, 'Skill Atelier', 'config.json');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-atelier-sc-'));
if (fs.existsSync(realConfig)) {
  fs.copyFileSync(realConfig, path.join(profile, 'config.json'));
  console.log('[scenario] 临时 profile：', profile);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const r = spawnSync(bin, ['.', `--profile=${profile}`, `--scenario=${scenario}`], {
  cwd: root,
  env,
  stdio: 'inherit'
});

process.exit(r.status === null ? 1 : r.status);
