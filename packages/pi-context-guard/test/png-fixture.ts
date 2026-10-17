/**
 * 测试用 PNG 生成器：造一张"内容随机、压不动"的真 PNG。
 *
 * 为什么要真 PNG：`read` 工具按魔数识别图片类型，再用 photon 解码；假的 PNG 会走到
 * "图片被省略"的分支，验证不了"图片块让请求膨胀 → 清理后显著变小"这条 S2 断言。
 * 随机噪声用 deflate 的 stored 模式（level 0）打包，最终 base64 与原图同量级。
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** 写一张 `size × size` 的 RGB 噪声 PNG，返回文件字节数。 */
export function writeNoisePng(path: string, size = 256): number {
  const width = size;
  const height = size;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  let seed = 0x12345678;
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 1; x < stride; x += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[row + x] = seed & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const png = Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
  return png.length;
}
