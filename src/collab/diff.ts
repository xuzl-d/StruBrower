import type { BimElement, CategoryOverride, ElementCategory, FamilyType, Grid, Layer, Level, Material, ProjectDocument, ProjectParameter } from '../bim/types';

/**
 * 协作补丁：与服务端 server/validate.js 使用同一套语义。
 * - 构件按 id 合并：先 remove，再 put 覆盖/追加（保持原顺序，新构件追加到末尾）
 * - 标高/轴网/类型/材质为小集合，整包替换
 * - 未变化的对象按引用比较跳过，避免对大网格做 JSON 序列化
 */
export interface DocumentDiff {
  name?: string;
  levels?: Level[];
  grids?: Grid[];
  types?: FamilyType[];
  materials?: Material[];
  /** 图层表与类别可见性替换为小集合，整包替换 */
  layers?: Layer[];
  categoryOverrides?: Partial<Record<ElementCategory, CategoryOverride>>;
  /** 全局参数表整包替换 */
  parameters?: ProjectParameter[];
  elements?: {
    put?: BimElement[];
    remove?: string[];
  };
}

function sameContent(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function diffDocuments(prev: ProjectDocument, next: ProjectDocument): DocumentDiff | null {
  if (prev === next) return null;
  const diff: DocumentDiff = {};
  if (prev.name !== next.name) diff.name = next.name;

  if (prev.levels !== next.levels && !sameContent(prev.levels, next.levels)) diff.levels = next.levels;
  if (prev.grids !== next.grids && !sameContent(prev.grids, next.grids)) diff.grids = next.grids;
  if (prev.types !== next.types && !sameContent(prev.types, next.types)) diff.types = next.types;
  if (prev.materials !== next.materials && !sameContent(prev.materials, next.materials)) diff.materials = next.materials;
  if (prev.layers !== next.layers && !sameContent(prev.layers, next.layers)) diff.layers = next.layers;
  if (prev.categoryOverrides !== next.categoryOverrides && !sameContent(prev.categoryOverrides, next.categoryOverrides)) {
    diff.categoryOverrides = next.categoryOverrides;
  }
  if (prev.parameters !== next.parameters && !sameContent(prev.parameters, next.parameters)) diff.parameters = next.parameters;

  const previousById = new Map(prev.elements.map((element) => [element.id, element]));
  const nextIds = new Set(next.elements.map((element) => element.id));
  const put: BimElement[] = [];
  for (const element of next.elements) {
    const before = previousById.get(element.id);
    if (!before) {
      put.push(element);
      continue;
    }
    if (before === element) continue;
    if (!sameContent(before, element)) put.push(element);
  }
  const remove = [...previousById.keys()].filter((id) => !nextIds.has(id));
  if (put.length || remove.length) {
    diff.elements = {
      ...(put.length ? { put } : {}),
      ...(remove.length ? { remove } : {}),
    };
  }

  return Object.keys(diff).length ? diff : null;
}

export function applyDocumentDiff(document: ProjectDocument, diff: DocumentDiff): ProjectDocument {
  const next: ProjectDocument = { ...document };
  if (typeof diff.name === 'string' && diff.name.trim()) next.name = diff.name.trim();
  if (diff.levels) next.levels = diff.levels;
  if (diff.grids) next.grids = diff.grids;
  if (diff.types) next.types = diff.types;
  if (diff.materials) next.materials = diff.materials;
  if (diff.layers) next.layers = diff.layers;
  if (diff.categoryOverrides) next.categoryOverrides = diff.categoryOverrides;
  if (diff.parameters) next.parameters = diff.parameters;

  if (diff.elements) {
    const remove = new Set(diff.elements.remove ?? []);
    const merged = new Map<string, BimElement>();
    for (const element of document.elements) {
      if (!remove.has(element.id)) merged.set(element.id, element);
    }
    for (const element of diff.elements.put ?? []) merged.set(element.id, element);
    next.elements = [...merged.values()];
  }
  return next;
}

export function isEmptyDiff(diff: DocumentDiff | null): boolean {
  if (!diff) return true;
  if (diff.elements && !diff.elements.put?.length && !diff.elements.remove?.length) {
    const rest = Object.keys(diff).filter((key) => key !== 'elements');
    return rest.length === 0;
  }
  return Object.keys(diff).length === 0;
}
