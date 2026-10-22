'use strict';
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-update-apply-'));
after(() => { if (process.env.SA_KEEP_UPDATE_TEST) console.log('Test artifacts:', root); else fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
function powershell(command, env = {}) {
  return execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', command],
    { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
}
const oldExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/whoami.exe');
const newExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/hostname.exe');
function fixture(mode, corrupt = false) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const targetDir = path.join(dir, '安装 Apps'); fs.mkdirSync(targetDir);
  const executable = path.join(targetDir, 'SkillAtelier.exe'); fs.copyFileSync(oldExe, executable);
  const data = path.join(targetDir, 'SkillAtelier-data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), 'user-data-must-survive');
  for (const name of ['translations', 'translation-tasks']) {
    fs.mkdirSync(path.join(targetDir, name));
    fs.writeFileSync(path.join(targetDir, name, 'saved.json'), 'persistent-data-must-survive');
  }
  const job = path.join(dir, 'job'); fs.mkdirSync(job);
  const file = path.join(job, mode === 'directory' ? 'update.zip' : 'update.exe');
  if (mode === 'directory') {
    const stage = path.join(dir, 'SkillAtelier');
    fs.mkdirSync(path.join(stage, 'resources/app'), { recursive: true });
    fs.copyFileSync(newExe, path.join(stage, 'SkillAtelier.exe'));
    fs.writeFileSync(path.join(stage, 'resources/app/package.json'), JSON.stringify({ version: '1.0.6' }));
    fs.writeFileSync(path.join(stage, 'z-blocked.txt'), 'new file');
    powershell('Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:SA_TEST_SOURCE,$env:SA_TEST_OUTPUT,[IO.Compression.CompressionLevel]::Optimal,$true)',
      { SA_TEST_SOURCE: stage, SA_TEST_OUTPUT: file });
  } else fs.copyFileSync(newExe, file);
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { dir, executable, data, payload: { mode, target: mode === 'portable' ? executable : targetDir, file,
    checksum: corrupt ? '0'.repeat(64) : checksum, version: '1.0.6', parentPid: 2147483647,
    job, result: path.join(dir, 'result.json'), armed: path.join(job, 'armed') } };
}
async function apply(item, expectedSuccess) {
  execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../main/apply-update.ps1'), '-Payload', Buffer.from(JSON.stringify(item.payload)).toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const result = JSON.parse(fs.readFileSync(item.payload.result, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(result.success, expectedSuccess, JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(item.data, 'config.json'), 'utf8'), 'user-data-must-survive');
  for (const name of ['translations', 'translation-tasks']) assert.equal(fs.readFileSync(path.join(path.dirname(item.executable), name, 'saved.json'), 'utf8'), 'persistent-data-must-survive');
  if (fs.existsSync(item.payload.armed)) {
    assert.ok(fs.existsSync(path.join(item.payload.job, 'restarted')));
  }
  return result;
}
test('Windows apply helper replaces portable/directory apps and restarts while preserving user data', { skip: process.platform !== 'win32' }, async () => {
  for (const mode of ['portable', 'directory']) {
    const item = fixture(mode); await apply(item, true);
    assert.deepEqual(fs.readFileSync(item.executable), fs.readFileSync(newExe));
  }
});
test('Windows apply helper rejects a changed package before exiting the current app', { skip: process.platform !== 'win32' }, async () => {
  const item = fixture('portable', true); const result = await apply(item, false);
  assert.equal(result.error, 'Checksum mismatch');
  assert.ok(!fs.existsSync(item.payload.armed));
  assert.deepEqual(fs.readFileSync(item.executable), fs.readFileSync(oldExe));
});
test('Partial directory update restores previously replaced files on failure', { skip: process.platform !== 'win32' }, async () => {
  const item = fixture('directory'); fs.mkdirSync(path.join(path.dirname(item.executable), 'z-blocked.txt'));
  const result = await apply(item, false);
  assert.equal(result.error, 'Destination is a directory');
  assert.ok(fs.existsSync(path.join(item.payload.job, 'backup/SkillAtelier.exe')));
  assert.deepEqual(fs.readFileSync(item.executable), fs.readFileSync(oldExe));
});
