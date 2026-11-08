/**
 * 构件明细表（工程量统计）。数值单位统一为米 / 平方米 / 立方米。
 * 三角面数取自 buildElementGeometry 的真实几何，而非估算。
 */
import {
  columnTypeOf,
  elementHeight,
  levelById,
  polygonArea,
  slabTypeOf,
  typeById,
  wallLength,
  wallTypeOf,
} from './document';
import { buildElementGeometry } from './geometry';
import { materialOfElement } from './layers';
import { categoryLabels } from './types';
import type { BimElement, ProjectDocument } from './types';

export interface ScheduleRow {
  id: string;
  name: string;
  /** 中文类别名（取 categoryLabels） */
  category: string;
  typeName: string;
  level: string;
  material: string;
  /** 墙长，米 */
  length?: number;
  /** 楼板面积，平方米 */
  area?: number;
  /** 体积，立方米 */
  volume?: number;
  triangles: number;
}

/** 中文表头，CSV 与 UI 表格共用。 */
export const scheduleHeaders: string[] = [
  '编号',
  '名称',
  '类别',
  '类型',
  '标高',
  '材质',
  '长度(m)',
  '面积(m²)',
  '体积(m³)',
  '三角面',
];

/** 图元材质覆盖优先于类型材质；导入几何无材质时显示自身颜色。 */
function materialName(project: ProjectDocument, element: BimElement): string {
  return materialOfElement(project, element)?.name
    ?? (element.category === 'mesh' ? element.color : '未指定');
}

/** 用实际几何统计三角面数（索引或非索引几何都支持）。 */
function triangleCount(project: ProjectDocument, element: BimElement): number {
  const geometry = buildElementGeometry(project, element);
  if (!geometry) return 0;
  const position = geometry.getAttribute('position');
  const count = geometry.index ? geometry.index.count : position.count;
  geometry.dispose();
  return Math.floor(count / 3);
}

/** 统计全部构件的工程量（含隐藏构件，明细表是全量清单）。 */
export function buildSchedule(project: ProjectDocument): ScheduleRow[] {
  return project.elements.map((element) => {
    const type = typeById(project, element.typeId);
    const row: ScheduleRow = {
      id: element.id,
      name: element.name,
      category: categoryLabels[element.category],
      typeName: type?.name ?? (element.category === 'mesh' ? element.source : ''),
      level: levelById(project, element.levelId)?.name ?? '',
      material: materialName(project, element),
      triangles: triangleCount(project, element),
    };

    if (element.category === 'wall') {
      const wallType = wallTypeOf(project, element);
      const length = wallLength(element);
      row.length = length;
      if (wallType) row.volume = length * elementHeight(project, element) * wallType.thickness;
    } else if (element.category === 'column') {
      const columnType = columnTypeOf(project, element);
      if (columnType) {
        row.volume = columnType.width * columnType.depth * elementHeight(project, element);
      }
    } else if (element.category === 'slab') {
      const slabType = slabTypeOf(project, element);
      const area = polygonArea(element.points);
      row.area = area;
      if (slabType) row.volume = area * slabType.thickness;
    }
    return row;
  });
}

/** CSV 单元格：数值保留 3 位小数，含逗号/引号/换行时用双引号包裹并把 " 翻倍。 */
function csvCell(value: string | number | undefined): string {
  if (value === undefined) return '';
  const text = typeof value === 'number' ? value.toFixed(3) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 导出带 UTF-8 BOM 的 CSV（Excel 直接打开中文不乱码）。 */
export function scheduleToCsv(rows: ScheduleRow[]): string {
  const lines = [scheduleHeaders.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.name,
        row.category,
        row.typeName,
        row.level,
        row.material,
        row.length,
        row.area,
        row.volume,
        row.triangles,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
