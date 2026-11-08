import type { Tool, ViewKind } from '../ModelViewport';
import type { ModifyCommandId } from '../bim/modify';
import { MODIFY_LABELS, MODIFY_SHORTCUTS } from '../bim/modify';
import type { PrimitiveKind } from '../bim/primitives';
import { PRIMITIVE_LABELS } from '../bim/primitives';
import { IMPORT_ACCEPT, IMPORT_FORMATS } from '../import/catalog';

export type RibbonTab = 'architecture' | 'solid' | 'structure' | 'modify' | 'view' | 'manage';

interface RibbonProps {
  tab: RibbonTab;
  onTabChange: (tab: RibbonTab) => void;
  tool: Tool;
  onTool: (tool: Tool) => void;
  onModify: (command: ModifyCommandId) => void;
  onPrimitive: (kind: PrimitiveKind) => void;
  onBoolean: (operation: 'union' | 'subtract' | 'intersect') => void;
  onCopyToClipboard: () => void;
  onPaste: () => void;
  activeModify: ModifyCommandId | null;
  primitiveKind: PrimitiveKind | null;
  viewKind: ViewKind;
  onViewKind: (kind: ViewKind) => void;
  projection: 'perspective' | 'parallel';
  onProjection: (projection: 'perspective' | 'parallel') => void;
  onZoomAll: () => void;
  isImporting: boolean;
  onImport: (files: File[]) => void;
  onExport: () => void;
  onExportIfc: () => void;
  onOpenSchedule: () => void;
  onOpenLayers: () => void;
  onOpenMaterials: () => void;
  onOpenParameters: () => void;
  /** 打开模型库（预置造型：飞机 / 亭子 / 无人机…） */
  onOpenLibrary: () => void;
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
  { id: 'solid', label: '造型' },
  { id: 'modify', label: '修改' },
  { id: 'view', label: '视图' },
  { id: 'manage', label: '管理' },
];

const TOOL_LABELS: Record<Tool, string> = {
  select: '选择', wall: '墙', column: '柱', slab: '楼板', grid: '轴网', primitive: '体量',
};

const DRAW_SHORTCUT_BY_TOOL: Partial<Record<Tool, string>> = {
  wall: 'WA', column: 'CL', slab: 'SB', grid: 'GR',
};

const SHORTCUT_BY_COMMAND: Record<string, string> = Object.fromEntries(
  Object.entries(MODIFY_SHORTCUTS).map(([key, command]) => [command, key]),
);

const MODIFY_BUTTONS: Array<{ id: ModifyCommandId; glyph: string; label?: string }> = [
  { id: 'move', glyph: '✥' },
  { id: 'copy', glyph: '⧉' },
  { id: 'rotate', glyph: '↻' },
  { id: 'mirror-draw', glyph: '⇋', label: '镜像·绘制轴' },
  { id: 'mirror-pick', glyph: '⇆', label: '镜像·拾取轴' },
  { id: 'array-linear', glyph: '▦', label: '线性阵列' },
  { id: 'array-radial', glyph: '◉', label: '环形阵列' },
  { id: 'align', glyph: '⇤' },
  { id: 'offset', glyph: '⇥' },
  { id: 'scale', glyph: '⤢' },
  { id: 'trim', glyph: '✂', label: '修剪/延伸' },
  { id: 'split', glyph: '⌁', label: '拆分' },
];

const UTILITY_BUTTONS: Array<{ id: ModifyCommandId; glyph: string; label?: string }> = [
  { id: 'measure', glyph: '📐', label: '测量' },
  { id: 'pin', glyph: '🔒', label: '锁定' },
  { id: 'unpin', glyph: '🔓', label: '解锁' },
  { id: 'delete', glyph: '⌫', label: '删除' },
];

const PRIMITIVE_BUTTONS: Array<{ kind: PrimitiveKind; glyph: string }> = [
  { kind: 'extrude', glyph: '▤' },
  { kind: 'revolve', glyph: '◍' },
  { kind: 'box', glyph: '▣' },
  { kind: 'cylinder', glyph: '⬤' },
  { kind: 'sphere', glyph: '●' },
  { kind: 'pyramid', glyph: '▲' },
  { kind: 'solid', glyph: '✦' },
];

export default function Ribbon({
  tab, onTabChange, tool, onTool, onModify, onPrimitive, onBoolean,
  onCopyToClipboard, onPaste, activeModify, primitiveKind,
  viewKind, onViewKind, projection, onProjection, onZoomAll,
  isImporting, onImport, onExport, onExportIfc, onOpenSchedule, onOpenLayers, onOpenMaterials, onOpenParameters, onOpenLibrary, onNewProject,
  serverMode, readOnly, onOpenVersions, onOpenMembers, onDeleteProject,
  onOpenSettings, isAdmin, onOpenAdmin,
}: RibbonProps) {
  const drawButton = (value: Tool, glyph: string, label: string, className = '') => (
    <button
      key={value}
      className={`tool-button ${className} ${tool === value ? 'active' : ''}`}
      onClick={() => onTool(tool === value ? 'select' : value)}
      title={readOnly ? '当前角色为查看者，无法编辑' : `${label}（${DRAW_SHORTCUT_BY_TOOL[value] ?? '—'}）· Esc 退出`}
      disabled={readOnly}
    >
      <b>{glyph}</b>
      <span>{label}</span>
    </button>
  );

  const modifyButton = (item: { id: ModifyCommandId; glyph: string; label?: string }) => (
    <button
      key={item.id}
      className={`tool-button modify-command ${activeModify === item.id ? 'active' : ''}`}
      disabled={readOnly && item.id !== 'measure'}
      onClick={() => onModify(item.id)}
      title={`${MODIFY_LABELS[item.id]}（${SHORTCUT_BY_COMMAND[item.id] ?? '—'}）· 先选构件，再在视口中取点`}
    >
      <b>{item.glyph}</b>
      <span>{item.label ?? MODIFY_LABELS[item.id]}</span>
    </button>
  );

  const primitiveButton = (item: { kind: PrimitiveKind; glyph: string }) => (
    <button
      key={item.kind}
      className={`tool-button ${tool === 'primitive' && primitiveKind === item.kind ? 'active' : ''}`}
      disabled={readOnly}
      onClick={() => onPrimitive(item.kind)}
      title={`${PRIMITIVE_LABELS[item.kind]}：视口两点放置，之后可在属性面板改参数`}
    >
      <b>{item.glyph}</b>
      <span>{PRIMITIVE_LABELS[item.kind]}</span>
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
        <span className={`ribbon-tool-state ${tool !== 'select' || activeModify ? 'armed' : ''}`}>
          {activeModify
            ? `${MODIFY_LABELS[activeModify]} 命令进行中 · 选项栏在下方 · Esc 逐级退出`
            : tool === 'select' ? '选择模式（Revit 操作逻辑）' : `${TOOL_LABELS[tool]}工具 · 点击视口放置 / 按 Esc 退出`}
        </span>
      </div>

      <nav className="ribbon">
        {tab === 'architecture' && (
          <div className="ribbon-group">
            <div className="button-row">
              {drawButton('wall', '▤', '墙')}
              {drawButton('column', '▮', '柱')}
              {drawButton('slab', '▬', '楼板')}
              {drawButton('grid', '┼', '轴网')}
            </div>
            <span className="group-caption">绘制构件 <small>在当前标高上绘制</small></span>
          </div>
        )}

        {tab === 'solid' && (
          <>
            <div className="ribbon-group">
              <div className="button-row">{PRIMITIVE_BUTTONS.map(primitiveButton)}</div>
              <span className="group-caption">体量 <small>拉伸 / 旋转 / 基本几何体 / 特征实体</small></span>
            </div>
            <div className="ribbon-divider" />
            <div className="ribbon-group">
              <div className="button-row">
                <button
                  className="tool-button"
                  onClick={onOpenLibrary}
                  title="模型库：亭子 / 飞机 / 无人机 / 齿轮 / 花瓶…（都是特征树数据）"
                >
                  <b>❒</b>
                  <span>模型库</span>
                </button>
              </div>
              <span className="group-caption">设计库 <small>预置造型 · 放下来还能改</small></span>
            </div>
          </>
        )}

        {tab === 'modify' && (
          <>
            <div className="ribbon-group">
              <div className="button-row">{MODIFY_BUTTONS.map(modifyButton)}</div>
              <span className="group-caption">修改 <small>选择 → 命令 → 视口取点 → 预览 → 完成</small></span>
            </div>
            <div className="ribbon-divider" />
            <div className="ribbon-group">
              <div className="button-row">{UTILITY_BUTTONS.map(modifyButton)}</div>
              <span className="group-caption">工具与保护 <small>Pin 锁定后不可移动/删除</small></span>
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
              </div>
              <span className="group-caption">布尔 <small>需先选择 2 个构件</small></span>
            </div>
          </>
        )}

        {tab === 'structure' && (
          <div className="ribbon-group">
            <div className="button-row">
              {drawButton('column', '▮', '结构柱')}
              {drawButton('slab', '▬', '结构板')}
            </div>
            <span className="group-caption">结构构件</span>
          </div>
        )}

        {tab === 'view' && (
          <>
            <div className="ribbon-group">
              <div className="button-row">
                <button className={`tool-button ${viewKind === '3d' ? 'active' : ''}`} onClick={() => onViewKind('3d')}><b>◈</b><span>三维视图</span></button>
                <button className={`tool-button ${viewKind === 'plan' ? 'active' : ''}`} onClick={() => onViewKind('plan')}><b>▦</b><span>平面视图</span></button>
                <button className="tool-button" onClick={onZoomAll} title="缩放至全部（ZF）"><b>⊞</b><span>缩放至全部</span></button>
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
            <div className="ribbon-divider" />
            <div className="ribbon-group">
              <div className="button-row">
                <button className="tool-button" onClick={onOpenLayers} title="图层管理 / 可见性图形替换（快捷键 VV）"><b>▦</b><span>图层 (VV)</span></button>
                <button className="tool-button" onClick={onOpenMaterials} title="材质浏览器（快捷键 MA）"><b>◐</b><span>材质</span></button>
                <button className="tool-button" onClick={onOpenParameters} title="参数关联管理器（快捷键 GP）"><b>fx</b><span>参数 (GP)</span></button>
              </div>
              <span className="group-caption">图形 <small>图层可见性 / 类别替换 / 材质 / 参数关联</small></span>
            </div>
          </>
        )}

        {tab === 'manage' && (
          <>
            <div className="ribbon-group">
              <div className="button-row">
                <button className="tool-button" onClick={onNewProject}><b>＋</b><span>新建项目</span></button>
                <label
                  className={`tool-button file-button ${isImporting ? 'importing' : ''}`}
                  title={`导入模型：${IMPORT_FORMATS.map((format) => format.label).join('、')}、STEP/STP（Ctrl/⌘ 可多选，.gltf 请连同 .bin 一起选）`}
                >
                  <b>{isImporting ? '…' : '⇧'}</b>
                  <span>{isImporting ? '正在导入' : '导入模型'}</span>
                  <input
                    type="file"
                    multiple
                    accept={`${IMPORT_ACCEPT},.step,.stp`}
                    disabled={isImporting}
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      if (files.length) onImport(files);
                      event.target.value = '';
                    }}
                  />
                </label>
                <button className="tool-button" onClick={onExport}><b>⇩</b><span>导出 OBJ</span></button>
                <button className="tool-button" onClick={onExportIfc}><b>⇩</b><span>导出 IFC4</span></button>
                <button className="tool-button" onClick={onOpenSchedule}><b>▤</b><span>构件明细表</span></button>
              </div>
              <span className="group-caption">项目 / 交换</span>
            </div>
            <div className="ribbon-divider" />
            <div className="ribbon-group">
              <div className="button-row">
                <button className="tool-button" onClick={onOpenLayers} title="图层管理 / 可见性图形替换（VV）"><b>▦</b><span>图层管理</span></button>
                <button className="tool-button" onClick={onOpenMaterials} title="材质浏览器（MA）"><b>◐</b><span>材质浏览器</span></button>
                <button className="tool-button" onClick={onOpenParameters} title="参数关联管理器（GP）"><b>fx</b><span>参数关联</span></button>
              </div>
              <span className="group-caption">项目设置 <small>随项目保存并协作同步</small></span>
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
                <button className="tool-button" title="账户中心：个人资料 / 我的项目 / 软件设置" onClick={onOpenSettings}><b>⚙</b><span>账户与设置</span></button>
                <button className="tool-button" disabled={!isAdmin} title={isAdmin ? '用户管理 / AI 设置 / 系统与审计（仅系统管理员）' : '需要系统管理员'} onClick={onOpenAdmin}><b>🛡</b><span>用户与系统</span></button>
              </div>
              <span className="group-caption">系统 <small>账号 / 权限 / AI</small></span>
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
