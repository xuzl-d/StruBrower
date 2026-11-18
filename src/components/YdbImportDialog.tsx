/**
 * ydb 语义导入确认对话框。
 *
 * 与通用 ImportDialog 不同：ydb 自带楼层与单位（mm），无需选轴向 / 单位；
 * 这里展示「读到了哪些构件」，并说明导入会新增标高 / 族类型 / 材质，
 * 让用户确认后再一次性写入文档。
 */
import ModalShell from './ModalShell';
import type { YdbImportResult } from '../import';

export interface YdbImportDialogProps {
  result: YdbImportResult;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function YdbImportDialog({ result, onCancel, onConfirm }: YdbImportDialogProps) {
  const { stats, notices } = result;
  const total = stats.columns + stats.beams + stats.walls + stats.braces + stats.slabs;
  const rows: Array<{ label: string; value: number; tone: string }> = [
    { label: '楼层标高', value: stats.levels, tone: '#8a6fb0' },
    { label: '轴网', value: stats.grids, tone: '#7f8fa6' },
    { label: '柱', value: stats.columns, tone: '#8b98a8' },
    { label: stats.arcBeams ? `梁（含 ${stats.arcBeams} 根弧梁）` : '梁', value: stats.beams, tone: '#5f86a8' },
    { label: stats.arcWalls ? `墙（含 ${stats.arcWalls} 段弧墙）` : '墙', value: stats.walls, tone: '#b09b7f' },
    { label: '支撑', value: stats.braces, tone: '#5f8f86' },
    {
      label: `楼板${stats.mezzanineSlabs ? `（含 ${stats.mezzanineSlabs} 块夹层）` : ''}${stats.skewedSlabs ? `（含 ${stats.skewedSlabs} 块斜板）` : ''}${stats.roomHoles ? `（跳过 ${stats.roomHoles} 处全房间洞）` : ''}`,
      value: stats.slabs, tone: '#7fa88a',
    },
  ];

  return (
    <ModalShell cardClassName="modal-card import-card" cardStyle={{ width: 'min(560px, 94vw)' }} ariaLabel="导入 ydb 结构模型">
      <div className="modal-head">
        <div>
          <strong>导入 ydb 结构模型</strong>
          <span>{result.fileName}</span>
        </div>
        <button className="modal-close" onClick={onCancel} aria-label="关闭">✕</button>
      </div>

      <div className="modal-body import-body">
        <p className="import-reason" style={{ marginTop: 0 }}>
          已识别为盈建科结构模型，将以<strong>语义构件</strong>导入（而非整体网格）。
          导入后构件可单独选中、编辑属性与尺寸。
        </p>
        <div className="import-stats">
          {rows.map((row) => (
            <div key={row.label}>
              <span>{row.label}</span>
              <b style={{ color: row.tone }}>{row.value.toLocaleString('zh-CN')}</b>
            </div>
          ))}
          <div className="wide">
            <span>合计构件</span>
            <b>{total.toLocaleString('zh-CN')} 个</b>
          </div>
        </div>
        <div className="import-options">
          <div className="property-note">
            将新增 {result.patch.levels.length} 个标高、{result.patch.types.length} 个族类型
            {result.patch.materials.length ? `、${result.patch.materials.length} 种材质` : ''}。
            坐标已从毫米换算为米，单位 Z 轴向上。
          </div>
        </div>
        {notices.length > 0 && (
          <ul className="import-notices">
            {notices.map((notice) => <li key={notice}>{notice}</li>)}
          </ul>
        )}
        {stats.beams > 0 && stats.columns === 0 && stats.walls === 0 && (
          <div className="property-note">该文件只含梁，未发现柱 / 墙构件（属于正常情况，可能仅导出部分构件）。</div>
        )}
      </div>

      <div className="modal-foot import-foot">
        <span>项目单位：米 · Z 轴向上</span>
        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button className="primary" onClick={onConfirm}>导入（{total.toLocaleString('zh-CN')} 构件）</button>
        </div>
      </div>
    </ModalShell>
  );
}
