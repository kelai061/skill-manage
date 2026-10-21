'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { check, parseVer, REPO } = require('./updater');

const MAX_DOWNLOAD = 1024 * 1024 * 1024;

function installation({ packaged, platform, env, executable, resources }) {
  if (!packaged || platform !== 'win32') return { mode: 'unsupported', target: '' };
  if (env.PORTABLE_EXECUTABLE_FILE) return { mode: 'portable', target: path.resolve(env.PORTABLE_EXECUTABLE_FILE) };
  if (fs.existsSync(path.join(resources, 'PORTABLE.txt'))) return { mode: 'directory', target: path.dirname(executable) };
  return { mode: 'setup', target: path.dirname(executable) };
}

function selectAsset(info, mode) {
  if (!parseVer(info?.latest) || !info.hasUpdate) throw new Error('没有可安装的新版本。');
  const names = {
    setup: `SkillAtelier-Setup-${info.latest}.exe`,
    portable: `SkillAtelier-${info.latest}.exe`,
    directory: `SkillAtelier-${info.latest}-win-x64.zip`
  };
  const name = names[mode];
  const asset = info.assets?.find((item) => item.name === name);
  if (!name) throw new Error('请在 Windows 正式版中使用应用内更新。');
  if (!asset || !info.assets.some((item) => item.name === 'SHA256SUMS.txt')) throw new Error('新版更新包尚未就绪，请稍后重试。');
  if (!(asset.size > 0 && asset.size <= MAX_DOWNLOAD)) throw new Error('更新包大小无效。');
  return asset;
}

function downloadUrl(info, name) {
  if (!parseVer(info.tag) || /[\\/]/.test(name)) throw new Error('更新附件无效。');
  return `https://github.com/${REPO}/releases/download/${encodeURIComponent(info.tag)}/${encodeURIComponent(name)}`;
}

function expectedHash(manifest, name) {
  const hashes = String(manifest).split(/\r?\n/).map((line) => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i))
    .filter((match) => match && match[2] === name).map((match) => match[1].toLowerCase());
  if (hashes.length !== 1) throw new Error('更新包校验信息缺失或重复。');
  return hashes[0];
}

async function receive(fetchImpl, url, { signal, limit, destination, progress }) {
  const response = await fetchImpl(url, { signal, headers: { 'User-Agent': 'SkillAtelier' } });
  if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）。`);
  const reader = response.body.getReader();
  let size = 0;
  let fd;
  const chunks = [];
  const hash = crypto.createHash('sha256');
  try {
    if (destination) fd = fs.openSync(destination, 'wx');
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (signal.aborted) throw new Error('下载已取消。');
      size += value.byteLength;
      if (size > limit) throw new Error('更新文件大小超过限制。');
      const bytes = Buffer.from(value);
      hash.update(bytes);
      if (fd !== undefined) {
        let offset = 0;
        while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
      } else chunks.push(bytes);
      if (progress) progress(size);
    }
    return { size, hash: hash.digest('hex'), text: destination ? '' : Buffer.concat(chunks).toString('utf8') };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    await reader.cancel().catch(() => {});
  }
}

function createManager(options) {
  const { current, directory, mode, target, fetchImpl, quit, parentPid = process.pid } = options;
  let info = null;
  let ready = null;
  let controller = null;
  let transfer = null;
  let preparing = false;
  let state = { stage: 'idle', received: 0, total: 0, percent: 0, version: '', error: '', mode };
  const resultFile = path.join(directory, 'result.json');
  try {
    const previous = JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, ''));
    if (previous.success === false) state = { ...state, stage: 'error', error: '上次更新未完成，请重试。' };
  } catch { /* first run */ }
  const status = () => ({ ...state });
  const set = (patch) => { state = { ...state, ...patch }; };
  const checkUpdate = async () => {
    if ((transfer || ready) && info) return { ...info, canInstall: mode !== 'unsupported' };
    info = await check(current, { fetchImpl });
    return { ...info, canInstall: mode !== 'unsupported' };
  };

  async function download() {
    if (transfer || state.stage === 'installing' || ready) return status();
    const release = info;
    const asset = selectAsset(release, mode);
    fs.mkdirSync(directory, { recursive: true });
    const job = fs.mkdtempSync(path.join(directory, 'download-'));
    const file = path.join(job, asset.name);
    controller = new AbortController();
    const signal = controller.signal;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller?.abort(); }, options.timeoutMs || 10 * 60 * 1000);
    set({ stage: 'downloading', version: release.latest, received: 0, total: asset.size, percent: 0, error: '' });
    transfer = (async () => {
      try {
        const manifest = await receive(fetchImpl, downloadUrl(release, 'SHA256SUMS.txt'), { signal, limit: 65536 });
        const checksum = expectedHash(manifest.text, asset.name);
        const downloaded = await receive(fetchImpl, downloadUrl(release, asset.name), {
          signal, limit: asset.size, destination: file,
          progress: (size) => set({ received: size, percent: Math.min(99, Math.floor(size / asset.size * 100)) })
        });
        if (signal.aborted) throw new Error('下载已取消。');
        set({ stage: 'verifying' });
        if (downloaded.size !== asset.size || downloaded.hash !== checksum) throw new Error('更新包校验失败，请重新下载。');
        ready = { file, checksum, job, version: release.latest };
        set({ stage: 'ready', percent: 100 });
      } catch (error) {
        // job is the exact directory created above; no caller-supplied deletion path.
        try { fs.rmSync(job, { recursive: true, force: true }); } catch { /* preserve failed download for later cleanup */ }
        set({ stage: signal.aborted && !timedOut ? 'cancelled' : 'error',
          error: timedOut ? '下载超时，请重试。' : signal.aborted ? '' : (error.message || '下载失败，请重试。') });
      } finally {
        clearTimeout(timer);
        controller = null;
        transfer = null;
      }
    })();
    return status();
  }

  async function install() {
    if (preparing || state.stage === 'installing') return status();
    if (!ready || state.stage !== 'ready') throw new Error('请先完成更新包下载。');
    if (options.canInstall === false) throw new Error('当前测试环境不允许安装更新。');
    preparing = true;
    set({ stage: 'preparing' });
    try {
    const { file, job, checksum, version } = ready;
    // Recheck immediately before handing off to the external installer.
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== checksum) {
      ready = null;
      set({ stage: 'error', error: '更新包已变化，请重新下载。' });
      throw new Error(state.error);
    }
    const script = path.join(job, 'apply-update.ps1');
    fs.copyFileSync(path.join(__dirname, 'apply-update.ps1'), script);
    const payload = { mode, target, file, checksum, version, parentPid, job,
      result: path.join(directory, 'result.json'), armed: path.join(job, 'armed') };
    // Each handoff must obtain a fresh acknowledgement, including after a retry.
    if (fs.existsSync(payload.armed)) fs.unlinkSync(payload.armed);
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
    const windows = options.windows || process.env.SystemRoot || process.env.WINDIR;
    if (!windows) throw new Error('找不到 Windows 更新组件。');
    const executable = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const launch = options.spawnImpl || spawn;
    const child = launch(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Payload', encoded],
      { detached: true, windowsHide: true, stdio: 'ignore' });
    let launchError;
    child.once('error', (error) => { launchError = error; });
    try {
      const started = Date.now();
      while (!fs.existsSync(payload.armed)) {
        if (launchError) throw launchError;
        if (child.exitCode !== null && child.exitCode !== undefined) throw new Error('更新程序准备失败，请重试。');
        if (Date.now() - started > 120000) throw new Error('更新程序准备超时，请重试。');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      child.kill();
      throw error;
    }
    child.unref();
    set({ stage: 'installing' });
    // Let the IPC response reach the UI before closing the application.
    setTimeout(quit, 250);
    return status();
    } catch (error) {
      if (error.code === 'ENOENT') {
        ready = null;
        set({ stage: 'error', error: '更新包已丢失，请重新下载。' });
      } else if (ready) set({ stage: 'ready' });
      throw error;
    } finally { preparing = false; }
  }

  return { check: checkUpdate, status, download, install,
    cancel: () => { controller?.abort(); return status(); },
    // Tests await the actual transfer instead of polling progress.
    waitForDownload: () => transfer };
}

module.exports = { installation, selectAsset, downloadUrl, expectedHash, receive, createManager };
