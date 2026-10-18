'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { resolveAsset } = require('../main/assetProtocol');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-assets-'));
try {
  for (const dir of ['renderer', 'shared', 'main']) fs.mkdirSync(path.join(root, dir));
  for (const file of ['renderer/index.html', 'shared/align.mjs', 'main/store.js', 'package.json']) fs.writeFileSync(path.join(root, file), 'fixture');
  assert.equal(resolveAsset(root, '/index.html'), path.join(root, 'renderer/index.html'));
  assert.equal(resolveAsset(root, '/shared/align.mjs'), path.join(root, 'shared/align.mjs'));
  for (const url of ['/../main/store.js', '/%2e%2e/main/store.js', '/shared/../main/store.js', '/%2e%2e/package.json', '/%zz', '/shared', '/%00', '/..%5cmain%5cstore.js']) assert.equal(resolveAsset(root, url), null, url);
  console.log('[PASS] public assets and encoded traversal/malformed path boundaries (10 assertions)');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
