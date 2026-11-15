/**
 * Generates `app-icon.png` (1024×1024) for LovaEngine without any image
 * dependencies: a rounded-square dark gradient with the LovaEngine heart,
 * rendered with 2× supersampling and encoded as a raw PNG (zlib + CRC32).
 *
 * Usage: node scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const SS = 2; // supersample factor
const N = SIZE * SS;

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (c1, c2, t) => [
  c1[0] + (c2[0] - c1[0]) * t,
  c1[1] + (c2[1] - c1[1]) * t,
  c1[2] + (c2[2] - c1[2]) * t,
];

const BG_TOP = hex("#282d38");
const BG_BOT = hex("#0f1216");
const HEART_A = hex("#ff5c7a");
const HEART_B = hex("#ff8a5c");

const margin = 82 * SS;
const radius = 226 * SS;

function insideRoundedRect(x, y) {
  const x0 = margin,
    y0 = margin,
    x1 = N - margin,
    y1 = N - margin;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const rx = Math.min(x - x0, x1 - x);
  const ry = Math.min(y - y0, y1 - y);
  if (Math.min(rx, ry) >= radius) return true;
  const cx = x < x0 + radius ? x0 + radius : x1 - radius;
  const cy = y < y0 + radius ? y0 + radius : y1 - radius;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

/** Implicit heart curve: (u² + v² − 1)³ − u²·v³ ≤ 0, with v pointing up. */
function insideHeart(px, py) {
  const s = 0.36 * N;
  const u = (px - N / 2) / s;
  const v = -(py - (N / 2 + 0.03 * N)) / s;
  const q = u * u + v * v - 1;
  return q * q * q - u * u * v * v * v <= 0;
}

// ── render (internal resolution) ──────────────────────────────────────────
const img = new Uint8Array(N * N * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    let px = 0;
    if (insideRoundedRect(x, y)) {
      let c = mix(BG_TOP, BG_BOT, y / N);
      if (insideHeart(x, y)) {
        c = mix(HEART_A, HEART_B, (x + y) / (2 * N));
      }
      img[i] = Math.round(c[0]);
      img[i + 1] = Math.round(c[1]);
      img[i + 2] = Math.round(c[2]);
      img[i + 3] = 255;
      px = 1;
    }
    void px;
  }
}

// ── downsample + build raw scanlines (filter byte 0) ─────────────────────
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0;
  for (let x = 0; x < SIZE; x++) {
    let r = 0,
      g = 0,
      b = 0,
      a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
        r += img[i];
        g += img[i + 1];
        b += img[i + 2];
        a += img[i + 3];
      }
    }
    const c = SS * SS;
    raw[o++] = Math.round(r / c);
    raw[o++] = Math.round(g / c);
    raw[o++] = Math.round(b / c);
    raw[o++] = Math.round(a / c);
  }
}

// ── PNG encoding ──────────────────────────────────────────────────────────
let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// 10..12 = compression, filter, interlace = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "app-icon.png");
writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);
