/**
 * 楼层（标高）管理器：按高度升序列出项目全部标高，支持重命名、改标高值、设为当前、
 * 添加、删除、合并重复。楼层顺序由标高值决定（不手动排序）。所有修改通过 onUpdate 走 App.commit，
 * 因此可撤销、可协作同步；readOnly 时全部编辑入口关闭。
 */
import { useMemo } from 'react';
import { sortedLevels } from '../bim/document';
import { createId } from '../bim/id';
import type { BimElement, ProjectDocument } from '../bim/types';
import { NumberCommit, TextCommit } from './ManagerFields';
import ModalShell from './ModalShell';

export interface LevelsDialogProps {
  project: ProjectDocument;
  activeLevelId: string;
  readOnly: boolean;
  onUpdate: (mutator: (project: ProjectDocument) => ProjectDocument, label: string) => void;
  /** 设为当前工作标高（切回视口后用 selectLevel 同步全部状态） */
  onActivate: (levelId: string) => void;
  onClose: () => void;
  onToast?: (text: string) => void;
}

/** 顶部约束字段仅部分类别有，统一在此判定。 */
function topLevelIdOf(element: BimElement): string | undefined {
  return 'topLevelId' in element ? (element as { topLevelId?: string }).topLevelId : undefined;
}

export default function LevelsDialog({
  project, activeLevelId, readOnly, onUpdate, onActivate, onClose, onToast,
}: LevelsDialogProps) {
  /**楼层顺序由标高值决定，按高度升序显示 */
  const levels = useMemo(() => sortedLevels(project), [project]);
  /** 每个标高的底部约束 / 顶部约束构件数，供删除提示与列表展示 */
  const usage = useMemo(() => {
    const base = new Map<string, number>();
    const top = new Map<string, number>();
    for (const element of project.elements) {
      base.set(element.levelId, (base.get(element.levelId) ?? 0) + 1);
      const topId = topLevelIdOf(element);
      if (topId) top.set(topId, (top.get(topId) ?? 0) + 1);
    }
    return { base, top };
  }, [project.elements]);

  const apply = (mutator: (project: ProjectDocument) => ProjectDocument, label: string) => {
    if (readOnly) {
      onToast?.('当前角色为查看者，标高设置只读');
      return;
    }
    onUpdate(mutator, label);
  };

  const patchLevel = (id: string, patch: { name?: string; elevation?: number }, label: string) => {
    apply(
      (current) => ({
        ...current,
        levels: current.levels.map((level) => (level.id === id ? { ...level, ...patch } : level)),
      }),
      label,
    );
  };

  /** 名称 + 标高值（保留 3 位）相同的视为重复组 */
  const duplicateGroups = useMemo(() => {
    const groups = new Map<string, typeof levels>();
    for (const level of levels) {
      const key = `${level.name.trim()}|${level.elevation.toFixed(3)}`;
      const group = groups.get(key);
      if (group) group.push(level);
      else groups.set(key, [level]);
    }
    return [...groups.values()].filter((group) => group.length > 1);
  }, [levels]);
  const duplicateRows = useMemo(() => {
    const ids = new Set<string>();
    for (const group of duplicateGroups) for (const level of group) ids.add(level.id);
    return ids;
  }, [duplicateGroups]);

  /** 合并重复标高：每组保留标高值最低（列表最前）的一项，其余构件的 levelId / topLevelId 改挂到保留项。 */
  const mergeDuplicates = () => {
    if (readOnly || !duplicateGroups.length) return;
    const redirect = new Map<string, string>();
    for (const group of duplicateGroups) {
      const keeper = group[0]!;
      for (const level of group.slice(1)) redirect.set(level.id, keeper.id);
    }
    const removedCount = redirect.size;
    if (!window.confirm(`检测到 ${duplicateGroups.length} 组重复标高，共 ${removedCount} 个可合并。合并后引用它们的构件会自动改挂到保留项，是否继续？`)) return;
    onUpdate((current) => ({
      ...current,
      levels: current.levels.filter((level) => !redirect.has(level.id)),
      elements: current.elements.map((element) => {
        const topId = topLevelIdOf(element);
        const newLevelId = redirect.get(element.levelId);
        const newTopId = topId ? redirect.get(topId) : undefined;
        if (!newLevelId && !newTopId) return element;
        const patch: Record<string, string> = {};
        if (newLevelId) patch.levelId = newLevelId;
        if (newTopId) patch.topLevelId = newTopId;
        return { ...element, ...patch } as BimElement;
      }),
    }), `已合并 ${removedCount} 个重复标高`);
    if (redirect.has(activeLevelId)) onActivate(redirect.get(activeLevelId)!);
    onToast?.(`已合并 ${removedCount} 个重复标高`);
  };

  const addLevel = () => {
    if (readOnly) return;
    const highest = levels.reduce((max, level) => Math.max(max, level.elevation), 0);
    const level = {
      id: createId(),
      name: `标高 ${levels.length + 1}`,
      elevation: Math.round((highest + 3) * 100) / 100,
    };
    onUpdate((current) => ({ ...current, levels: [...current.levels, level] }), `已添加 ${level.name}`);
    onActivate(level.id);
    onToast?.(`已添加 ${level.name}（${level.elevation.toFixed(2)} m），并设为当前标高`);
  };

  const removeLevel = (index: number) => {
    if (readOnly || levels.length <= 1) return;
    const level = levels[index];
    const baseCount = usage.base.get(level.id) ?? 0;
    const topCount = usage.top.get(level.id) ?? 0;
    // 删除后把引用该标高的构件改挂到相邻标高（优先下方，其次上方），避免悬空约束
    const neighbor = levels[index - 1] ?? levels[index + 1];
    const impact = baseCount + topCount;
    const detail = impact
      ? `该标高被 ${baseCount} 个构件作为底部约束、${topCount} 个作为顶部约束。删除后这些构件将改挂到「${neighbor.name}」。`
      : '该标高没有构件引用。';
    if (!window.confirm(`确定删除「${level.name}」吗？\n${detail}`)) return;

    onUpdate((current) => ({
      ...current,
      levels: current.levels.filter((item) => item.id !== level.id),
      elements: current.elements.map((element) => {
        const topId = topLevelIdOf(element);
        if (element.levelId !== level.id && topId !== level.id) return element;
        const patch: Record<string, string> = {};
        if (element.levelId === level.id) patch.levelId = neighbor.id;
        if (topId === level.id) patch.topLevelId = neighbor.id;
        return { ...element, ...patch } as BimElement;
      }),
    }), `已删除标高「${level.name}」`);
    if (activeLevelId === level.id) onActivate(neighbor.id);
    onToast?.(`已删除 ${level.name}${impact ? `，${impact} 个构件改挂到 ${neighbor.name}` : ''}`);
  };

  return (
    <ModalShell cardClassName="modal-card manager-card" cardStyle={{ width: 'min(880px, 95vw)' }} ariaLabel="楼层管理">
      <div className="modal-head">
        <div>
          <strong>楼层管理 · 标高</strong>
          <span>标高是构件竖向定位的基准；修改标高值会联动所有以它为基准/顶部的构件</span>
        </div>
        <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
      </div>

      <div className="modal-body manager-body">
        <div className="manager-toolbar">
          <button className="primary" disabled={readOnly} onClick={addLevel}>＋ 添加标高</button>
          <button
            className="merge-levels-button"
            disabled={readOnly || duplicateGroups.length === 0}
            onClick={mergeDuplicates}
            title={duplicateGroups.length ? '合并名称与标高值都相同的重复标高' : '当前没有重复标高'}
          >合并重复标高{duplicateGroups.length ? `（${duplicateGroups.length} 组）` : ''}</button>
          <span className="manager-sep" />
          <span className="manager-tabs-note">
            {levels.length} 个标高 · {project.elements.length} 个构件 · 选中行「设为当前」后切换视口楼层
          </span>
        </div>

        <div className="admin-table-wrap">
          <table className="admin-table levels-table">
            <thead>
              <tr>
                <th>当前</th>
                <th>标高名称</th>
                <th>标高值 (m)</th>
                <th>底部构件</th>
                <th>顶部引用</th>
                <th>楼层</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((level, index) => {
                const isActive = level.id === activeLevelId;
                return (
                  <tr key={level.id} className={`${isActive ? 'level-active-row' : ''} ${duplicateRows.has(level.id) ? 'level-duplicate-row' : ''}`}>
                    <td>
                      <input
                        type="radio"
                        name="current-level"
                        aria-label={`设为当前标高 ${level.name}`}
                        checked={isActive}
                        onChange={() => {
                          onActivate(level.id);
                          onToast?.(`当前标高：${level.name}（${level.elevation.toFixed(2)} m）`);
                        }}
                      />
                    </td>
                    <td>
                      <TextCommit
                        className="manager-input manager-name"
                        ariaLabel={`标高名称 ${level.name}`}
                        value={level.name}
                        onCommit={(name) => patchLevel(level.id, { name }, '已重命名标高')}
                      />
                    </td>
                    <td>
                      <NumberCommit
                        value={level.elevation}
                        min={-1000}
                        max={1000}
                        step={0.01}
                        suffix="m"
                        ariaLabel={`标高值 ${level.name}`}
                        onCommit={(elevation) => patchLevel(level.id, { elevation }, '已修改标高值')}
                      />
                    </td>
                    <td className="level-count">{usage.base.get(level.id) ?? 0}</td>
                    <td className="level-count">{usage.top.get(level.id) ?? 0}</td>
                    <td className="level-order"><span className="level-index">第 {index + 1} 层</span></td>
                    <td>
                      <button
                        className="mini-icon danger"
                        disabled={readOnly || levels.length <= 1}
                        onClick={() => removeLevel(index)}
                        title={levels.length <= 1 ? '至少保留一个标高' : '删除标高'}
                        aria-label={`删除 ${level.name}`}
                      >✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="manager-footnote">
          提示：楼层按标高值由低到高自动排序，顺序由高度决定；修改标高值会立即联动构件几何，并重新排列楼层。
        </div>
      </div>
    </ModalShell>
  );
}
