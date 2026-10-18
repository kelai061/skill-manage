'use strict';
/**
 * main.js — 主进程入口
 *
 * 隔离设计：
 *   - 渲染进程 sandbox + contextIsolation，无 Node 能力
 *   - 页面通过自定义 app:// 协议加载，ES Module 可用，且只暴露 renderer/ 与 shared/
 *   - 一切文件系统 / 网络 / 剪贴板能力都走 preload 白名单
 */

const { app, BrowserWindow, protocol, net, shell, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const { resolveAsset } = require('./assetProtocol');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
]);

let mainWindow = null;

/* ---------------------------------------------------------------- */
/* 无人值守模式：隔离 profile + 场景脚本（给自动化测试用）             */
/* ---------------------------------------------------------------- */

const profileArg = process.argv.find((a) => a.startsWith('--profile='));
const scenarioArg = process.argv.find((a) => a.startsWith('--scenario='));
const shotMode = process.argv.includes('--shot');
const isAutomated = !!scenarioArg || shotMode;

if (isAutomated && !profileArg) {
  throw new Error('自动化验证必须指定独立的 --profile 目录。');
}

if (profileArg) {
  // 测试隔离：把 userData 指到临时目录，绝不碰用户真实配置
  const dir = path.resolve(profileArg.slice('--profile='.length));
  fs.mkdirSync(dir, { recursive: true });
  app.setPath('userData', dir);
} else if (app.isPackaged) {
  /**
   * 打包态的数据落点，按安装形态分两种：
   *
   *   便携版（PORTABLE_EXECUTABLE_DIR 存在）→ 双击的那个 exe 旁边的 SkillAtelier-data\
   *     （electron-builder portable 会把程序解压到临时目录运行，所以不能看 execPath）
   *
   *   安装版 → %LOCALAPPDATA%\SkillAtelier\data\
   *     为什么不放在安装目录：卸载器会把 $INSTDIR 整个删掉，用户的配置、译文、
   *     标记会跟着一起没。放在 LocalAppData 里，卸载重装后数据还在。
   *
   * 硬保证：任何一档都不等于开发态的 %APPDATA%\Skill Atelier\。
   * 否则同一台机器上打开分发包，看到的会是开发者的产品列表与 API Key。
   */
  const portableBase = process.env.PORTABLE_EXECUTABLE_DIR ||
    (fs.existsSync(path.join(process.resourcesPath, 'PORTABLE.txt')) ? path.dirname(process.execPath) : '');
  const candidates = [];
  if (portableBase && fs.existsSync(portableBase)) {
    candidates.push(path.join(portableBase, 'SkillAtelier-data'));
  }
  const localRoot = process.env.LOCALAPPDATA || (process.env.APPDATA ? path.join(process.env.APPDATA, '..', 'Local') : '');
  if (localRoot) candidates.push(path.join(localRoot, 'SkillAtelier', 'data'));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'SkillAtelier', 'data'));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 目录存在不代表可写，用一次真实写入探活
      const probe = path.join(dir, '.write-probe');
      fs.writeFileSync(probe, '1');
      fs.unlinkSync(probe);
      app.setPath('userData', dir);
      break;
    } catch {
      /* 换下一个落点 */
    }
  }
}

// Two writers sharing one profile can silently overwrite each other's edits.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

if (isAutomated) {
  // 无 GPU / 双实例 / 沙箱受限时硬渲染会把进程直接打崩，测试环境统一走软渲染
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('no-sandbox');
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 660,
    backgroundColor: '#FEF7FF',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#FEF7FF',
      symbolColor: '#1D1B20',
      height: 64
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
      additionalArguments: isAutomated ? ['--atelier-automated'] : []
    }
  });

  Menu.setApplicationMenu(null);

  // 自动化模式关掉后台节流，否则窗口一被遮挡，计时器与渲染都会被降频
  if (isAutomated) mainWindow.webContents.setBackgroundThrottling(false);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadURL('app://local/index.html');

  // 外链一律交给系统浏览器，绝不在客户端内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // 开发期把渲染进程的日志转发到终端，方便排查
  if (process.argv.includes('--dev') || isAutomated) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('[load-fail]', code, desc, url);
    });
  }

  /* 场景脚本：把窗口交给一个 Node 模块驱动，跑完即退出 */
  if (scenarioArg) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await delay(1400);
      let code = 0;
      const logFile = path.join(app.getPath('userData'), 'scenario.log');
      const log = (m) => {
        try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`); } catch { /* ignore */ }
      };
      log('scenario start: ' + scenarioArg);
      try {
        const file = path.resolve(scenarioArg.slice('--scenario='.length));
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const mod = require(file);
        const run = typeof mod === 'function' ? mod : mod.run;
        const res = await run({ win: mainWindow, app, delay, shot, log });
        log('scenario done: ' + JSON.stringify(res && res.summary));
        if (res && res.ok === false) code = 1;
      } catch (e) {
        log('scenario FAILED: ' + ((e && e.stack) || e));
        console.error('[scenario] failed:', (e && e.stack) || e);
        code = 1;
      }
      app.exit(code);
    });
  }

  // 截图模式：用于无人值守的界面自检（旧入口，保留兼容）
  if (shotMode && !scenarioArg) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const clickArg = process.argv.find((a) => a.startsWith('--shot-click='));
          const waitArg = process.argv.find((a) => a.startsWith('--shot-wait='));
          const wait = waitArg ? Number(waitArg.split('=')[1]) : 1800;
          if (clickArg) {
            const selectors = clickArg.slice('--shot-click='.length).split('|');
            for (const sel of selectors) {
              await mainWindow.webContents.executeJavaScript(
                `(function(){const el=document.querySelector(${JSON.stringify(sel)});if(el)el.click();return !!el;})()`
              );
              await delay(wait);
            }
          }
          const evalArg = process.argv.find((a) => a.startsWith('--shot-eval='));
          if (evalArg) {
            const code = evalArg.slice('--shot-eval='.length);
            try {
              const r = await mainWindow.webContents.executeJavaScript(code);
              console.log('[eval]', JSON.stringify(r));
            } catch (e) {
              console.error('[eval] failed', e.message);
            }
          }
          await shot('shot');
        } catch (e) {
          console.error('[shot] failed', e.message);
        }
        app.quit();
      }, 2600);
    });
  }
}

/** 强制走两帧再截图，避免软渲染下拿到上一帧的陈旧画面 */
async function shot(name = 'shot') {
  try {
    // rAF 在窗口被遮挡时会暂停，加超时兜底，别把整个验收挂死
    await Promise.race([
      mainWindow.webContents.executeJavaScript(
        'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))'
      ),
      delay(800)
    ]);
    if (typeof mainWindow.webContents.invalidate === 'function') mainWindow.webContents.invalidate();
  } catch { /* ignore */ }
  await delay(360);
  const img = await mainWindow.capturePage();
  const out = profileArg
    ? path.join(app.getPath('userData'), 'shots', `${name}.png`)
    : path.join(ROOT, 'docs', 'shots', `${name}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log('[shot]', out);
  return out;
}

app.whenReady().then(() => {
  if (!hasInstanceLock) return;
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const target = resolveAsset(ROOT, url.pathname === '/' ? '/index.html' : url.pathname);
    if (!target) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(target).href);
  });

  require('./ipc').register();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
