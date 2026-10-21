'use strict';
// Run only on the disposable Windows CI host: NSIS writes its installation registry.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32') throw new Error('安装更新验证仅在隔离的 Windows CI 中运行。');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-installed-update-'));
const { version } = require('../package.json');
const installer = path.resolve(`release/current/SkillAtelier-Setup-${version}.exe`);
const target = path.join(root, 'SkillAtelier test with spaces');
const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
  '$ErrorActionPreference="Stop"; $p=Start-Process -FilePath $env:SA_TEST_INSTALLER -ArgumentList @("/S","--updated",("/D="+$env:SA_TEST_TARGET)) -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode'],
  { env: { ...process.env, SA_TEST_INSTALLER: installer, SA_TEST_TARGET: target }, stdio: 'inherit', windowsHide: true, timeout: 180000 });
assert.ok(fs.existsSync(path.join(target, 'SkillAtelier.exe')));
const data = path.join(process.env.LOCALAPPDATA, 'SkillAtelier/data');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ settings: { preservedUpdateTest: true,
  onboarded: { detect: true, help: true }, update: { auto: false } } }));
const marker = path.join(data, 'preserve-update-test.txt'); fs.writeFileSync(marker, 'keep my data');
const job = path.join(root, 'job'); fs.mkdirSync(job);
const file = path.join(job, path.basename(installer)); fs.copyFileSync(installer, file);
const payload = { mode: 'setup', target, file, checksum: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  version, parentPid: 2147483647, job, armed: path.join(job, 'armed'), result: path.join(root, 'result.json') };
execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('main/apply-update.ps1'),
  '-Payload', Buffer.from(JSON.stringify(payload)).toString('base64')], { stdio: 'inherit', windowsHide: true, timeout: 180000 });
const result = JSON.parse(fs.readFileSync(payload.result, 'utf8').replace(/^\uFEFF/, ''));
assert.equal(result.success, true, JSON.stringify(result));
assert.equal(fs.readFileSync(marker, 'utf8'), 'keep my data');
assert.ok(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).settings.preservedUpdateTest);
assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'resources/app/package.json'), 'utf8')).version, version);
assert.ok(fs.existsSync(path.join(job, 'restarted')));
console.log('[PASS] Real NSIS in-app update: path with spaces, preserved data, successful restart handoff');
// Stop only the process in the exact temporary installation we created.
execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
  'Get-Process SkillAtelier -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:SA_TEST_EXECUTABLE } | Stop-Process -Force'],
  { env: { ...process.env, SA_TEST_EXECUTABLE: path.join(target, 'SkillAtelier.exe') }, windowsHide: true });
