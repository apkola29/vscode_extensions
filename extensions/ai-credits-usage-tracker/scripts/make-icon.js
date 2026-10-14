'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Deterministic, original PNG artwork; no captured screen, user information, or third-party asset.
const size = 256;
const rows = Buffer.alloc((size * 4 + 1) * size);
const circle = (x, y, cx, cy, radius) => (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
const bars = [
  { x: 80, top: 140 },
  { x: 112, top: 114 },
  { x: 144, top: 83 },
  { x: 176, top: 125 },
];
for (let y = 0; y < size; y++) {
  const offset = y * (size * 4 + 1);
  rows[offset] = 0;
  for (let x = 0; x < size; x++) {
    const insetX = Math.max(28 - x, x - 227, 0);
    const insetY = Math.max(28 - y, y - 227, 0);
    const rounded = insetX ** 2 + insetY ** 2 <= 28 ** 2;
    let color = rounded ? [34, 63, 51, 255] : [0, 0, 0, 0];
    if (circle(x, y, 128, 128, 94) && !circle(x, y, 128, 128, 85)) color = [224, 235, 224, 255];
    if (bars.some((bar) => x >= bar.x - 7 && x <= bar.x + 7 && y >= bar.top && y <= 170)) {
      color = [224, 235, 224, 255];
    }
    const p = offset + 1 + x * 4;
    for (let channel = 0; channel < 4; channel++) rows[p + channel] = color[channel];
  }
}

function chunk(name, data) {
  const type = Buffer.from(name, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(rows)),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log('Generated original 256 x 256 Marketplace icon.');
