'use strict';
/**
 * docx.js — 只读提取 .docx 正文（不引第三方库）
 *
 * .docx 本质是一个 zip，正文在 word/document.xml。
 * 这里做两件事：解析 zip 中央目录找到该条目 → inflate → 把 XML 还原成带段落/标题的纯文本。
 * 只读，不落盘，不执行任何宏。
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

const EOCD = 0x06054b50;
const CEN = 0x02014b50;

function readEntry(buf, want) {
  let eocd = -1;
  const stop = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (name === want) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** 把 document.xml 拆成「段落」文本，标题样式还原成 Markdown 井号 */
function xmlToText(xml) {
  const paras = xml.split(/<\/w:p>/);
  const out = [];

  for (const raw of paras) {
    if (!raw.trim()) continue;

    const style = (raw.match(/<w:pStyle[^>]*w:val="([^"]+)"/) || [])[1] || '';
    let text = raw
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<w:cr\/>/g, '\n')
      .replace(/<[^>]+>/g, '');
    text = decodeEntities(text).replace(/[ \t]+$/gm, '').trim();
    if (!text) continue;

    const hm = style.match(/^Heading(\d)$/i) || style.match(/^heading (\d)$/i);
    if (hm) out.push('#'.repeat(Math.min(6, Number(hm[1]))) + ' ' + text);
    else if (/^(Title|Subtitle)$/i.test(style)) out.push('# ' + text);
    else if (/^ListParagraph$/i.test(style)) out.push('- ' + text);
    else out.push(text);
  }

  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @returns {{ok:true, text:string, paragraphs:number}|{ok:false, error:string}}
 */
function extract(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return { ok: false, error: e.message }; }
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    return { ok: false, error: '不是有效的 docx（可能是旧版 .doc 或被加密）' };
  }
  const entry = readEntry(buf, 'word/document.xml');
  if (!entry) return { ok: false, error: 'docx 内未找到 word/document.xml' };

  const text = xmlToText(entry.toString('utf8'));
  return { ok: true, text, paragraphs: text ? text.split(/\n{2,}/).length : 0 };
}

module.exports = { extract };
