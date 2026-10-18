/**
 * align.mjs — 双语对齐内核（渲染进程 / 主进程 / 测试共用 · 纯 ESM）
 *
 * 并排阅读器的「滚动同步」与「选中同步」都建立在同一套映射上：
 *   源文本里的第 X 个字符  ←→  译文里的第 Y 个字符
 * 两个语言的句数、句长都不相等，所以不能按「第几句」硬配对，
 * 只能按「累计字符比例」落点，再吸附到目标语言最近的句子边界。
 *
 * 这套算法只依赖字符串，不碰 DOM，便于单测。
 */

const CJK_END = '。！？；…';
const LATIN_END = '.!?;';
const CLOSERS = /["'”’）)】」』》*_]/;

const ABBR = /\b(e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Prof|St|No|Fig|approx|Inc|Ltd|Jr|Sr)\.?$/i;

function trimStart(s, a, b) {
  let i = a;
  while (i < b && /\s/.test(s[i])) i++;
  return i;
}

function trimEnd(s, a, b) {
  let j = b;
  while (j > a && /\s/.test(s[j - 1])) j--;
  return j;
}

/**
 * 切句。中英混排都能切，且保护小数、缩写、代码标识符里的点。
 * @returns {Array<{start:number,end:number}>} 相对原串的字符区间
 */
export function sentenceSpans(text) {
  const s = String(text || '');
  const spans = [];
  let start = 0;
  let i = 0;

  while (i < s.length) {
    const ch = s[i];
    let cut = -1;

    if (CJK_END.includes(ch)) {
      cut = i + 1;
      // 连续的句末符号（…… / ！？）一起吃掉
      while (cut < s.length && CJK_END.includes(s[cut])) cut++;
    } else if (LATIN_END.includes(ch)) {
      const next = s[i + 1];
      const isBoundary = next === undefined || /[\s"'”’）)】]/.test(next);
      if (isBoundary) {
        const before = s.slice(Math.max(0, i - 24), i + 1);
        const isAbbr = ABBR.test(before.trim());
        const isDecimal = /\d/.test(s[i - 1] || '') && /\d/.test(next || '');
        if (!isAbbr && !isDecimal) cut = i + 1;
      }
    }

    if (cut > 0) {
      while (cut < s.length && CLOSERS.test(s[cut])) cut++;
      const a = trimStart(s, start, cut);
      const b = trimEnd(s, a, cut);
      if (b > a) spans.push({ start: a, end: b });
      start = cut;
      while (start < s.length && /\s/.test(s[start])) start++;
      i = start;
      continue;
    }
    i++;
  }

  const a = trimStart(s, start, s.length);
  const b = trimEnd(s, a, s.length);
  if (b > a) spans.push({ start: a, end: b });

  if (!spans.length) return s.trim() ? [{ start: 0, end: s.length }] : [];
  return spans;
}

/** 某个字符偏移落在第几句（找不到就返回 -1） */
export function spanIndexAt(spans, off) {
  for (let i = 0; i < spans.length; i++) {
    if (off >= spans[i].start && off < spans[i].end) return i;
  }
  return -1;
}

/** 取离该偏移最近的一句 */
export function spanAt(spans, off) {
  if (!spans.length) return null;
  const hit = spanIndexAt(spans, off);
  if (hit >= 0) return spans[hit];
  for (const sp of spans) if (off < sp.start) return sp;
  return spans[spans.length - 1];
}

/** 字符偏移按长度比例映射（唯一不会因语种长度差而错位的做法） */
export function mapOffset(lenA, lenB, off) {
  if (!lenA) return 0;
  const r = Math.max(0, Math.min(1, off / lenA));
  return Math.round(r * lenB);
}

/**
 * 把源文本里的一个区间映射到目标文本，并吸附到目标语言的句子边界。
 * 选区跨多句时，取首句起点 → 末句终点。
 */
export function mapSpan(textA, textB, startA, endA) {
  const a = String(textA || '');
  const b = String(textB || '');
  if (!b.trim()) return null;

  const spans = sentenceSpans(b);
  if (!spans.length) return null;

  const s = mapOffset(a.length, b.length, startA);
  const e = mapOffset(a.length, b.length, Math.max(startA, endA));
  const i = Math.max(0, spanIndexAt(spans, s) >= 0 ? spanIndexAt(spans, s) : 0);
  const jRaw = spanIndexAt(spans, Math.max(s, e - 1));
  const j = jRaw >= 0 ? jRaw : i;

  const from = spans[Math.min(i, j)];
  const to = spans[Math.max(i, j)];
  return { start: from.start, end: to.end, from: Math.min(i, j), to: Math.max(i, j) };
}

/**
 * 行间对照：把目标文本的句子按位置分给 n 个源句。
 *
 * 每句只归属一个桶（按句子中点落位），所以不会出现同一句译文被两条源句
 * 重复显示。目标句比源句少时，空桶返回 null —— 宁可少一行，也不重复。
 */
export function groupSentences(n, textB) {
  const b = String(textB || '');
  const spans = sentenceSpans(b);
  if (!spans.length || n <= 0) return [];

  const buckets = Array.from({ length: n }, () => []);
  const total = b.length || 1;
  for (const sp of spans) {
    const mid = (sp.start + sp.end) / 2;
    const idx = Math.min(n - 1, Math.max(0, Math.floor((mid / total) * n)));
    buckets[idx].push(sp);
  }

  return buckets.map((list) => (list.length
    ? { start: list[0].start, end: list[list.length - 1].end }
    : null));
}

/** 去掉切句时被拆散、落单的强调符号（** / __），否则行间对照会露出星号 */
function balanceEmphasis(s) {
  let t = String(s || '').trim();
  const marks = () => (t.match(/\*\*/g) || []).length;
  for (let guard = 0; guard < 4 && marks() % 2 === 1; guard++) {
    if (t.startsWith('**')) t = t.slice(2).trim();
    else if (t.endsWith('**')) t = t.slice(0, -2).trim();
    else break;
  }
  return t;
}

/** 行间对照：把译文切成与源句一一对应的片段 */
export function pairSentences(textA, textB) {
  const a = String(textA || '');
  const b = String(textB || '');
  const src = sentenceSpans(a).map((sp) => a.slice(sp.start, sp.end));
  const dst = b;
  if (!src.length) return [];
  if (!dst.trim()) return src.map(() => '');

  const dstSpans = sentenceSpans(dst);
  // 句数刚好相等就一一对应 —— 比按比例分桶精确得多
  if (dstSpans.length === src.length) {
    return dstSpans.map((sp) => balanceEmphasis(dst.slice(sp.start, sp.end)));
  }

  const groups = groupSentences(src.length, dst);
  return groups.map((g) => (g ? balanceEmphasis(dst.slice(g.start, g.end)) : ''));
}

/* ------------------------- 词级对齐（006 轮） ------------------------- */

/**
 * 在文本里找某个词的所有出现位置，返回离 near 最近的那一处。
 * 词级高亮要求「精确落到那个词」，所以不能像句子映射那样按比例估算。
 * @returns {{start:number,end:number}|null}
 */
export function findTermSpan(text, term, near = 0) {
  const s = String(text || '');
  const t = String(term || '');
  if (!s || !t) return null;

  let best = null;
  let idx = s.indexOf(t);
  while (idx >= 0) {
    const d = Math.abs(idx - near);
    if (!best || d < best.d) best = { start: idx, end: idx + t.length, d };
    idx = s.indexOf(t, idx + 1);
  }
  return best ? { start: best.start, end: best.end } : null;
}

/**
 * 从一组 [源词, 译词] 里挑出与选区重叠的那一对。
 *
 * 选一个单词时，选区通常落在某个短语内部（模型给的是短语对），
 * 所以用「重叠字符数 / 词条长度」打分，取覆盖度最高的那一对；
 * 完全没重叠才返回 null，交给句子级映射兜底。
 *
 * @param {Array<[string,string]>} pairs
 * @param {string} text 选区所在的整块文本
 * @param {number} start 选区起点（相对整块）
 * @param {number} end 选区终点
 * @param {0|1} side 0 = 选区在源文，1 = 选区在译文
 */
export function pickAlignPair(pairs, text, start, end, side = 0) {
  const s = String(text || '');
  if (!Array.isArray(pairs) || !pairs.length || !s) return null;
  const a = Math.max(0, Math.min(start, end));
  const b = Math.max(start, end);
  if (b <= a) return null;

  let best = null;
  for (const p of pairs) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const term = String(p[side] || '');
    if (!term) continue;
    let idx = s.indexOf(term);
    while (idx >= 0) {
      const ts = idx;
      const te = idx + term.length;
      const overlap = Math.min(te, b) - Math.max(ts, a);
      if (overlap > 0) {
        const score = overlap / Math.max(1, te - ts);
        if (!best || score > best.score) {
          best = { pair: p, start: ts, end: te, score, term };
        }
      }
      idx = s.indexOf(term, idx + 1);
    }
  }
  return best;
}

/**
 * 选中的是不是「一个词/短语」而不是整段。
 * 超过这个长度就按句子映射走 —— 长选区用词对齐反而会切碎。
 */
export function isWordSelection(text, max = 48) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (s.length > max) return false;
  return true;
}
