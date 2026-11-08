import { useMemo } from 'react';
import { buildSchedule, scheduleHeaders, scheduleToCsv } from '../bim/schedule';
import type { ProjectDocument } from '../bim/types';
import ModalShell from './ModalShell';

export interface ScheduleDialogProps {
  project: ProjectDocument;
  onClose: () => void;
  onToast?: (text: string) => void;
}

const formatMeasure = (value: number | undefined): string =>
  value === undefined ? '—' : value.toFixed(3);

export default function ScheduleDialog({ project, onClose, onToast }: ScheduleDialogProps) {
  const rows = useMemo(() => buildSchedule(project), [project]);
  const totalVolume = useMemo(
    () => rows.reduce((sum, row) => sum + (row.volume ?? 0), 0),
    [rows],
  );
  const totalTriangles = useMemo(
    () => rows.reduce((sum, row) => sum + row.triangles, 0),
    [rows],
  );

  const exportCsv = () => {
    const blob = new Blob([scheduleToCsv(rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${project.name}-明细表.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    onToast?.('明细表已导出');
  };

  return (
    <ModalShell
      cardClassName="modal-card"
      cardStyle={{ width: 'min(920px, 94vw)' }}
      ariaLabel="构件明细表"
    >
        <div className="modal-head">
          <div>
            <strong>构件明细表</strong>
            <span>长度 m · 面积 m² · 体积 m³，数值保留 3 位小数</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="modal-body">
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  {scheduleHeaders.map((header) => (
                    <th key={header}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    <td>{row.name}</td>
                    <td>{row.category}</td>
                    <td>{row.typeName || '—'}</td>
                    <td>{row.level}</td>
                    <td>{row.material}</td>
                    <td>{formatMeasure(row.length)}</td>
                    <td>{formatMeasure(row.area)}</td>
                    <td>{formatMeasure(row.volume)}</td>
                    <td>{row.triangles}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6}><strong>合计</strong>：{rows.length} 个构件</td>
                  <td>—</td>
                  <td>—</td>
                  <td><strong>{totalVolume.toFixed(3)}</strong></td>
                  <td><strong>{totalTriangles}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div
          className="modal-foot"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}
        >
          <span style={{ marginRight: 'auto', color: '#7f90a7' }}>
            共 {rows.length} 个构件，总体积 {totalVolume.toFixed(3)} m³，总三角面 {totalTriangles}
          </span>
          <button
            type="button"
            onClick={exportCsv}
            style={{
              height: 32,
              padding: '0 16px',
              border: '1px solid #3f6ea8',
              borderRadius: 6,
              background: '#24507f',
              color: '#eef6ff',
              cursor: 'pointer',
            }}
          >
            导出 CSV
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              height: 32,
              padding: '0 16px',
              border: '1px solid #33445a',
              borderRadius: 6,
              background: '#1a2534',
              color: '#a9bdd7',
              cursor: 'pointer',
            }}
          >
            关闭
          </button>
        </div>
    </ModalShell>
  );
}
