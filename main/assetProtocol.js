'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only these two public trees may be served to the sandboxed renderer.
function resolveAsset(root, urlPath) {
  let clean;
  try { clean = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, ''); }
  catch { return null; }
  if (clean.includes('\0') || clean.includes('\\')) return null;
  const shared = clean.startsWith('shared/');
  const base = path.join(root, shared ? 'shared' : 'renderer');
  const target = path.resolve(base, shared ? clean.slice('shared/'.length) : clean);
  const inside = (parent, file) => {
    const rel = path.relative(parent, file);
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  };
  if (!inside(base, target)) return null;
  try {
    if (!fs.statSync(target).isFile()) return null;
    if (!inside(fs.realpathSync(base), fs.realpathSync(target))) return null;
    return target;
  } catch { return null; }
}

module.exports = { resolveAsset };
