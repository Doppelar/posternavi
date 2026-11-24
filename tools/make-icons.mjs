// アイコン（PNG）を描いて icons/ に書き出す。node tools/make-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0x14, 0x5d, 0xa0], WHITE = [255, 255, 255], YELLOW = [0xf9, 0xc8, 0x2d];
// 0..1 の座標。輪になった巡回ルートと、寄る点。最初の点が出発地点。
const ROUTE = [[0.30, 0.66], [0.38, 0.36], [0.62, 0.30], [0.72, 0.56], [0.52, 0.72]];

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function colorAt(x, y) {
  let c = BG;
  for (let i = 0; i < ROUTE.length; i++) {
    if (segDist(x, y, ROUTE[i], ROUTE[(i + 1) % ROUTE.length]) < 0.022) c = WHITE;
  }
  ROUTE.forEach(([cx, cy], i) => {
    const d = Math.hypot(x - cx, y - cy);
    if (d < 0.07) c = i === 0 ? YELLOW : WHITE;
    if (i > 0 && d < 0.035) c = BG;
  });
  return c;
}

function png(size) {
  const SS = 4; // 縁をなめらかにするため、1画素を4×4で調べて平均する
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = colorAt((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
        for (let k = 0; k < 3; k++) sum[k] += c[k];
      }
      for (let k = 0; k < 3; k++) raw[y * (size * 3 + 1) + 1 + x * 3 + k] = Math.round(sum[k] / (SS * SS));
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), png(size));
