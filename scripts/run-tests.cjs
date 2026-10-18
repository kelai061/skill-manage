'use strict';
/**
 * run-tests.cjs — 端到端验收入口（npm test）
 *
 * 关键：整套测试跑在一个**临时 profile** 里。
 * 复制一份当前 config.json 过去，让测试看得见真实的 skill，
 * 但收藏、翻译缓存、评分这些写操作全部落在临时目录，
 * 绝不污染用户正在用的那份配置。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const scenario = path.join(root, 'scripts', 'scenarios', 'reader.cjs');

/* 1) 纯逻辑单测：不启动 Electron，秒级失败快 */
console.log('\n===== 单元测试：双语对齐内核 =====');
const unit = spawnSync(process.execPath, [path.join(root, 'scripts', 'unit-align.mjs')], {
  cwd: root,
  stdio: 'inherit'
});
if (unit.status !== 0) {
  console.error('\n[test] 单元测试未通过，已中止端到端测试。');
  process.exit(unit.status || 1);
}

console.log('\n===== 单元测试：附属文件分类 =====');
const unitFiles = spawnSync(process.execPath, [path.join(root, 'scripts', 'unit-files.cjs')], {
  cwd: root,
  stdio: 'inherit'
});
if (unitFiles.status !== 0) {
  console.error('\n[test] 文件分类单测未通过，已中止端到端测试。');
  process.exit(unitFiles.status || 1);
}

console.log('\n===== 端到端测试：并排阅读器 =====');

let bin;
try {
  bin = require('electron');
} catch (e) {
  console.error('找不到 Electron 运行时，请先执行 npm install');
  console.error(String(e.message).split('\n')[0]);
  process.exit(1);
}

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const realConfig = path.join(appData, 'Skill Atelier', 'config.json');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-atelier-test-'));
if (fs.existsSync(realConfig)) {
  fs.copyFileSync(realConfig, path.join(profile, 'config.json'));
  console.log('[test] 已复制真实索引到临时 profile：', profile);
} else {
  console.log('[test] 未找到现有配置，测试将使用空索引');
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const args = ['.', `--profile=${profile}`, `--scenario=${scenario}`];
const r = spawnSync(bin, args, { cwd: root, env, stdio: 'inherit' });

const report = path.join(root, 'docs', 'test-report.json');
if (fs.existsSync(report)) {
  const j = JSON.parse(fs.readFileSync(report, 'utf8'));
  console.log(`\n[test] ${j.passed}/${j.total} 通过，报告：${report}`);
  if (j.failed) {
    console.log('[test] 失败项：');
    for (const it of j.results.filter((x) => !x.ok)) console.log('  -', it.name, JSON.stringify(it.detail));
  }
}

process.exit(r.status === null ? 1 : r.status);
