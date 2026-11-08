/**
 * SketchUp（.skp）导入。
 *
 * 为什么不能像 OBJ/STL 那样直接读几何：几何在 model.dat 里是 Trimble 的专有二进制
 * （含自研压缩），没有公开规范，也没有任何可用的 JS 解析器 —— 声称「直接解析 SKP」
 * 的实现都是调外部 SketchUp SDK。
 *
 * .skp 有两种容器，都要认（否则会像以前那样把 ZIP 版直接判成「不是 SketchUp 文件」）：
 * - **OLE 复合文档（CFB）**：SketchUp 桌面版保存的普通 .skp，按 FAT / mini stream 读流；
 * - **VFF / ZIP**：65 字节 SketchUp 头（UTF-16 的 "SketchUp Model" + 版本 + "VFF"）+ 一个 ZIP，
 *   Trimble 的在线服务 / 渲染服务（Renderbot 之类）产出的文件是这种，几何同样在 model.dat 里。
 *
 * 能确定做到的部分：
 * 1. 真解析容器（CFB 的 FAT/DIFAT/mini stream/目录树；ZIP 的 local header 顺序扫描）；
 * 2. 读 meta.dat（老版是 XML，新版是 TLV）里的版本、单位、原始路径；
 * 3. 提取内嵌预览图（meta/preview_thumbnail.png），让用户确认「这份文件读对了」；
 * 4. 给出可执行的下一步（SketchUp 里导出 DAE / OBJ / GLB，本项目都能直接导入）。
 *
 * 这样导入链路是「尽量读 + 明确告知差哪一步」，而不是假装成功或直接报错。
 */
import type { ImportContext, ImportedModel } from './types';
import { findZipStart, readZip } from './zip';

interface CfbEntry {
  name: string;
  type: number;
  startSector: number;
  size: number;
  path: string;
  children: CfbEntry[];
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;

function hasCfbMagic(bytes: Uint8Array): boolean {
  return CFB_MAGIC.every((value, index) => bytes[index] === value);
}

class Cfb {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly sectorSize: number;
  private readonly miniSectorSize: number;
  private readonly miniCutoff: number;
  private readonly fat: number[] = [];
  private readonly miniFat: number[] = [];
  private miniStream: Uint8Array = new Uint8Array(0);
  readonly root: CfbEntry = { name: 'Root', type: 5, startSector: 0, size: 0, path: '', children: [] };

  constructor(data: ArrayBuffer) {
    this.view = new DataView(data);
    this.bytes = new Uint8Array(data);
    this.sectorSize = 1 << this.view.getUint16(30, true);
    this.miniSectorSize = 1 << this.view.getUint16(32, true);
    this.miniCutoff = this.view.getUint32(56, true);
    this.readFat();
    this.readDirectory();
    this.readMiniStream();
  }

  private sectorOffset(sector: number): number {
    return (sector + 1) * this.sectorSize;
  }

  private sectorBytes(sector: number): Uint8Array {
    const start = this.sectorOffset(sector);
    return this.bytes.subarray(start, Math.min(start + this.sectorSize, this.bytes.length));
  }

  private readFat(): void {
    const perSector = this.sectorSize / 4;
    const difat: number[] = [];
    for (let i = 0; i < 109; i += 1) {
      const sector = this.view.getUint32(76 + i * 4, true);
      if (sector >= 0xfffffffa) break;
      difat.push(sector);
    }
    let next = this.view.getUint32(68, true);
    let guard = 0;
    while (next < 0xfffffffa && guard < 100000) {
      const body = this.sectorBytes(next);
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      for (let i = 0; i < perSector - 1; i += 1) {
        const sector = view.getUint32(i * 4, true);
        if (sector < 0xfffffffa) difat.push(sector);
      }
      next = view.getUint32((perSector - 1) * 4, true);
      guard += 1;
    }
    for (const sector of difat) {
      const body = this.sectorBytes(sector);
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      for (let i = 0; i < perSector; i += 1) this.fat.push(view.getUint32(i * 4, true));
    }
  }

  private chain(start: number, table: number[]): number[] {
    const sectors: number[] = [];
    let sector = start;
    let guard = 0;
    while (sector < 0xfffffffa && sector !== FREE_SECTOR && guard < 1000000) {
      sectors.push(sector);
      sector = table[sector] ?? END_OF_CHAIN;
      guard += 1;
    }
    return sectors;
  }

  private readDirectory(): void {
    const dirSectors = this.chain(this.view.getUint32(48, true), this.fat);
    const entries: CfbEntry[] = [];
    for (const sector of dirSectors) {
      const body = this.sectorBytes(sector);
      for (let offset = 0; offset + 128 <= body.length; offset += 128) {
        const view = new DataView(body.buffer, body.byteOffset + offset, 128);
        const nameLength = view.getUint16(64, true);
        const type = view.getUint8(66);
        if (type === 0) continue;
        const nameBytes = body.subarray(offset, offset + Math.max(0, nameLength - 2));
        let name = '';
        for (let i = 0; i + 1 < nameBytes.length; i += 2) {
          name += String.fromCharCode(nameBytes[i]! | (nameBytes[i + 1]! << 8));
        }
        entries.push({
          name,
          type,
          startSector: view.getUint32(116, true),
          size: view.getUint32(120, true),
          path: name,
          children: [],
        });
      }
    }
    const rootEntry = entries.find((entry) => entry.type === 5);
    if (!rootEntry) throw new Error('SKP 容器缺少根目录项。');
    this.root.startSector = rootEntry.startSector;
    this.root.size = rootEntry.size;
    this.root.children = this.buildTree(entries);
  }

  /** 目录项是扁平数组，子项用 left/right/child 三指针组织；这里按「先序自增」简化重建。 */
  private buildTree(entries: CfbEntry[]): CfbEntry[] {
    const flat = entries.filter((entry) => entry.type !== 5);
    const result: CfbEntry[] = [];
    for (const entry of flat) {
      entry.path = entry.name;
      result.push(entry);
    }
    // 目录层级对读取流不重要（流都按名字找），把 storage 也当容器并列列出即可
    return result;
  }

  private readMiniStream(): void {
    const rootSectors = this.chain(this.root.startSector, this.fat);
    const chunks = rootSectors.map((sector) => this.sectorBytes(sector));
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const stream = new Uint8Array(Math.min(total, this.root.size || total));
    let cursor = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, stream.length - cursor);
      if (take <= 0) break;
      stream.set(chunk.subarray(0, take), cursor);
      cursor += take;
    }
    this.miniStream = stream;

    const miniFatSectors = this.chain(this.view.getUint32(60, true), this.fat);
    for (const sector of miniFatSectors) {
      const body = this.sectorBytes(sector);
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      for (let i = 0; i < body.length / 4; i += 1) this.miniFat.push(view.getUint32(i * 4, true));
    }
  }

  entries(): CfbEntry[] {
    return this.root.children;
  }

  findStream(predicate: (entry: CfbEntry) => boolean): CfbEntry | undefined {
    return this.root.children.find((entry) => entry.type === 2 && predicate(entry));
  }

  read(entry: CfbEntry): Uint8Array {
    if (entry.size < this.miniCutoff) {
      const sectors = this.chain(entry.startSector, this.miniFat);
      const out = new Uint8Array(entry.size);
      let cursor = 0;
      for (const sector of sectors) {
        const start = sector * this.miniSectorSize;
        const chunk = this.miniStream.subarray(start, Math.min(start + this.miniSectorSize, this.miniStream.length));
        const take = Math.min(chunk.length, out.length - cursor);
        if (take <= 0) break;
        out.set(chunk.subarray(0, take), cursor);
        cursor += take;
      }
      return out;
    }
    const sectors = this.chain(entry.startSector, this.fat);
    const out = new Uint8Array(entry.size);
    let cursor = 0;
    for (const sector of sectors) {
      const chunk = this.sectorBytes(sector);
      const take = Math.min(chunk.length, out.length - cursor);
      if (take <= 0) break;
      out.set(chunk.subarray(0, take), cursor);
      cursor += take;
    }
    return out;
  }
}


interface SkpMember {
  name: string;
  size: number;
  read(): Uint8Array;
}

function formatBytes(size: number): string {
  if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size > 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function bytesToDataUrl(bytes: Uint8Array): string | undefined {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPng && !isJpeg) return undefined;
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${isPng ? 'image/png' : 'image/jpeg'};base64,${btoa(binary)}`;
}

/** 内嵌预览图：优先 preview，其次 thumbnail，最后任何小尺寸图片。 */
function previewOf(members: SkpMember[]): string | undefined {
  const pick = members.find((member) => /preview/i.test(member.name))
    ?? members.find((member) => /thumbnail/i.test(member.name))
    ?? members.find((member) => member.size > 1024 && member.size < 4 * 1024 * 1024 && /\.(png|jpe?g)$/i.test(member.name));
  if (!pick) return undefined;
  try {
    return bytesToDataUrl(pick.read());
  } catch {
    return undefined;
  }
}

/** 老版 meta.dat 是 XML。 */
function readMetaXml(bytes: Uint8Array): Record<string, string> {
  const text = new TextDecoder('utf-8').decode(bytes).replace(/\u0000/g, '');
  const fields: Record<string, string> = {};
  const pattern = /<([A-Za-z_][\w.:-]*)\b[^>]*>([^<>]{1,120})<\/\1>/g;
  let match = pattern.exec(text);
  while (match) {
    const key = match[1]!.split(':').pop()!.toLowerCase();
    fields[key] = match[2]!.trim();
    match = pattern.exec(text);
  }
  return fields;
}

/** 只把「纯可打印 ASCII」当成字符串返回，二进制负载（UUID / 内嵌结构）返回空串。 */
function printable(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    if (byte === 0) continue;
    if (byte < 32 || byte >= 127) return '';
    text += String.fromCharCode(byte);
  }
  return text;
}

/**
 * 新版 meta.dat（二进制 TLV）：`tag(u16) + length(u32) + value`，无对齐填充，
 * 外层是一个 `d` 容器（值里还是同一套 TLV）。tag 是单个 ASCII 字母：
 * u=版本、m=单位、o=原始文件路径、g/h=缩略图条目。
 */
function readMetaTlv(bytes: Uint8Array, out: Map<string, string>, depth = 0): void {
  if (depth > 3 || bytes.length < 6) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 6 <= bytes.length) {
    const tag = view.getUint16(offset, true);
    const length = view.getUint32(offset + 2, true);
    if (offset + 6 + length > bytes.length) break;
    const value = bytes.subarray(offset + 6, offset + 6 + length);
    if (tag === 0x64) {
      readMetaTlv(value, out, depth + 1);
    } else if (tag >= 32 && tag < 127) {
      const text = printable(value);
      if (text) out.set(String.fromCharCode(tag), text);
    }
    offset += 6 + length;
  }
}

const SKP_UNIT_METERS: Record<string, number> = {
  meter: 1,
  meters: 1,
  centimeter: 0.01,
  centimeters: 0.01,
  millimeter: 0.001,
  millimeters: 0.001,
  inch: 0.0254,
  inches: 0.0254,
  foot: 0.3048,
  feet: 0.3048,
  yard: 0.9144,
};

interface SkpMeta {
  version?: string;
  units?: string;
  unitMeters: number | null;
  originPath?: string;
}

function readMeta(bytes: Uint8Array): SkpMeta {
  const fields = new Map<string, string>();
  if (bytes[0] === 0x64 && bytes[1] === 0x00) readMetaTlv(bytes, fields);
  else for (const [key, value] of Object.entries(readMetaXml(bytes))) fields.set(key, value);

  const values = [...fields.values()];
  const version = fields.get('u')
    ?? fields.get('version')
    ?? fields.get('fileversion')
    ?? values.find((value) => /^\d+\.\d+\.\d+$/.test(value));
  const units = fields.get('m')
    ?? fields.get('units')
    ?? fields.get('lengthunits')
    ?? values.find((value) => /^(meter|centimeter|millimeter|inch|foot|feet|yard)s?$/i.test(value));
  const originPath = fields.get('o') ?? fields.get('path') ?? fields.get('file');
  return {
    version,
    units,
    unitMeters: units ? SKP_UNIT_METERS[units.toLowerCase()] ?? null : null,
    originPath,
  };
}

function cfbMembers(cfb: Cfb): SkpMember[] {
  return cfb.entries().map((entry) => ({
    name: entry.path,
    size: entry.type === 2 ? entry.size : 0,
    read: () => (entry.type === 2 ? cfb.read(entry) : new Uint8Array(0)),
  }));
}

/** 前缀（0 ~ ZIP 起点）里是否声明了自己是 SketchUp（UTF-16LE 或 ASCII）。 */
function declaresSketchUp(bytes: Uint8Array, end: number): boolean {
  const ascii = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(end, 512)));
  if (/SketchUp\s+Model/i.test(ascii)) return true;
  const squeezed = ascii.replace(/\u0000/g, '');
  return /SketchUp\s+Model/i.test(squeezed) || squeezed.includes('VFF');
}

function blockedResult(
  containerLabel: string,
  members: SkpMember[],
  meta: SkpMeta,
  fileName: string,
  totalBytes: number,
): ImportedModel {
  const streams = members.filter((member) => member.size > 0);
  const unit = containerLabel.includes('ZIP') ? '条目' : '内部流';
  const model = streams.find((member) => /model\.dat$/i.test(member.name));
  const materials = new Set(members
    .filter((member) => /^materials\/[^/]+\//.test(member.name))
    .map((member) => member.name.split('/')[1]));
  const textures = members.filter((member) => /^materials\/.*\.(jpe?g|png)$/i.test(member.name)).length;

  const noticed: string[] = [];
  if (meta.version) noticed.push(`文件版本：SketchUp ${meta.version}`);
  if (meta.units) {
    const scale = meta.unitMeters ? `（1 单位 = ${meta.unitMeters} m）` : '';
    noticed.push(`文件单位：${meta.units}${scale}`);
  }
  if (model) noticed.push(`几何流 model.dat：${formatBytes(model.size)}`);
  if (materials.size) {
    noticed.push(`材质 ${materials.size} 个${textures ? `、贴图 ${textures} 张` : ''}（几何读不出，贴图也带不走）`);
  }
  const styles = members.filter((member) => /^styles\//.test(member.name)).length;
  if (styles) noticed.push(`样式文件 ${styles} 个`);

  const details = streams
    .slice(0, 60)
    .map((member) => `${member.name} · ${formatBytes(member.size)}`);
  if (meta.originPath) details.push(`文件内部记录的原始路径：${meta.originPath}`);

  return {
    format: 'skp',
    formatLabel: `SketchUp（.skp${meta.version ? ` ${meta.version}` : ''}）`,
    parts: [],
    upAxis: 'z',
    unitMeters: meta.unitMeters,
    notices: noticed,
    previewDataUrl: previewOf(members),
    details: details.length ? details : undefined,
    blocked: {
      reason: `容器读通了（${containerLabel}，${streams.length} ${unit}，${formatBytes(totalBytes)}）：`
        + `${meta.version ? `版本 ${meta.version}、` : ''}${meta.units ? `单位 ${meta.units}、` : ''}`
        + `预览图${materials.size ? `和 ${materials.size} 个材质` : ''}都拿到了。`
        + '但几何数据存在 model.dat 里，是 Trimble 的专有编码（没有公开规范，也没有可用的 JS 解析器），'
        + '浏览器里解不出来 —— 这一步只能靠 SketchUp 自己导出。',
      steps: [
        `在 SketchUp 里打开「${fileName}」。`,
        '文件 → 导出 → 三维模型，选 COLLADA（.dae，保留图层与单位）或 OBJ（.obj，体积更小）。',
        '需要保留材质与层级时选 glTF（SketchUp 2023+ 支持 .glb）。',
        '把导出的文件拖回本窗口：.dae / .obj / .glb / .fbx / .3ds / .stl 都能直接导入并保留颜色。',
      ],
    },
  };
}

export function parseSkp(data: ArrayBuffer, context: ImportContext): ImportedModel {
  const bytes = new Uint8Array(data);
  const fileName = context.fileName;

  // ① 最常见形态：OLE 复合文档（SketchUp 桌面版另存的 .skp）
  if (hasCfbMagic(bytes)) {
    const cfb = new Cfb(data);
    const members = cfbMembers(cfb);
    const metaEntry = cfb.findStream((entry) => /meta\.dat$/i.test(entry.name));
    const meta = metaEntry ? readMeta(cfb.read(metaEntry)) : { unitMeters: null };
    return blockedResult('OLE 复合文档', members, meta, fileName, data.byteLength);
  }

  // ② VFF 容器：65 字节 SketchUp 头 + ZIP（Trimble 在线服务 / 渲染服务产出的文件）
  const zipStart = findZipStart(bytes);
  if (zipStart > 0 && declaresSketchUp(bytes, zipStart)) {
    const members = readZip(bytes, zipStart);
    const metaMember = members.find((member) => /meta\.dat$/i.test(member.name));
    let meta: SkpMeta = { unitMeters: null };
    if (metaMember) {
      try {
        meta = readMeta(metaMember.read());
      } catch {
        // meta 读不出来不影响结论（几何照样读不出来），继续走下面的兜底
      }
    }
    const result = blockedResult('SketchUp VFF（ZIP）容器', members, meta, fileName, data.byteLength);
    if (!result.details) result.details = [`ZIP 起点：第 ${zipStart} 字节（前面是 SketchUp 头）`];
    return result;
  }

  // ③ 旧版（v3–v5）：ASCII 头的自有格式，同样没有公开几何规范
  const asciiHead = new TextDecoder('latin1').decode(bytes.subarray(0, 64));
  if (asciiHead.startsWith('SketchUp Model')) {
    const version = /Version\s+([\d.]+)/.exec(asciiHead)?.[1];
    return {
      format: 'skp',
      formatLabel: 'SketchUp（旧版 ASCII）',
      parts: [],
      upAxis: 'z',
      unitMeters: 0.0254,
      notices: [],
      blocked: {
        reason: `这是 SketchUp ${version ?? 'v5 及以前'} 的旧版文件，几何同样为专有编码，无法直接解码。`,
        steps: [
          '在 SketchUp 中打开该文件（新版 SketchUp 可打开旧版）。',
          '文件 → 导出 → 三维模型，格式选 COLLADA（.dae）或 OBJ。',
          '把导出的文件拖回本窗口即可（.dae 会自动读单位与轴向）。',
        ],
      },
    };
  }

  throw new Error(
    '不是 SketchUp 文件：既没有 OLE 复合文档头，也没有 VFF（SketchUp 头 + ZIP）或旧版 ASCII 头。'
    + '如果扩展名本来是别的格式被改名成 .skp，请按原格式导入。',
  );
}
