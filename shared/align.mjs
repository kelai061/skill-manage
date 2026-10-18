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
  const spans = findTermSpans(text, term);
  if (!spans.length) return null;
  let best = spans[0];
  for (const sp of spans) if (Math.abs(sp.start - near) < Math.abs(best.start - near)) best = sp;
  return { start: best.start, end: best.end, index: best.index };
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

/* ------------------ 012 轮：结构级 + 词级的严格对应 ------------------ */

/**
 * 对齐算法版本。缓存必须带上它：算法改了，旧词对可能指向错误位置，
 * 必须失效重建，否则「修好了界面却还在用旧结果」。
 */
export const ALIGN_VERSION = 2;

const LATIN_WORD = /[A-Za-z0-9_'-]/;

function isLatin(ch) {
  return !!ch && LATIN_WORD.test(ch);
}

/**
 * 词边界：拉丁词不能在更长的词内部命中（link 不得命中 blink / links）。
 * 中文没有词边界，靠字面命中即可。
 */
export function hasWordBoundary(text, start, end) {
  const s = String(text || '');
  if (start < 0 || end > s.length) return false;
  const first = s[start];
  const last = s[end - 1];
  const before = start > 0 ? s[start - 1] : '';
  const after = end < s.length ? s[end] : '';
  if (isLatin(first) && isLatin(before)) return false;
  if (isLatin(last) && isLatin(after)) return false;
  return true;
}

/** 把模型给的词条还原成「可见文本」：去掉 ** / ` / ~~ / 链接语法 */
export function plainTerm(term) {
  return String(term || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .trim();
}

/**
 * 找出某个词条在文本里的所有合法出现位置（带词边界过滤）。
 * @returns {Array<{start:number,end:number,index:number}>}
 */
export function findTermSpans(text, term) {
  const s = String(text || '');
  const t = String(term || '');
  const out = [];
  if (!s || !t) return out;
  let idx = s.indexOf(t);
  while (idx >= 0) {
    if (hasWordBoundary(s, idx, idx + t.length)) {
      out.push({ start: idx, end: idx + t.length, index: out.length });
    }
    idx = s.indexOf(t, idx + 1);
  }
  return out;
}

/**
 * 从一组 [源词, 译词] 里挑出与选区重叠的那一对。
 *
 * 006 轮只看「交集 / 词条长度」，少量相交也能命中，于是「选一个链接」
 * 可能抓到整句词条。012 轮加三条硬约束：
 *   1. 覆盖率按「选区与词条里较短的那个」算，必须 ≥ 0.6；
 *   2. 命中位置必须落在词边界上；
 *   3. 只在选区所属的结构单元（行）内找。
 *
 * @param {Array<[string,string]>} pairs
 * @param {string} text 选区所在的整块文本
 * @param {number} start 选区起点（相对整块）
 * @param {number} end 选区终点
 * @param {0|1} side 0 = 选区在源文，1 = 选区在译文
 * @param {{from?:number,to?:number}} [bounds] 只在该区间内取词条
 */
export function pickAlignPair(pairs, text, start, end, side = 0, bounds = null) {
  const s = String(text || '');
  if (!Array.isArray(pairs) || !pairs.length || !s) return null;
  const a = Math.max(0, Math.min(start, end));
  const b = Math.max(start, end);
  if (b <= a) return null;
  const lo = bounds && Number.isFinite(bounds.from) ? bounds.from : 0;
  const hi = bounds && Number.isFinite(bounds.to) ? bounds.to : s.length;

  let best = null;
  for (const p of pairs) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const raw = String(p[side] || '');
    // 跨行词条 = 跨列表项/段落，一定不是词级对应，直接丢弃
    if (!raw || raw.includes('\n')) continue;
    for (const sp of findTermSpans(s, raw)) {
      if (sp.start < lo || sp.end > hi) continue;
      const overlap = Math.min(sp.end, b) - Math.max(sp.start, a);
      if (overlap <= 0) continue;
      const shorter = Math.min(b - a, sp.end - sp.start);
      const score = overlap / Math.max(1, shorter);
      if (score < 0.6) continue;
      const exact = sp.end - sp.start === b - a ? 1 : 0;
      const better = !best
        || score > best.score + 1e-9
        || (Math.abs(score - best.score) <= 1e-9 && exact > best.exact)
        || (Math.abs(score - best.score) <= 1e-9 && exact === best.exact && (sp.end - sp.start) < (best.end - best.start));
      if (better) best = { pair: p, start: sp.start, end: sp.end, score, exact, term: raw };
    }
  }
  return best;
}

/**
 * 结构切分：多行块按行（列表项 / 引用行），单行块按句。
 * 这是「一个列表项不能跳到相邻列表项」的地基 —— 行索引一一对应，
 * 不再用字符比例去猜。
 */
export function structureOf(text) {
  const s = String(text || '');
  const lines = [];
  let from = 0;
  for (let i = 0; i <= s.length; i++) {
    if (i !== s.length && s[i] !== '\n') continue;
    let a = from;
    let b = i;
    while (a < b && /\s/.test(s[a])) a++;
    while (b > a && /\s/.test(s[b - 1])) b--;
    if (b > a) lines.push({ start: a, end: b });
    from = i + 1;
  }
  if (!lines.length) return [];

  // 只有一行时，这一行内部按句子细分；多行时每行就是结构单元
  const units = lines.length >= 2 ? lines : [lines[0]];
  return units.map((l) => {
    const seg = s.slice(l.start, l.end);
    const sents = sentenceSpans(seg).map((x) => ({ start: x.start + l.start, end: x.end + l.start }));
    return {
      start: l.start,
      end: l.end,
      sentences: sents.length ? sents : [{ start: l.start, end: l.end }]
    };
  });
}

/** 偏移落在第几个结构单元（找不到就取最近的） */
export function unitIndexAt(units, off) {
  if (!units || !units.length) return -1;
  for (let i = 0; i < units.length; i++) {
    if (off >= units[i].start && off < units[i].end) return i;
  }
  for (let i = 0; i < units.length; i++) if (off < units[i].start) return i;
  return units.length - 1;
}

function nearIn(fromUnit, toUnit, off, aligned) {
  if (!fromUnit || !toUnit) return 0;
  if (!aligned) return toUnit.start;
  const r = (off - fromUnit.start) / Math.max(1, fromUnit.end - fromUnit.start);
  return toUnit.start + Math.max(0, Math.min(1, r)) * (toUnit.end - toUnit.start);
}

/**
 * 选中对应的唯一决策点（纯函数，渲染进程与单测共用）。
 *
 * 判定顺序：词对（同结构单元内） → 同句 / 同行 / 跨行 → 块内比例兜底。
 * 词对不成立时**不显示词级气泡**，只退到同一结构单元，绝不拿整块充数。
 *
 * @param {{textA:string,textB:string,start:number,end:number,pairs?:Array,side?:0|1}} opts
 * @returns {{kind:'word'|'sentence'|'line'|'range'|'block'|'none',start?:number,end?:number,
 *            term?:string,targetTerm?:string,line?:number,occurrence?:number}}
 */
export function resolveSelection(opts) {
  const o = opts || {};
  const A = String(o.textA || '');
  const B = String(o.textB || '');
  const side = o.side === 1 ? 1 : 0;
  const a = Math.max(0, Math.min(Number(o.start) || 0, Number(o.end) || 0));
  const b = Math.max(a, Number(o.end) || 0);
  if (!B.trim() || b <= a) return { kind: 'none' };

  const src = structureOf(A);
  const dst = structureOf(B);
  if (!src.length) return { kind: 'none' };

  const l1 = Math.max(0, unitIndexAt(src, a));
  const l2 = Math.max(l1, unitIndexAt(src, Math.max(a, b - 1)));
  const sameLines = src.length === dst.length;
  const lineA = src[l1];

  // ① 词级：选区短、有词对、且词条落在同一结构单元内
  //    跨行/跨句的选区绝不走词级 —— 否则「选两项」只会高亮其中一个词
  const sel = A.slice(a, b).trim();
  const singleSentence = l1 === l2
    && unitIndexAt(lineA.sentences, a) === unitIndexAt(lineA.sentences, Math.max(a, b - 1));
  if (singleSentence && Array.isArray(o.pairs) && o.pairs.length && sel && isWordSelection(sel)) {
    const hit = pickAlignPair(o.pairs, A, a, b, side, { from: lineA.start, to: lineA.end });
    if (hit) {
      const targetTerm = plainTerm(hit.pair[1 - side]);
      if (targetTerm) {
        let lo = 0;
        let hi = B.length;
        if (sameLines) { lo = dst[l1].start; hi = dst[l1].end; }
        const near = sameLines
          ? nearIn(lineA, dst[l1], a, true)
          : (a / Math.max(1, A.length)) * B.length;
        const spans = findTermSpans(B, targetTerm).filter((sp) => sp.start >= lo && sp.end <= hi);
        if (spans.length) {
          let pick = spans[0];
          for (const sp of spans) if (Math.abs(sp.start - near) < Math.abs(pick.start - near)) pick = sp;
          return {
            kind: 'word',
            start: pick.start,
            end: pick.end,
            term: String(hit.pair[side] || ''),
            targetTerm,
            line: l1,
            occurrence: pick.index
          };
        }
      }
    }
  }

  // ② 结构级：行索引对齐（中英句数不等时退到行；行数不等才用比例）
  if (sameLines) {
    if (l1 === l2) {
      const sa = lineA.sentences;
      const sb = dst[l1].sentences;
      if (sa.length === sb.length) {
        const s1 = Math.max(0, unitIndexAt(sa, a));
        const s2 = Math.max(s1, unitIndexAt(sa, Math.max(a, b - 1)));
        return {
          kind: s1 === s2 ? 'sentence' : 'range',
          start: sb[s1].start,
          end: sb[s2].end,
          line: l1
        };
      }
      return { kind: 'line', start: dst[l1].start, end: dst[l1].end, line: l1 };
    }
    return { kind: 'range', start: dst[l1].start, end: dst[l2].end, line: l1 };
  }

  // ③ 块内比例兜底：同一块、同一行语义单元，不做词级气泡
  const m = mapSpan(A, B, a, b);
  return m ? { kind: 'block', start: m.start, end: m.end } : { kind: 'none' };
}
