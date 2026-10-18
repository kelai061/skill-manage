/* views/reader.js — 阅读器：美化排版 · 双语对照 · 标记 · 朗读 */

import { icon } from '../icons.js';
import { state, skillById, productName, refresh } from '../state.js';
import { api } from '../api.js';
import { esc, shortPath, pickLang } from '../util.js';
import { toast, dialog, menu, confirm } from '../ui.js';
import { renderProse, outline } from '../md.js';
import { segmentMarkdown } from '../../../shared/mdseg.mjs';
import { resolveSelection } from '../../../shared/align.mjs';
import { virtualText, offsetAt, rangeFromVirtual, rangeFromPlainOffsets } from '../domtext.js';
import { openAiRewrite } from '../ai-dialog.js';

const HL_NAMES = ['mark-1', 'mark-2', 'mark-3', 'mark-4'];
const HL_COLORS = ['#FFC857', '#7BD389', '#7FB2FF', '#FF8FA3'];

let cur = null;
let hlSupported = false;
/**
 * 全局单调递增的上下文令牌。
 * 不能用「每个 cur 从 0 数」—— A 文档和 B 文档都会数到 1，晚到的 A 响应
 * 就会被当成 B 的合法响应。全局只增不减才真正唯一。
 */
let epochSeq = 0;

/* ============================== 入口 ============================== */

export async function openReader(id, opts = {}) {
  closeReader();

  const skill = skillById(id);
  if (!skill) { toast('skill 索引已失效，请重新扫描', 'error'); return; }

  const r = state.config.settings.reader;
  hlSupported = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';

  cur = {
    skill,
    mode: opts.mode || r.mode || 'off',
    spacing: !!r.spacing,
    fontSize: r.fontSize || 16,
    measure: r.measure || 720,
    tocOpen: r.toc !== false,
    content: '',
    blocks: [],
    translations: null,
    align: null,
    alignLoading: false,
    loadingTr: false,
    trPromise: null,
    /** 上下文令牌：换文件 / 重开阅读器就 +1，晚到的响应一律丢弃 */
    epoch: 0,
    annotations: [],
    files: [],
    activeFile: skill.path,
    speaking: false,
    utter: null
  };

  buildShell();
  await loadContent(skill.path, skill.name);
  loadFiles();
  loadAnnotations();
}

export function closeReader() {
  if (cur && window.speechSynthesis) speechSynthesis.cancel();
  const node = document.getElementById('readerRoot');
  if (node) node.remove();
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    for (const n of [...HL_NAMES, 'sync']) CSS.highlights.delete(n);
  }
  document.removeEventListener('selectionchange', onSelectionChange);
  window.removeEventListener('resize', scheduleMap);
  if (rootObserver) { rootObserver.disconnect(); rootObserver = null; }
  clearTimeout(syncTimer);
  clearTimeout(mapTimer);
  alignMap = null;
  document.querySelectorAll('.seltool').forEach((n) => n.remove());
  document.querySelectorAll('.wordtip').forEach((n) => n.remove());
  cur = null;
}

/* ============================== 骨架 ============================== */

function buildShell() {
  const s = cur.skill;
  const root = document.createElement('div');
  root.className = 'reader';
  root.id = 'readerRoot';
  root.style.setProperty('--reader-fs', cur.fontSize + 'px');
  root.style.setProperty('--measure', cur.measure + 'px');

  root.innerHTML = `
    <div class="reader__bar">
      <button class="iconbtn" id="rBack" data-tip="返回">${icon('back')}</button>
      <div class="reader__title">
        <strong>${esc(s.name)}</strong>
        <span id="rSub">${esc(productName(s.productId))} · ${esc(shortPath(s.dir, 52))}</span>
      </div>
      <div class="reader__tools">
        <div class="segmented segmented--sm" id="modeSeg">
          <button class="segmented__item" data-mode="off" aria-pressed="${cur.mode === 'off'}">原文</button>
          <button class="segmented__item" data-mode="side" aria-pressed="${cur.mode === 'side'}">${icon('columns', 'icon--sm')}并排</button>
          <button class="segmented__item" data-mode="interlinear" aria-pressed="${cur.mode === 'interlinear'}">${icon('rows', 'icon--sm')}行间</button>
        </div>
        <button class="iconbtn" id="spacingBtn" data-tip="译文词间距" aria-pressed="${cur.spacing}">${icon('text')}</button>
        <button class="iconbtn" id="tocBtn" data-tip="目录" aria-pressed="${cur.tocOpen}">${icon('panelLeft')}</button>
        <button class="iconbtn" id="fsBtn" data-tip="字号">${icon('highlighter')}</button>
        <button class="iconbtn" id="speakBtn" data-tip="朗读全文">${icon('volume')}</button>
        <button class="iconbtn" id="rMore" data-tip="更多">${icon('more')}</button>
      </div>
    </div>
    <div class="reader__progress"><i id="rProg"></i></div>
    <div class="reader__body">
      <aside class="toc ${cur.tocOpen ? '' : 'is-hidden'}" id="toc"></aside>
      <div class="panes" id="panes">
        <div class="pane pane--src" id="paneSrc">
          <div class="prose" id="proseSrc"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  root.querySelector('#rBack').addEventListener('click', closeReader);
  root.querySelector('#proseSrc').addEventListener('click', (e) => {
    const b = e.target.closest('[data-reveal]');
    if (b) api.reveal(b.dataset.reveal);
  });

  root.querySelectorAll('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => switchMode(b.dataset.mode));
  });

  root.querySelector('#spacingBtn').addEventListener('click', () => {
    cur.spacing = !cur.spacing;
    root.querySelector('#spacingBtn').setAttribute('aria-pressed', String(cur.spacing));
    api.patchConfig({ settings: { reader: { spacing: cur.spacing } } }).catch(() => {});
    paint();
  });

  root.querySelector('#tocBtn').addEventListener('click', () => {
    cur.tocOpen = !cur.tocOpen;
    root.querySelector('#tocBtn').setAttribute('aria-pressed', String(cur.tocOpen));
    root.querySelector('#toc').classList.toggle('is-hidden', !cur.tocOpen);
    api.patchConfig({ settings: { reader: { toc: cur.tocOpen } } }).catch(() => {});
  });

  root.querySelector('#fsBtn').addEventListener('click', (e) => {
    menu(e.currentTarget, [
      { label: '增大字号', icon: 'plus', onClick: () => setFont(cur.fontSize + 1) },
      { label: '减小字号', icon: 'text', onClick: () => setFont(cur.fontSize - 1) },
      { label: '恢复默认（16）', icon: 'refresh', onClick: () => setFont(16) },
      { sep: true },
      { label: '加宽行宽', icon: 'columns', onClick: () => setMeasure(cur.measure + 80) },
      { label: '收窄行宽', icon: 'rows', onClick: () => setMeasure(cur.measure - 80) }
    ]);
  });

  root.querySelector('#speakBtn').addEventListener('click', () => toggleSpeakAll());
  root.querySelector('#rMore').addEventListener('click', (e) => openMoreMenu(e.currentTarget));

  root.querySelector('#paneSrc').addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('selectionchange', onSelectionChange);

  // 字号 / 行宽 / 窗口尺寸变化都会改变两栏高度，映射表必须跟着重建
  window.addEventListener('resize', scheduleMap);
  if (typeof ResizeObserver !== 'undefined') {
    rootObserver = new ResizeObserver(() => scheduleMap());
    rootObserver.observe(root.querySelector('#proseSrc'));
  }
}

let rootObserver = null;

function setFont(v) {
  cur.fontSize = Math.max(12, Math.min(26, v));
  document.getElementById('readerRoot').style.setProperty('--reader-fs', cur.fontSize + 'px');
  api.patchConfig({ settings: { reader: { fontSize: cur.fontSize } } }).catch(() => {});
}

function setMeasure(v) {
  cur.measure = Math.max(520, Math.min(1040, v));
  document.getElementById('readerRoot').style.setProperty('--measure', cur.measure + 'px');
  api.patchConfig({ settings: { reader: { measure: cur.measure } } }).catch(() => {});
}

/* ============================== 内容 ============================== */

async function loadContent(filePath, title) {
  if (!cur) return;

  // 换文件即换上下文：旧请求的响应不能再写进新文件
  const epoch = ++epochSeq;
  cur.epoch = epoch;
  cur.trPromise = null;
  cur.loadingTr = false;
  cur.alignLoading = false;
  cur.translations = null;
  cur.align = null;
  clearSyncHighlight();
  hideSelTool();

  const skillId = cur.skill.id;
  const isMain = filePath === cur.skill.path;
  const r = isMain
    ? await api.readSkill(skillId)
    : await api.readFile(filePath);

  // 读文件期间用户可能已经关掉阅读器 / 换了文件 —— 这里必须停手
  if (!cur || cur.epoch !== epoch || !document.getElementById('proseSrc')) return;

  cur.kind = r.kind || 'md';
  cur.content = r.content || '';
  cur.dataUrl = r.dataUrl || '';
  cur.hint = r.hint || '';
  cur.bytes = r.bytes || 0;
  cur.activeFile = filePath;
  cur.isMain = isMain;

  // 只有 Markdown 能翻译；图片 / Word / 代码 / 二进制只做预览
  const root = document.getElementById('readerRoot');
  if (root) root.classList.toggle('reader--static', cur.kind !== 'md');

  const sub = document.getElementById('rSub');
  if (sub) {
    sub.textContent = isMain
      ? `${productName(cur.skill.productId)} · ${shortPath(cur.skill.dir, 52)}`
      : `${cur.skill.name} / ${title || ''}`;
  }

  paint();
  buildToc();

  if (cur.kind !== 'md') return;

  if (cur.mode !== 'off') {
    ensureTranslation().then((st) => {
      if (!cur || cur.epoch !== epoch) return;
      if (st === 'ready') { paint(); loadAlign(); }
    });
  }
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / 1024 / 1024).toFixed(1) + ' MB';
}

/** 非 Markdown 附属文件的预览（图片 / 代码 / 纯文本 / 不可预览） */
function renderFileView(kind) {
  const name = esc(String(cur.activeFile || '').split(/[\\/]/).pop());

  if (kind === 'image') {
    return `
      <div class="fileimg">
        <img src="${cur.dataUrl}" alt="${name}" />
        <div class="fileimg__meta">${name} · ${fmtBytes(cur.bytes)}</div>
      </div>`;
  }

  if (kind === 'binary') {
    return `
      <div class="filevoid">
        <div class="filevoid__icon">${icon('file')}</div>
        <h3>这个格式暂时没法预览</h3>
        <p>${esc(cur.hint || '二进制文件不支持预览。')}</p>
        <p class="muted">${name} · ${fmtBytes(cur.bytes)}</p>
        <button class="btn btn--outlined btn--sm" data-reveal="${esc(cur.activeFile)}">在文件夹中显示</button>
      </div>`;
  }

  if (kind === 'code') {
    const lines = String(cur.content || '').split('\n');
    const max = 4000;
    const body = lines.slice(0, max)
      .map((l, i) => `<div class="code-line"><span class="code-ln">${i + 1}</span><span class="code-src">${esc(l) || ' '}</span></div>`)
      .join('');
    return `
      <div class="filecode">
        <div class="filecode__bar"><span>${name}</span><span class="muted">${lines.length} 行 · 只读</span></div>
        <pre class="filecode__body">${body}</pre>
        ${lines.length > max ? `<div class="filecode__more">仅显示前 ${max} 行</div>` : ''}
      </div>`;
  }

  return `
    <div class="filetext">
      <div class="filecode__bar"><span>${name}</span><span class="muted">${fmtBytes(cur.bytes)}</span></div>
      <pre class="filetext__body">${esc(cur.content || '')}</pre>
    </div>`;
}

function paint() {
  const prose = document.getElementById('proseSrc');
  if (!prose) return;

  const kind = cur.kind || 'md';
  if (kind !== 'md' && kind !== 'docx') {
    const old = document.getElementById('paneDst');
    if (old) old.remove();
    cur.blocks = [];
    prose.innerHTML = renderFileView(kind);
    updateProgress();
    return;
  }

  cur.blocks = segmentMarkdown(cur.content);

  const panes = document.getElementById('panes');
  const oldDst = document.getElementById('paneDst');
  if (cur.mode !== 'side' && oldDst) oldDst.remove();

  prose.innerHTML = renderProse(cur.blocks, {
    translations: cur.translations,
    interlinear: cur.mode === 'interlinear',
    spacing: cur.spacing,
    lang: 'src'
  });

  if (cur.mode === 'side') {
    if (!oldDst) {
      const dst = document.createElement('div');
      dst.className = 'pane pane--dst';
      dst.id = 'paneDst';
      dst.innerHTML = `<div class="prose" id="proseDst"></div>`;
      panes.appendChild(dst);
      dst.addEventListener('scroll', onScroll, { passive: true });
    }
    const dstProse = document.getElementById('proseDst');
    dstProse.innerHTML = cur.translations
      ? renderProse(cur.blocks, { translations: cur.translations, lang: 'dst' })
      : `<div class="tr-pending"><span class="spinner"></span>正在翻译…</div>`;
    if (rootObserver) rootObserver.observe(dstProse);
  }

  applyAnnotations();
  updateProgress();
  scheduleMap();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleMap).catch(() => {});
}

/**
 * 确保当前文件有译文。
 * 返回值：'ready'（可用/已有） | 'failed' | 'aborted'
 *
 * 006 轮把「已有译文」和「正在加载」都当成 false 返回，上层据此把按钮
 * 打回原文，可 cur.mode 又没跟着改 —— 按钮、模式、画面三者不一致。
 * 012 轮改成三态，并且并发请求直接复用同一个 Promise。
 */
async function ensureTranslation(force = false) {
  if (!cur) return 'aborted';
  if (!force && cur.translations) return 'ready';
  if (cur.trPromise) return cur.trPromise;

  const epoch = cur.epoch;
  const skillId = cur.skill.id;
  const isMain = cur.isMain;
  const file = cur.activeFile;

  const p = (async () => {
    try {
      const r = await api.translate(skillId, !!force, isMain ? undefined : file);
      if (!cur || cur.epoch !== epoch) return 'aborted';
      cur.translations = r.translations || {};
      if (r.blocks && isMain) cur.blocks = r.blocks;
      if (r.cached) {
        toast(`译文全部命中本地缓存（${r.count} 段）`, '', { duration: 1800 });
      } else if (r.missed !== undefined && r.reused > 0) {
        toast(`复用 ${r.reused} 段已有译文，只新译了 ${r.missed} 段`, '', { duration: 2400 });
      }
      return 'ready';
    } catch (e) {
      if (!cur || cur.epoch !== epoch) return 'aborted';
      toast(e.message, 'error', {
        actionLabel: '去设置',
        onAction: () => { closeReader(); window.__goto('settings'); }
      });
      return 'failed';
    }
  })();

  cur.trPromise = p;
  try {
    return await p;
  } finally {
    if (cur && cur.trPromise === p) cur.trPromise = null;
  }
}

/** 模式值 / 按钮 aria-pressed / 画面必须永远同步 */
function setModeUI(mode) {
  if (!cur) return;
  cur.mode = mode;
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  });
}

async function switchMode(mode) {
  if (!cur || cur.mode === mode) return;
  const epoch = cur.epoch;
  const prev = cur.mode;
  setModeUI(mode);

  if (mode !== 'off') {
    const st = await ensureTranslation();
    // 等待期间可能已经换了文档/关了阅读器 —— 旧流程不得改新文档的模式
    if (!cur || cur.epoch !== epoch) return;
    if (st !== 'ready') {
      // 失败/中止：模式与按钮一起回退，不留「按钮说并排、画面是原文」
      setModeUI(prev);
      paint();
      return;
    }
    loadAlign();
  }
  paint();
  if (mode === 'side') { buildMap(); syncScroll('src'); }
}

/**
 * 词级对齐（006）：进入并排/行间后异步取一次，结果按文件缓存。
 * 失败不打扰阅读 —— 词对齐是「选中更准」的增强，句子级同步仍然可用。
 */
async function loadAlign(force = false) {
  if (!cur || cur.alignLoading) return;
  if (cur.align && !force) return;

  const epoch = cur.epoch;
  const skillId = cur.skill.id;
  const isMain = cur.isMain;
  const file = cur.activeFile;
  cur.alignLoading = true;

  try {
    const r = await api.align(skillId, !!force, isMain ? undefined : file);
    if (!cur || cur.epoch !== epoch) return;
    cur.align = r.map || {};
    // 对齐到货时若已有选区，立刻按词级重算一次高亮
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) onSelectionChange();
  } catch (e) {
    if (!cur || cur.epoch !== epoch) return;
    console.warn('[align] ' + e.message);
  } finally {
    if (cur && cur.epoch === epoch) cur.alignLoading = false;
  }
}

/* ============================== 目录 ============================== */

function buildToc() {
  const toc = document.getElementById('toc');
  if (!toc) return;
  const items = outline(cur.blocks);
  toc.innerHTML = `
    <div class="toc__label">目录</div>
    ${items.length ? items.map((h) => `
      <button class="toc__item" data-seg="${h.i}" data-level="${h.level}" title="${esc(h.text)}">${esc(h.text)}</button>
    `).join('') : '<p class="muted" style="padding:0 12px;font:var(--type-body-s)">这份文件没有标题层级</p>'}
    <div class="toc__files">
      <div class="toc__label" style="padding-left:12px">附属文件</div>
      <div id="fileList"></div>
    </div>
  `;

  toc.querySelectorAll('[data-seg]').forEach((b) => {
    b.addEventListener('click', () => {
      const seg = b.dataset.seg;
      const paneS = document.getElementById('paneSrc');
      const paneD = document.getElementById('paneDst');
      const target = paneS && paneS.querySelector(`.blk[data-seg="${seg}"]`);
      if (target) lockScroll(paneS, target.offsetTop - 12);
      const mate = paneD && paneD.querySelector(`.blk[data-seg="${seg}"]`);
      if (mate) lockScroll(paneD, mate.offsetTop - 12);
      updateProgress();
    });
  });
}

async function loadFiles() {
  try {
    cur.files = await api.skillFiles(cur.skill.id);
  } catch {
    if (!cur) return;
    cur.files = [];
  }
  if (!cur) return;
  const box = document.getElementById('fileList');
  if (!box) return;
  const others = cur.files.filter((f) => f.rel.toLowerCase() !== 'skill.md');
  box.innerHTML = `
    <button class="toc__file" data-file="${esc(cur.skill.path)}" data-name="SKILL.md"
      style="${cur.activeFile === cur.skill.path ? 'color:var(--md-primary);font-weight:500' : ''}">
      ${icon('file', 'icon--sm')}SKILL.md
    </button>
    ${others.map((f) => `
      <button class="toc__file" data-file="${esc(joinPath(cur.skill.dir, f.rel))}" data-name="${esc(f.rel)}"
        style="${cur.activeFile === joinPath(cur.skill.dir, f.rel) ? 'color:var(--md-primary);font-weight:500' : ''}"
        title="${esc(f.rel)}">${icon('file', 'icon--sm')}${esc(f.rel)}</button>`).join('')}
  `;
  box.querySelectorAll('[data-file]').forEach((b) => {
    b.addEventListener('click', () => {
      loadContent(b.dataset.file, b.dataset.name);
      loadFiles();
    });
  });
}

function joinPath(dir, rel) {
  return dir.replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\');
}

/* ============================== 滚动同步 ============================== */

/**
 * 两栏共用的唯一对齐真相表：每个块在左栏/右栏里的 (top, height)。
 *
 * 为什么必须建表：中文译文与英文原文的段落高度不一样，
 * 直接搬「滚动距离」会一段一段累积误差，滚到中段就彻底错位。
 * 有了这张表，就能把滚动位置换算成「第几块的百分之几」，
 * 再按同样比例落到另一栏 —— 块边界永远精确对齐，误差不会累积。
 */
let alignMap = null;
let mapTimer = 0;
let rafPending = 0;
/** 建表时两栏的内容高度；滚动时若对不上，说明表已过期，必须重建 */
let mapStamp = { s: -1, d: -1 };
function blkList(paneId) {
  const pane = document.getElementById(paneId);
  return pane ? [...pane.querySelectorAll('.blk[data-seg]')] : [];
}

function buildMap() {
  const src = blkList('paneSrc');
  if (!src.length) { alignMap = null; mapStamp = { s: -1, d: -1 }; return null; }
  const dst = blkList('paneDst');
  const baseS = src[0].offsetTop;
  const baseD = dst.length ? dst[0].offsetTop : 0;
  const bySeg = new Map(dst.map((el) => [Number(el.dataset.seg), el]));

  alignMap = src.map((el) => {
    const d = bySeg.get(Number(el.dataset.seg));
    return {
      seg: Number(el.dataset.seg),
      sTop: el.offsetTop - baseS,
      sH: el.offsetHeight,
      dTop: d ? d.offsetTop - baseD : 0,
      dH: d ? d.offsetHeight : 0
    };
  });
  const ps = document.getElementById('paneSrc');
  const pd = document.getElementById('paneDst');
  mapStamp = { s: ps ? ps.scrollHeight : -1, d: pd ? pd.scrollHeight : -1 };
  return alignMap;
}

/** 表是否过期（内容高度变了）——译文分块到达、图片加载、字号变化都会导致 */
function mapStale() {
  if (!alignMap) return true;
  const ps = document.getElementById('paneSrc');
  const pd = document.getElementById('paneDst');
  if (!ps || !pd) return true;
  return Math.abs(ps.scrollHeight - mapStamp.s) > 1 || Math.abs(pd.scrollHeight - mapStamp.d) > 1;
}

function scheduleMap() {
  if (!cur) return;
  clearTimeout(mapTimer);
  mapTimer = setTimeout(() => {
    // 注意：这里不用 requestAnimationFrame —— 窗口被遮挡/最小化时 Chromium 会暂停 rAF，
    // 同步会静默失效（打包版实测踩过）。setTimeout 虽被降频，但一定会执行。
    buildMap();
    if (document.getElementById('paneDst')) syncScroll('src');
  }, 50);
}

/** 程序化滚动：给目标栏打上「预期值」，它自己触发的 scroll 事件就不会被当成用户操作 */
function lockScroll(el, target) {
  if (!el) return;
  const v = Math.max(0, target);
  if (Math.abs(el.scrollTop - v) < 1) { el.__expect = undefined; return; }
  el.__expect = v;
  el.scrollTop = v;
  setTimeout(() => { if (el.__expect !== undefined) el.__expect = undefined; }, 250);
}

function onScroll(e) {
  const el = e.target;
  if (!el || !el.id) return;

  if (el.__expect !== undefined) {
    // 这次滚动是自己写进去的，消费掉，不再反向驱动
    el.__expect = undefined;
    if (el.id === 'paneSrc') updateProgress(el);
    return;
  }

  if (el.id === 'paneSrc') updateProgress(el);
  if (!document.getElementById('paneDst')) return;
  if (rafPending) return;

  const from = el.id === 'paneDst' ? 'dst' : 'src';
  rafPending = setTimeout(() => {
    rafPending = 0;
    syncScroll(from);
  }, 16);
}

/** 把一栏的滚动位置按块比例换算到另一栏 */
function mapScroll(from, y) {
  if (mapStale() && !buildMap()) return 0;
  if (!alignMap.length) return 0;

  const topKey = from === 'src' ? 'sTop' : 'dTop';
  const hKey = from === 'src' ? 'sH' : 'dH';
  const oTop = from === 'src' ? 'dTop' : 'sTop';
  const oH = from === 'src' ? 'dH' : 'sH';

  let lo = 0;
  let hi = alignMap.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (alignMap[mid][topKey] <= y) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }

  const b = alignMap[idx];
  const h = b[hKey];
  const r = h > 0 ? Math.max(0, Math.min(1, (y - b[topKey]) / h)) : 0;
  return b[oTop] + r * b[oH];
}

function syncScroll(from) {
  const a = document.getElementById(from === 'src' ? 'paneSrc' : 'paneDst');
  const b = document.getElementById(from === 'src' ? 'paneDst' : 'paneSrc');
  if (!a || !b) return;

  const maxA = a.scrollHeight - a.clientHeight;
  const maxB = b.scrollHeight - b.clientHeight;
  if (maxB <= 0) return;

  let target;
  if (maxA > 0 && a.scrollTop >= maxA - 2) {
    // 一栏到底，另一栏也到底 —— 否则末尾会永远差一截
    target = maxB;
  } else {
    target = mapScroll(from, a.scrollTop);
  }
  lockScroll(b, Math.min(maxB, Math.max(0, target)));
}

function updateProgress(srcEl) {
  const src = srcEl || document.getElementById('paneSrc');
  const bar = document.getElementById('rProg');
  if (!src || !bar) return;
  const max = src.scrollHeight - src.clientHeight;
  const p = max > 0 ? Math.min(100, (src.scrollTop / max) * 100) : 0;
  bar.style.width = p + '%';

  // 目录高亮
  const blocks = src.querySelectorAll('.blk[data-seg]');
  const y = src.scrollTop + 80;
  let activeSeg = null;
  for (const el of blocks) {
    if (el.offsetTop <= y) activeSeg = el.dataset.seg;
    else break;
  }
  document.querySelectorAll('.toc__item').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.seg === activeSeg);
  });
}

/* ============================== 标记 ============================== */

async function loadAnnotations() {
  try {
    cur.annotations = await api.getAnnotations(cur.skill.id);
  } catch {
    if (!cur) return;
    cur.annotations = [];
  }
  if (!cur) return;
  applyAnnotations();
}

function currentFileKey() {
  return cur.isMain ? 'SKILL.md' : cur.activeFile;
}

function applyAnnotations() {
  if (!hlSupported) return;
  const prose = document.getElementById('proseSrc');
  if (!prose) return;

  const groups = { 1: [], 2: [], 3: [], 4: [] };
  const key = currentFileKey();

  for (const a of cur.annotations) {
    if (a.file && a.file !== key) continue;
    const holder = prose.querySelector(`.blk[data-seg="${a.block}"] .blk__src`);
    if (!holder) continue;
    // v2 及以后用「虚拟文本」坐标（块级元素之间有分隔符）；
    // 旧批注是 textContent 坐标，按旧坐标还原，避免历史高亮整体漂移。
    const range = a.v === 2
      ? rangeFromVirtual(holder, a.start, a.end)
      : rangeFromPlainOffsets(holder, a.start, a.end);
    if (range) (groups[a.color] || groups[1]).push(range);
  }

  for (const [c, ranges] of Object.entries(groups)) {
    if (ranges.length) CSS.highlights.set('mark-' + c, new Highlight(...ranges));
    else CSS.highlights.delete('mark-' + c);
  }
}

/* ============================== 选中同步 ============================== */

let selInfo = null;
let syncTimer = 0;

function clearSyncHighlight() {
  clearTimeout(syncTimer);
  clearWordTip();
  if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete('sync');
}

/**
 * 对侧同步：源栏选中 → 译文栏对应单元高亮；译文栏选中 → 原文对应单元高亮。
 *
 * 012 轮不再「按字符比例吸附到最近的句子」—— 那在列表项长短不一时必然
 * 跳到相邻项。现在按「块 → 行（列表项） → 句 → 词」逐级定位：
 *   1. 词对命中且落在同一行 → 精确到词；
 *   2. 否则落到同一行/同一句（结构单元）；
 *   3. 行数都对不上才退回块内比例，并且**不显示词级气泡**。
 */
function syncSelection(from, info) {
  if (typeof CSS === 'undefined' || !CSS.highlights) return;
  const otherPane = document.getElementById(from === 'src' ? 'paneDst' : 'paneSrc');
  if (!otherPane) return clearSyncHighlight();

  const side = from === 'src' ? 0 : 1;
  const ranges = [];
  let wordHit = null;

  for (const seg of info.segments) {
    const holder = otherPane.querySelector(`.blk[data-seg="${seg.block}"] .blk__src`);
    if (!holder) continue;
    const dst = virtualText(holder);
    if (!dst.text.trim()) continue;

    const pairs = cur.align ? (cur.align[seg.block] || cur.align[String(seg.block)]) : null;
    const res = resolveSelection({
      textA: seg.blockText,
      textB: dst.text,
      start: seg.start,
      end: seg.end,
      pairs: Array.isArray(pairs) ? pairs : null,
      side
    });
    if (res.kind === 'none') continue;

    const range = rangeFromVirtual(holder, res.start, res.end);
    if (!range) continue;
    ranges.push(range);
    if (res.kind === 'word' && !wordHit) wordHit = { range, res };
  }

  if (!ranges.length) { clearWordTip(); return clearSyncHighlight(); }

  CSS.highlights.set('sync', new Highlight(...ranges));
  // 只有「唯一一段、且确实命中了词对」才弹词级气泡；句子级不弹假气泡
  if (wordHit && ranges.length === 1) showWordTip(wordHit.range, wordHit.res.term, wordHit.res.targetTerm);
  else clearWordTip();

  // 对侧那段如果不在视野里，就滚过去 —— 用户不用自己找
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { if (cur) revealRange(otherPane, ranges[0]); }, 150);
}

/** 词级对照小气泡：源词 → 译词，贴在选区下方，不跟工具条抢位置 */
function showWordTip(range, fromTerm, toTerm) {
  clearWordTip();
  const r = range.getBoundingClientRect();
  if (!r.height) return;
  const el = document.createElement('div');
  el.className = 'wordtip';
  el.innerHTML = `<b>${esc(fromTerm)}</b><span class="wordtip__arrow">→</span><b>${esc(toTerm)}</b>`;
  document.body.appendChild(el);

  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.max(10, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 10));
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

function clearWordTip() {
  document.querySelectorAll('.wordtip').forEach((n) => n.remove());
}

/**
 * 自动化测试用注入口：直接塞入对齐数据，不依赖真实接口。
 * 正常运行时 cur.align 由 ai:align 填充；这里只是让端到端能稳定验证「词级落点」。
 */
if (typeof window !== 'undefined') {
  window.__atelierDebug = {
    setAlign(map) { if (!cur) return false; cur.align = map || {}; return true; },
    getAlign() { return cur ? cur.align : null; }
  };
}

function revealRange(pane, range) {
  const r = range.getBoundingClientRect();
  const p = pane.getBoundingClientRect();
  if (!r.height) return;
  const top = p.top + 44;
  const bottom = p.bottom - 28;
  if (r.top >= top && r.bottom <= bottom) return;
  const delta = r.top - (p.top + p.height / 2) + r.height / 2;
  lockScroll(pane, pane.scrollTop + delta);
}

function blockOf(node, root) {
  if (!node) return null;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el || !el.closest) return null;
  const blk = el.closest('.blk[data-seg]');
  return blk && root.contains(blk) ? blk : null;
}

function onSelectionChange() {
  if (!cur) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    clearSyncHighlight();
    return hideSelTool();
  }

  const range = sel.getRangeAt(0);
  const prose = document.getElementById('proseSrc');
  const proseDst = document.getElementById('proseDst');
  if (!prose) return hideSelTool();

  const inSrc = prose.contains(range.commonAncestorContainer);
  const inDst = !!proseDst && proseDst.contains(range.commonAncestorContainer);
  if (!inSrc && !inDst) { clearSyncHighlight(); return hideSelTool(); }

  const paneRoot = inSrc ? prose : proseDst;
  const blocks = [...paneRoot.querySelectorAll('.blk[data-seg]')];
  const startBlk = blockOf(range.startContainer, paneRoot);
  if (!startBlk) return hideSelTool();
  const endBlk = blockOf(range.endContainer, paneRoot) || startBlk;

  const text = String(range.toString() || '');
  if (!text.trim()) return hideSelTool();

  // 跨块选择：起点块到终点块逐块记录，不再用「起始块 + 总长度」推算
  const i0 = blocks.indexOf(startBlk);
  const i1 = Math.max(i0, blocks.indexOf(endBlk));
  const segments = [];
  for (let i = i0; i <= i1 && i < blocks.length; i++) {
    const blk = blocks[i];
    const holder = blk.querySelector('.blk__src');
    if (!holder) continue;
    const vt = virtualText(holder);
    if (!vt.text.trim()) continue;

    let s = 0;
    let e = vt.text.length;
    if (i === i0) s = offsetAt(holder, range.startContainer, range.startOffset);
    if (i === i1) e = offsetAt(holder, range.endContainer, range.endOffset);
    if (e < s) { const t = s; s = e; e = t; }
    if (e <= s) continue;
    segments.push({ block: Number(blk.dataset.seg), start: s, end: e, blockText: vt.text });
  }
  if (!segments.length) return hideSelTool();

  selInfo = {
    block: segments[0].block,
    start: segments[0].start,
    end: segments[0].end,
    text,
    pane: inSrc ? 'src' : 'dst',
    blockText: segments[0].blockText,
    segments
  };

  syncSelection(inSrc ? 'src' : 'dst', selInfo);
  showSelTool(range.getBoundingClientRect(), inSrc);
}

function showSelTool(rect, allowMark = true) {
  hideSelTool(true);
  const bar = document.createElement('div');
  bar.className = 'seltool';
  bar.innerHTML = `
    ${allowMark
      ? HL_COLORS.map((c, i) => `<button class="seltool__swatch" data-color="${i + 1}"
          style="background:${c}" data-tip="高亮 ${i + 1}"></button>`).join('')
      : '<span class="seltool__hint">译文栏选中 · 可朗读或复制</span>'}
    <span class="seltool__sep"></span>
    <button class="iconbtn iconbtn--sm" data-act="speak" data-tip="朗读">${icon('volume')}</button>
    <button class="iconbtn iconbtn--sm" data-act="copy" data-tip="复制">${icon('copy')}</button>
    <button class="iconbtn iconbtn--sm" data-act="note" data-tip="加备注">${icon('edit')}</button>
  `;
  document.body.appendChild(bar);

  const w = bar.offsetWidth;
  const h = bar.offsetHeight;
  let left = rect.left + rect.width / 2 - w / 2;
  let top = rect.top - h - 10;
  // 选区在顶部就翻到下方；再统一夹进视口，避免选区滚出屏幕时工具条跑到屏幕外
  if (rect.top - h - 10 < 8) top = rect.bottom + 10;
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
  left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';

  bar.addEventListener('mousedown', (e) => e.preventDefault());
  bar.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-color]');
    if (c) {
      await addAnnotation(Number(c.dataset.color), '');
      hideSelTool();
      return;
    }
    const a = e.target.closest('[data-act]');
    if (!a || !selInfo) return;
    if (a.dataset.act === 'speak') speak(selInfo.text);
    if (a.dataset.act === 'copy') {
      await window.atelier.call('clipboard:write', { text: selInfo.text });
      toast('已复制选中文本', 'success');
    }
    if (a.dataset.act === 'note') {
      const note = await dialogPrompt('给这段加个备注', '备注会跟着这条标记一起保存。');
      if (note !== null) await addAnnotation(1, note);
      hideSelTool();
    }
  });
}

function hideSelTool(keepInfo = false) {
  document.querySelectorAll('.seltool').forEach((n) => n.remove());
  if (!keepInfo) selInfo = null;
}

function dialogPrompt(title, subtitle) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const d = dialog({
      title,
      subtitle,
      body: `<textarea class="textarea" id="noteInp" placeholder="可选，写点你自己的话…" style="min-height:72px"></textarea>`,
      actions: [
        { label: '取消', onClick: () => finish(null) },
        { label: '保存', kind: 'filled', onClick: (ref) => finish(ref.body.querySelector('#noteInp').value.trim()) }
      ],
      onMount(ref) { setTimeout(() => ref.body.querySelector('#noteInp').focus(), 60); }
    });
    const orig = d.close;
    d.close = () => { orig(); finish(null); };
  });
}

async function addAnnotation(color, note) {
  if (!selInfo) return;
  if (selInfo.pane === 'dst') {
    toast('标记请打在原文栏，译文栏只能朗读和复制', '', { duration: 2600 });
    return;
  }
  const item = {
    id: 'a' + Date.now().toString(36),
    file: currentFileKey(),
    block: selInfo.block,
    start: selInfo.start,
    end: selInfo.end,
    v: 2,
    text: selInfo.text.slice(0, 200),
    color,
    note,
    at: Date.now()
  };
  cur.annotations.push(item);
  await api.setAnnotations(cur.skill.id, cur.annotations);
  applyAnnotations();
  window.getSelection()?.removeAllRanges();
  toast(note ? '已标记并保存备注' : '已标记', 'success', { duration: 1600 });
}

/* ============================== 朗读 ============================== */

function voiceFor(text) {
  const lang = pickLang(text);
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  const cfg = state.config.settings.tts;
  if (cfg.voice) {
    const hit = vs.find((v) => v.name === cfg.voice);
    if (hit) return hit;
  }
  const base = lang.split('-')[0];
  return vs.find((v) => v.lang && v.lang.toLowerCase().startsWith(base)) || null;
}

function speak(text) {
  if (!window.speechSynthesis) { toast('当前环境不支持语音合成', 'error'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text).slice(0, 3000));
  const v = voiceFor(text);
  if (v) u.voice = v;
  u.lang = v ? v.lang : pickLang(text);
  u.rate = state.config.settings.tts.rate || 1;
  speechSynthesis.speak(u);
  cur.utter = u;
}

function toggleSpeakAll() {
  if (!window.speechSynthesis) { toast('当前环境不支持语音合成', 'error'); return; }
  if (cur.speaking) {
    speechSynthesis.cancel();
    stopSpeakUI();
    return;
  }
  const prose = document.getElementById('proseSrc');
  if (!prose) return;

  const nodes = [...prose.querySelectorAll('.blk')].map((b) => ({
    el: b,
    text: (b.querySelector('.blk__src')?.textContent || '').trim()
  })).filter((x) => x.text.length > 0);

  if (!nodes.length) return;

  cur.speaking = true;
  const btn = document.getElementById('speakBtn');
  if (btn) { btn.innerHTML = icon('stop'); btn.setAttribute('aria-pressed', 'true'); }

  let i = 0;
  const next = () => {
    if (!cur || !cur.speaking) return stopSpeakUI();
    document.querySelectorAll('.speaking').forEach((n) => n.classList.remove('speaking'));
    if (i >= nodes.length) return stopSpeakUI();

    const item = nodes[i++];
    item.el.classList.add('speaking');
    item.el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const u = new SpeechSynthesisUtterance(item.text.slice(0, 1200));
    const v = voiceFor(item.text);
    if (v) u.voice = v;
    u.lang = v ? v.lang : pickLang(item.text);
    u.rate = state.config.settings.tts.rate || 1;
    u.onend = next;
    u.onerror = next;
    speechSynthesis.speak(u);
  };
  next();
}

function stopSpeakUI() {
  if (cur) cur.speaking = false;
  document.querySelectorAll('.speaking').forEach((n) => n.classList.remove('speaking'));
  const btn = document.getElementById('speakBtn');
  if (btn) { btn.innerHTML = icon('volume'); btn.setAttribute('aria-pressed', 'false'); }
}

/* ============================== 更多 ============================== */

function openMoreMenu(anchor) {
  menu(anchor, [
    { label: 'AI 改写这个 skill…', icon: 'sparkles', onClick: () => openAiRewrite(cur.skill.id, () => reloadAfterWrite()) },
    { label: '重新翻译（忽略缓存）', icon: 'translate', onClick: async () => {
      if (!cur) return;
      const epoch = cur.epoch;
      clearSyncHighlight();
      cur.align = null;
      const st = await ensureTranslation(true);
      if (!cur || cur.epoch !== epoch || st !== 'ready') return;
      paint();
      if (cur.mode !== 'off') loadAlign(true);
      toast('已重新翻译', 'success');
    } },
    { sep: true },
    { label: '复制目录路径', icon: 'copy', onClick: async () => {
      await window.atelier.call('clipboard:write', { text: cur.skill.dir });
      toast('已复制目录路径', 'success');
    } },
    { label: '在资源管理器中显示', icon: 'external', onClick: () => api.reveal(cur.skill.path) },
    { sep: true },
    { label: `标记管理（${cur.annotations.length}）`, icon: 'highlighter', onClick: () => openMarksDialog() },
    { label: '分组…', icon: 'folder', onClick: async () => {
      const { openAssignGroups } = await import('./groups.js');
      await openAssignGroups([cur.skill.id]);
      await refresh('data');
    } }
  ], { alignRight: true });
}

async function reloadAfterWrite() {
  await refresh('data');
  if (!cur) return;
  const epoch = ++epochSeq;
  cur.epoch = epoch;
  cur.trPromise = null;
  cur.align = null;
  cur.alignLoading = false;
  clearSyncHighlight();
  const r = await api.readSkill(cur.skill.id);
  if (!cur || cur.epoch !== epoch) return;
  cur.content = r.content;
  cur.translations = null;
  paint();
  buildToc();
  toast('内容已更新', 'success');
}

function openMarksDialog() {
  const list = cur.annotations.filter((a) => !a.file || a.file === currentFileKey());
  dialog({
    title: '标记管理',
    subtitle: `当前文件共 ${list.length} 条标记`,
    wide: true,
    body: list.length ? `<div style="display:flex;flex-direction:column;gap:2px">
      ${list.map((a) => `
        <div class="list-item" data-mark="${a.id}">
          <span class="chip__dot" style="background:${HL_COLORS[a.color - 1]};width:10px;height:10px"></span>
          <div class="list-item__body">
            <div class="list-item__title truncate" style="font-size:13px">${esc(a.text)}</div>
            ${a.note ? `<div class="list-item__sub">${esc(a.note)}</div>` : ''}
          </div>
          <button class="iconbtn iconbtn--sm" data-del="${a.id}" data-tip="删除">${icon('trash')}</button>
        </div>`).join('')}
    </div>` : '<p class="muted">还没有标记。选中正文即可高亮。</p>',
    actions: [
      { label: '关闭' },
      {
        label: '清除全部',
        kind: 'danger',
        onClick: async () => {
          const ok = await confirm({ title: '清除全部标记？', text: '这会删除该 skill 下所有文件的标记记录。', confirmText: '清除', danger: true });
          if (!ok) return;
          cur.annotations = [];
          await api.setAnnotations(cur.skill.id, []);
          applyAnnotations();
          toast('已清除', 'success');
        }
      }
    ],
    onMount(ref) {
      ref.body.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-del]');
        if (!del) return;
        cur.annotations = cur.annotations.filter((a) => a.id !== del.dataset.del);
        await api.setAnnotations(cur.skill.id, cur.annotations);
        applyAnnotations();
        del.closest('.list-item').remove();
      });
    }
  });
}
