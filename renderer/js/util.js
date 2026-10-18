/* util.js — 小工具 */

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function frag(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
}

export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

export function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + ' 小时前';
  if (diff < 7 * 86400_000) return Math.floor(diff / 86400_000) + ' 天前';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const TONES = ['tone-1', 'tone-2', 'tone-3', 'tone-4', 'tone-5', 'tone-6', 'tone-7', 'tone-8'];

export function hashCode(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) {
    h = (h << 5) - h + String(s).charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function toneOf(seed) {
  return TONES[hashCode(seed) % TONES.length];
}

export function toneVar(tone) {
  return `var(--md-${tone || 'tone-1'})`;
}

export function initials(name) {
  const s = String(name || '?').trim();
  if (!s) return '?';
  const cjk = s.match(/[\u3400-\u9FFF]/);
  if (cjk) return s.slice(0, 1);
  const parts = s.split(/[\s_\-./]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

export function debounce(fn, ms = 220) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 绝对路径缩写：C:\Users\M\...\skills\x → ~\.workbuddy-ai\skills\x */
export function shortPath(p, max = 56) {
  const raw = String(p || '');
  const home = String(window.__HOME__ || '');
  let s = raw;

  if (home) {
    const a = raw.replace(/\//g, '\\').toLowerCase();
    const b = home.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    if (a.startsWith(b)) s = '~' + raw.replace(/\//g, '\\').slice(b.length);
  }

  if (s.length <= max) return s;

  const parts = s.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return '…' + s.slice(-max);
  const head = /^[A-Za-z]:$/.test(parts[0]) ? parts[0] + '\\' : parts[0] === '~' ? '~\\' : '';
  const tail = parts.slice(-2).join('\\');
  const out = head + '…\\' + tail;
  return out.length <= max ? out : '…\\' + parts.slice(-1)[0];
}

export function isZh(text) {
  const cjk = (String(text).match(/[\u3400-\u9FFF]/g) || []).length;
  return cjk > String(text).length * 0.15;
}

export function pickLang(text) {
  return isZh(text) ? 'zh-CN' : 'en-US';
}
