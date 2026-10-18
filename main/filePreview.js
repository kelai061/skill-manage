'use strict';
/**
 * filePreview.js — 把「任意附属文件」分类成前端能安全渲染的形态
 *
 * kind:
 *   md      Markdown（可翻译、可词对齐）
 *   text    纯文本
 *   code    代码（前端加行号）
 *   image   图片（data URL）
 *   docx    Word 正文（已抽成 Markdown 风格文本）
 *   binary  不支持预览（给原因，绝不把二进制当 utf8 读成乱码）
 */

const fs = require('node:fs');
const path = require('node:path');
const docx = require('./docx');

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.avif']);
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
};

const CODE = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.go', '.rs', '.rb', '.php', '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.html', '.htm', '.css', '.scss', '.less', '.xml', '.vue', '.svelte', '.lua', '.kt', '.swift',
  '.r', '.m', '.pl', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg'
]);

const TEXT = new Set([
  '.md', '.markdown', '.mdx', '.txt', '.csv', '.tsv', '.log', '.env', '.gitignore', '.npmrc',
  '.editorconfig', '.dockerignore', '.properties', '.conf'
]);

const HINT = {
  '.doc': '旧版 Word（.doc）是二进制格式，无法直接预览；另存为 .docx 即可。',
  '.xls': 'Excel 表格暂不支持预览。',
  '.xlsx': 'Excel 表格暂不支持预览。',
  '.ppt': 'PowerPoint 暂不支持预览。',
  '.pptx': 'PowerPoint 暂不支持预览。',
  '.pdf': 'PDF 暂不支持预览（可以在文件夹中打开）。',
  '.zip': '压缩包不支持预览。',
  '.7z': '压缩包不支持预览。',
  '.rar': '压缩包不支持预览。',
  '.exe': '可执行文件不支持预览。',
  '.dll': '二进制文件不支持预览。',
  '.woff': '字体文件不支持预览。',
  '.woff2': '字体文件不支持预览。',
  '.ttf': '字体文件不支持预览。'
};

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_IMAGE = 12 * 1024 * 1024;
const MAX_DOCX = 8 * 1024 * 1024;

function base(file, st) {
  return {
    name: path.basename(file),
    path: file,
    bytes: st.size,
    ext: path.extname(file).toLowerCase()
  };
}

function looksBinary(file, limit = 4096) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(limit);
    const n = fs.readSync(fd, buf, 0, limit, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function classify(file) {
  const st = fs.statSync(file);
  const meta = base(file, st);
  const ext = meta.ext;

  if (IMAGE.has(ext)) {
    if (st.size > MAX_IMAGE) {
      return { ...meta, kind: 'binary', hint: `图片超过 ${MAX_IMAGE / 1024 / 1024}MB，暂不加载。` };
    }
    const data = fs.readFileSync(file).toString('base64');
    return { ...meta, kind: 'image', dataUrl: `data:${MIME[ext] || 'application/octet-stream'};base64,${data}` };
  }

  if (ext === '.docx') {
    if (st.size > MAX_DOCX) return { ...meta, kind: 'binary', hint: '文档超过 8MB，暂不解析。' };
    const r = docx.extract(file);
    if (!r.ok) return { ...meta, kind: 'binary', hint: r.error };
    return { ...meta, kind: 'docx', content: r.text, paragraphs: r.paragraphs };
  }

  if (TEXT.has(ext) || CODE.has(ext) || ext === '') {
    if (st.size > MAX_TEXT) {
      return { ...meta, kind: 'binary', hint: `文件超过 ${MAX_TEXT / 1024 / 1024}MB，暂不加载。` };
    }
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('\u0000')) {
      return { ...meta, kind: 'binary', hint: HINT[ext] || '二进制文件，暂不支持预览。' };
    }
    if (ext === '.md' || ext === '.markdown' || ext === '.mdx') {
      return { ...meta, kind: 'md', content };
    }
    if (CODE.has(ext)) {
      return { ...meta, kind: 'code', content, lines: content.split('\n').length };
    }
    return { ...meta, kind: 'text', content, lines: content.split('\n').length };
  }

  // 未知扩展名：先嗅探是不是二进制
  if (!looksBinary(file) && st.size <= MAX_TEXT) {
    const content = fs.readFileSync(file, 'utf8');
    if (!content.includes('\u0000')) {
      return { ...meta, kind: 'text', content, lines: content.split('\n').length };
    }
  }
  return { ...meta, kind: 'binary', hint: HINT[ext] || '二进制文件，暂不支持预览。' };
}

module.exports = { classify };
