/**
 * domtext.js — DOM ↔ 可见文本坐标系
 *
 * 为什么需要它：选区同步与批注都靠「第几个字符」定位，而 `textContent`
 * 会把 <li>a</li><li>b</li> 粘成 "ab"，两个列表项之间没有任何分隔，
 * 于是「第二个列表项」永远算不出来，只能退化成按比例猜 —— 这正是
 * 012 轮「选译文里的链接，原文高亮跑到上一项」的根因。
 *
 * 这里把 DOM 展开成一份**虚拟文本**：块级元素（li / p / br / tr …）之间
 * 补一个 \n，行内元素（strong / code / a）原样拼接。偏移、区间、结构切分
 * 全部基于这份文本，Markdown 的 ** / ` / 链接语法天然不参与偏移。
 */

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'TABLE', 'TBODY', 'THEAD', 'TR', 'UL'
]);

function build(root) {
  const segs = [];
  let text = '';

  const sep = () => {
    if (text && !text.endsWith('\n')) text += '\n';
  };

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const v = child.nodeValue || '';
        if (!v) continue;
        segs.push({ node: child, start: text.length, end: text.length + v.length });
        text += v;
      } else if (child.nodeType === 1) {
        const tag = child.tagName;
        if (tag === 'BR') { sep(); continue; }
        const block = BLOCK_TAGS.has(tag);
        if (block) sep();
        walk(child);
        if (block) sep();
      }
    }
  };

  walk(root);
  return { text, segs };
}

export function virtualText(root) {
  if (!root) return { text: '', segs: [] };
  return build(root);
}

function firstText(node) {
  if (!node) return null;
  if (node.nodeType === 3) return node;
  for (const c of node.childNodes) {
    const hit = firstText(c);
    if (hit) return hit;
  }
  return null;
}

function lastText(node) {
  if (!node) return null;
  if (node.nodeType === 3) return node;
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const hit = lastText(node.childNodes[i]);
    if (hit) return hit;
  }
  return null;
}

/** 把 DOM 位置（node, offset）换成虚拟文本偏移 */
export function offsetAt(root, node, offset) {
  const { segs } = build(root);
  if (!segs.length) return 0;

  let target = node;
  let at = offset;

  if (target && target.nodeType === 1) {
    // 选中整个元素（三击 / 跨元素）时，endContainer 常是元素节点
    const child = target.childNodes[at];
    if (child) {
      const t = firstText(child);
      if (t) { target = t; at = 0; }
      else {
        // 该子节点没有文本，退到它前面那个文本节点的末尾
        const prev = target.childNodes[at - 1];
        const p = lastText(prev);
        if (p) { target = p; at = (p.nodeValue || '').length; }
      }
    } else {
      const p = lastText(target);
      if (p) { target = p; at = (p.nodeValue || '').length; }
    }
  }

  const seg = segs.find((s) => s.node === target);
  if (!seg) {
    // 找不到就按最近的前一个文本节点收尾，绝不错位到别的块
    let best = 0;
    for (const s of segs) if (s.start <= 0) best = s.end;
    return best;
  }
  return seg.start + Math.max(0, Math.min(at, seg.end - seg.start));
}

/** 虚拟文本偏移 → DOM Range（跨节点也能正确构造） */
export function rangeFromVirtual(root, start, end) {
  const { segs } = build(root);
  if (!segs.length) return null;

  const a = Math.max(0, Math.min(start, end));
  const b = Math.max(start, end);

  let sn = null;
  let so = 0;
  for (const s of segs) {
    if (a <= s.end && a >= s.start) { sn = s.node; so = a - s.start; break; }
    if (a < s.start) { sn = s.node; so = 0; break; }
  }
  if (!sn) { const last = segs[segs.length - 1]; sn = last.node; so = last.end - last.start; }

  let en = null;
  let eo = 0;
  for (const s of segs) {
    if (b >= s.start && b <= s.end) { en = s.node; eo = b - s.start; break; }
  }
  if (!en) {
    // 落在块尾的分隔符里：取最后一个文本节点的末尾
    const last = segs[segs.length - 1];
    en = last.node;
    eo = last.end - last.start;
  }

  try {
    const r = document.createRange();
    r.setStart(sn, Math.max(0, Math.min(so, (sn.nodeValue || '').length)));
    r.setEnd(en, Math.max(0, Math.min(eo, (en.nodeValue || '').length)));
    if (r.collapsed) return null;
    return r;
  } catch {
    return null;
  }
}

/**
 * 旧坐标（textContent，无分隔符）→ Range。
 * 006 及更早写入的批注用的是这套偏移，必须原样还原，不能因为换了
 * 坐标系就让用户已有的高亮整体漂移。
 */
export function rangeFromPlainOffsets(root, start, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode = null;
  let startOff = 0;
  let endNode = null;
  let endOff = 0;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (!startNode && pos + len > start) { startNode = node; startOff = start - pos; }
    if (!endNode && pos + len >= end) { endNode = node; endOff = end - pos; }
    pos += len;
    if (startNode && endNode) break;
  }
  if (!startNode || !endNode) return null;
  try {
    const r = document.createRange();
    r.setStart(startNode, Math.max(0, Math.min(startOff, startNode.nodeValue.length)));
    r.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.nodeValue.length)));
    return r.collapsed ? null : r;
  } catch {
    return null;
  }
}
