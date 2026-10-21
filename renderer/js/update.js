/* update.js — 联网自动检查更新 + 顶栏提示条 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, fmtDate } from './util.js';
import { dialog, toast } from './ui.js';
import { icon } from './icons.js';

const CHECK_INTERVAL = 12 * 3600 * 1000; // 同一台机器 12 小时内不重复请求

/**
 * 启动时静默检查一次：有新版就在顶栏挂一条提示，没有就当无事发生。
 * 失败不弹错——更新检查不该打断使用。
 */
export async function maybeAutoCheck() {
  if (window.atelier && window.atelier.automated) return;
  const u = (state.config.settings && state.config.settings.update) || {};
  if (u.auto === false) return;
  if (Date.now() - Number(u.lastCheckAt || 0) < CHECK_INTERVAL) return;

  try {
    const r = await api.checkUpdate();
    await api.patchConfig({ settings: { update: { lastCheckAt: Date.now() } } });
    if (r.hasUpdate) showUpdateBar(r);
  } catch {
    /* 静默：离线 / 限流 / 仓库没发布都不打扰 */
  }
}

/** 顶栏下方一条窄提示条 */
export function showUpdateBar(info) {
  if (document.getElementById('updateBar')) return;
  const header = document.querySelector('.appbar');
  if (!header) return;

  const bar = document.createElement('div');
  bar.id = 'updateBar';
  bar.className = 'updatebar';
  bar.innerHTML = `
    <span class="updatebar__text">${icon('sparkles', 'icon--sm')}
      发现新版本 <b>v${esc(info.latest)}</b><span class="updatebar__cur">当前 v${esc(info.current)}</span>
    </span>
    <button class="btn btn--text btn--sm" data-see>查看更新</button>
    <button class="iconbtn iconbtn--sm" data-dismiss aria-label="关闭">${icon('x')}</button>`;

  header.after(bar);
  bar.querySelector('[data-see]').addEventListener('click', () => openUpdateDialog(info));
  bar.querySelector('[data-dismiss]').addEventListener('click', () => bar.remove());
}

/** 更新详情对话框（设置页与顶栏提示共用） */
export function openUpdateDialog(r) {
  let latestStatus = { stage: 'idle' };
  let polling = false;
  const d = dialog({
    title: r.hasUpdate ? `发现新版本 v${r.latest}` : '已是最新版本',
    subtitle: `当前 v${r.current}${r.publishedAt ? ' · 发布 ' + fmtDate(new Date(r.publishedAt).getTime()) : ''}`,
    body: `
      <p style="margin:0 0 10px">${r.hasUpdate
        ? r.canInstall === false ? '请在 Windows 正式版中使用应用内更新。' : '下载完成后重启更新，保留现有数据。'
        : '没有检测到更新的正式版本。'}</p>
      ${r.hasUpdate && r.notes ? `<pre class="muted" style="white-space:pre-wrap;font:var(--type-body-s);margin:0 0 14px">${esc(r.notes)}</pre>` : ''}
      ${r.hasUpdate ? '<div data-update-progress role="status" aria-live="polite"></div>' : ''}`,
    actions: r.hasUpdate
      ? [
        { label: '稍后', kind: 'text' },
        { label: '取消下载', ref: 'cancel', keepOpen: true, onClick: async () => { await api.cancelUpdate(); return false; } },
        { label: '下载更新', ref: 'primary', kind: 'filled', disabled: r.canInstall === false, keepOpen: true,
          onClick: async () => {
            try {
              if (latestStatus.stage === 'ready') {
                d.primary.textContent = '正在准备…';
                d.primary.disabled = true;
                latestStatus = await api.installUpdate();
              } else latestStatus = await api.downloadUpdate();
              renderStatus();
            } catch (error) { toast(error.message, 'error'); }
            setTimeout(() => { if (d.root.isConnected) renderStatus(); }, 0);
            return false;
          } }
      ]
      : [{ label: '知道了', kind: 'text' }]
  });
  if (!r.hasUpdate) return d;
  d.cancel.style.display = 'none';
  function renderStatus() {
    const s = latestStatus;
    const active = ['downloading', 'verifying', 'preparing', 'installing'].includes(s.stage);
    const progress = d.body.querySelector('[data-update-progress]');
    const mb = (n) => (Number(n || 0) / 1048576).toFixed(1);
    const labels = { downloading: `正在下载 ${s.percent || 0}% · ${mb(s.received)} / ${mb(s.total)} MB`,
      verifying: '正在校验…', ready: '下载完成，可以重启更新。', preparing: '正在准备更新…', installing: '正在重启更新…',
      cancelled: '已取消下载。', error: s.error || '更新失败，请重试。' };
    progress.innerHTML = `${active ? `<progress max="100" value="${Number(s.percent) || 0}" style="width:100%;accent-color:var(--md-primary)"></progress>` : ''}
      <span style="font:var(--type-body-s);${s.stage === 'error' ? 'color:var(--md-error)' : ''}">${esc(labels[s.stage] || '')}</span>`;
    d.cancel.style.display = ['downloading', 'verifying'].includes(s.stage) ? '' : 'none';
    d.primary.textContent = s.stage === 'ready' ? '重启并更新' : active ? (s.stage === 'preparing' ? '正在准备…' : '更新中…') : s.stage === 'error' ? '重新下载' : '下载更新';
    d.primary.disabled = active || r.canInstall === false;
  }
  async function poll() {
    if (polling || !d.root.isConnected) return;
    polling = true;
    try { latestStatus = await api.updateStatus(); if (d.root.isConnected) renderStatus(); }
    catch { /* Keep the dialog usable if the app is already restarting. */ }
    finally { polling = false; }
  }
  poll();
  const timer = setInterval(poll, 600);
  d.closed.then(() => clearInterval(timer));
  return d;
}

/* 自动化验收注入口：直接挂一条更新提示，不依赖真实接口 */
if (typeof window !== 'undefined') {
  window.__atelierDebug = Object.assign(window.__atelierDebug || {}, { showUpdate: showUpdateBar });
}
