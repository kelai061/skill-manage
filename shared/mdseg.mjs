/**
 * mdseg.mjs — Markdown 结构切分器（主进程 / 渲染进程共用 · 纯 ESM）
 *
 * 把一份 Markdown 切成「块」，每个块是可独立渲染、可独立翻译的单元。
 * 双语对照的全部对齐能力都建立在这个稳定的块编号上：
 *   原文第 N 块  ←→  译文第 N 条
 * 只要块编号不变，译文就永远不会错位。
 */

const FENCE = /^(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

const isBlank = (line) => line.trim() === '';

/**
 * @param {string} md
 * @returns {Array<{i:number,type:string,level:number,raw:string,text:string,translatable:boolean}>}
 */
export function segmentMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let n = 0;

  const push = (type, raw, opts = {}) => {
    blocks.push({
      i: n++,
      type,
      level: opts.level || 0,
      raw,
      text: opts.text !== undefined ? opts.text : raw,
      translatable: opts.translatable !== false
    });
  };

  // ---- 前置 frontmatter：单独成块，不参与翻译 ----
  if (lines.length && lines[0].trim() === '---') {
    let end = -1;
    for (let k = 1; k < lines.length; k++) {
      if (lines[k].trim() === '---') { end = k; break; }
    }
    if (end > 0) {
      push('meta', lines.slice(1, end).join('\n'), { translatable: false });
      i = end + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) { i++; continue; }

    // ---- 代码围栏（整块不翻译） ----
    if (FENCE.test(line)) {
      const marker = line.trim().slice(0, 3);
      const buf = [line];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) { buf.push(lines[i]); i++; }
      push('code', buf.join('\n'), { translatable: false });
      continue;
    }

    // ---- 标题 ----
    const h = line.match(HEADING);
    if (h) {
      push('heading', line, { level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    // ---- 分割线 ----
    if (HR.test(line)) {
      push('hr', line, { translatable: false });
      i++;
      continue;
    }

    // ---- 表格（整块不翻译，保持原样最稳） ----
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const buf = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      push('table', buf.join('\n'), { translatable: false });
      continue;
    }

    // ---- 引用块 ----
    if (QUOTE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        buf.push(lines[i].replace(QUOTE, ''));
        i++;
      }
      push('quote', buf.join('\n'));
      continue;
    }

    // ---- 列表（连续项合并为一个块） ----
    if (LIST.test(line)) {
      const buf = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (LIST.test(cur) || (!isBlank(cur) && /^\s{2,}/.test(cur))) {
          buf.push(cur);
          i++;
          continue;
        }
        if (isBlank(cur) && i + 1 < lines.length && LIST.test(lines[i + 1])) {
          buf.push('');
          i++;
          continue;
        }
        break;
      }
      push('list', buf.join('\n'));
      continue;
    }

    // ---- 普通段落 ----
    const buf = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (isBlank(cur)) break;
      if (FENCE.test(cur) || HEADING.test(cur) || HR.test(cur) || QUOTE.test(cur)) break;
      if (LIST.test(cur) && buf.length) break;
      if (TABLE_ROW.test(cur) && buf.length) break;
      buf.push(cur);
      i++;
    }
    if (buf.length) push('paragraph', buf.join('\n'));
    else i++;
  }

  return blocks;
}

/** 抽出需要翻译的块 → {ids, texts}（两数组同长同序） */
export function translatableOf(blocks) {
  const ids = [];
  const texts = [];
  for (const b of blocks) {
    if (b.translatable && b.text.trim()) {
      ids.push(b.i);
      texts.push(b.text);
    }
  }
  return { ids, texts };
}

/** 中英混排字数统计 */
export function countWords(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
  const latin = (s.replace(/[\u3400-\u9FFF\uF900-\uFAFF]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  return cjk + latin;
}
