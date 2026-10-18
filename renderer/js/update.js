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
  if (!u.repo || u.auto === false) return;
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
  dialog({
    title: r.hasUpdate ? `发现新版本 v${r.latest}` : '已是最新版本',
    subtitle: `当前 v${r.current}${r.publishedAt ? ' · 发布 ' + fmtDate(new Date(r.publishedAt).getTime()) : ''}`,
    wide: true,
    body: `
      <p style="margin:0 0 10px">${r.hasUpdate
        ? '到发布页下载新的绿色版，解压后替换旧目录即可（配置在用户数据目录，不会被覆盖）。'
        : '没有检测到比当前更新的正式版本。'}</p>
      ${r.notes ? `<pre class="muted" style="white-space:pre-wrap;font:var(--type-body-s);max-height:240px;overflow:auto;margin:0">${esc(r.notes)}</pre>` : ''}`,
    actions: r.hasUpdate
      ? [
        { label: '稍后', kind: 'text' },
        { label: '打开发布页', kind: 'filled', onClick: () => api.openUpdate(r.url).catch((e) => toast(e.message, 'error')) }
      ]
      : [{ label: '知道了', kind: 'text' }]
  });
}

/* 自动化验收注入口：直接挂一条更新提示，不依赖真实接口 */
if (typeof window !== 'undefined') {
  window.__atelierDebug = Object.assign(window.__atelierDebug || {}, { showUpdate: showUpdateBar });
}
