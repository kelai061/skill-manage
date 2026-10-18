'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { releasePaths, validatePackage, verifyPortable, verifyCurrent, writeChecksums, assertInside } = require('./release-utils.cjs');

function packRelease(root = path.join(__dirname, '..')) {
  const { version } = validatePackage(root);
  const { portable, build, current } = releasePaths(root, version);
  verifyPortable(portable, version);
  verifyCurrent(root, version);
  fs.mkdirSync(current, { recursive: true });
  const name = `SkillAtelier-${version}-win-x64.zip`;
  const temporary = path.join(build, `${name}.tmp-${process.pid}`);
  assertInside(build, temporary);
  if (fs.existsSync(temporary)) throw new Error('压缩临时文件已存在，已中止。');
  try {
    // Values are passed through the environment so paths containing quotes are safe.
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:SKILL_ATELIER_ZIP_SOURCE, $env:SKILL_ATELIER_ZIP_DESTINATION, [System.IO.Compression.CompressionLevel]::Optimal, $true)"
    ], { stdio: 'inherit', env: { ...process.env, SKILL_ATELIER_ZIP_SOURCE: portable, SKILL_ATELIER_ZIP_DESTINATION: temporary } });
    if (result.error || result.status !== 0) throw new Error('绿色版压缩失败，请检查 PowerShell 是否可用。');
    const output = assertInside(current, path.join(current, name));
    if (fs.existsSync(output)) fs.unlinkSync(output);
    fs.renameSync(temporary, output);
    writeChecksums(root, version);
    return output;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

if (require.main === module) {
  try { console.log(`可分享的压缩包：${packRelease()}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { packRelease };
