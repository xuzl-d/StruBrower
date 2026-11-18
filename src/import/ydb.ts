/**
 * ydb 语义导入解析器。
 *
 * ydb 就是标准 SQLite 数据库（文件头 `SQLite format 3`），盈建科用它存结构模型：
 * 楼层、节点、网格、截面定义，以及柱 / 梁 / 墙 / 支撑 / 板等构件布置表。
 * 这里用 sql.js（SQLite 的 wasm 版，浏览器与本地模式都能跑）直接读表，
 * 映射成 StruBrowsers 的语义构件（而非一坨网格），并补上项目缺失的梁、支撑族类型。
 *
 * 坐标约定：ydb 用毫米、绝对坐标；项目用米、Z-up。解析时统一 ÷1000 并把
 * 平面坐标平移到模型包围盒中心，避免大型项目坐标漂到几百米外。
 *
 * 说明：
 * - ymd 是闭源二进制格式（解析在 YJK 私有 SDK 里），本解析器不支持；
 *   传入 .ymd 会给出明确提示（见 assertYdb）。
 * - 不同版本 ydb 表列数不同，读取一律按列名取值，缺列按 0 / 空处理。
 */
import type {
  BeamInstance,
  BeamType,
  BraceInstance,
  BraceType,
  ColumnInstance,
  ColumnType,
  Grid,
  Level,
  Material,
  SlabInstance,
  SlabType,
  WallInstance,
  WallType,
} from '../bim/types';
import { createId } from '../bim/id';
import { layerIdForCategory } from '../bim/layers';

/* ------------------------------ sql.js 加载 ------------------------------ */

// @ts-ignore vite 的 ?url 导出
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { Database, QueryExecResult, SqlJsStatic } from 'sql.js';

let sqlPromise: Promise<SqlJsStatic> | undefined;

/** 按需加载 sql.js（wasm 版），避免不导入 ydb 时把它打进首屏主包。 */
function loadSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = import('sql.js')
      .then((module) => {
        const init = module.default;
        return init({ locateFile: () => wasmUrl });
      })
      .catch((error: unknown) => {
        sqlPromise = undefined;
        throw error;
      });
  }
  return sqlPromise;
}

/* ------------------------------ 行访问工具 ------------------------------ */

type Row = Record<string, SqlValue>;
type SqlValue = string | number | Uint8Array | null;

function rowsOf(result: QueryExecResult[]): Row[] {
  if (!result.length) return [];
  const { columns, values } = result[0]!;
  return values.map((value) => {
    const row: Row = {};
    columns.forEach((column, index) => { row[column] = value[index] ?? null; });
    return row;
  });
}

function query(db: Database, sql: string): Row[] {
  try {
    return rowsOf(db.exec(sql));
  } catch {
    return [];
  }
}

function num(value: SqlValue | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value: SqlValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value);
}

function intOf(value: SqlValue | undefined): number {
  return Math.round(num(value));
}

/** 把 "1,2,3," 这样的字符串拆成有限数值数组（忽略末尾逗号产生的空项）。 */
function numberList(value: SqlValue | undefined): number[] {
  return text(value)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

/* ------------------------------ 截面解析 ------------------------------ */

const MM = 0.001;

/** 截面类型（IDSec_*）：1 矩形，2 工字形，3 圆形，7 箱形，其余按矩形外接框处理。 */
interface SectionShape {
  width: number; // b，米
  depth: number; // h，米
  kind: number;
  materialId: string;
}

/**
 * 解析 ShapeVal。格式：`类型,b,h,u,t,d,f,...,材料码,id,`。
 * 圆形（3）只有一个半径/直径参数，回退为 b=h。
 */
function parseShapeVal(shapeVal: SqlValue | undefined, matCode: number): SectionShape {
  const parts = numberList(shapeVal);
  const kind = parts.length ? Math.round(parts[0]!) : 1;
  let b = parts.length > 1 ? parts[1]! : 0;
  let h = parts.length > 2 ? parts[2]! : b;
  if (kind === 3) h = b; // 圆：直径
  if (!(b > 0)) b = 0.3;
  if (!(h > 0)) h = b;
  return { width: b * MM, depth: h * MM, kind, materialId: materialIdFor(matCode) };
}

/** 材料码（IDM_*）→ 项目材质 id。 */
function materialIdFor(code: number): string {
  if (code === 5) return 'mat-steel';
  if (code === 1 || code === 37) return 'mat-masonry';
  return 'mat-concrete'; // 6 及默认：混凝土
}

/* ------------------------------ 解析结果 ------------------------------ */

export interface YdbStats {
  levels: number;
  grids: number;
  columns: number;
  beams: number;
  /** 其中弧形梁数量（圆弧网格），可选的展示字段 */
  arcBeams?: number;
  walls: number;
  /** 其中弧形墙数量（圆弧网格），可选的展示字段 */
  arcWalls?: number;
  braces: number;
  slabs: number;
  /** 其中斜楼板数量（各顶点标高不同），可选的展示字段 */
  skewedSlabs?: number;
  /** 其中夹层/错层板数量（顶点落在带 HDiff 的节点上、按层底绝对高差定位），可选展示字段 */
  mezzanineSlabs?: number;
  subBeams: number;
}

export interface YdbImportResult {
  fileName: string;
  stats: YdbStats;
  notices: string[];
  /** 生成可直接合并进当前文档的增量（id 全新，类型/标高/材质带唯一后缀）。 */
  patch: {
    levels: Level[];
    grids: Grid[];
    materials: Material[];
    types: Array<ColumnType | BeamType | WallType | BraceType | SlabType>;
    elements: Array<ColumnInstance | BeamInstance | WallInstance | BraceInstance | SlabInstance>;
  };
}

/** 读取文件头，确认是 ydb（SQLite）；ymd 给出明确提示。 */
export function assertYdb(name: string, data: ArrayBuffer): void {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'ymd') {
    throw new Error('.ymd 是盈建科专有二进制格式，解析依赖其私有 SDK，暂不支持。请在 YJK 中「另存为 .ydb」后再导入。');
  }
  if (ext !== 'ydb') {
    throw new Error(`不是 ydb 文件：.${ext}`);
  }
  const head = new Uint8Array(data, 0, Math.min(16, data.byteLength));
  const signature = String.fromCharCode(...head);
  if (!signature.startsWith('SQLite format 3')) {
    throw new Error('文件头不是标准 SQLite，可能不是有效的 ydb 文件（或已损坏 / 加密）。');
  }
}

/** 解析 ydb 文件为语义化构件增量。纯函数，不改外部状态。 */
export async function parseYdb(name: string, data: ArrayBuffer): Promise<YdbImportResult> {
  assertYdb(name, data);
  const SQL = await loadSql();
  const db = new SQL.Database(new Uint8Array(data));
  const notices: string[] = [];
  try {
    return parseDatabase(db, name, notices);
  } finally {
    db.close();
  }
}

function parseDatabase(db: Database, name: string, notices: string[]): YdbImportResult {
  // ---- 版本校验（兼容 20120101 / 20130301 等） ----
  const versionRow = query(db, 'SELECT ParaVal FROM tblProjectPara WHERE ID = 1 LIMIT 1')[0];
  const version = versionRow ? num(versionRow.ParaVal) : 0;
  if (version && version !== 20120101 && version !== 20130301) {
    notices.push(`数据库版本 ${version} 非已知版本，按通用表结构尽力解析。`);
  }

  // ---- 标高体系 ----
  // YJK 构件布置表（tblColSeg / tblBeamSeg / tblSlab / …）的 StdFlrID 指向【标准层】，
  // 而一个标准层可被【多个自然层】复用（tblFloor.StdFlrID → tblStdFlr.ID）。
  // 因此标高必须按【自然层 tblFloor】建立，并把标准层构件展开到每个引用它的自然层，
  // 标高用各自自然层的 LevelB(+Height) 重算 —— 否则复用标准层的多个楼层会整层丢失。
  const floorRows = query(db, 'SELECT ID, No_, Name, StdFlrID, LevelB, Height FROM tblFloor ORDER BY LevelB, ID');
  const stdRows = query(db, 'SELECT ID, No_, Height, Para FROM tblStdFlr ORDER BY No_, ID');
  const stdHeight = new Map<number, number>();
  /**
   * 标准层默认板厚（m）= tblStdFlr.Para[1]。
   * 参考 yjks-model：当楼板 Thickness == 9999 或 0 时表示「板厚未单独指定」，
   * 回退到该标准层默认板厚（YjkModelLoaderImpl.cpp: `dSlabThick = stdFlr->Para[1]`）。
   */
  const stdDefaultSlabThickness = new Map<number, number>();
  for (const row of stdRows) {
    stdHeight.set(intOf(row.ID), num(row.Height) * MM);
    const defaultMm = num(numberList(row.Para)[1], 0);
    if (defaultMm > 0) stdDefaultSlabThickness.set(intOf(row.ID), defaultMm * MM);
  }
  /** 文件级兜底板厚：所有合法板厚的众数（无标准层默认值时用）。 */
  let fallbackSlabThickness = 0.12;
  {
    const hist = new Map<number, number>();
    for (const row of query(db, 'SELECT Thickness FROM tblSlab')) {
      const raw = num(row.Thickness);
      if (raw >= 60 && raw <= 1000) hist.set(raw, (hist.get(raw) ?? 0) + 1);
    }
    let best = 0;
    for (const [value, freq] of hist) if (freq > best) { best = freq; fallbackSlabThickness = value * MM; }
  }

  interface NaturalFloor {
    stdFlrId: number;
    levelId: string;
    topLevelId: string;
    height: number;   // 层高（m）
    elevation: number; // 层底标高（m）
    label: string;
  }
  const levels: Level[] = [];
  const naturalFloors: NaturalFloor[] = [];

  if (floorRows.length) {
    for (const row of floorRows) {
      const elevation = num(row.LevelB) * MM;
      const height = num(row.Height) * MM;
      const id = createId();
      const label = text(row.Name) || `标高 ${text(row.No_) || levels.length + 1}`;
      levels.push({ id, name: label, elevation });
      naturalFloors.push({ stdFlrId: intOf(row.StdFlrID), levelId: id, topLevelId: '', height, elevation, label });
    }
  } else {
    // 无自然层表：按标准层逐层累加层高，生成虚拟楼层
    let acc = 0;
    for (const row of stdRows) {
      const height = num(row.Height) * MM;
      const id = createId();
      levels.push({ id, name: `标准层 ${text(row.No_) || levels.length + 1}`, elevation: acc });
      naturalFloors.push({ stdFlrId: intOf(row.ID), levelId: id, topLevelId: '', height, elevation: acc, label: '' });
      acc += height;
    }
  }
  if (naturalFloors.length) {
    const last = naturalFloors[naturalFloors.length - 1]!;
    const roofId = createId();
    levels.push({ id: roofId, name: '层顶', elevation: last.elevation + last.height });
    for (let i = 0; i < naturalFloors.length; i += 1) {
      naturalFloors[i]!.topLevelId = i + 1 < naturalFloors.length
        ? naturalFloors[i + 1]!.levelId : roofId;
    }
  } else {
    levels.push({ id: createId(), name: '层顶', elevation: 3 });
  }
  levels.sort((a, b) => a.elevation - b.elevation);

  /** 标准层 ID → 引用它的所有自然层；构件需为每个自然层各生成一份。 */
  const floorsByStd = new Map<number, NaturalFloor[]>();
  for (const nf of naturalFloors) {
    const arr = floorsByStd.get(nf.stdFlrId) ?? [];
    arr.push(nf);
    floorsByStd.set(nf.stdFlrId, arr);
  }

  // ---- 节点 ----
  interface Node { x: number; y: number; hdiff: number }
  const nodeById = new Map<number, Node>();
  /** tblJoint.idNew → tblJoint.ID。网格的圆弧圆心用 idCen(idNew) 引用，需据此反查圆心节点。 */
  const nodeIdByIdNew = new Map<number, number>();
  /** 原始坐标(mm,取整) → 节点高差(mm)。用于识别「夹层板」：其顶点/网格边落在带 HDiff 的节点上。 */
  const nodeHdiffByCoord = new Map<string, number>();
  /** 节点 ID → 高差(mm)，供网格端点判断 */
  const nodeHdiffById = new Map<number, number>();
  for (const row of query(db, 'SELECT ID, X, Y, HDiff, idNew FROM tblJoint')) {
    nodeById.set(intOf(row.ID), { x: num(row.X) * MM, y: num(row.Y) * MM, hdiff: num(row.HDiff) * MM });
    const hd = num(row.HDiff);
    nodeHdiffByCoord.set(`${Math.round(num(row.X))},${Math.round(num(row.Y))}`, hd);
    nodeHdiffById.set(intOf(row.ID), hd);
    if (row.idNew !== null && row.idNew !== undefined) nodeIdByIdNew.set(intOf(row.idNew), intOf(row.ID));
  }
  if (!nodeById.size) throw new Error('ydb 中没有节点（tblJoint 为空），无法还原几何。');

  // 平面归一化：平移到包围盒中心
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const node of nodeById.values()) {
    minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y);
  }
  const shiftX = -(minX + maxX) / 2;
  const shiftY = -(minY + maxY) / 2;
  const point = (id: number): Node | undefined => {
    const node = nodeById.get(id);
    return node ? { x: node.x + shiftX, y: node.y + shiftY, hdiff: node.hdiff } : undefined;
  };

  // ---- 网格（Jt1ID / Jt2ID → 两端节点；idCen 有效时为圆弧网格）----
  // 参考 yjks-model：tblGrid.idCen 是圆心节点的 idNew（0xFFFFFFFF 表示直线）。
  // 圆弧网格由圆心 + 两个弧端点确定，不能按直线连接，否则圆弧墙被画成弦。
  interface GridGeometry {
    a: Node;
    b: Node;
    /** 圆心（平移后的世界坐标）与从 a 到 b 的有符号扫掠角；直线网格为 undefined */
    arc?: { center: Node; sweep: number };
  }
  const gridById = new Map<number, GridGeometry>();
  /** 网格 ID → 两端节点的最大 HDiff(mm)。夹层板所依赖的网格边端点常带高差。 */
  const gridHdiff = new Map<number, number>();
  const grids: Grid[] = [];
  const ARC_CENTER_NONE = 4294967295;
  for (const row of query(db, 'SELECT ID, Jt1ID, Jt2ID, idCen FROM tblGrid')) {
    gridHdiff.set(intOf(row.ID), Math.max(nodeHdiffById.get(intOf(row.Jt1ID)) ?? 0, nodeHdiffById.get(intOf(row.Jt2ID)) ?? 0));
    const a = point(intOf(row.Jt1ID));
    const b = point(intOf(row.Jt2ID));
    if (!a || !b) continue;

    let arc: GridGeometry['arc'];
    const cenIdNew = intOf(row.idCen);
    if (row.idCen !== null && row.idCen !== undefined && cenIdNew !== ARC_CENTER_NONE) {
      const centerNodeId = nodeIdByIdNew.get(cenIdNew);
      const center = centerNodeId === undefined ? undefined : point(centerNodeId);
      if (center) {
        // 两端到圆心等距（ydb 约定）。用向量夹角求圆心角，叉积定方向，取劣弧（|sweep| ≤ π）。
        const a1 = Math.atan2(a.y - center.y, a.x - center.x);
        const a2 = Math.atan2(b.y - center.y, b.x - center.x);
        let sweep = a2 - a1;
        // 归一到 (-π, π]，即劣弧方向
        while (sweep <= -Math.PI) sweep += Math.PI * 2;
        while (sweep > Math.PI) sweep -= Math.PI * 2;
        if (Math.abs(sweep) > 1e-6) arc = { center, sweep };
      }
    }
    gridById.set(intOf(row.ID), { a, b, arc });
    if (Math.hypot(a.x - b.x, a.y - b.y) >= 0.01) {
      grids.push({ id: createId(), name: String(grids.length + 1), start: [a.x, a.y], end: [b.x, b.y] });
    }
  }

  // ---- 截面定义表 ----
  const colSect = new Map<number, SectionShape>();
  for (const row of query(db, 'SELECT ID, ShapeVal, Mat FROM tblColSect')) {
    colSect.set(intOf(row.ID), parseShapeVal(row.ShapeVal, num(row.Mat, 6)));
  }
  const beamSect = new Map<number, SectionShape>();
  for (const row of query(db, 'SELECT ID, ShapeVal, Mat FROM tblBeamSect')) {
    beamSect.set(intOf(row.ID), parseShapeVal(row.ShapeVal, num(row.Mat, 6)));
  }
  const braceSect = new Map<number, SectionShape>();
  for (const row of query(db, 'SELECT ID, ShapeVal, Mat FROM tblBraceSect')) {
    braceSect.set(intOf(row.ID), parseShapeVal(row.ShapeVal, num(row.Mat, 6)));
  }
  // 墙截面：tblWallSect.B 为厚度（mm）
  const wallSect = new Map<number, { thickness: number; materialId: string }>();
  for (const row of query(db, 'SELECT ID, B, Mat FROM tblWallSect')) {
    const thickness = num(row.B) * MM;
    wallSect.set(intOf(row.ID), {
      thickness: thickness > 0 ? thickness : 0.2,
      materialId: materialIdFor(num(row.Mat, 6)),
    });
  }

  // ---- 类型（按截面尺寸去重）----
  // ydb 的结构模型大多数只有「混凝土」一种材质码，若所有构件共用同一灰白色，
  // 视口里就是一片灰模、难以分辨。这里为混凝土按构件类别派生带区分度的颜色变体
  // （仍保留混凝土语义与名称），钢材 / 砌体等真实材质码则原样保留。
  const materials: Material[] = [
    { id: 'mat-concrete', name: '混凝土 · C30', color: '#a3adb8', roughness: 0.85, metalness: 0.02, description: '现浇混凝土（ydb 导入）' },
    { id: 'mat-concrete-slab', name: '混凝土 · 楼板', color: '#c8d4e0', roughness: 0.85, metalness: 0.02, description: '现浇混凝土楼板（ydb 导入）' },
    { id: 'mat-concrete-beam', name: '混凝土 · 梁', color: '#8faec4', roughness: 0.82, metalness: 0.02, description: '现浇混凝土梁（ydb 导入）' },
    { id: 'mat-concrete-column', name: '混凝土 · 柱', color: '#6d8fa8', roughness: 0.8, metalness: 0.02, description: '现浇混凝土柱（ydb 导入）' },
    { id: 'mat-concrete-wall', name: '混凝土 · 墙', color: '#d1c4ab', roughness: 0.88, metalness: 0.01, description: '现浇混凝土墙（ydb 导入）' },
    { id: 'mat-concrete-brace', name: '混凝土 · 支撑', color: '#a8c4b0', roughness: 0.82, metalness: 0.02, description: '现浇混凝土支撑（ydb 导入）' },
    { id: 'mat-steel', name: '钢材 · Q355', color: '#8b98a8', roughness: 0.35, metalness: 0.75, description: '结构钢（ydb 导入）' },
    { id: 'mat-masonry', name: '砌体', color: '#c6bba8', roughness: 0.9, metalness: 0.01, description: '砌体（ydb 导入）' },
  ];
  const materialIds = new Set(materials.map((material) => material.id));
  /** 混凝土按构件类别派生颜色变体；钢材 / 砌体等真实材质保持原样。 */
  const categoryMaterial = (baseId: string, category: 'slab' | 'beam' | 'column' | 'wall' | 'brace'): string =>
    baseId === 'mat-concrete' ? `mat-concrete-${category}` : baseId;
  const types: Array<ColumnType | BeamType | WallType | BraceType | SlabType> = [];

  const colTypeBySect = new Map<string, string>();
  const beamTypeBySect = new Map<string, string>();
  const braceTypeBySect = new Map<string, string>();
  const wallTypeBySect = new Map<string, string>();
  const slabTypeByThickness = new Map<number, string>();

  const keyOf = (w: number, h: number): string => `${w.toFixed(3)}x${h.toFixed(3)}`;
  const ensureColumnType = (shape: SectionShape): string => {
    const key = keyOf(shape.width, shape.depth);
    const existing = colTypeBySect.get(key);
    if (existing) return existing;
    const id = createId();
    types.push({
      id, category: 'column',
      name: `${shape.materialId === 'mat-steel' ? '钢' : '混凝土'}柱 ${Math.round(shape.width * 1000)}×${Math.round(shape.depth * 1000)}`,
      width: shape.width, depth: shape.depth, materialId: categoryMaterial(shape.materialId, 'column'),
    });
    colTypeBySect.set(key, id);
    return id;
  };
  const ensureBeamType = (shape: SectionShape): string => {
    const key = keyOf(shape.width, shape.depth);
    const existing = beamTypeBySect.get(key);
    if (existing) return existing;
    const id = createId();
    const label = shape.kind === 2 ? '工形' : shape.kind === 3 ? '圆' : shape.kind === 7 ? '箱形' : '矩形';
    types.push({
      id, category: 'beam',
      name: `${shape.materialId === 'mat-steel' ? '钢' : '混凝土'}${label}梁 ${Math.round(shape.width * 1000)}×${Math.round(shape.depth * 1000)}`,
      width: shape.width, depth: shape.depth, materialId: categoryMaterial(shape.materialId, 'beam'),
    });
    beamTypeBySect.set(key, id);
    return id;
  };
  const ensureBraceType = (shape: SectionShape): string => {
    const key = keyOf(shape.width, shape.depth);
    const existing = braceTypeBySect.get(key);
    if (existing) return existing;
    const id = createId();
    types.push({
      id, category: 'brace',
      name: `支撑 ${Math.round(shape.width * 1000)}×${Math.round(shape.depth * 1000)}`,
      width: shape.width, depth: shape.depth, materialId: categoryMaterial(shape.materialId, 'brace'),
    });
    braceTypeBySect.set(key, id);
    return id;
  };
  const ensureWallType = (sect: { thickness: number; materialId: string }): string => {
    const key = sect.thickness.toFixed(3);
    const existing = wallTypeBySect.get(key);
    if (existing) return existing;
    const id = createId();
    const materialId = categoryMaterial(sect.materialId, 'wall');
    types.push({
      id, category: 'wall',
      name: `${materialId === 'mat-steel' ? '钢' : '混凝土'}墙 ${Math.round(sect.thickness * 1000)}mm`,
      thickness: sect.thickness, materialId,
    });
    wallTypeBySect.set(key, id);
    return id;
  };
  const ensureSlabType = (thickness: number): string => {
    const key = Math.round(thickness * 1000);
    const existing = slabTypeByThickness.get(key);
    if (existing) return existing;
    const id = createId();
    types.push({
      id, category: 'slab',
      name: `混凝土楼板 ${key}mm`, thickness, materialId: 'mat-concrete-slab',
    });
    slabTypeByThickness.set(key, id);
    return id;
  };

  const elements: YdbImportResult['patch']['elements'] = [];
  const count: YdbStats = { levels: naturalFloors.length, grids: grids.length, columns: 0, beams: 0, arcBeams: 0, walls: 0, arcWalls: 0, braces: 0, slabs: 0, skewedSlabs: 0, mezzanineSlabs: 0, subBeams: 0 };

  const stamp = (category: 'wall' | 'column' | 'beam' | 'brace' | 'slab') => ({
    layerId: layerIdForCategory(category), visible: true,
  });

  // ---- 柱：JtID 定位，底部 LevelB+HDiffB，顶部 = 楼面标高 ----
  // 标准层被多自然层复用时，同一布置在每个自然层各生成一份。
  for (const row of query(db, 'SELECT ID, StdFlrID, SectID, JtID, HDiffB, Rotation FROM tblColSeg')) {
    const pos = point(intOf(row.JtID));
    const floors = floorsByStd.get(intOf(row.StdFlrID));
    if (!pos || !floors) continue;
    const shape = colSect.get(intOf(row.SectID)) ?? parseShapeVal(undefined, 6);
    const baseOffset = num(row.HDiffB) * MM;
    const typeId = ensureColumnType(shape);
    const rotation = num(row.Rotation) * Math.PI / 180;
    for (const floor of floors) {
      const column: ColumnInstance = {
        id: createId(), name: `柱 ${count.columns + 1}`, category: 'column',
        typeId, levelId: floor.levelId,
        ...stamp('column'),
        position: [pos.x, pos.y],
        rotation,
        baseOffset,
        topLevelId: floor.topLevelId, topOffset: 0,
      };
      elements.push(column);
      count.columns += 1;
    }
  }

  // ---- 梁：GridID → 两端节点；梁顶 = 楼面标高，梁底 = 楼面 − 梁高 ----
  const addBeam = (sectId: number, stdFlrId: number, gridId: number, name: string): void => {
    const grid = gridById.get(gridId);
    const floors = floorsByStd.get(stdFlrId);
    if (!grid || !floors) return;
    const shape = beamSect.get(sectId) ?? parseShapeVal(undefined, 6);
    const typeId = ensureBeamType(shape);
    // 圆弧网格：写入圆心与有符号扫掠角，供几何层还原弧形梁
    const arcCenter: [number, number] | undefined = grid.arc
      ? [grid.arc.center.x, grid.arc.center.y] : undefined;
    const arcSweep = grid.arc?.sweep;
    for (const floor of floors) {
      const beam: BeamInstance = {
        id: createId(), name, category: 'beam',
        typeId, levelId: floor.levelId,
        ...stamp('beam'),
        start: [grid.a.x, grid.a.y], end: [grid.b.x, grid.b.y],
        baseOffset: Math.max(0, floor.height - shape.depth),
        topLevelId: floor.topLevelId, topOffset: 0,
        rotation: 0,
        ...(arcCenter ? { arcCenter, arcSweep } : {}),
      };
      elements.push(beam);
      count.beams += 1;
      if (arcCenter) count.arcBeams = (count.arcBeams ?? 0) + 1;
    }
  };
  for (const row of query(db, 'SELECT ID, StdFlrID, SectID, GridID FROM tblBeamSeg')) {
    addBeam(intOf(row.SectID), intOf(row.StdFlrID), intOf(row.GridID), `梁 ${count.beams + 1}`);
  }
  // 次梁：直接存 X1/Y1/Z1、X2/Y2/Z2（相对层底），补进网格临时表后当梁处理
  const subBeamRows = query(db, 'SELECT ID, StdFlrID, SectID, X1, Y1, Z1, X2, Y2, Z2 FROM tblSubBeam');
  for (const row of subBeamRows) {
    const floors = floorsByStd.get(intOf(row.StdFlrID));
    if (!floors) continue;
    const shape = beamSect.get(intOf(row.SectID)) ?? parseShapeVal(undefined, 6);
    const typeId = ensureBeamType(shape);
    const z = num(row.Z1, num(row.Z2)) * MM;
    for (const floor of floors) {
      const beam: BeamInstance = {
        id: createId(), name: `次梁 ${count.subBeams + 1}`, category: 'beam',
        typeId, levelId: floor.levelId,
        ...stamp('beam'),
        start: [num(row.X1) * MM + shiftX, num(row.Y1) * MM + shiftY],
        end: [num(row.X2) * MM + shiftX, num(row.Y2) * MM + shiftY],
        baseOffset: Math.max(0, floor.height - shape.depth - z),
        topLevelId: floor.topLevelId, topOffset: 0, rotation: 0,
      };
      elements.push(beam);
      count.beams += 1;
      count.subBeams += 1;
    }
  }

  // ---- 墙：GridID → 两端；底部 层底+HDiffB，顶部 = 楼面标高 ----
  for (const row of query(db, 'SELECT ID, StdFlrID, SectID, GridID, HDiffB FROM tblWallSeg')) {
    const grid = gridById.get(intOf(row.GridID));
    const floors = floorsByStd.get(intOf(row.StdFlrID));
    if (!grid || !floors) continue;
    const sect = wallSect.get(intOf(row.SectID)) ?? { thickness: 0.2, materialId: 'mat-concrete' };
    const typeId = ensureWallType(sect);
    const baseOffset = num(row.HDiffB) * MM;
    // 圆弧网格：写入圆心与有符号扫掠角，供几何层还原弧形墙
    const arcCenter: [number, number] | undefined = grid.arc
      ? [grid.arc.center.x, grid.arc.center.y] : undefined;
    const arcSweep = grid.arc?.sweep;
    for (const floor of floors) {
      const wall: WallInstance = {
        id: createId(), name: `墙 ${count.walls + 1}`, category: 'wall',
        typeId, levelId: floor.levelId,
        ...stamp('wall'),
        start: [grid.a.x, grid.a.y], end: [grid.b.x, grid.b.y],
        baseOffset,
        topLevelId: floor.topLevelId, topOffset: 0,
        ...(arcCenter ? { arcCenter, arcSweep } : {}),
      };
      elements.push(wall);
      count.walls += 1;
      if (arcCenter) count.arcWalls = (count.arcWalls ?? 0) + 1;
    }
  }

  // ---- 支撑：Jt1ID / Jt2ID 两端节点；两端高度由 HDiff1/HDiff2 决定 ----
  // 依据 yjks-model（YjkModelLoaderImpl.cpp）：
  //   startZOffset = (HDiff1 == 1) ? (层高 + 节点1.HDiff) : HDiff1
  //   endZOffset   = (HDiff2 == 1) ? (层高 + 节点2.HDiff) : HDiff2
  // 即 HDiff==1 是「该端点在本层顶」的哨兵，而非 1mm。旧代码当成 1mm 导致斜撑两端都塌到层底、平躺。
  for (const row of query(db, 'SELECT ID, StdFlrID, SectID, Jt1ID, Jt2ID, HDiff1, HDiff2 FROM tblBraceSeg')) {
    const a = point(intOf(row.Jt1ID));
    const b = point(intOf(row.Jt2ID));
    const floors = floorsByStd.get(intOf(row.StdFlrID));
    if (!a || !b || !floors) continue;
    const nodeA = nodeById.get(intOf(row.Jt1ID));
    const nodeB = nodeById.get(intOf(row.Jt2ID));
    const shape = braceSect.get(intOf(row.SectID)) ?? parseShapeVal(undefined, 6);
    const typeId = ensureBraceType(shape);
    const h1 = num(row.HDiff1);
    const h2 = num(row.HDiff2);
    for (const floor of floors) {
      // 两端相对层底的绝对高度（米）。HDiff==1 哨兵 → 本层顶（层高 + 节点高差）；否则 HDiff 即毫米偏移。
      const startZ = h1 === 1 ? floor.height + (nodeA?.hdiff ?? 0) : h1 * MM;
      const endZ = h2 === 1 ? floor.height + (nodeB?.hdiff ?? 0) : h2 * MM;
      const brace: BraceInstance = {
        id: createId(), name: `支撑 ${count.braces + 1}`, category: 'brace',
        typeId, levelId: floor.levelId,
        ...stamp('brace'),
        start: [a.x, a.y], end: [b.x, b.y],
        baseOffset: startZ,
        topLevelId: floor.topLevelId,
        // topElevation = 层底 + 层高 + topOffset 应等于 层底 + endZ ⇒ topOffset = endZ − 层高
        topOffset: endZ - floor.height,
        rotation: 0,
      };
      elements.push(brace);
      count.braces += 1;
    }
  }

  // ---- 板：VertexX/Y/Z 点列 → 轮廓；厚度 Thickness ----
  // 关键（依据 yjks-model 参考实现）：VertexZ 是【板顶相对楼面标高(层底+层高)】的偏移，
  // 降板为负值（如 -50 / -150）。板底绝对标高 = 层底 + 层高 + VertexZ − 板厚。
  // 标准层被多自然层复用时，同一板布置在每个自然层各生成一份。
  let fallbackSlabCount = 0;
  for (const row of query(db, 'SELECT ID, StdFlrID, VertexX, VertexY, VertexZ, Thickness, cc, GridsID FROM tblSlab')) {
    const floors = floorsByStd.get(intOf(row.StdFlrID));
    if (!floors) continue;
    const xs = numberList(row.VertexX);
    const ys = numberList(row.VertexY);
    const zs = numberList(row.VertexZ);
    let n = Math.min(xs.length, ys.length, zs.length);
    if (n < 3) continue;
    // YJK 顶点序列末尾固定带一个 (0,0,0) 结束哨兵，不是真实顶点；
    // 若末点为 (0,0) 且前面仍有 ≥3 点，剔除它，否则会在轮廓中心多出一个错误尖角。
    if (n >= 4 && xs[n - 1] === 0 && ys[n - 1] === 0) n -= 1;
    if (n < 3) continue;
    // YJK 用 Thickness=9999（及 0）表示「板厚未单独指定」，必须回退到标准层默认板厚，
    // 不能当成真实的 9.999m 厚板（否则会生成悬空的巨厚竖板）。
    const rawThicknessMm = num(row.Thickness);
    let t = rawThicknessMm * MM;
    const needsFallback = rawThicknessMm === 9999 || rawThicknessMm <= 0 || rawThicknessMm > 1000;
    if (needsFallback) {
      t = stdDefaultSlabThickness.get(intOf(row.StdFlrID)) ?? fallbackSlabThickness;
      fallbackSlabCount += 1;
    }
    if (!(t > 0)) t = 0.12;
    // 取板顶点 Z 的代表值（第一点）；VertexZ 已是相对楼面标高，cc(错层)在计算中相互抵消。
    const zTopMm = num(zs[0]);
    const zTop = zTopMm * MM;
    // 夹层板识别：YJK 里夹层/错层平台的顶点落在带 HDiff>0 的节点上，且 VertexZ 等于该节点高差
    // （如幼儿园 VertexZ=1500 ↔ 节点 HDiff=1500；图书馆 10800 ↔ 10800）。这类板的 VertexZ 是
    // 【相对层底】的绝对高差，板顶 = 层底 + VertexZ；若按普通板再叠加层高会飘到楼面上方，正是「楼板飘起」。
    // 普通楼板(VertexZ≤0)、降板、逐点不同的斜板都不满足此判据，保持原逻辑不变。
    let isMezzanine = false;
    if (zTopMm > 0 && zs.every((v) => Math.abs(num(v) - zTopMm) < 1)) {
      // 判据 1：轮廓顶点落在带相同 HDiff 的节点上
      for (let i = 0; i < n; i += 1) {
        const hdiffMm = nodeHdiffByCoord.get(`${Math.round(num(xs[i]))},${Math.round(num(ys[i]))}`);
        if (hdiffMm !== undefined && hdiffMm > 0 && Math.abs(hdiffMm - zTopMm) < 1) {
          isMezzanine = true;
          break;
        }
      }
      // 判据 2：GridsID 关联的网格边端点节点带相同 HDiff（板顶点未必落在高差节点上）
      if (!isMezzanine) {
        for (const gid of numberList(row.GridsID)) {
          const gh = gridHdiff.get(gid);
          if (gh !== undefined && gh > 0 && Math.abs(gh - zTopMm) < 1) {
            isMezzanine = true;
            break;
          }
        }
      }
    }
    const points: Array<[number, number]> = [];
    /** 斜板：各顶点相对第一点的 Z 偏移（米）；平板时全为 0 */
    const vertexZ: number[] = [];
    let skewed = false;
    for (let i = 0; i < n; i += 1) {
      points.push([xs[i]! * MM + shiftX, ys[i]! * MM + shiftY]);
      const dz = (num(zs[i]) - num(zs[0])) * MM;
      vertexZ.push(Math.round(dz * 1e6) / 1e6);
      if (Math.abs(dz) > 1e-4) skewed = true;
    }
    const typeId = ensureSlabType(t);
    for (const floor of floors) {
      // SlabInstance 轮廓在板底。普通板：板顶 = 层底 + 层高 + VertexZ；
      // 夹层板：板顶 = 层底 + VertexZ（VertexZ 是带高差节点的相对层底绝对高度，不再叠加层高）。
      const topAboveBase = isMezzanine ? zTop : floor.height + zTop;
      const slab: SlabInstance = {
        id: createId(), name: `楼板 ${count.slabs + 1}`, category: 'slab',
        typeId, levelId: floor.levelId,
        ...stamp('slab'),
        points,
        baseOffset: topAboveBase - t,
        ...(skewed ? { vertexZ } : {}),
      };
      elements.push(slab);
      count.slabs += 1;
      if (isMezzanine) count.mezzanineSlabs = (count.mezzanineSlabs ?? 0) + 1;
      if (skewed) count.skewedSlabs = (count.skewedSlabs ?? 0) + 1;
    }
  }
  if (fallbackSlabCount > 0) {
    notices.push(`${fallbackSlabCount} 块楼板的厚度在 ydb 中标记为未指定（9999/0），已按该标准层的默认板厚处理。`);
  }

  // 材质去重（项目已有内置材质时按 id 覆盖，这里只带回实际用到的）
  const usedMaterials = new Set<string>();
  for (const element of elements) {
    const type = types.find((item) => item.id === element.typeId);
    if (type && 'materialId' in type) usedMaterials.add(type.materialId);
  }
  const patchMaterials = materials.filter((material) => usedMaterials.has(material.id));
  // 保证 type 引用的材质都存在（含内置 mat-wood 等不会用到）
  for (const id of usedMaterials) {
    if (!materialIds.has(id)) {
      patchMaterials.push({ id, name: id, color: '#a3adb8', roughness: 0.7, metalness: 0.1 });
    }
  }

  if (!elements.length) {
    notices.push('未识别到柱 / 梁 / 墙 / 支撑 / 板构件，可能该文件不含结构布置或表结构不兼容。');
  }
  if (count.subBeams) notices.push(`次梁 ${count.subBeams} 根按端点坐标还原为梁。`);
  if (count.arcBeams) notices.push(`${count.arcBeams} 根梁位于圆弧网格，已按弧线还原。`);
  if (count.skewedSlabs) notices.push(`${count.skewedSlabs} 块楼板各顶点标高不同，已按斜板还原。`);
  if (count.mezzanineSlabs) notices.push(`${count.mezzanineSlabs} 块楼板位于夹层/错层平台，已按节点的相对层底高差定位（避免悬空）。`);
  if (!count.grids) notices.push('文件缺少网格（tblGrid），梁墙按节点连线还原。');

  return {
    fileName: name,
    stats: count,
    notices,
    patch: { levels, grids, materials: patchMaterials, types, elements },
  };
}
