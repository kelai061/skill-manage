'use strict';
/**
 * make-icon.cjs — 生成应用图标 build/icon.ico（零依赖）
 *
 * 做法：4× 超采样画一张 1024 的位图 → 缩到 256 → 编码成 PNG → 包进 ICO 容器。
 * 图形语言跟界面一致：M3 主色底 + 三层「atelier 图层」标记。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const SS = 4;               // 超采样倍数
const W = SIZE * SS;

const BG_A = [103, 80, 164];   // #6750A4
const BG_B = [64, 44, 120];    // #402C78
const FG = [255, 251, 254];

const px = new Float32Array(W * W * 3);   // rgb
const al = new Float32Array(W * W);       // alpha 0..1

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 圆角矩形的有向距离场（<0 在内部） */
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

const M = W * 0.075;                 // 外边距
const CX = W / 2;
const CY = W / 2;
const HW = W / 2 - M;
const HH = W / 2 - M;
const R = W * 0.22;

// 三层图层条
const bars = [
  { cy: 0.30, hw: 0.235, h: 0.075, a: 1.0 },
  { cy: 0.50, hw: 0.185, h: 0.075, a: 0.92 },
  { cy: 0.70, hw: 0.125, h: 0.075, a: 0.82 }
];

for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const d = sdRoundRect(x + 0.5, y + 0.5, CX, CY, HW, HH, R);
    if (d > 0.5) continue;

    // 底：左上到右下的双色渐变
    const t = Math.min(1, Math.max(0, ((x / W) * 0.6 + (y / W) * 0.4)));
    let c = mix(BG_A, BG_B, t);

    // 顶部一层柔光，避免整块死板
    const glow = Math.max(0, 1 - Math.hypot(x - CX * 0.85, y - CY * 0.55) / (W * 0.62));
    c = mix(c, [255, 255, 255], glow * 0.10);

    // 三层条
    for (const b of bars) {
      const bd = sdRoundRect(x + 0.5, y + 0.5, CX, W * b.cy, W * b.hw, W * b.h / 2, W * b.h / 2);
      if (bd < 0.5) {
        const a = (bd < 0 ? 1 : 0.5) * b.a;
        c = mix(c, FG, a);
      }
    }

    px[i * 3] = c[0];
    px[i * 3 + 1] = c[1];
    px[i * 3 + 2] = c[2];
    al[i] = d < 0 ? 1 : Math.max(0, 0.5 - d);
  }
}

/* 下采样到 256 */
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = (y * SS + sy) * W + (x * SS + sx);
        const w = al[i];
        r += px[i * 3] * w;
        g += px[i * 3 + 1] * w;
        b += px[i * 3 + 2] * w;
        a += w;
      }
    }
    const n = SS * SS;
    const o = (y * SIZE + x) * 4;
    const aa = a / n;
    out[o] = aa > 0 ? Math.round(r / a) : 0;
    out[o + 1] = aa > 0 ? Math.round(g / a) : 0;
    out[o + 2] = aa > 0 ? Math.round(b / a) : 0;
    out[o + 3] = Math.round(aa * 255);
  }
}

/* PNG 编码 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const png = encodePng(out, SIZE, SIZE);

/* ICO 容器（单张 256×256 PNG 条目） */
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);   // type = icon
header.writeUInt16LE(1, 4);   // count

const entry = Buffer.alloc(16);
entry[0] = 0;                 // 256 记作 0
entry[1] = 0;
entry[2] = 0;
entry[3] = 0;
entry.writeUInt16LE(1, 4);    // color planes
entry.writeUInt16LE(32, 6);   // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(6 + 16, 12);

const dir = path.join(__dirname, '..', 'build');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, entry, png]));
fs.writeFileSync(path.join(dir, 'icon.png'), png);
console.log('icon.ico / icon.png →', dir, (png.length / 1024).toFixed(1) + ' KB');
