/**
 * 模型库（设计库）对话框：`SOLID_TEMPLATES` 的图形化入口。
 *
 * 之前模板只藏在「体量 → 特征实体 → 属性面板 → 编辑造型 → 模板下拉」四层后面，
 * 用户找不到也说得过去。这里一次列全，点卡片直接在当前标高落一个构件，
 * 带参数绑定的模型（支架）落完自动进特征树编辑器，宽 / 高当场能改。
 */
import { useMemo, useState } from 'react';
import ModalShell from './ModalShell';
import { SOLID_TEMPLATES } from '../bim/solidTemplates';
import { countSolidFeatures } from '../bim/solid';
import { paramTemplate } from '../bim/parametric';

interface LibraryDialogProps {
  readOnly: boolean;
  /** 放置到当前标高；带参数的模型会顺带打开特征树（可改尺寸） */
  onPlace: (templateId: string) => void;
  onClose: () => void;
}

export default function LibraryDialog({ readOnly, onPlace, onClose }: LibraryDialogProps) {
  const entries = useMemo(
    () =>
      SOLID_TEMPLATES.map((template) => {
        const spec = template.parametric ? paramTemplate(template.parametric.template) : null;
        return { template, spec, count: countSolidFeatures(template.build()) };
      }),
    [],
  );
  const [active, setActive] = useState(
    entries.find((entry) => entry.template.parametric)?.template.id ?? entries[0]?.template.id ?? '',
  );
  const current = entries.find((entry) => entry.template.id === active) ?? entries[0] ?? null;

  const place = (id: string) => {
    if (readOnly) return;
    onPlace(id);
    onClose();
  };

  return (
    <ModalShell
      cardClassName="modal-card library-card"
      cardStyle={{ width: 'min(1020px, 94vw)' }}
      ariaLabel="模型库"
    >
      <div className="modal-head">
        <div>
          <strong>模型库</strong>
          <span>
            {entries.length} 个预置造型 · 都是特征树数据，落下来还能逐项改（双击卡片直接放置）
          </span>
        </div>
        <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
      </div>

      <div className="modal-body">
        <div className="library-grid">
          {entries.map((entry) => {
            const { template, spec, count } = entry;
            const selected = template.id === active;
            return (
              <button
                key={template.id}
                className={`library-card${selected ? ' active' : ''}`}
                onClick={() => setActive(template.id)}
                onDoubleClick={() => place(template.id)}
                disabled={readOnly}
                title={readOnly ? '当前角色为查看者，无法放置' : `${template.name}：双击放置`}
              >
                <div className="library-card-head">
                  <span className="library-card-name">{template.name}</span>
                  {spec ? <em className="library-badge param">参数化</em> : <em className="library-badge">静态</em>}
                </div>
                <p className="library-card-note">{template.summary}</p>
                <div className="library-card-meta">
                  <span>{count} 个特征</span>
                  {spec ? <span>{spec.params.length} 个驱动参数</span> : <span>特征树固定</span>}
                </div>
              </button>
            );
          })}
        </div>

        {current?.spec ? (
          <div className="library-hint">
            <strong>{current.template.name}</strong>
            <span>{current.spec.summary}</span>
            <span className="library-hint-params">
              {current.spec.params.map((item) => `${item.label} ${item.default}${item.unit === 'length' ? ' m' : ''}`).join(' · ')}
            </span>
          </div>
        ) : current ? (
          <div className="library-hint">
            <strong>{current.template.name}</strong>
            <span>静态特征树：放置后可在特征树编辑器里逐项改形状与尺寸，但没有整组联动的参数。</span>
          </div>
        ) : null}
      </div>

      <div className="modal-foot library-foot">
        <span>放置位置：当前标高、原点附近（已有构件时自动让位） · 放置后可拖动定位</span>
        <button
          className="primary"
          disabled={readOnly || !current}
          onClick={() => current && place(current.template.id)}
        >
          放置到当前标高
        </button>
      </div>
    </ModalShell>
  );
}
