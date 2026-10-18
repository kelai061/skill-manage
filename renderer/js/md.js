/* md.js — 轻量 Markdown 渲染（无第三方依赖，输出前全部转义） */

import { esc } from './util.js';
import { pairSentences } from '../../shared/align.mjs';

/* --------------------------- 行内元素 --------------------------- */

export function inline(text) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  // 图片 → 链接兜底（本地文件不加载远程图，避免意外外连）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_, alt, href) => `<a href="${href}" title="${alt}">${alt || href}</a>`);

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_, label, href) => `<a href="${href}" data-link="1">${label}</a>`);

  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // 段落内的软换行按 Markdown 语义折成空格；行尾两个空格才是硬换行。
  // 之前的实现把每个 \n 都变成 <br/>，导致原文栏被拆成一截一截，既难看又拉高了两栏高度差。
  s = s.replace(/[ \t]{2,}\n/g, '\u0000B\u0000').replace(/\s*\n\s*/g, ' ').replace(/\u0000B\u0000/g, '<br/>');

  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

/* --------------------------- 块级元素 --------------------------- */

function renderCode(raw) {
  const lines = raw.split('\n');
  const first = lines[0] || '';
  const lang = first.replace(/^(`{3,}|~{3,})/, '').trim();
  const body = lines.slice(1, lines[lines.length - 1].trim().startsWith('```') || lines[lines.length - 1].trim().startsWith('~~~')
    ? lines.length - 1
    : lines.length).join('\n');
  return `<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body)}</code></pre>`;
}

function renderTable(raw) {
  const rows = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (rows.length < 2) return '';
  const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
  const tb = body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
}

function renderList(raw) {
  const lines = raw.split('\n');
  const items = [];
  for (const line of lines) {
    const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (m) {
      items.push({
        indent: m[1].replace(/\t/g, '  ').length,
        ordered: /^\d/.test(m[2]),
        text: m[3]
      });
    } else if (items.length && line.trim()) {
      items[items.length - 1].text += ' ' + line.trim();
    }
  }
  if (!items.length) return '';

  const root = { children: [], ordered: items[0].ordered };
  const stack = [{ indent: -1, node: root }];

  for (const it of items) {
    while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    const li = { text: it.text, ordered: it.ordered, children: [] };
    if (!parent.children) parent.children = [];
    parent.children.push(li);
    stack.push({ indent: it.indent, node: li });
  }

  const renderNodes = (nodes) => nodes.map((n) => {
    const inner = n.children && n.children.length
      ? renderListNodes(n.children, n.children[0].ordered)
      : '';
    return `<li>${inline(n.text)}${inner}</li>`;
  }).join('');

  const renderListNodes = (nodes, ordered) => {
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag}>${renderNodes(nodes)}</${tag}>`;
  };

  return renderListNodes(root.children, root.ordered);
}

function renderMeta(raw) {
  const keep = new Set(['name', 'description', 'version', 'license', 'author', 'allowed-tools']);
  const rows = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    if (!keep.has(m[1])) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    if (!v) continue;
    rows.push([m[1], v]);
  }
  if (!rows.length) return '';
  return `<div class="fm">${rows.map(([k, v]) => `
    <div class="fm__row"><span class="fm__k">${esc(k)}</span><span class="fm__v">${esc(v)}</span></div>`).join('')}
  </div>`;
}

export function renderBlock(b) {
  switch (b.type) {
    case 'meta': return renderMeta(b.raw);
    case 'heading': {
      const lv = Math.min(6, Math.max(1, b.level || 1));
      return `<h${lv} data-anchor="h-${b.i}">${inline(b.text)}</h${lv}>`;
    }
    case 'code': return renderCode(b.raw);
    case 'table': return renderTable(b.raw);
    case 'hr': return '<hr/>';
    case 'quote': return `<blockquote>${b.raw.split('\n').map((l) => inline(l)).join('<br/>')}</blockquote>`;
    case 'list': return renderList(b.raw);
    default: return `<p>${inline(b.raw)}</p>`;
  }
}


/* --------------------------- 中文排版 --------------------------- */

/**
 * 中英混排加空格：中文与拉丁字母/数字之间补一个空格，中文标点两侧不留空格。
 * 行内代码（`...`）原样跳过，避免把标识符改坏。
 */
export function cjkSpace(text) {
  const s = String(text || '');
  const parts = s.split(/(`[^`\n]*`)/);
  return parts.map((p, i) => {
    if (i % 2 === 1) return p;
    return p
      .replace(/([\u3400-\u9FFF\uF900-\uFAFF])([A-Za-z0-9@#$%&])/g, '$1 $2')
      .replace(/([A-Za-z0-9%)\]}>.,:;!?])([\u3400-\u9FFF\uF900-\uFAFF])/g, '$1 $2')
      .replace(/[ \t]+([，。！？；：、）】」』])/g, '$1')
      .replace(/([（【「『])[ \t]+/g, '$1')
      .replace(/[ \t]{2,}/g, ' ');
  }).join('');
}

/**
 * 把模型返回的「一整段译文」拆回列表项。
 * 模型常见的两种写法：保留换行，或把 1. 2. 3. 全塞进一行 —— 两种都要拆开。
 */
function splitListItems(text) {
  const s = String(text || '').replace(/\r/g, '').trim();
  if (!s) return [];

  // ① 有换行：按行拆，去掉行首标记
  const byLine = s.split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.replace(/^([-*+•]|\d{1,2}[.)、])\s*/, '').trim())
    .filter(Boolean);
  if (byLine.length > 1) return byLine;

  // ② 单行里带编号：按「2.」「3.」这种切
  const marks = [...s.matchAll(/(?:^|[\s；;。])(\d{1,2})[.)、]\s+/g)];
  if (marks.length >= 1) {
    const out = [];
    if (marks[0].index > 0) {
      const head = s.slice(0, marks[0].index).replace(/^\d{1,2}[.)、]\s*/, '').trim();
      if (head) out.push(head);
    }
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].index + marks[i][0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index : s.length;
      const t = s.slice(start, end).trim();
      if (t) out.push(t);
    }
    if (out.length > 1) return out;
  }

  // ③ 无序列表：按 • / - / * 切
  const bullets = [...s.matchAll(/(?:^|\s)[-*•]\s+/g)];
  if (bullets.length >= 1) {
    const out = [];
    for (let i = 0; i < bullets.length; i++) {
      const start = bullets[i].index + bullets[i][0].length;
      const end = i + 1 < bullets.length ? bullets[i + 1].index : s.length;
      const t = s.slice(start, end).trim();
      if (t) out.push(t);
    }
    if (out.length > 1) return out;
  }

  return [];
}

/** 译文列表：能拆开就渲染成真正的 <ol>/<ul>，拆不开退回单段 */
function renderTranslatedList(b, text) {
  const srcLines = String(b.raw || '').split('\n').filter((l) => /^\s*([-*+]|\d+[.)])\s+/.test(l));
  const ordered = /^\s*\d/.test(srcLines[0] || '');
  const items = splitListItems(text);
  if (items.length < 2) return null;

  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${items.map((it) => `<li>${inline(cjkSpace(it))}</li>`).join('')}</${tag}>`;
}

/* --------------------------- 句子切分（行间对照用） --------------------------- */

export function splitSentences(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  // 中文按 。！？； 切，英文按 .!?; 后跟空格切；保护常见缩写与小数
  const parts = s
    .replace(/([.!?;])\s+(?=[A-Z0-9"'(])/g, '$1\u0001')
    .replace(/([。！？；])/g, '$1\u0001')
    .split('\u0001')
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : [s];
}

/* --------------------------- 整篇渲染 --------------------------- */

/**
 * @param {Array} blocks segmentMarkdown 的输出
 * @param {object} opts { translations, interlinear, spacing, lang }
 *
 * 铁律：无论 lang 是 src 还是 dst，输出的 .blk 序列必须**完全同构**——
 * 同一个 seg 在两栏里各出现一次、顺序一致。滚动同步与选中同步都只认这个编号。
 */
export function renderProse(blocks, opts = {}) {
  const { translations = null, interlinear = false, spacing = false, lang = 'src' } = opts;
  const out = [];
  const wrap = (b, inner, extra = '') =>
    `<div class="blk" data-seg="${b.i}" data-type="${b.type}"><div class="blk__src">${inner}</div>${extra}</div>`;

  for (const b of blocks) {
    const tr = translations ? translations[b.i] : null;

    if (lang === 'dst') {
      // 译文栏：块编号与原文一一对应。
      // 不翻译的块（代码 / 表格 / 元信息 / --- 分割线）原样渲染 —— 既让读者看得到，
      // 也让两栏的块序列保持同构，滚动时才不会一路错位。
      if (!b.translatable) {
        out.push(wrap(b, renderBlock(b)));
        continue;
      }
      const text = tr || '';
      if (!text.trim()) {
        // 占位块：高度为 0 但必须存在，否则块编号会错开
        out.push(`<div class="blk blk--empty" data-seg="${b.i}" data-type="${b.type}"></div>`);
        continue;
      }
      if (b.type === 'list') {
        const html = renderTranslatedList(b, text);
        if (html) { out.push(wrap(b, html)); continue; }
      }
      const tag = b.type === 'heading' ? `h${Math.min(6, Math.max(2, b.level || 2))}` : 'p';
      out.push(wrap(b, `<${tag}>${inline(cjkSpace(text))}</${tag}>`));
      continue;
    }

    const html = renderBlock(b);
    let extra = '';
    // 译文与原文完全一致（多为标题、专有名词）时不重复显示
    const same = tr && tr.trim() === b.text.trim();
    if (interlinear && tr && !same) {
      // 逐句配对；句数不等时允许某些源句没有对应译文行，但绝不重复显示
      const pairs = pairSentences(b.text, tr).filter((s) => s && s.trim());
      if (pairs.length > 1) {
        extra = `<span class="blk__tr${spacing ? ' blk__tr--spacing' : ''}">` +
          pairs.map((s) => `<span class="blk__pair">${inline(cjkSpace(s))}</span>`).join('') +
          `</span>`;
      } else {
        extra = `<span class="blk__tr${spacing ? ' blk__tr--spacing' : ''}">${inline(cjkSpace(tr))}</span>`;
      }
    }
    out.push(wrap(b, html, extra));
  }

  return out.join('\n');
}

/** 从块里抽目录 */
export function outline(blocks) {
  return blocks
    .filter((b) => b.type === 'heading' && b.level <= 3)
    .map((b) => ({ i: b.i, level: b.level, text: b.text }));
}

/** 纯文本化（用于朗读 / 复制） */
export function plainOf(block) {
  return block.text || '';
}
