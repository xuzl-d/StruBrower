import { useEffect, useState } from 'react';
import { ApiError, membersApi } from '../data';
import type { MemberEntry } from '../data';
import ModalShell from './ModalShell';

interface MembersDialogProps {
  projectId: string;
  currentUserId: string;
  isAdmin: boolean;
  onClose: () => void;
}

const ROLE_LABELS: Record<MemberEntry['role'], string> = {
  viewer: '查看者',
  editor: '编辑者',
  admin: '管理者',
};

export default function MembersDialog({ projectId, currentUserId, isAdmin, onClose }: MembersDialogProps) {
  const [members, setMembers] = useState<MemberEntry[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberEntry['role']>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await membersApi.list(projectId);
      setMembers(data.members);
      setError('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '读取成员失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const addMember = async () => {
    if (busy || !email.trim()) return;
    setBusy(true);
    setError('');
    try {
      const data = await membersApi.add(projectId, email.trim(), role);
      setMembers(data.members);
      setEmail('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '添加成员失败');
    } finally {
      setBusy(false);
    }
  };

  const updateRole = async (member: MemberEntry, nextRole: MemberEntry['role']) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const data = await membersApi.update(projectId, member.id, nextRole);
      setMembers(data.members);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '修改角色失败');
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (member: MemberEntry) => {
    if (busy) return;
    if (!window.confirm(`将 ${member.name}（${member.email}）移出项目？`)) return;
    setBusy(true);
    setError('');
    try {
      const data = await membersApi.remove(projectId, member.id);
      setMembers(data.members);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '移除成员失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell cardClassName="modal-card" ariaLabel="成员与权限">
        <div className="modal-head">
          <div>
            <strong>成员与权限</strong>
            <span>查看者可读、编辑者可保存、管理者可改成员与删除项目</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="modal-body">
          {isAdmin ? (
            <div className="member-add">
              <input
                type="email"
                value={email}
                placeholder="已注册用户的邮箱"
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void addMember(); }}
              />
              <select value={role} onChange={(event) => setRole(event.target.value as MemberEntry['role'])}>
                <option value="viewer">查看者</option>
                <option value="editor">编辑者</option>
                <option value="admin">管理者</option>
              </select>
              <button onClick={() => void addMember()} disabled={busy || !email.trim()}>添加</button>
            </div>
          ) : (
            <div className="modal-note">只有项目管理者可以邀请或移除成员。</div>
          )}

          {error ? <div className="modal-error">{error}</div> : null}
          {loading ? <div className="modal-note">正在读取成员…</div> : null}

          <div className="member-list">
            {members.map((member) => (
              <div className="member-row" key={member.id}>
                <div className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</div>
                <div className="member-meta">
                  <strong>
                    {member.name}
                    {member.id === currentUserId ? <em>（你）</em> : null}
                  </strong>
                  <span>{member.email}</span>
                </div>
                {isAdmin ? (
                  <select
                    value={member.role}
                    disabled={busy}
                    onChange={(event) => void updateRole(member, event.target.value as MemberEntry['role'])}
                  >
                    <option value="viewer">查看者</option>
                    <option value="editor">编辑者</option>
                    <option value="admin">管理者</option>
                  </select>
                ) : (
                  <span className="member-role">{ROLE_LABELS[member.role]}</span>
                )}
                {isAdmin ? (
                  <button
                    className="member-remove"
                    disabled={busy || member.id === currentUserId}
                    title={member.id === currentUserId ? '不能移除自己' : '移除成员'}
                    onClick={() => void removeMember(member)}
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="modal-foot version-foot">
          <span>项目至少保留一名管理者；被移出的成员会立即失去访问权限。</span>
          <button className="primary" onClick={onClose}>关闭</button>
        </div>
    </ModalShell>
  );
}
