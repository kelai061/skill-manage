'use strict';
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createManager, installation, selectAsset, expectedHash, downloadUrl } = require('../main/updateManager');
const { conciseNotes } = require('../main/updater');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-update-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const bytes = Buffer.from('test update executable bytes');
const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
const name = 'SkillAtelier-1.0.6.exe';
const release = { tag_name: 'v1.0.6', body: '- One change\n- Another change', assets: [{ name, size: bytes.length }, { name: 'SHA256SUMS.txt', size: 100 }] };
function fixture(overrides = {}) {
  let calls = 0;
  const directory = fs.mkdtempSync(path.join(root, 'case-'));
  const fetchImpl = async (url) => {
    calls++;
    if (url.includes('api.github.com')) return Response.json(release);
    if (url.endsWith('SHA256SUMS.txt')) return new Response(`${checksum}  ${name}\n`);
    return new Response(bytes);
  };
  const manager = createManager({ current: '1.0.5', directory, mode: 'portable', target: path.join(directory, 'app.exe'), fetchImpl, quit: () => {}, ...overrides });
  return { manager, directory, calls: () => calls };
}
test('Installation mode selects the correct package without changing data location', () => {
  const resources = path.join(root, 'resources'); fs.mkdirSync(resources);
  const base = { packaged: true, platform: 'win32', executable: path.join(root, 'App', 'SkillAtelier.exe'), resources, env: {} };
  assert.equal(installation(base).mode, 'setup');
  assert.equal(installation({ ...base, env: { PORTABLE_EXECUTABLE_FILE: path.join(root, 'custom.exe') } }).mode, 'portable');
  fs.writeFileSync(path.join(resources, 'PORTABLE.txt'), 'portable');
  assert.equal(installation(base).mode, 'directory');
  assert.equal(installation({ ...base, packaged: false }).mode, 'unsupported');
  assert.equal(installation({ ...base, platform: 'linux' }).mode, 'unsupported');
});
test('Only matching official assets and unambiguous checksums can be used', () => {
  const info = { latest: '1.0.6', tag: 'v1.0.6', hasUpdate: true, assets: release.assets };
  assert.equal(selectAsset(info, 'portable').name, name);
  assert.throws(() => selectAsset(info, 'setup'), /尚未就绪/);
  assert.throws(() => selectAsset({ ...info, latest: '../../bad' }, 'portable'));
  assert.throws(() => expectedHash('', name));
  assert.throws(() => expectedHash(`${checksum}  ${name}\n${checksum}  ${name}`, name));
  assert.equal(expectedHash(`${checksum}  ${name}`, name), checksum);
  assert.match(downloadUrl(info, name), /^https:\/\/github.com\/kelai061\/skill-manage\/releases\/download\/v1.0.6\//);
  assert.throws(() => downloadUrl(info, '../anything'));
});
test('Download is streamed, deduplicated, verified, and only then made ready', async () => {
  const { manager, directory, calls } = fixture();
  await manager.check();
  await manager.download(); await manager.download();
  await manager.waitForDownload();
  assert.equal(manager.status().stage, 'ready');
  assert.equal(manager.status().percent, 100);
  assert.equal(calls(), 3);
  const job = fs.readdirSync(directory).find((item) => item.startsWith('download-'));
  assert.deepEqual(fs.readFileSync(path.join(directory, job, name)), bytes);
});
test('Corrupt or truncated packages fail verification and never become installable', async () => {
  const { manager } = fixture({ fetchImpl: async (url) => url.includes('api.github.com') ? Response.json(release) :
    url.endsWith('.txt') ? new Response(`${checksum}  ${name}\n`) : new Response('corrupt') });
  await manager.check(); await manager.download(); await manager.waitForDownload();
  assert.equal(manager.status().stage, 'error');
  await assert.rejects(manager.install(), /先完成/);
});
test('Cancellation aborts the request and permits retry', async () => {
  let cancelled = false;
  const { manager } = fixture({ fetchImpl: async (url, options) => {
    if (url.includes('api.github.com')) return Response.json(release);
    if (cancelled) return url.endsWith('.txt') ? new Response(`${checksum}  ${name}\n`) : new Response(bytes);
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { cancelled = true; reject(new Error('aborted')); }));
  } });
  await manager.check(); await manager.download(); manager.cancel(); await manager.waitForDownload();
  assert.equal(manager.status().stage, 'cancelled');
  await manager.download(); await manager.waitForDownload();
  assert.equal(manager.status().stage, 'ready');
});
test('Changed download bytes are rejected before any installer is launched', async () => {
  const { manager, directory } = fixture({ spawnImpl: () => { throw new Error('must not launch'); } });
  await manager.check(); await manager.download(); await manager.waitForDownload();
  const job = fs.readdirSync(directory).find((item) => item.startsWith('download-'));
  fs.appendFileSync(path.join(directory, job, name), 'tampered');
  await assert.rejects(manager.install(), /已变化/);
  assert.equal(manager.status().stage, 'error');
});
test('Installer handshake gates quitting; concurrent install calls launch once', async () => {
  let spawned = 0; let quit = 0;
  const { manager } = fixture({ quit: () => quit++, spawnImpl: (_exe, args, options) => {
    spawned++;
    assert.equal(options.windowsHide, true);
    const data = JSON.parse(Buffer.from(args.at(-1), 'base64').toString());
    fs.writeFileSync(data.armed, 'ready');
    const child = new EventEmitter(); child.unref = () => {}; child.kill = () => {}; child.exitCode = null;
    return child;
  } });
  await manager.check(); await manager.download(); await manager.waitForDownload();
  await Promise.all([manager.install(), manager.install()]);
  assert.equal(spawned, 1); assert.equal(manager.status().stage, 'installing');
  await new Promise((resolve) => setTimeout(resolve, 300)); assert.equal(quit, 1);
});
test('Release descriptions only show short notes for the latest version', () => {
  const notes = conciseNotes('# Updates\n\n## v1.0.5 — today\n- In-app updates\n- Short notes\n\n## v1.0.4 — yesterday\n- Old note');
  assert.equal(notes, '• In-app updates\n• Short notes');
  const { releaseNotes } = require('./release-notes.cjs');
  assert.ok(!releaseNotes().includes('v1.0.4'));
});
