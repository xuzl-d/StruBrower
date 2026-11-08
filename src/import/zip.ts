/**
 * 极简 ZIP 读取器（只读），专门用来读 SketchUp 的 VFF 容器。
 *
 * 为什么不直接用 fflate 的 unzipSync：新版 .skp 是「65 字节 SketchUp 头 + ZIP」，
 * 而 ZIP 结尾的中央目录偏移是按「没有这 65 字节前缀」写的。unzipSync（以及系统 unzip）
 * 会按结尾记录去定位中央目录，落到 prefix 里，报 “missing 2 bytes in zipfile”。
 *
 * 所以这里改成**顺序扫描 local file header**：从第一个 PK\x03\x04 开始往后走，
 * 每个头自己带名字和压缩后长度，走完一个就到下一个，前缀多长都不影响。
 * 中央目录只用来补一种情况：local header 标志位 bit3（data descriptor）时长度写在数据后面。
 */
import { inflateSync } from 'three/examples/jsm/libs/fflate.module.js';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;

export interface ZipMember {
  name: string;
  /** 解压后字节数 */
  size: number;
  /** 压缩后字节数 */
  compressedSize: number;
  read(): Uint8Array;
}

interface CentralRecord {
  compressedSize: number;
  size: number;
  method: number;
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** 找第一个 local file header（容器前缀长度不定，所以由内容定位）。 */
export function findZipStart(bytes: Uint8Array): number {
  for (let i = 0; i + 4 <= bytes.length; i += 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) return i;
  }
  return -1;
}

function readCentralDirectory(bytes: Uint8Array, view: DataView): Map<string, CentralRecord> {
  const records = new Map<string, CentralRecord>();
  for (let i = 0; i + 46 <= bytes.length; i += 1) {
    if (view.getUint32(i, true) !== CENTRAL_HEADER) continue;
    const method = view.getUint16(i + 10, true);
    const compressedSize = view.getUint32(i + 20, true);
    const size = view.getUint32(i + 24, true);
    const nameLength = view.getUint16(i + 28, true);
    const extraLength = view.getUint16(i + 30, true);
    const commentLength = view.getUint16(i + 32, true);
    if (i + 46 + nameLength > bytes.length) break;
    const name = utf8(bytes.subarray(i + 46, i + 46 + nameLength));
    records.set(name, { compressedSize, size, method });
    i += 45 + nameLength + extraLength + commentLength;
  }
  return records;
}

export function readZip(bytes: Uint8Array, start = 0): ZipMember[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const central = readCentralDirectory(bytes, view);
  const members: ZipMember[] = [];
  let cursor = Math.max(0, start);

  while (cursor + 30 <= bytes.length) {
    if (view.getUint32(cursor, true) !== LOCAL_HEADER) {
      // 前一个条目的数据后面可能还跟着别的块（数据描述符 / 签名），逐字节找下一个头
      cursor += 1;
      continue;
    }
    const flags = view.getUint16(cursor + 6, true);
    const localMethod = view.getUint16(cursor + 8, true);
    const nameLength = view.getUint16(cursor + 26, true);
    const extraLength = view.getUint16(cursor + 28, true);
    if (cursor + 30 + nameLength > bytes.length) break;
    const name = utf8(bytes.subarray(cursor + 30, cursor + 30 + nameLength));
    const dataStart = cursor + 30 + nameLength + extraLength;
    const record = central.get(name);
    const method = record?.method ?? localMethod;
    const compressedSize = record?.compressedSize ?? view.getUint32(cursor + 18, true);
    const size = record?.size ?? view.getUint32(cursor + 22, true);

    // 长度写在数据描述符里、又没有中央目录可查 → 只能跳过（不会发生在 SketchUp 文件上）
    if ((flags & 0x8) && !record) {
      cursor = dataStart;
      continue;
    }
    if (dataStart + compressedSize > bytes.length) break;

    const slice = { start: dataStart, length: compressedSize };
    const memberMethod = method;
    members.push({
      name,
      size,
      compressedSize,
      read: () => unpack(bytes, slice.start, slice.length, size, memberMethod),
    });
    cursor = dataStart + compressedSize;
  }

  if (!members.length) throw new Error('ZIP 里没有条目（容器结构异常）。');
  return members;
}

function unpack(bytes: Uint8Array, start: number, length: number, size: number, method: number): Uint8Array {
  const raw = bytes.subarray(start, start + length);
  if (method === 0) return raw.slice(0, size || raw.length);
  if (method === 8) {
    try {
      return inflateSync(raw);
    } catch (error) {
      throw new Error(`ZIP 条目解压失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`不支持 ZIP 压缩方式 ${method}（目前只支持存储 / deflate）。`);
}
