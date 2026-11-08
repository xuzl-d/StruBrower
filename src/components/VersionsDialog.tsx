import { useEffect, useState } from 'react';
import { ApiError, versionsApi } from '../data';
import type { VersionEntry } from '../data';
import ModalShell from './ModalShell';

interface VersionsDialogProps {
  projectId: string;
  projectName: string;
  canWrite: boolean;
  onClose: () => void;
  onRestored: () => void;
}

export default function VersionsDialog({ projectId, projectName, canWrite, onClose, onRestored }: VersionsDialogProps) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await versionsApi.list(projectId);
      setVersions(data.versions);
      setError('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '读取版本历史失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const createVersion = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await versionsApi.create(projectId, label.trim() || `快照 ${new Date().toLocaleString('zh-CN')}`);
      setLabel('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '创建版本失败');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (version: number) => {
    if (busy) return;
    if (!window.confirm(`恢复到版本 v${version}？当前文档会被该快照覆盖（历史记录保留）。`)) return;
    setBusy(true);
    setError('');
    try {
      await versionsApi.restore(projectId, version);
      onRestored();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '恢复版本失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell cardClassName="modal-card" ariaLabel="版本历史">
        <div className="modal-head">
          <div>
            <strong>版本历史</strong>
            <span>{projectName}</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="modal-body">
          {canWrite ? (
            <div className="version-create">
              <input
                value={label}
                maxLength={120}
                placeholder="版本标签，例如：方案 A / 报审版"
                onChange={(event) => setLabel(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void createVersion(); }}
              />
              <button onClick={() => void createVersion()} disabled={busy}>保存当前版本</button>
            </div>
          ) : (
            <div className="modal-note">当前角色为查看者，不能创建或恢复版本。</div>
          )}

          {error ? <div className="modal-error">{error}</div> : null}
          {loading ? <div className="modal-note">正在读取版本…</div> : null}
          {!loading && versions.length === 0 ? <div className="modal-note">还没有历史版本，先“保存当前版本”。</div> : null}

          <div className="version-list">
            {versions.map((version) => (
              <div className="version-row" key={version.version}>
                <div className="version-badge">v{version.version}</div>
                <div className="version-meta">
                  <strong>{version.label ?? '未命名版本'}</strong>
                  <span>{version.createdAt.replace('T', ' ').slice(0, 19)} · {version.author ?? '未知'}</span>
                </div>
                <button
                  className="version-restore"
                  disabled={busy || !canWrite}
                  onClick={() => void restore(version.version)}
                >
                  恢复
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="modal-foot version-foot">
          <span>版本是不可变快照；恢复会生成新的 rev，不会删除历史。</span>
          <button className="primary" onClick={onClose}>关闭</button>
        </div>
    </ModalShell>
  );
}
