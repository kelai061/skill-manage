/* ui.js — 提示条 / 对话框 / 菜单 / 确认框 */

import { icon } from './icons.js';
import { esc, el } from './util.js';

/* ---------------------------- Snackbar ---------------------------- */

let snackHost = null;

export function toast(message, kind = '', opts = {}) {
  if (!snackHost) {
    snackHost = el('<div class="snackbar-host"></div>');
    document.body.appendChild(snackHost);
  }
  const node = el(`
    <div class="snackbar ${kind ? 'snackbar--' + kind : ''}">
      ${kind === 'error' ? icon('alert') : kind === 'success' ? icon('check') : ''}
      <span style="flex:1">${esc(message)}</span>
      ${opts.actionLabel ? `<button class="btn btn--text btn--sm" data-act>${esc(opts.actionLabel)}</button>` : ''}
    </div>
  `);
  if (opts.actionLabel && opts.onAction) {
    node.querySelector('[data-act]').addEventListener('click', () => {
      opts.onAction();
      node.remove();
    });
  }
  snackHost.appendChild(node);
  const ttl = opts.duration || (kind === 'error' ? 6000 : 3200);
  setTimeout(() => {
    node.style.transition = 'opacity 200ms, transform 200ms';
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    setTimeout(() => node.remove(), 220);
  }, ttl);
  return node;
}

/* ---------------------------- Dialog ---------------------------- */

let openDialogs = 0;

export function dialog({ title, subtitle = '', body = '', actions = [], wide = false, onMount }) {
  const scrim = el(`
    <div class="scrim">
      <div class="dialog ${wide ? 'dialog--wide' : ''}" role="dialog" aria-modal="true">
        <div class="dialog__head">
          <div style="flex:1;min-width:0">
            <h3>${esc(title)}</h3>
            ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
          </div>
          <button class="iconbtn iconbtn--sm" data-close aria-label="关闭">${icon('x')}</button>
        </div>
        <div class="dialog__body">${body}</div>
        <div class="dialog__foot"></div>
      </div>
    </div>
  `);

  const foot = scrim.querySelector('.dialog__foot');
  const api = {
    root: scrim,
    body: scrim.querySelector('.dialog__body'),
    close() {
      scrim.remove();
      openDialogs = Math.max(0, openDialogs - 1);
      document.removeEventListener('keydown', onKey);
    }
  };

  for (const a of actions) {
    const b = el(`<button class="btn ${a.kind ? 'btn--' + a.kind : 'btn--text'}">${a.icon ? icon(a.icon) : ''}${esc(a.label)}</button>`);
    if (a.disabled) b.disabled = true;
    b.addEventListener('click', async () => {
      if (a.onClick) {
        const keep = await a.onClick(api);
        if (keep === false) return;
      }
      if (a.keepOpen !== true) api.close();
    });
    foot.appendChild(b);
    if (a.ref) api[a.ref] = b;
  }
  if (!actions.length) foot.remove();

  scrim.querySelector('[data-close]').addEventListener('click', api.close);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) api.close();
  });

  function onKey(e) {
    if (e.key === 'Escape') api.close();
  }
  document.addEventListener('keydown', onKey);

  document.body.appendChild(scrim);
  openDialogs++;

  if (onMount) onMount(api);
  return api;
}

export function confirm({ title, text = '', confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const d = dialog({
      title,
      body: `<p style="margin:0;font:var(--type-body-m);color:var(--md-on-surface-variant);line-height:1.7">${esc(text)}</p>`,
      actions: [
        { label: cancelText, onClick: () => { done = true; resolve(false); } },
        { label: confirmText, kind: danger ? 'danger' : 'filled', onClick: () => { done = true; resolve(true); } }
      ]
    });
    d.root.addEventListener('remove', () => { if (!done) resolve(false); });
    const orig = d.close;
    d.close = () => { orig(); if (!done) { done = true; resolve(false); } };
  });
}

export function promptText({ title, subtitle = '', label = '', value = '', placeholder = '', multiline = false, confirmText = '确定', hint = '' }) {
  return new Promise((resolve) => {
    let done = false;
    const field = multiline
      ? `<textarea class="textarea" data-inp placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input class="input" data-inp value="${esc(value)}" placeholder="${esc(placeholder)}" />`;
    const d = dialog({
      title,
      subtitle,
      body: `
        <label class="field">
          ${label ? `<span class="field__label">${esc(label)}</span>` : ''}
          ${field}
          ${hint ? `<span class="field__label" style="font-weight:400">${esc(hint)}</span>` : ''}
        </label>`,
      actions: [
        { label: '取消', onClick: () => { done = true; resolve(null); } },
        {
          label: confirmText,
          kind: 'filled',
          onClick: (api) => {
            const v = api.body.querySelector('[data-inp]').value;
            done = true;
            resolve(v.trim());
          }
        }
      ],
      onMount(api) {
        const inp = api.body.querySelector('[data-inp]');
        setTimeout(() => { inp.focus(); inp.select(); }, 60);
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (!multiline || e.ctrlKey)) {
            e.preventDefault();
            api.body.parentElement.querySelector('.dialog__foot .btn--filled').click();
          }
        });
      }
    });
    const orig = d.close;
    d.close = () => { orig(); if (!done) { done = true; resolve(null); } };
  });
}

/* ---------------------------- Menu ---------------------------- */

let menuNode = null;

export function closeMenu() {
  if (menuNode) { menuNode.remove(); menuNode = null; }
}

export function menu(anchor, items, opts = {}) {
  closeMenu();
  const node = el('<div class="menu"></div>');
  for (const it of items) {
    if (it.sep) { node.appendChild(el('<div class="menu__sep"></div>')); continue; }
    const b = el(`<button class="menu__item">${it.icon ? icon(it.icon) : '<span style="width:18px"></span>'}<span>${esc(it.label)}</span></button>`);
    if (it.danger) b.style.color = 'var(--md-error)';
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeMenu();
      if (it.onClick) await it.onClick();
    });
    node.appendChild(b);
  }
  document.body.appendChild(node);
  menuNode = node;

  const r = anchor.getBoundingClientRect();
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  let left = opts.alignRight ? r.right - w : r.left;
  let top = r.bottom + 6;
  if (left + w > window.innerWidth - 12) left = window.innerWidth - w - 12;
  if (left < 12) left = 12;
  if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 6);
  node.style.left = left + 'px';
  node.style.top = top + 'px';

  setTimeout(() => {
    const off = (e) => {
      if (menuNode && !menuNode.contains(e.target)) {
        closeMenu();
        document.removeEventListener('mousedown', off, true);
      }
    };
    document.addEventListener('mousedown', off, true);
  }, 0);

  return node;
}

/* ---------------------------- Tooltip ---------------------------- */

/**
 * 全局唯一的浮动气泡。
 *
 * 为什么不用 CSS ::after：卡片、工具条、图标按钮都有 overflow / 伪元素占用，
 * CSS 气泡要么被裁掉，要么和状态层抢伪元素（上一轮的黑块就是这么来的），
 * 要么贴到窗口顶上变成一条黑边。统一用一个挂在 body 上的绝对定位元素，
 * 位置自己算、越界自己翻，永远不会被任何容器裁切。
 */
let tipNode = null;
let tipTarget = null;
let tipTimer = 0;

function ensureTip() {
  if (!tipNode) {
    tipNode = el('<div class="tip" role="tooltip"></div>');
    document.body.appendChild(tipNode);
  }
  return tipNode;
}

function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  if (tipNode) tipNode.classList.remove('is-on');
}

function placeTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  const node = ensureTip();
  node.textContent = text;
  node.classList.add('is-on');

  const r = target.getBoundingClientRect();
  const w = node.offsetWidth;
  const h = node.offsetHeight;

  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));

  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;                 // 上面放不下就翻到下面
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));

  node.style.left = left + 'px';
  node.style.top = top + 'px';
}

export function initTooltips() {
  if (window.__tipInited) return;
  window.__tipInited = true;

  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) { if (tipTarget) hideTip(); return; }
    if (t === tipTarget) return;
    tipTarget = t;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { if (tipTarget === t) placeTip(t); }, 260);
  });

  document.addEventListener('mouseout', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t && t === tipTarget) hideTip();
  });

  document.addEventListener('mousedown', hideTip, true);
  document.addEventListener('scroll', hideTip, true);
  window.addEventListener('blur', hideTip);
}

/* ---------------------------- 其它 ---------------------------- */

export function busyButton(btn, on) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span><span>处理中</span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

export function emptyState({ iconName = 'grid', title, text = '', action = '' }) {
  return `
    <div class="empty">
      <div class="empty__icon">${icon(iconName, 'icon--lg')}</div>
      <h3>${esc(title)}</h3>
      ${text ? `<p>${esc(text)}</p>` : ''}
      ${action}
    </div>`;
}
