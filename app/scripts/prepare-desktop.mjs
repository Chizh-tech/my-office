import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.length + 4);
  return chunk;
}

export function desktopIcon() {
  const size = 256;
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const rectangles = [
    [2, 2, 30, 30, [53, 45, 66, 255]],
    [4, 4, 28, 28, [255, 250, 240, 255]],
    [7, 7, 15, 15, [113, 96, 128, 255]],
    [17, 7, 25, 15, [113, 96, 128, 255]],
    [7, 17, 15, 25, [113, 96, 128, 255]],
    [17, 17, 25, 25, [157, 187, 139, 255]],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (const [left, top, right, bottom, color] of rectangles) {
        if (x >= left * 8 && x < right * 8 && y >= top * 8 && y < bottom * 8) {
          pixels.set(color, y * (size * 4 + 1) + 1 + x * 4);
        }
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function prepareDesktop(output = resolve(ROOT, 'app', '.local', 'desktop-build')) {
  await mkdir(output, { recursive: true });
  const png = desktopIcon();
  const icoHeader = Buffer.alloc(22);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(1, 4);
  icoHeader.writeUInt16LE(1, 10);
  icoHeader.writeUInt16LE(32, 12);
  icoHeader.writeUInt32LE(png.length, 14);
  icoHeader.writeUInt32LE(22, 18);
  await Promise.all([
    writeFile(resolve(output, 'my-office.png'), png),
    writeFile(resolve(output, 'my-office.ico'), Buffer.concat([icoHeader, png])),
    writeFile(resolve(output, 'office-location.json'), JSON.stringify({ version: 1, workspaceRoot: ROOT }, null, 2)),
  ]);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(await prepareDesktop());
}
