'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { check, cmp, parseVer, REPO } = require('../main/updater');

const response = (release, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => release });
const fetchRelease = (release, status) => async () => response(release, status);

test('SemVer orders numeric components, prereleases, and ignores build metadata', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.2', '1.0.10', '1.1.0', '2.0.0'];
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(cmp(ordered[i - 1], ordered[i]), -1);
    assert.equal(cmp(ordered[i], ordered[i - 1]), 1);
  }
  assert.equal(cmp('v1.0.2+build.17', '1.0.2+other'), 0);
  assert.equal(cmp('1.0.0-99999999999999999999', '1.0.0-99999999999999999998'), 1);
  assert.equal(cmp('99999999999999999999.0.0', '99999999999999999998.0.0'), 1);
});

test('Malformed versions are rejected instead of being treated as zero', () => {
  for (const value of ['', 'latest', '1.0', '1.0.0.1', '01.0.0', '1.0.0-01', '1.0.0-', '1.0.0+', '1.0.0-a..b', null]) {
    assert.equal(parseVer(value), null, String(value));
    assert.throws(() => cmp(value, '1.0.0'), /版本号/);
  }
});

test('A newer stable release returns only the official download page', async () => {
  let options;
  const result = await check('1.0.2', { fetchImpl: async (url, init) => {
    assert.equal(url, `https://api.github.com/repos/${REPO}/releases/latest`);
    options = init;
    return response({ tag_name: 'v1.0.3', html_url: 'https://untrusted.invalid/file.exe', body: 'A'.repeat(5000) });
  } });
  assert.equal(result.hasUpdate, true);
  assert.equal(result.latest, '1.0.3');
  assert.equal(result.url, `https://github.com/${REPO}/releases/tag/v1.0.3`);
  assert.equal(result.notes, '');
  assert.equal(options.signal.aborted, false);
});

test('Older, equal, draft, and prerelease versions do not trigger stable updates', async () => {
  for (const release of [
    { tag_name: 'v1.0.1' }, { tag_name: '1.0.2+build.9' },
    { tag_name: '1.1.0-beta.1' }, { tag_name: '1.1.0', prerelease: true }, { tag_name: '1.1.0', draft: true }
  ]) {
    assert.equal((await check('1.0.2', { fetchImpl: fetchRelease(release) })).hasUpdate, false);
  }
});

test('Missing releases are normal and HTTP failures are explained', async () => {
  const empty = await check('1.0.2', { fetchImpl: fetchRelease(null, 404) });
  assert.equal(empty.empty, true);
  assert.equal(empty.hasUpdate, false);
  for (const status of [403, 429]) await assert.rejects(check('1.0.2', { fetchImpl: fetchRelease(null, status) }), /受限/);
  await assert.rejects(check('1.0.2', { fetchImpl: fetchRelease(null, 500) }), /HTTP 500/);
});

test('Malformed JSON and tags fail clearly without trusting release names', async () => {
  await assert.rejects(check('1.0.2', { fetchImpl: fetchRelease({ name: '1.1.0' }) }), /发布版本号无效/);
  await assert.rejects(check('1.0.2', { fetchImpl: fetchRelease(null) }), /发布版本号无效/);
  await assert.rejects(check('1.0.2', { fetchImpl: async () => ({ ...response(null), json: async () => { throw new SyntaxError(); } }) }), /更新信息无效/);
  await assert.rejects(check('1.0.2', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), /网络不可达/);
});

test('Timeout aborts a request stalled before response headers', async () => {
  let signal;
  await assert.rejects(check('1.0.2', { timeoutMs: 15, fetchImpl: async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } }), /超时/);
  assert.equal(signal.aborted, true);
});

test('Timeout also covers a response body that never finishes', async () => {
  let signal;
  await assert.rejects(check('1.0.2', { timeoutMs: 15, fetchImpl: async (_, options) => {
    signal = options.signal;
    return { ...response(null), json: async () => new Promise(() => {}) };
  } }), /超时/);
  assert.equal(signal.aborted, true);
});
