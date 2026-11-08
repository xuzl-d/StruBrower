/**
 * 模型导入的统一契约。
 *
 * 各格式解析器只负责「把文件读成三角形 + 颜色」，坐标轴与单位都原样保留，
 * 由 index.ts 在写入项目时统一归一（项目用 Z-up + 米）。
 * 这样导入对话框可以把「轴 / 单位」做成可切换选项，而不是硬编码在解析器里。
 */
import type { BufferGeometry } from 'three';

/** 解析出的一个构件：已烘焙世界变换，尚未做轴向 / 单位换算。 */
export interface ImportedPart {
  name: string;
  geometry: BufferGeometry;
  /** '#rrggbb' */
  color: string;
}

export type UpAxis = 'y' | 'z';

export interface ImportedModel {
  /** 命中的格式 id，见 IMPORT_FORMATS */
  format: string;
  formatLabel: string;
  parts: ImportedPart[];
  /** 文件自己声明的向上轴；用于对话框默认值 */
  upAxis: UpAxis;
  /** 文件自己声明的单位（米）；未知为 null，交给启发式推断 */
  unitMeters: number | null;
  /** 解析中的提示：贴图缺失、压缩扩展缺失、节点被跳过等 */
  notices: string[];
  /** 无法读取几何时（目前只有 SKP）给出原因与下一步 */
  blocked?: { reason: string; steps: string[] };
  /** 文件内嵌的预览图（SKP 的 preview），导入对话框里显示，证明「文件读到了」 */
  previewDataUrl?: string;
  /** 诊断信息：容器内的流清单等，折叠显示 */
  details?: string[];
}

export interface ImportContext {
  /** 原始文件名（判断扩展名 / 生成构件名） */
  fileName: string;
  /** 同名附属资源（.gltf 旁边的 .bin / 贴图）→ blob URL，供 loader 的 URLModifier 使用 */
  resources?: Map<string, string>;
  onNotice?: (message: string) => void;
}

export const DEFAULT_IMPORT_COLOR = '#a3adb8';

/** 常用单位（米），导入对话框下拉用。 */
export const UNIT_CHOICES: Array<{ id: string; label: string; meters: number }> = [
  { id: 'auto', label: '自动判断', meters: 0 },
  { id: 'm', label: '米', meters: 1 },
  { id: 'mm', label: '毫米', meters: 0.001 },
  { id: 'cm', label: '厘米', meters: 0.01 },
  { id: 'in', label: '英寸', meters: 0.0254 },
  { id: 'ft', label: '英尺', meters: 0.3048 },
];
