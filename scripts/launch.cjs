'use strict';
/**
 * launch.cjs — 启动器
 *
 * 存在的唯一理由：某些终端（例如另一个 Electron 应用内嵌的 shell）会带着
 * ELECTRON_RUN_AS_NODE=1 这个环境变量，此时 electron.exe 会退化成纯 Node，
 * 表现是「Electron failed to install correctly / fetch failed」。
 * 这里把它清掉再拉起来，避免用户面对一个莫名其妙的报错。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
let bin;
try {
  bin = require('electron'); // 正常返回可执行文件路径
} catch (e) {
  console.error('\n找不到 Electron 运行时。请先执行：npm install\n');
  console.error(String(e.message).split('\n')[0]);
  process.exit(1);
}

if (typeof bin !== 'string' || !fs.existsSync(bin)) {
  console.error('\nElectron 运行时缺失，请重新安装依赖：rm -rf node_modules && npm install\n');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const args = ['.', ...process.argv.slice(2)];
const child = spawn(bin, args, { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
