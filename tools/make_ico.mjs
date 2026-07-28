/**
 * Build build/icon.ico from the PNGs sips generated.
 *
 * macOS has no ImageMagick by default and electron-builder needs a real .ico for
 * the NSIS target, so we write the container by hand. A Vista-era ICO may embed
 * PNG data directly, which makes this a header plus a directory plus the file
 * bytes -- no BMP encoding required.
 *
 * Usage: node tools/make_ico.mjs 16 32 48 64 128 256
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const sizes = (process.argv.slice(2).length ? process.argv.slice(2) : ['16', '32', '48', '64', '128', '256'])
  .map(Number).sort((a, b) => a - b);

const images = sizes.map((s) => {
  const p = join(BUILD, `icon-${s}.png`);
  if (!existsSync(p)) throw new Error(`missing ${p} — generate the PNGs first`);
  return { size: s, data: readFileSync(p) };
});

const ICONDIR = 6, ICONDIRENTRY = 16;
const header = Buffer.alloc(ICONDIR);
header.writeUInt16LE(0, 0);              // reserved
header.writeUInt16LE(1, 2);              // type 1 = icon
header.writeUInt16LE(images.length, 4);

const dir = Buffer.alloc(ICONDIRENTRY * images.length);
let offset = ICONDIR + dir.length;

images.forEach((img, i) => {
  const b = dir.subarray(i * ICONDIRENTRY);
  // 256 is written as 0 — the field is one byte, so 256 does not fit.
  b.writeUInt8(img.size >= 256 ? 0 : img.size, 0);  // width
  b.writeUInt8(img.size >= 256 ? 0 : img.size, 1);  // height
  b.writeUInt8(0, 2);                                // palette count
  b.writeUInt8(0, 3);                                // reserved
  b.writeUInt16LE(1, 4);                             // colour planes
  b.writeUInt16LE(32, 6);                            // bits per pixel
  b.writeUInt32LE(img.data.length, 8);
  b.writeUInt32LE(offset, 12);
  offset += img.data.length;
});

writeFileSync(join(BUILD, 'icon.ico'),
  Buffer.concat([header, dir, ...images.map((i) => i.data)]));
console.log(`icon.ico written — ${images.length} sizes: ${sizes.join(', ')}`);
