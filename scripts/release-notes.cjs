'use strict';
const fs = require('node:fs');
const path = require('node:path');
function releaseNotes(root = path.join(__dirname, '..')) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const sections = changelog.split(/^## /m);
  const section = sections.find((item) => item.startsWith(`v${version} `));
  if (!section) throw new Error('缺少当前版本更新说明');
  return section.split(/\r?\n/).slice(1).join('\n').trim() + '\n';
}
if (require.main === module) {
  const destination = path.join(__dirname, '..', '.cache', 'release-notes.md');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, releaseNotes());
}
module.exports = { releaseNotes };
