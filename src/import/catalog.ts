/**
 * 格式目录（只描述「支持什么」，不含解析器实现）。
 *
 * 单独成文件的原因：Ribbon 的 accept 列表、拖拽提示、错误文案都要用它，
 * 而那些地方不应该把 FBX / COLLADA / glTF 的解析器拖进主包 —— 解析器在
 * index.ts 里按需动态 import。
 */

export interface ImportFormatMeta {
  id: string;
  label: string;
  extensions: string[];
  /** 导入对话框 / tooltip 里的格式说明 */
  hint: string;
}

export const IMPORT_FORMATS: ImportFormatMeta[] = [
  { id: 'glb', label: 'glTF / GLB', extensions: ['glb', 'gltf'], hint: '现代三维交换格式，保留材质与层级（Y-up，米）' },
  { id: 'obj', label: 'OBJ', extensions: ['obj'], hint: 'Wavefront OBJ，最通用的网格格式（Y-up）' },
  { id: 'fbx', label: 'FBX', extensions: ['fbx'], hint: 'Autodesk FBX，读 GlobalSettings 定轴向与单位' },
  { id: 'dae', label: 'COLLADA', extensions: ['dae'], hint: 'SketchUp / Blender 常用导出格式，读 up_axis 与单位' },
  { id: 'stl', label: 'STL', extensions: ['stl'], hint: '三角网格，无单位无材质（按 Z-up）' },
  { id: 'ply', label: 'PLY', extensions: ['ply'], hint: '扫描 / 点面网格，保留顶点色（Y-up）' },
  { id: 'off', label: 'OFF', extensions: ['off', 'coff'], hint: 'Geomview 多边形文件，COFF 带顶点色' },
  { id: '3ds', label: '3DS', extensions: ['3ds'], hint: '3D Studio 老格式（Z-up，无单位）' },
  { id: '3mf', label: '3MF', extensions: ['3mf'], hint: '打印交换格式（Z-up，默认毫米）' },
  { id: 'dxf', label: 'DXF（三维面）', extensions: ['dxf'], hint: '只导入 3DFACE / 网格实体，线框会被忽略' },
  { id: 'skp', label: 'SketchUp（.skp）', extensions: ['skp'], hint: '读取版本 / 单位 / 预览，几何需先导出 DAE 或 OBJ' },
];

/** 文件选择器的 accept 串（STEP 由 OCCT 链路单独处理，见 App）。 */
export const IMPORT_ACCEPT = IMPORT_FORMATS
  .flatMap((format) => format.extensions.map((extension) => `.${extension}`))
  .join(',');

export const IMPORT_LABELS = IMPORT_FORMATS.map((format) => format.label);

export function formatForFile(name: string): ImportFormatMeta | undefined {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return IMPORT_FORMATS.find((format) => format.extensions.includes(extension));
}
