import crypto from 'node:crypto';

/**
 * AI 建模指令（BIM ops）：LLM 只能改这些结构化指令，服务端逐条校验后再落库。
 * 好处：可校验、可预览、可撤销、可与协作 rev 合并；模型无法直接写坏文档。
 */
const OPS = new Set([
  'addLevel',
  'addGrid',
  'addWall',
  'addColumn',
  'addSlab',
  'updateElement',
  'setTypeProperty',
  'deleteElement',
]);

const CATEGORY_LABELS = { wall: '墙', column: '柱', slab: '楼板' };
const MAX_OPS = 60;

export class OpsError extends Error {}

const newId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

function num(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new OpsError(`${label} 必须是数字`);
  if (Math.abs(value) > 20000) throw new OpsError(`${label} 超出允许范围（±20000）`);
  return value;
}

function point(value, label) {
  if (!Array.isArray(value) || value.length !== 2) throw new OpsError(`${label} 必须是 [x, y]`);
  return [num(value[0], `${label}[0]`), num(value[1], `${label}[1]`)];
}

function resolveLevel(document, ref) {
  if (!ref) return document.levels[0];
  const found = document.levels.find(
    (level) => level.id === ref || level.name.toLowerCase() === String(ref).toLowerCase(),
  );
  if (!found) throw new OpsError(`找不到标高「${ref}」`);
  return found;
}

function resolveElement(document, target) {
  if (typeof target !== 'string' || !target.trim()) throw new OpsError('target 必须提供构件 id 或名称');
  const byId = document.elements.find((element) => element.id === target);
  if (byId) return byId;
  const matches = document.elements.filter(
    (element) => element.name.toLowerCase() === target.toLowerCase(),
  );
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new OpsError(`找不到构件「${target}」`);
  throw new OpsError(`构件名称「${target}」匹配到 ${matches.length} 个，请改用 id`);
}

function nextElementName(document, category) {
  const prefix = CATEGORY_LABELS[category] ?? '构件';
  const used = new Set(document.elements.map((element) => element.name));
  for (let index = 1; index < 10000; index += 1) {
    const candidate = `${prefix} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${prefix} ${Date.now()}`;
}

function defaultMaterialId(document) {
  return document.materials[0]?.id ?? '';
}

function createType(document, category, overrides = {}) {
  if (category === 'wall') {
    const thickness = overrides.thickness ?? 0.2;
    return {
      id: newId('type'),
      category,
      name: overrides.name ?? `墙 ${Math.round(thickness * 1000)}mm`,
      thickness,
      materialId: defaultMaterialId(document),
    };
  }
  if (category === 'column') {
    const width = overrides.width ?? 0.4;
    const depth = overrides.depth ?? 0.4;
    return {
      id: newId('type'),
      category,
      name: overrides.name ?? `柱 ${Math.round(width * 1000)}×${Math.round(depth * 1000)}`,
      width,
      depth,
      materialId: defaultMaterialId(document),
    };
  }
  const thickness = overrides.thickness ?? 0.15;
  return {
    id: newId('type'),
    category,
    name: overrides.name ?? `楼板 ${Math.round(thickness * 1000)}mm`,
    thickness,
    materialId: defaultMaterialId(document),
  };
}

/** 解析类型：按名称/id → 同类别默认 → 按尺寸参数复用或新建。类型会写入 next.types。 */
function resolveType(next, ref, category, overrides = {}) {
  let type = null;
  if (ref) {
    type = next.types.find(
      (item) => item.id === ref || item.name.toLowerCase() === String(ref).toLowerCase(),
    );
    if (type && type.category !== category) {
      throw new OpsError(`类型「${ref}」不是${CATEGORY_LABELS[category]}`);
    }
  }
  if (!type) type = next.types.find((item) => item.category === category);

  const hasOverride = category === 'wall' || category === 'slab'
    ? overrides.thickness !== undefined
    : overrides.width !== undefined || overrides.depth !== undefined;

  if (type && hasOverride) {
    const sameSize = next.types.find((item) => {
      if (item.category !== category) return false;
      if (category === 'wall' || category === 'slab') {
        return Math.abs((item.thickness ?? 0) - (overrides.thickness ?? 0)) < 1e-6;
      }
      return Math.abs((item.width ?? 0) - (overrides.width ?? 0)) < 1e-6
        && Math.abs((item.depth ?? 0) - (overrides.depth ?? 0)) < 1e-6;
    });
    if (sameSize) return sameSize;
    const created = createType(next, category, overrides);
    next.types.push(created);
    return created;
  }

  if (!type) {
    type = createType(next, category, overrides);
    next.types.push(type);
  }
  return type;
}

function nextLevelAbove(document, level) {
  return document.levels
    .filter((item) => item.elevation > level.elevation + 1e-6)
    .sort((a, b) => a.elevation - b.elevation)[0];
}

function rectPoints(rect) {
  if (!rect || typeof rect !== 'object') throw new OpsError('缺少 rect');
  const x = num(rect.x ?? 0, 'rect.x');
  const y = num(rect.y ?? 0, 'rect.y');
  const width = num(rect.width, 'rect.width');
  const depth = num(rect.depth, 'rect.depth');
  if (width < 0.2 || depth < 0.2) throw new OpsError('楼板尺寸至少 0.2 m');
  return [
    [x, y],
    [x + width, y],
    [x + width, y + depth],
    [x, y + depth],
  ];
}

function validateOp(op) {
  if (!op || typeof op !== 'object') throw new OpsError('指令必须是对象');
  if (!OPS.has(op.op)) {
    throw new OpsError(`不支持的指令「${op.op}」，可用：${[...OPS].join(', ')}`);
  }
}

/**
 * 在当前文档上顺序应用 ops，返回新文档与人类可读的执行摘要。
 * 抛出 OpsError 时调用方应返回 400，不写库。
 */
export function applyOps(document, ops) {
  if (!Array.isArray(ops) || !ops.length) throw new OpsError('没有可执行的指令');
  if (ops.length > MAX_OPS) throw new OpsError(`单次最多 ${MAX_OPS} 条指令`);

  const next = {
    ...document,
    levels: [...document.levels],
    grids: [...document.grids],
    types: [...document.types],
    materials: [...document.materials],
    elements: [...document.elements],
  };
  const applied = [];

  for (const op of ops) {
    validateOp(op);
    switch (op.op) {
      case 'addLevel': {
        const name = String(op.name ?? '').trim();
        if (!name) throw new OpsError('标高名称不能为空');
        if (next.levels.some((level) => level.name.toLowerCase() === name.toLowerCase())) {
          throw new OpsError(`标高「${name}」已存在`);
        }
        const elevation = num(op.elevation, 'elevation');
        next.levels.push({ id: newId('level'), name, elevation });
        next.levels.sort((a, b) => a.elevation - b.elevation);
        applied.push(`新增标高 ${name}（${elevation.toFixed(2)} m）`);
        break;
      }

      case 'addGrid': {
        const start = point(op.start, 'start');
        const end = point(op.end, 'end');
        if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 0.2) throw new OpsError('轴网太短');
        const name = String(op.name ?? next.grids.length + 1);
        next.grids.push({ id: newId('grid'), name, start, end });
        applied.push(`新增轴网 ${name}`);
        break;
      }

      case 'addWall': {
        const level = resolveLevel(next, op.level);
        const start = point(op.start, 'start');
        const end = point(op.end, 'end');
        const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
        if (length < 0.1) throw new OpsError('墙长度至少 0.1 m');
        const type = resolveType(next, op.type, 'wall', { thickness: op.thickness });
        const above = op.topLevel ? resolveLevel(next, op.topLevel) : nextLevelAbove(next, level);
        const height = typeof op.height === 'number' ? num(op.height, 'height') : 3;
        next.elements.push({
          id: newId('wall'),
          name: op.name ? String(op.name) : nextElementName(next, 'wall'),
          category: 'wall',
          typeId: type.id,
          levelId: level.id,
          visible: true,
          start,
          end,
          baseOffset: typeof op.baseOffset === 'number' ? num(op.baseOffset, 'baseOffset') : 0,
          topLevelId: above ? above.id : level.id,
          topOffset: above
            ? (typeof op.topOffset === 'number' ? num(op.topOffset, 'topOffset') : 0)
            : height,
        });
        applied.push(`新增墙（${length.toFixed(2)} m，${type.name}）`);
        break;
      }

      case 'addColumn': {
        const level = resolveLevel(next, op.level);
        const position = point(op.position, 'position');
        const type = resolveType(next, op.type, 'column', { width: op.width, depth: op.depth });
        const above = op.topLevel ? resolveLevel(next, op.topLevel) : nextLevelAbove(next, level);
        const height = typeof op.height === 'number' ? num(op.height, 'height') : 3;
        next.elements.push({
          id: newId('column'),
          name: op.name ? String(op.name) : nextElementName(next, 'column'),
          category: 'column',
          typeId: type.id,
          levelId: level.id,
          visible: true,
          position,
          rotation: typeof op.rotation === 'number' ? num(op.rotation, 'rotation') : 0,
          baseOffset: typeof op.baseOffset === 'number' ? num(op.baseOffset, 'baseOffset') : 0,
          topLevelId: above ? above.id : level.id,
          topOffset: above
            ? (typeof op.topOffset === 'number' ? num(op.topOffset, 'topOffset') : 0)
            : height,
        });
        applied.push(`新增柱（${type.name}）`);
        break;
      }

      case 'addSlab': {
        const level = resolveLevel(next, op.level);
        const points = Array.isArray(op.points) ? op.points.map((item, index) => point(item, `points[${index}]`)) : rectPoints(op.rect);
        if (points.length < 3) throw new OpsError('楼板至少需要 3 个轮廓点');
        const type = resolveType(next, op.type, 'slab', { thickness: op.thickness });
        next.elements.push({
          id: newId('slab'),
          name: op.name ? String(op.name) : nextElementName(next, 'slab'),
          category: 'slab',
          typeId: type.id,
          levelId: level.id,
          visible: true,
          points,
          baseOffset: typeof op.baseOffset === 'number' ? num(op.baseOffset, 'baseOffset') : 0,
        });
        applied.push(`新增楼板（${points.length} 个轮廓点，${type.name}）`);
        break;
      }

      case 'updateElement': {
        const element = resolveElement(next, op.target);
        const index = next.elements.findIndex((item) => item.id === element.id);
        const patch = {};
        if (op.name !== undefined) patch.name = String(op.name);
        if (op.start !== undefined) patch.start = point(op.start, 'start');
        if (op.end !== undefined) patch.end = point(op.end, 'end');
        if (op.baseOffset !== undefined) patch.baseOffset = num(op.baseOffset, 'baseOffset');
        if (op.topOffset !== undefined) patch.topOffset = num(op.topOffset, 'topOffset');
        if (op.level !== undefined) patch.levelId = resolveLevel(next, op.level).id;
        if (op.topLevel !== undefined) patch.topLevelId = resolveLevel(next, op.topLevel).id;
        if (op.visible !== undefined) patch.visible = Boolean(op.visible);
        if (!Object.keys(patch).length) throw new OpsError('updateElement 没有任何可更新字段');
        next.elements[index] = { ...element, ...patch };
        applied.push(`修改构件 ${element.name}`);
        break;
      }

      case 'setTypeProperty': {
        const type = next.types.find(
          (item) => item.id === op.type || item.name.toLowerCase() === String(op.type ?? '').toLowerCase(),
        );
        if (!type) throw new OpsError(`找不到类型「${op.type}」`);
        const index = next.types.findIndex((item) => item.id === type.id);
        const patch = { ...type };
        if (op.thickness !== undefined) {
          if (type.category === 'column') throw new OpsError('柱类型没有厚度参数');
          patch.thickness = num(op.thickness, 'thickness');
          if (patch.thickness <= 0.01) throw new OpsError('厚度必须大于 0.01 m');
        }
        if (op.width !== undefined) patch.width = num(op.width, 'width');
        if (op.depth !== undefined) patch.depth = num(op.depth, 'depth');
        if (op.name !== undefined) patch.name = String(op.name);
        next.types[index] = patch;
        applied.push(`修改类型 ${type.name}`);
        break;
      }

      case 'deleteElement': {
        const element = resolveElement(next, op.target);
        next.elements = next.elements.filter((item) => item.id !== element.id);
        applied.push(`删除构件 ${element.name}`);
        break;
      }

      default:
        throw new OpsError(`未实现的指令 ${op.op}`);
    }
  }

  return { document: next, applied };
}

/** 给 UI 用的简要统计：{"墙": 4, "楼板": 1} */
export function summarizeOps(ops) {
  const counts = {};
  for (const op of Array.isArray(ops) ? ops : []) {
    const label = {
      addLevel: '标高',
      addGrid: '轴网',
      addWall: '墙',
      addColumn: '柱',
      addSlab: '楼板',
      updateElement: '修改构件',
      setTypeProperty: '修改类型',
      deleteElement: '删除构件',
    }[op?.op] ?? op?.op ?? '未知';
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}
