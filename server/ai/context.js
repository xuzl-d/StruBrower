/** 把项目压缩成 LLM 可读的上下文（不发送网格几何，避免超大 token）。 */
export function buildProjectContext(document, selectedIds = []) {
  const levelName = new Map(document.levels.map((level) => [level.id, level.name]));
  const typeById = new Map(document.types.map((type) => [type.id, type]));

  const elements = document.elements.slice(0, 120).map((element) => {
    const base = {
      id: element.id,
      name: element.name,
      category: element.category,
      level: levelName.get(element.levelId) ?? null,
      type: typeById.get(element.typeId)?.name ?? null,
    };
    if (element.category === 'wall') return { ...base, start: element.start, end: element.end };
    if (element.category === 'column') return { ...base, position: element.position };
    if (element.category === 'slab') return { ...base, vertices: element.points?.length ?? 0 };
    return { ...base, source: element.source };
  });

  const counts = document.elements.reduce((acc, element) => {
    acc[element.category] = (acc[element.category] ?? 0) + 1;
    return acc;
  }, {});

  return {
    project: document.name,
    units: 'meter',
    coordinateSystem: 'Z-up',
    levels: document.levels.map((level) => ({ name: level.name, elevation: level.elevation })),
    types: document.types.map((type) => ({
      name: type.name,
      category: type.category,
      ...(type.thickness !== undefined ? { thickness: type.thickness } : {}),
      ...(type.width !== undefined ? { width: type.width, depth: type.depth } : {}),
    })),
    grids: document.grids.map((grid) => ({ name: grid.name, start: grid.start, end: grid.end })),
    counts,
    selected: elements.filter((element) => selectedIds.includes(element.id)),
    elements,
    truncated: document.elements.length > elements.length,
  };
}
