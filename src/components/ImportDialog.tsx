/**
 * 导入确认对话框。
 *
 * 解析完成、写项目之前停一步，让用户看到「读到了什么」并纠正两件最容易错的事：
 * 向上轴（Y-up 的 glTF / OBJ / PLY 与 Z-up 的 STL / 3DS / DXF 混在一起）
 * 和单位（毫米 / 厘米 / 英寸的模型直接进项目会差 1000 倍）。
 * SKP 这类读不出几何的格式，这里负责把「为什么」和「下一步怎么做」讲清楚。
 */
import { useMemo, useState } from 'react';
import ModalShell from './ModalShell';
import { countImportTriangles, guessUnitMeters, measureImport, rawSize } from '../import';
import type { ImportTransform } from '../import';
import { UNIT_CHOICES, type ImportedModel, type UpAxis } from '../import/types';

export interface ImportDialogProps {
  fileName: string;
  model: ImportedModel;
  onCancel: () => void;
  onConfirm: (transform: ImportTransform) => void;
}

function metersLabel(meters: number): string {
  if (Math.abs(meters - 1) < 1e-9) return '米';
  if (Math.abs(meters - 0.001) < 1e-9) return '毫米';
  if (Math.abs(meters - 0.01) < 1e-9) return '厘米';
  if (Math.abs(meters - 0.0254) < 1e-9) return '英寸';
  if (Math.abs(meters - 0.3048) < 1e-9) return '英尺';
  return `${meters} m`;
}

function sizeText(size: { x: number; y: number; z: number }): string {
  return `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`;
}

export default function ImportDialog({ fileName, model, onCancel, onConfirm }: ImportDialogProps) {
  const guessedUnit = useMemo(() => guessUnitMeters(model), [model]);
  const [unitId, setUnitId] = useState('auto');
  const [axisId, setAxisId] = useState<'auto' | UpAxis>('auto');
  const [showDetails, setShowDetails] = useState(false);

  const upAxis: UpAxis = axisId === 'auto' ? model.upAxis : axisId;
  const unitMeters = unitId === 'auto'
    ? guessedUnit
    : UNIT_CHOICES.find((choice) => choice.id === unitId)?.meters ?? 1;
  const transform: ImportTransform = { upAxis, unitMeters };

  const triangles = useMemo(() => countImportTriangles(model), [model]);
  const sourceSize = useMemo(() => rawSize(model), [model]);
  const resultSize = useMemo(
    () => (model.parts.length ? measureImport(model, transform) : null),
    [model, transform.upAxis, transform.unitMeters],
  );

  const blocked = model.blocked;

  return (
    <ModalShell cardClassName="modal-card import-card" cardStyle={{ width: 'min(600px, 94vw)' }} ariaLabel="导入模型">
      <div className="modal-head">
        <div>
          <strong>{blocked ? '无法直接导入' : '导入模型'}</strong>
          <span>{model.formatLabel} · {fileName}</span>
        </div>
        <button className="modal-close" onClick={onCancel} aria-label="关闭">✕</button>
      </div>

      <div className="modal-body import-body">
        {blocked ? (
          <>
            {model.previewDataUrl && (
              <div className="import-preview">
                <img src={model.previewDataUrl} alt="文件内嵌预览" />
                <span>文件内嵌预览图（已从 SketchUp 容器中提取）</span>
              </div>
            )}
            <p className="import-reason">{blocked.reason}</p>
            <ol className="import-steps">
              {blocked.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
            {model.notices.length > 0 && (
              <ul className="import-notices">
                {model.notices.map((notice) => <li key={notice}>{notice}</li>)}
              </ul>
            )}
            {model.details && (
              <div className="import-details">
                <button className="import-details-toggle" onClick={() => setShowDetails((value) => !value)}>
                  {showDetails ? '▾' : '▸'} 容器内容（{model.details.length} 项）
                </button>
                {showDetails && (
                  <pre className="import-streams">{model.details.join('\n')}</pre>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="import-stats">
              <div><span>构件</span><b>{model.parts.length.toLocaleString('zh-CN')}</b></div>
              <div><span>三角面</span><b>{triangles.toLocaleString('zh-CN')}</b></div>
              <div><span>原始尺寸</span><b>{sourceSize.x.toFixed(2)} × {sourceSize.y.toFixed(2)} × {sourceSize.z.toFixed(2)}</b></div>
              <div className="wide"><span>导入后尺寸（长 × 宽 × 高）</span><b>{resultSize ? sizeText(resultSize) : '—'}</b></div>
            </div>

            <div className="import-options">
              <label>
                <span>向上轴</span>
                <select value={axisId} onChange={(event) => setAxisId(event.target.value as 'auto' | UpAxis)}>
                  <option value="auto">按格式（{model.upAxis === 'y' ? 'Y 向上' : 'Z 向上'}）</option>
                  <option value="y">Y 向上（转 90°）</option>
                  <option value="z">Z 向上（不转）</option>
                </select>
              </label>
              <label>
                <span>单位</span>
                <select value={unitId} onChange={(event) => setUnitId(event.target.value)}>
                  <option value="auto">自动判断（{metersLabel(guessedUnit)}）</option>
                  {UNIT_CHOICES.filter((choice) => choice.id !== 'auto').map((choice) => (
                    <option key={choice.id} value={choice.id}>{choice.label}</option>
                  ))}
                </select>
              </label>
            </div>

            {model.notices.length > 0 && (
              <ul className="import-notices">
                {model.notices.map((notice) => <li key={notice}>{notice}</li>)}
              </ul>
            )}
            <div className="modal-note">
              导入后是一个整体网格构件，可移动 / 旋转 / 缩放 / 布尔，也可再次导入其它模型叠加。
            </div>
          </>
        )}
      </div>

      <div className="modal-foot import-foot">
        <span>项目单位：米 · Z 轴向上</span>
        <div className="modal-actions">
          <button onClick={onCancel}>{blocked ? '关闭' : '取消'}</button>
          {!blocked && (
            <button className="primary" onClick={() => onConfirm(transform)}>
              导入{triangles ? `（${triangles.toLocaleString('zh-CN')} 面）` : ''}
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
