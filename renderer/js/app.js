/* app.js — 外壳：导航、主题、路由 */

import { state, reload, subscribe, notify, products, refresh } from './state.js';
import { api } from './api.js';
import { icon } from './icons.js';
import { esc, debounce } from './util.js';
import { toast, initTooltips } from './ui.js';
import { renderSkills } from './views/skills.js';
import { renderGroups } from './views/groups.js';
import { renderCombos } from './views/combos.js';
import { renderProducts } from './views/products.js';
import { renderStaging } from './views/staging.js';
import { renderSettings } from './views/settings.js';
import { closeReader } from './views/reader.js';
import { maybeOnboard } from './onboarding.js';
import { maybeAutoCheck } from './update.js';

const NAV = [
  { id: 'skills', label: '全部 Skill', icon: 'grid', title: '全部 Skill' },
  { id: 'groups', label: '分组', icon: 'folder', title: '分组' },
  { id: 'combos', label: '组合', icon: 'layers', title: '组合' },
  { id: 'staging', label: '暂存', icon: 'zap', title: '暂存区 · 导入与归位' },
  { id: 'products', label: '产品', icon: 'cpu', title: '智能体产品' },
  { id: 'settings', label: '设置', icon: 'settings', title: '设置' }
];

let lastReason = 'init';

/* ------------------------------ 主题 ------------------------------ */

function effectiveTheme(t) {
  if (t === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return t === 'dark' ? 'dark' : 'light';
}

export function applyTheme(t) {
  const eff = effectiveTheme(t);
  const root = document.documentElement;
  root.classList.add('theme-anim');
  root.dataset.theme = eff;
  setTimeout(() => root.classList.remove('theme-anim'), 260);

  const color = eff === 'dark' ? '#141218' : '#FEF7FF';
  const symbol = eff === 'dark' ? '#E6E0E9' : '#1D1B20';
  api.applyTheme(color, symbol).catch(() => {});

  const btn = document.getElementById('themeToggle');
  if (btn) btn.innerHTML = icon(eff === 'dark' ? 'sun' : 'moon');
}

window.__applyTheme = applyTheme;

/* ------------------------------ 导航 ------------------------------ */

function buildRail() {
  const nav = document.getElementById('railNav');
  nav.innerHTML = NAV.map((n) => `
    <button class="rail__item" data-view="${n.id}" aria-selected="${state.view === n.id}">
      <span class="rail__pill">${icon(n.icon, 'icon--lg')}</span>
      <span class="rail__label">${esc(n.label)}</span>
    </button>`).join('');

  nav.querySelectorAll('[data-view]').forEach((b) => {
    b.addEventListener('click', () => go(b.dataset.view));
  });
}

export function go(view) {
  if (!NAV.some((n) => n.id === view)) return;
  state.view = view;
  state.selection.clear();
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.view === view));
  });
  lastReason = 'view';
  render();
}

window.__goto = go;
/** 供自动化验收使用：外部改了配置后强制重读并重绘 */
window.__refreshAll = async () => { await refresh('data'); };

/* ------------------------------ 渲染 ------------------------------ */

function render() {
  const canvas = document.getElementById('canvas');
  const meta = NAV.find((n) => n.id === state.view);
  document.getElementById('pageTitle').textContent = meta ? meta.title : '';

  const copyBtn = document.getElementById('copyPathsBtn');
  if (copyBtn) copyBtn.classList.remove('hidden');
  const sub = document.getElementById('pageSub');
  const searchBox = document.getElementById('searchBox');
  searchBox.classList.toggle('hidden', state.view !== 'skills');
  sub.textContent = state.view === 'skills'
    ? `${state.config.skills.length} 个 skill · ${products().length} 个产品`
    : '';

  const keep = canvas.scrollTop;
  canvas.innerHTML = '';

  try {
    switch (state.view) {
      case 'skills': renderSkills(canvas); break;
      case 'groups': renderGroups(canvas); break;
      case 'combos': renderCombos(canvas); break;
      case 'staging': renderStaging(canvas); break;
      case 'products': renderProducts(canvas); break;
      case 'settings': renderSettings(canvas); break;
      default: renderSkills(canvas);
    }
  } catch (e) {
    canvas.innerHTML = `<div class="empty"><div class="empty__icon">${icon('alert')}</div>
      <h3>渲染出错</h3><p>${esc(e.message)}</p></div>`;
    console.error(e);
  }

  if (lastReason === 'selection' || lastReason === 'data' || lastReason === 'filter') {
    canvas.scrollTop = keep;
  }
}

/* ------------------------------ 搜索 ------------------------------ */

const onSearch = debounce((v) => {
  state.query = v;
  lastReason = 'filter';
  render();
}, 200);

/* ------------------------------ 启动 ------------------------------ */

async function boot() {
  buildRail();
  initTooltips();

  try {
    await reload();
  } catch (e) {
    document.body.innerHTML = `<div class="empty" style="height:100vh">
      <div class="empty__icon">${icon('alert')}</div>
      <h3>无法读取本地配置</h3><p>${esc(e.message)}</p></div>`;
    return;
  }

  applyTheme(state.config.settings.theme || 'light');
  document.getElementById('themeToggle').innerHTML =
    icon(effectiveTheme(state.config.settings.theme) === 'dark' ? 'sun' : 'moon');

  // 首次使用：直接落到「产品」页引导登记路径
  if (!products().length) state.view = 'products';
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.view === state.view));
  });

  subscribe((reason) => {
    lastReason = reason || 'data';
    if (state.view === 'settings' && lastReason === 'data') {
      // 设置页自行维护输入焦点，整体重绘会打断输入
      return;
    }
    render();
  });

  render();

  /* 搜索框 */
  const input = document.getElementById('searchInput');
  input.addEventListener('input', (e) => onSearch(e.target.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; onSearch(''); input.blur(); }
  });

  /* 顶栏按钮 */
  document.getElementById('themeToggle').addEventListener('click', async () => {
    const order = ['light', 'dark', 'system'];
    const cur = state.config.settings.theme || 'light';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    await api.patchConfig({ settings: { theme: next } });
    await reload();
    applyTheme(next);
    toast(next === 'system' ? '主题：跟随系统' : next === 'dark' ? '主题：深色' : '主题：浅色', '', { duration: 1600 });
  });

  /* 复制给智能体：软件目录 + 引导语（清单由主进程随索引自动生成） */
  document.getElementById('copyPathsBtn').addEventListener('click', async () => {
    try {
      const r = await api.copyBrief();
      toast(`已复制软件目录与引导语 · 清单里 ${r.count} 个 skill`, 'success', { duration: 2600 });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('refreshBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      let added = 0;
      for (const p of products()) {
        const r = await api.rescan(p.id);
        added += r.added;
      }
      await reload();
      notify('data');
      toast(products().length ? `索引已刷新，新增 ${added} 个 skill` : '还没有登记产品', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = icon('refresh');
    }
  });

  /* 滚动时给顶栏加分隔线 */
  const canvas = document.getElementById('canvas');
  canvas.addEventListener('scroll', () => {
    document.querySelector('.appbar').classList.toggle('is-scrolled', canvas.scrollTop > 8);
  }, { passive: true });

  /* 快捷键 */
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state.view !== 'skills') go('skills');
      setTimeout(() => document.getElementById('searchInput')?.focus(), 30);
    }
    if (e.key === 'Escape') {
      const reader = document.getElementById('readerRoot');
      if (reader) { closeReader(); e.stopPropagation(); }
    }
  });

  /* 跟随系统主题变化 */
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((state.config.settings.theme || 'light') === 'system') applyTheme('system');
  });

  /* 首次启动：探测工具 + 新手教程（自动化模式下自动跳过） */
  setTimeout(() => { maybeOnboard().catch((e) => console.warn('[onboard]', e.message)); }, 600);
  setTimeout(() => { maybeAutoCheck().catch(() => {}); }, 2500);
}

boot();
