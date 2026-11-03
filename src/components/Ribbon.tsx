import type { Tool, ViewKind } from '../ModelViewport';

export type RibbonTab = 'architecture' | 'structure' | 'modify' | 'view' | 'manage';

interface RibbonProps {
  tab: RibbonTab;
  onTabChange: (tab: RibbonTab) => void;
  tool: Tool;
  onTool: (tool: Tool) => void;
  onBoolean: (operation: 'union' | 'subtract' | 'intersect') => void;
  onDelete: () => void;
  onMove: () => void;
  onCopy: () => void;
  onRotate: () => void;
  onMirror: () => void;
  onArray: () => void;
  onCopyToClipboard: () => void;
  onPaste: () => void;
  viewKind: ViewKind;
  onViewKind: (kind: ViewKind) => void;
  projection: 'perspective' | 'parallel';
  onProjection: (projection: 'perspective' | 'parallel') => void;
  onZoomAll: () => void;
  isImporting: boolean;
  onImport: (file: File) => void;
  onExport: () => void;
  onNewProject: () => void;
  serverMode: boolean;
  readOnly: boolean;
  onOpenVersions: () => void;
  onOpenMembers: () => void;
  onDeleteProject: () => void;
  onOpenSettings: () => void;
  isAdmin: boolean;
  onOpenAdmin: () => void;
}

const TABS: Array<{ id: RibbonTab; label: string }> = [
  { id: 'architecture', label: '建筑' },
  { id: 'structure', label: '结构' },
  { id: 'modify', label: '修改' },
  { id: 'view', label: '视图' },
  { id: 'manage', label: '管理' },
];

const TOOL_LABELS: Record<Tool, string> = {
  select: '选择',
  wall: '墙',
  column: '柱',
  slab: '楼板',
  grid: '轴网',
};

export default function Ribbon({
  tab,
  onTabChange,
  tool,
  onTool,
  onBoolean,
  onDelete,
  onMove,
  onCopy,
  onRotate,
  onMirror,
  onArray,
  onCopyToClipboard,
  onPaste,
  viewKind,
  onViewKind,
  projection,
  onProjection,
  onZoomAll,
  isImporting,
  onImport,
  onExport,
  onNewProject,
  serverMode,
  readOnly,
  onOpenVersions,
  onOpenMembers,
  onDeleteProject,
  onOpenSettings,
  isAdmin,
  onOpenAdmin,
}: RibbonProps) {
  const drawButton = (value: Tool, glyph: string, label: string, className = '') => (
    <button
      key={value}
      className={`tool-button ${className} ${tool === value ? 'active' : ''}`}
      onClick={() => onTool(tool === value ? 'select' : value)}
      title={readOnly ? '当前角色为查看者，无法编辑' : `${label}（Esc 退出）`}
      disabled={readOnly}
    >
      <b>{glyph}</b>
      <span>{label}</span>
    </button>
  );

  return (
    <div className="ribbon-wrap">
      <div className="ribbon-tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={`ribbon-tab ${tab === item.id ? 'active' : ''}`}
            onClick={() => onTabChange(item.id)}
          >
            {item.label}
          </button>
        ))}
        <div className="ribbon-tab-spacer" />
        <span className={`ribbon-tool-state ${tool !== 'select' ? 'armed' : ''}`}>
          {tool === 'select' ? '选择模式' : `${TOOL_LABELS[tool]}工具 · 点击视口放置 / 按 Esc 退出`}
        </span>
      </div>

      <nav className="ribbon">
        {tab === 'architecture' && (
          <>
            <div className="ribbon-group">
              <div className="button-row">
                {drawButton('wall', '▤', '墙')}
                {drawButton('column', '▮', '柱')}
                {drawButton('slab', '▬', '楼板')}
                {drawButton('grid', '┼', '轴网')}
              </div>
              <span className="group-caption">绘制构件 <small>在当前标高上绘制</small></span>
            </div>
          </>
        )}

        {tab === 'modify' && (
          <>
            <div className="ribbon-group">
              <div className="button-row">
                <button className="tool-button" disabled={readOnly} onClick={onMove} title="移动：ΔX / ΔY / ΔZ"><b>✥</b><span>移动</span></button>
                <button className="tool-button" disabled={readOnly} onClick={onCopy} title="复制（偏移 1 m）"><b>⧉</b><span>复制</span></button>
                <button className="tool-button" disabled={readOnly} onClick={onRotate} title="旋转：绕基点按角度旋转"><b>↻</b><span>旋转</span></button>
                <button className="tool-button" disabled={readOnly} onClick={onMirror} title="镜像：关于水平/垂直直线"><b>⇋</b><span>镜像</span></button>
                <button className="tool-button" disabled={readOnly} onClick={onArray} title="阵列：线性 / 环形"><b>▦</b><span>阵列</span></button>
              </div>
              <span className="group-caption">变换 <small>方向键微移 0.1 m</small></span>
            </div>
            <div className="ribbon-divider" />
            <div className="ribbon-group">
              <div className="button-row">
                <button className="tool-button" onClick={onCopyToClipboard} title="复制到剪贴板 (Ctrl/Cmd+C)"><b>⎘</b><span>复制到剪贴板</span></button>
                <button className="tool-button" disabled={readOnly} onClick={onPaste} title="粘贴 (Ctrl/Cmd+V)"><b>⎗</b><span>粘贴</span></button>
              </div>
              <span className="group-caption">剪贴板 <small>连续粘贴逐次偏移</small></span>
            </div>
            <div className="ribbon-divider" />
            <div className="ribbon-group">
              <div className="button-row">
                <button className="tool-button boolean-button" disabled={readOnly} onClick={() => onBoolean('union')}><b>⊕</b><span>并集</span></button>
                <button className="tool-button boolean-button" disabled={readOnly} onClick={() => onBoolean('subtract')}><b>⊖</b><span>差集</span></button>
                <button className="tool-button boolean-button" disabled={readOnly} onClick={() => onBoolean('intersect')}><b>◩</b><span>交集</span></button>
                <button className="tool-button delete-button" disabled={readOnly} onClick={onDelete}><b>⌫</b><span>删除</span></button>
              </div>
              <span className="group-caption">实体与删除 <small>布尔需选择 2 个</small></span>
            </div>
            <div className="ribbon-divider" />
            <div className="ribbon-group">
              <div className="button-row">
                <button className="tool-button" disabled title="对齐（规划中）"><b>⇤</b><span>对齐</span></button>
                <button className="tool-button" disabled title="偏移（规划中）"><b>⇥</b><span>偏移</span></button>
                <button className="tool-button" disabled title="缩放（规划中）"><b>⤢</b><span>缩放</span></button>
                <button className="tool-button" disabled title="修剪 / 延伸（规划中）"><b>✂</b><span>修剪</span></button>
              </div>
              <span className="group-caption">常用（规划中）</span>
            </div>
          </>
        )}

        {tab === 'structure' && (
          <>
            <div className="ribbon-group">
              <div className="button-row">
                {drawButton('column', '▮', '结构柱')}
                {drawButton('slab', '▬', '结构板')}
              </div>
              <span className="group-caption">结构构件</span>
            </div>
            <div className="ribbon-divider" />
            <div className="ribbon-group">
              <div className="button-row">
                <button className="tool-button" disabled><b>╫</b><span>梁</span></button>
                <button className="tool-button" disabled><b>╱</b><span>支撑</span></button>
                <button className="tool-button" disabled><b>◍</b><span>基础</span></button>
              </div>
              <span className="group-caption">规划中 <small>梁 / 支撑 / 基础</small></span>
            </div>
          </>
        )}

        {tab === 'view' && (
          <>
            <div className="ribbon-group">
              <div className="button-row">
                <button className={`tool-button ${viewKind === '3d' ? 'active' : ''}`} onClick={() => onViewKind('3d')}><b>◈</b><span>三维视图</span></button>
                <button className={`tool-button ${viewKind === 'plan' ? 'active' : ''}`} onClick={() => onViewKind('plan')}><b>▦</b><span>平面视图</span></button>
                <button className="tool-button" onClick={onZoomAll}><b>⊞</b><span>缩放至全部</span></button>
              </div>
              <span className="group-caption">视图</span>
            </div>
            <div className="ribbon-divider" />
            <div className="ribbon-group">
              <div className="button-row">
                <button className={`tool-button ${projection === 'perspective' ? 'active' : ''}`} onClick={() => onProjection('perspective')}><b>◭</b><span>透视</span></button>
                <button className={`tool-button ${projection === 'parallel' ? 'active' : ''}`} onClick={() => onProjection('parallel')}><b>▱</b><span>平行</span></button>
              </div>
              <span className="group-caption">投影方式</span>
            </div>
          </>
        )}

        {tab === 'manage' && (
          <>
            <div className="ribbon-group">
              <div className="button-row">
                <button className="tool-button" onClick={onNewProject}><b>＋</b><span>新建项目</span></button>
                <label className={`tool-button file-button ${isImporting ? 'importing' : ''}`}>
                  <b>{isImporting ? '…' : '⇧'}</b>
                  <span>{isImporting ? '正在导入' : '导入 STEP/OBJ'}</span>
                  <input
                    type="file"
                    accept=".obj,.step,.stp"
                    disabled={isImporting}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) onImport(file);
                      event.target.value = '';
                    }}
                  />
                </label>
                <button className="tool-button" onClick={onExport}><b>⇩</b><span>导出 OBJ</span></button>
              </div>
              <span className="group-caption">项目 / 交换</span>
            </div>
            <div className="ribbon-divider" />
            <div className="ribbon-group">
              <div className="button-row">
                <button
                  className="tool-button"
                  disabled={!serverMode}
                  title={serverMode ? '查看 / 创建 / 恢复历史版本' : '需要服务端模式'}
                  onClick={onOpenVersions}
                ><b>⟳</b><span>版本历史</span></button>
                <button
                  className="tool-button"
                  disabled={!serverMode}
                  title={serverMode ? '邀请成员、调整角色' : '需要服务端模式'}
                  onClick={onOpenMembers}
                ><b>☁</b><span>成员权限</span></button>
                <button
                  className="tool-button delete-button"
                  disabled={!serverMode}
                  title={serverMode ? '删除当前项目（不可撤销）' : '需要服务端模式'}
                  onClick={onDeleteProject}
                ><b>⌫</b><span>删除项目</span></button>
              </div>
              <span className="group-caption">协作 <small>{serverMode ? '服务端项目' : '本地模式不可用'}</small></span>
            </div>
            <div className="ribbon-divider" />
            <div className="ribbon-group">
              <div className="button-row">
                <button
                  className="tool-button"
                  title="软件设置（显示与交互）/ 用户管理 / AI 设置"
                  onClick={onOpenSettings}
                ><b>⚙</b><span>设置</span></button>
                <button
                  className="tool-button"
                  disabled={!isAdmin}
                  title={isAdmin ? '系统概览 / 全部项目 / 审计日志' : '需要系统管理员'}
                  onClick={onOpenAdmin}
                ><b>🛡</b><span>管理后台</span></button>
              </div>
              <span className="group-caption">系统 <small>用户 / AI</small></span>
            </div>
          </>
        )}

        <div className="ribbon-note">
          <span className="note-dot" />
          本地工作区 · 自动保存
        </div>
      </nav>
    </div>
  );
}
