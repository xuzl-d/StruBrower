import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BufferGeometry, Float32BufferAttribute, Mesh, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import ModelViewport from './ModelViewport';
import type { Tool, ViewKind } from './ModelViewport';
import Ribbon from './components/Ribbon';
import type { RibbonTab } from './components/Ribbon';
import ProjectBrowser from './components/ProjectBrowser';
import PropertiesPanel from './components/PropertiesPanel';
import AuthGate from './components/AuthGate';
import VersionsDialog from './components/VersionsDialog';
import MembersDialog from './components/MembersDialog';
import AiPanel from './components/AiPanel';
import SettingsDialog from './components/SettingsDialog';
import MoveDialog from './components/MoveDialog';
import type { MoveDelta } from './components/MoveDialog';
import { ArrayDialog, MirrorDialog, RotateDialog } from './components/ModifyDialogs';
import type { ArrayDelta, MirrorDelta, RotateDelta } from './components/ModifyDialogs';
import { countTriangles, levelById } from './bim/document';
import type { ProjectSummary } from './bim/document';
import { booleanElement, exportObj, meshElementFromGeometry } from './bim/geometry';
import { arrayElements, duplicateElements, mirrorElement, rotateElement, selectionCenter, translateElement } from './bim/edit';
import { createId } from './bim/id';
import { loadViewSettings, saveViewSettings } from './settings';
import type { ViewSettings } from './settings';
import { createDemoProject, createProject, nextElementName } from './bim/template';
import type {
  BimElement,
  FamilyType,
  ProjectDocument,
  SlabInstance,
  Vec2,
  WallInstance,
  ColumnInstance,
} from './bim/types';
import {
  ApiError,
  authApi,
  ConflictError,
  getAuthToken,
  pingServer,
  resolveRepository,
  setAuthToken,
} from './data';
import type { AuthUser } from './data';
import type { ProjectRepository } from './data/repository';
import { CollabClient } from './collab/client';
import type { CollabStatus, CollabUser } from './collab/client';
import { applyDocumentDiff, diffDocuments } from './collab/diff';
import { loadStepImporter } from './occtImport';
import { fetchServerStepMesh } from './step/convert';

const TOOL_LABELS: Record<Tool, string> = {
  select: '选择',
  wall: '墙',
  column: '柱',
  slab: '楼板',
  grid: '轴网',
};

const HISTORY_LIMIT = 50;

type CommandId =
  | 'move'
  | 'duplicate'
  | 'rotate'
  | 'mirror'
  | 'array'
  | 'delete'
  | 'copy'
  | 'union'
  | 'subtract'
  | 'intersect';

const COMMAND_LABELS: Record<CommandId, string> = {
  move: '移动',
  duplicate: '复制',
  rotate: '旋转',
  mirror: '镜像',
  array: '阵列',
  delete: '删除',
  copy: '复制到剪贴板',
  union: '并集',
  subtract: '差集',
  intersect: '交集',
};

function readUiFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== '0';
  } catch {
    return true;
  }
}

interface ImportProgress {
  stage: string;
  percent: number | null;
}

function readFileWithProgress(
  file: File,
  mode: 'text' | 'buffer',
  onProgress: (ratio: number) => void,
): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    reader.onload = () => resolve(reader.result as string | ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    if (mode === 'buffer') reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  });
}

function downloadFile(filename: string, content: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  /* ---------- 会话与存储 ---------- */
  const [repository, setRepository] = useState<ProjectRepository | null>(null);
  const [mode, setMode] = useState<'local' | 'server' | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [bootstrapError, setBootstrapError] = useState('');
  const [conflictRev, setConflictRev] = useState<number | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [collabStatus, setCollabStatus] = useState<CollabStatus>('offline');
  const [collabUsers, setCollabUsers] = useState<CollabUser[]>([]);
  const collabRef = useRef<CollabClient | null>(null);

  /* ---------- 文档与编辑 ---------- */
  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectDocument>(() => createDemoProject());
  const projectRef = useRef(project);
  projectRef.current = project;
  const lastSavedRef = useRef<ProjectDocument | null>(null);

  const [hydrated, setHydrated] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null);
  const [activeLevelId, setActiveLevelId] = useState<string>(project.levels[0]?.id ?? '');
  const [viewKind, setViewKind] = useState<ViewKind>('3d');
  const [viewLevelId, setViewLevelId] = useState<string | null>(null);
  const [projection, setProjection] = useState<'perspective' | 'parallel'>('perspective');
  const [tool, setTool] = useState<Tool>('select');
  const [draftStart, setDraftStart] = useState<Vec2 | null>(null);
  const [ribbonTab, setRibbonTab] = useState<RibbonTab>('architecture');
  const [message, setMessage] = useState('');
  const [hoverPoint, setHoverPoint] = useState<Vector3 | null>(null);
  const [history, setHistory] = useState<{ past: ProjectDocument[]; future: ProjectDocument[] }>({ past: [], future: [] });
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const [zoomAllRequest, setZoomAllRequest] = useState(0);
  const [fitElementId, setFitElementId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'view' | 'users' | 'ai'>('view');
  const [rendererInfo, setRendererInfo] = useState<{ renderer: string; software: boolean } | null>(null);
  const softwareWarnedRef = useRef(false);
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const slowWarnedRef = useRef(false);
  const [viewSettings, setViewSettings] = useState<ViewSettings>(() => loadViewSettings());
  const [moveOpen, setMoveOpen] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<CommandId | null>(null);
  const pendingCommandRef = useRef<CommandId | null>(null);
  pendingCommandRef.current = pendingCommand;
  const [rotateOpen, setRotateOpen] = useState(false);
  const [mirrorOpen, setMirrorOpen] = useState(false);
  const [arrayOpen, setArrayOpen] = useState(false);
  const clipboardRef = useRef<BimElement[] | null>(null);
  const pasteCountRef = useRef(1);
  const apiReachableRef = useRef<boolean | null>(null);
  const [browserOpen, setBrowserOpen] = useState(() => readUiFlag('strubrowser.ui.browser'));
  const [propertiesOpen, setPropertiesOpen] = useState(() => readUiFlag('strubrowser.ui.properties'));

  const currentSummary = summaries.find((item) => item.id === project.id);
  const role = mode === 'server' ? currentSummary?.role : 'admin';
  const canEdit = mode !== 'server' || role === 'editor' || role === 'admin';
  const isAdmin = mode !== 'server' || role === 'admin';

  const selectedElements = useMemo(
    () => project.elements.filter((element) => selection.includes(element.id)),
    [project.elements, selection],
  );
  const selectedLevel = useMemo(
    () => (selectedLevelId ? levelById(project, selectedLevelId) ?? null : null),
    [project, selectedLevelId],
  );
  const triangles = useMemo(() => countTriangles(project), [project]);
  const activeLevel = levelById(project, activeLevelId) ?? project.levels[0];

  /* 解析存储模式（本地 / 服务端），并恢复登录态 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const choice = await resolveRepository();
        if (cancelled) return;
        setRepository(choice.repository);
        setMode(choice.mode);
        if (choice.mode === 'server' && getAuthToken()) {
          try {
            const me = await authApi.me();
            if (!cancelled) setUser(me.user);
          } catch {
            setAuthToken(null);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setBootstrapError(error instanceof Error ? error.message : '无法连接服务端');
        }
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    saveViewSettings(viewSettings);
  }, [viewSettings]);

  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get('settings');
    if (tab === 'users' || tab === 'ai') {
      setSettingsTab(tab);
      setSettingsOpen(true);
    }
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--ui-font-scale', String(viewSettings.uiFontScale));
    document.body.classList.toggle('ui-large', viewSettings.uiFontScale >= 0.9);
  }, [viewSettings.uiFontScale]);

  useEffect(() => {
    if (rendererInfo?.software && !softwareWarnedRef.current) {
      softwareWarnedRef.current = true;
      setMessage('检测到软件渲染（无 GPU 加速）：已自动降低画质，卡顿与网络无关，建议使用有显卡的电脑或开启浏览器硬件加速');
    }
  }, [rendererInfo]);

  /* 服务端连接看门狗：断开时提示，恢复后自动清除 */
  const checkApi = useCallback(async () => {
    if (mode !== 'server') return;
    const started = performance.now();
    const reachable = await pingServer('', 2500);
    const elapsed = Math.round(performance.now() - started);
    if (apiReachableRef.current === false && reachable) setMessage('已重新连接服务端');
    apiReachableRef.current = reachable;
    setApiReachable(reachable);
    setLatencyMs(reachable ? elapsed : null);
    if (reachable && elapsed > 500 && !slowWarnedRef.current) {
      slowWarnedRef.current = true;
      setMessage(`网络延迟较高（${elapsed} ms）：渲染是本地的不受影响，但保存/协同会慢；建议使用离使用者更近的服务器或 Tailscale/局域网`);
    }
  }, [mode]);

  useEffect(() => {
    if (!pendingCommand) return;
    const isBoolean = pendingCommand === 'union' || pendingCommand === 'subtract' || pendingCommand === 'intersect';
    if (!isBoolean || selection.length !== 2) return;
    setPendingCommand(null);
    runBoolean(pendingCommand);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCommand, selection]);

  useEffect(() => {
    if (mode !== 'server') {
      apiReachableRef.current = null;
      setApiReachable(null);
      return;
    }
    void checkApi();
    const timer = window.setInterval(() => { void checkApi(); }, 8000);
    const onFocus = () => { void checkApi(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [mode, checkApi]);

  /* 载入项目（登录态或本地模式就绪后） */
  useEffect(() => {
    if (!repository || !authReady) return;
    if (mode === 'server' && !user) return;
    let cancelled = false;
    setHydrated(false);
    void (async () => {
      try {
        const list = await repository.list();
        const lastId = await repository.loadLastOpenedId();
        let loaded = lastId ? await repository.load(lastId) : null;
        if (!loaded && list[0]) loaded = await repository.load(list[0].id);
        if (!loaded) {
          loaded = createDemoProject();
          await repository.save(loaded);
        }
        if (cancelled) return;
        setProject(loaded);
        projectRef.current = loaded;
        lastSavedRef.current = loaded;
        setActiveLevelId(loaded.levels[0]?.id ?? '');
        setSelectedLevelId(null);
        setSelection([]);
        setHistory({ past: [], future: [] });
        setViewKind('3d');
        setViewLevelId(null);
        setTool('select');
        setDraftStart(null);
        setConflictRev(null);
        setSaveState('saved');
        setSummaries(await repository.list());
        await repository.saveLastOpenedId(loaded.id);
      } catch (error) {
        if (!cancelled) {
          console.error('读取项目失败。', error);
          setMessage(error instanceof Error ? `读取项目失败：${error.message}` : '读取项目失败。');
        }
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repository, authReady, mode, user]);

  /* 协作：服务端模式下为当前项目建立 WebSocket（房间广播 + 差分补丁） */
  useEffect(() => {
    const stop = () => {
      collabRef.current?.disconnect();
      collabRef.current = null;
      setCollabStatus('offline');
      setCollabUsers([]);
    };
    if (mode !== 'server' || !user || !hydrated || !repository) {
      stop();
      return;
    }
    const token = getAuthToken();
    if (!token) {
      stop();
      return;
    }
    const client = new CollabClient(project.id, token, {
      onStatus: (status) => setCollabStatus(status),
      onHello: ({ rev, document, users }) => {
        repository.adoptRevision?.(project.id, rev);
        setCollabUsers(users);
        // 本地没有未保存修改时，采用服务端快照，保证加入房间时状态一致
        if (projectRef.current === lastSavedRef.current) {
          setProject(document);
          projectRef.current = document;
          lastSavedRef.current = document;
        }
      },
      onPatch: ({ rev, diff }) => {
        repository.adoptRevision?.(project.id, rev);
        setProject((current) => {
          const next = applyDocumentDiff(current, diff);
          projectRef.current = next;
          lastSavedRef.current = next;
          return next;
        });
        setHistory({ past: [], future: [] });
        setSaveState('saved');
      },
      onDocument: ({ rev, document }) => {
        repository.adoptRevision?.(project.id, rev);
        if (projectRef.current === lastSavedRef.current) {
          setProject(document);
          projectRef.current = document;
          lastSavedRef.current = document;
          setHistory({ past: [], future: [] });
          setSaveState('saved');
          setMessage(`模型已更新（rev ${rev}）`);
        } else {
          setMessage('其他成员修改了模型；本地还有未保存修改，请先保存或重新加载');
        }
      },
      onPresence: setCollabUsers,
      onError: (text) => setMessage(text),
    });
    client.connect();
    collabRef.current = client;
    return () => {
      client.disconnect();
      if (collabRef.current === client) collabRef.current = null;
      setCollabStatus('offline');
      setCollabUsers([]);
    };
  }, [mode, user, hydrated, project.id, repository]);

  /* 自动保存（带 rev 冲突检测；协作在线时由补丁落库，跳过 HTTP 保存） */
  useEffect(() => {
    if (!repository || !hydrated) return;
    if (mode === 'server' && !user) return;
    if (collabRef.current?.online) return;
    if (project === lastSavedRef.current) return;
    setSaveState('dirty');
    const timer = window.setTimeout(() => {
      setSaveState('saving');
      void repository.save(project).then(async () => {
        lastSavedRef.current = project;
        setSaveState('saved');
        setConflictRev(null);
        setSummaries(await repository.list());
      }).catch((error: unknown) => {
        if (error instanceof ConflictError) {
          setConflictRev(error.rev);
          setSaveState('dirty');
          setMessage('服务端文档已被其他会话修改，请选择加载最新或覆盖保存。');
          return;
        }
        console.error('保存项目失败。', error);
        setSaveState('dirty');
        setMessage(error instanceof Error ? `保存失败：${error.message}` : '保存失败。');
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [project, repository, hydrated, mode, user]);

  useEffect(() => {
    if (!repository || !hydrated) return;
    void repository.saveLastOpenedId(project.id);
  }, [project.id, repository, hydrated]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 4200);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    try {
      localStorage.setItem('strubrowser.ui.browser', browserOpen ? '1' : '0');
    } catch {
      // 忽略存储失败
    }
  }, [browserOpen]);

  useEffect(() => {
    try {
      localStorage.setItem('strubrowser.ui.properties', propertiesOpen ? '1' : '0');
    } catch {
      // 忽略存储失败
    }
  }, [propertiesOpen]);

  useEffect(() => {
    const onChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (!active) keyboardLock()?.unlock?.();
    };
    document.addEventListener('fullscreenchange', onChange);
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  type KeyboardLock = { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };
  const keyboardLock = (): KeyboardLock | undefined =>
    (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await document.documentElement.requestFullscreen();
      // 锁定 Esc：全屏时 Esc 只用于取消选择，不再退出全屏（Chrome/Edge 支持 Keyboard Lock）
      let locked = false;
      const keyboard = keyboardLock();
      if (keyboard?.lock) {
        try {
          await keyboard.lock(['Escape']);
          locked = true;
        } catch {
          locked = false;
        }
      }
      setMessage(locked
        ? '已进入全屏：Esc 取消选择，退出全屏请点右上角 ⤡'
        : '已进入全屏（当前浏览器 Esc 会退出全屏）');
    } catch (error) {
      setMessage(error instanceof Error ? `全屏失败：${error.message}` : '当前浏览器不支持全屏');
    }
  }

  function commit(mutator: (document: ProjectDocument) => ProjectDocument, label: string) {
    if (!canEdit) {
      setMessage('当前角色为查看者，无法修改项目。');
      return;
    }
    const current = projectRef.current;
    const next = mutator(current);
    if (next === current) return;
    const stamped = { ...next, updatedAt: new Date().toISOString() };
    setHistory((previous) => ({
      past: [...previous.past.slice(-(HISTORY_LIMIT - 1)), current],
      future: [],
    }));
    setProject(stamped);
    projectRef.current = stamped;
    const client = collabRef.current;
    if (client?.online) {
      const diff = diffDocuments(current, stamped);
      if (diff && client.sendPatch(diff)) {
        lastSavedRef.current = stamped;
        setSaveState('saved');
      }
    }
    setMessage(label);
  }

  function undo() {
    if (!canEdit || !history.past.length) return;
    const previous = history.past[history.past.length - 1]!;
    setHistory({ past: history.past.slice(0, -1), future: [projectRef.current, ...history.future].slice(0, HISTORY_LIMIT) });
    const before = projectRef.current;
    setProject(previous);
    projectRef.current = previous;
    setSelection((current) => current.filter((id) => previous.elements.some((element) => element.id === id)));
    syncLocalChange(before, previous);
    setMessage('已撤销');
  }

  function redo() {
    if (!canEdit || !history.future.length) return;
    const next = history.future[0]!;
    setHistory({ past: [...history.past, projectRef.current].slice(-HISTORY_LIMIT), future: history.future.slice(1) });
    const before = projectRef.current;
    setProject(next);
    projectRef.current = next;
    setSelection((current) => current.filter((id) => next.elements.some((element) => element.id === id)));
    syncLocalChange(before, next);
    setMessage('已重做');
  }

  /** 撤销/重做等绕过 commit 的本地改动，在协作在线时也要广播补丁 */
  function syncLocalChange(before: ProjectDocument, after: ProjectDocument) {
    const client = collabRef.current;
    if (!client?.online) return;
    const diff = diffDocuments(before, after);
    if (diff && client.sendPatch(diff)) {
      lastSavedRef.current = after;
      setSaveState('saved');
    }
  }

  function cancelTool() {
    if (tool === 'select' && !draftStart) return;
    setTool('select');
    setDraftStart(null);
    setMessage('已退出工具');
  }

  /** Esc：退出当前工具 + 清空选择 + 取消标高选中 */
  function escape() {
    if (pendingCommandRef.current) {
      setPendingCommand(null);
      setMessage('已取消命令');
      return;
    }
    const hadSelection = selection.length > 0 || selectedLevelId !== null;
    setTool('select');
    setDraftStart(null);
    setSelection([]);
    setSelectedLevelId(null);
    if (hadSelection || tool !== 'select') setMessage('已取消选择');
  }

  function deleteSelection() {
    if (!selection.length || !canEdit) return;
    const removed = new Set(selection);
    commit(
      (document) => ({ ...document, elements: document.elements.filter((element) => !removed.has(element.id)) }),
      `已删除 ${selection.length} 个构件`,
    );
    setSelection([]);
  }

  const actionsRef = useRef({
    undo,
    redo,
    deleteSelection,
    cancelTool,
    escape,
    copySelection,
    pasteSelection,
    duplicateSelection: () => duplicateSelection(),
    nudgeSelection,
    continueCommand,
    cancelCommand,
  });
  actionsRef.current = {
    undo,
    redo,
    deleteSelection,
    cancelTool,
    escape,
    copySelection,
    pasteSelection,
    duplicateSelection: () => duplicateSelection(),
    nudgeSelection,
    continueCommand,
    cancelCommand,
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) actionsRef.current.redo();
        else actionsRef.current.undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        actionsRef.current.redo();
        return;
      }
      if (typing) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        actionsRef.current.copySelection();
        return;
      }
      if (mod && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        actionsRef.current.pasteSelection();
        return;
      }
      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        actionsRef.current.duplicateSelection();
        return;
      }
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, 1],
        ArrowDown: [0, -1],
      };
      const step = arrows[event.key];
      if (step) {
        event.preventDefault();
        const size = event.shiftKey ? 1 : 0.1;
        actionsRef.current.nudgeSelection(step[0] * size, step[1] * size);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        actionsRef.current.continueCommand();
        return;
      }
      if (event.key === 'Escape') actionsRef.current.escape();
      if (event.key === 'Delete' || event.key === 'Backspace') actionsRef.current.deleteSelection();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  function selectElement(id: string, additive: boolean) {
    setSelectedLevelId(null);
    setSelection((current) => {
      if (!additive) return [id];
      return current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
    });
  }

  function moveSelection(delta: MoveDelta) {
    if (!canEdit || !selection.length) return;
    const selected = new Set(selection);
    commit(
      (document) => ({
        ...document,
        elements: document.elements.map((element) => (
          selected.has(element.id) ? translateElement(element, delta) : element
        )),
      }),
      `已平移 ${selection.length} 个构件`,
    );
  }

  function rotateSelection(delta: RotateDelta) {
    if (!canEdit || !selection.length) return;
    const angle = (delta.angleDeg * Math.PI) / 180;
    const selected = new Set(selection);
    commit(
      (document) => ({
        ...document,
        elements: document.elements.map((element) => (
          selected.has(element.id) ? rotateElement(element, { angle, center: delta.center }) : element
        )),
      }),
      `已旋转 ${selection.length} 个构件（${delta.angleDeg}°）`,
    );
  }

  function mirrorSelection(delta: MirrorDelta) {
    if (!canEdit || !selectedElements.length) return;
    const usable = selectedElements.filter((element) => element.category !== 'mesh');
    const skipped = selectedElements.length - usable.length;
    if (!usable.length) {
      setMessage('导入网格暂不支持镜像');
      return;
    }
    const options = { axis: delta.axis, position: delta.position };
    let text = '';
    if (delta.keepOriginal) {
      const copies = duplicateElements(project, usable, { dx: 0, dy: 0 })
        .map((element) => mirrorElement(element, options));
      commit(
        (document) => ({ ...document, elements: [...document.elements, ...copies] }),
        `已镜像复制 ${copies.length} 个构件`,
      );
      setSelection(copies.map((element) => element.id));
      text = `已镜像复制 ${copies.length} 个构件`;
    } else {
      const mirrored = usable.map((element) => mirrorElement(element, options));
      const byId = new Map(mirrored.map((element) => [element.id, element]));
      commit(
        (document) => ({
          ...document,
          elements: document.elements.map((element) => byId.get(element.id) ?? element),
        }),
        `已镜像 ${mirrored.length} 个构件`,
      );
      setSelection(mirrored.map((element) => element.id));
      text = `已镜像 ${mirrored.length} 个构件`;
    }
    if (skipped) text += `；跳过 ${skipped} 个导入网格（暂不支持镜像）`;
    setMessage(text);
  }

  function applyArray(delta: ArrayDelta) {
    if (!canEdit || !selectedElements.length) return;
    const copies = arrayElements(project, selectedElements, delta);
    if (!copies.length) return;
    commit(
      (document) => ({ ...document, elements: [...document.elements, ...copies] }),
      `已生成阵列：${copies.length} 个副本`,
    );
    setSelection(copies.map((element) => element.id));
  }

  function beginCommand(command: CommandId) {
    setPendingCommand(command);
    const need = command === 'union' || command === 'subtract' || command === 'intersect'
      ? '2 个构件'
      : '要修改的构件';
    setMessage(`${COMMAND_LABELS[command]}：请选择${need}，按 Enter 继续，Esc 取消`);
  }

  function continueCommand() {
    const command = pendingCommandRef.current;
    if (!command) return;
    if (!selection.length) {
      setMessage('请先在视口中选择构件');
      return;
    }
    const need = command === 'union' || command === 'subtract' || command === 'intersect';
    if (need && selection.length !== 2) {
      setMessage(`布尔运算需要选择 2 个构件（当前 ${selection.length}）`);
      return;
    }
    setPendingCommand(null);
    if (command === 'move') setMoveOpen(true);
    else if (command === 'rotate') setRotateOpen(true);
    else if (command === 'mirror') setMirrorOpen(true);
    else if (command === 'array') setArrayOpen(true);
    else if (command === 'delete') deleteSelection();
    else if (command === 'copy') copySelection();
    else if (command === 'duplicate') duplicateSelection();
    else runBoolean(command);
  }

  function cancelCommand() {
    if (!pendingCommandRef.current) return;
    setPendingCommand(null);
    setMessage('已取消命令');
  }

  function startMove() {
    if (!canEdit) return;
    if (selection.length) { setPendingCommand(null); setMoveOpen(true); }
    else beginCommand('move');
  }

  function startRotate() {
    if (!canEdit) return;
    if (selection.length) { setPendingCommand(null); setRotateOpen(true); }
    else beginCommand('rotate');
  }

  function startMirror() {
    if (!canEdit) return;
    if (selection.length) { setPendingCommand(null); setMirrorOpen(true); }
    else beginCommand('mirror');
  }

  function startArray() {
    if (!canEdit) return;
    if (selection.length) { setPendingCommand(null); setArrayOpen(true); }
    else beginCommand('array');
  }

  function startDuplicate() {
    if (!canEdit) return;
    if (selection.length) { setPendingCommand(null); duplicateSelection(); }
    else beginCommand('duplicate');
  }

  function startDelete() {
    if (!canEdit) return;
    if (selection.length) { setPendingCommand(null); deleteSelection(); }
    else beginCommand('delete');
  }

  function startCopyClipboard() {
    if (selection.length) { setPendingCommand(null); copySelection(); }
    else beginCommand('copy');
  }

  function startBoolean(operation: 'union' | 'subtract' | 'intersect') {
    if (!canEdit) return;
    if (selection.length === 2) {
      setPendingCommand(null);
      runBoolean(operation);
    }
    else beginCommand(operation);
  }

  function nudgeSelection(dx: number, dy: number) {
    moveSelection({ dx, dy, dz: 0 });
  }

  function copySelection() {
    if (!selectedElements.length) return;
    clipboardRef.current = selectedElements.map((element) => element);
    pasteCountRef.current = 1;
    setMessage(`已复制 ${selectedElements.length} 个构件到剪贴板`);
  }

  function duplicateSelection(offset = { dx: 1, dy: 0 }) {
    if (!canEdit || !selectedElements.length) return;
    const copies = duplicateElements(project, selectedElements, offset);
    commit(
      (document) => ({ ...document, elements: [...document.elements, ...copies] }),
      `已复制 ${copies.length} 个构件（偏移 ${offset.dx} m）`,
    );
    setSelection(copies.map((element) => element.id));
  }

  function pasteSelection() {
    if (!canEdit || !clipboardRef.current?.length) {
      if (!clipboardRef.current?.length) setMessage('剪贴板为空：先选中构件并按 Ctrl/Cmd+C');
      return;
    }
    const offset = { dx: pasteCountRef.current, dy: 0 };
    pasteCountRef.current += 1;
    duplicateSelection(offset);
  }

  function handleContextAction(action: 'select-all' | 'select-same-type' | 'clear', targetId: string | null) {
    if (action === 'clear') {
      setSelection([]);
      setSelectedLevelId(null);
      return;
    }
    if (action === 'select-all') {
      const ids = project.elements.filter((element) => element.visible).map((element) => element.id);
      setSelectedLevelId(null);
      setSelection(ids);
      setMessage(`已选择全部 ${ids.length} 个可见构件`);
      return;
    }
    const target = project.elements.find((element) => element.id === (targetId ?? selection[0]));
    if (!target) {
      setMessage('请先选择一个构件');
      return;
    }
    const ids = project.elements
      .filter((element) => element.visible && element.category === target.category && element.typeId === target.typeId)
      .map((element) => element.id);
    setSelectedLevelId(null);
    setSelection(ids);
    const typeName = project.types.find((type) => type.id === target.typeId)?.name;
    setMessage(`已选择 ${ids.length} 个同类构件${typeName ? `（${typeName}）` : ''}`);
  }

  function boxSelect(ids: string[], additive: boolean) {
    setSelectedLevelId(null);
    setSelection((current) => {
      if (!additive) return ids;
      const merged = new Set(current);
      for (const id of ids) merged.add(id);
      return [...merged];
    });
    if (!ids.length) setMessage('框选未命中构件');
    else setMessage(`已框选 ${ids.length} 个构件${additive ? '（已加选）' : ''}`);
  }

  function toggleVisibility(id: string) {
    commit(
      (document) => ({
        ...document,
        elements: document.elements.map((element) => (element.id === id ? { ...element, visible: !element.visible } : element)),
      }),
      '已切换构件可见性',
    );
  }

  function patchElement(id: string, patch: Record<string, unknown>) {
    commit(
      (document) => ({
        ...document,
        elements: document.elements.map((element) =>
          element.id === id ? ({ ...element, ...patch } as BimElement) : element),
      }),
      '已修改构件参数',
    );
  }

  function patchType(typeId: string, patch: Record<string, unknown>) {
    commit(
      (document) => ({
        ...document,
        types: document.types.map((type) => (type.id === typeId ? ({ ...type, ...patch } as FamilyType) : type)),
      }),
      '已修改类型参数（全部实例联动）',
    );
  }

  function patchLevel(levelId: string, patch: { name?: string; elevation?: number }) {
    commit(
      (document) => ({
        ...document,
        levels: document.levels.map((level) => (level.id === levelId ? { ...level, ...patch } : level)),
      }),
      '已修改标高',
    );
  }

  function addLevel() {
    if (!canEdit) {
      setMessage('当前角色为查看者，无法添加标高。');
      return;
    }
    const highest = project.levels.reduce((max, level) => Math.max(max, level.elevation), 0);
    const level = {
      id: createId(),
      name: `标高 ${project.levels.length + 1}`,
      elevation: Math.round((highest + 3) * 100) / 100,
    };
    commit((document) => ({ ...document, levels: [...document.levels, level] }), `已添加 ${level.name}`);
    setSelectedLevelId(level.id);
    setActiveLevelId(level.id);
  }

  function activate3d() {
    setViewKind('3d');
    setViewLevelId(null);
    setTool('select');
    setDraftStart(null);
    setFitElementId(null);
  }

  function activatePlan(levelId: string) {
    setViewKind('plan');
    setViewLevelId(levelId);
    setActiveLevelId(levelId);
    setSelectedLevelId(levelId);
    setDraftStart(null);
    setFitElementId(null);
  }

  function selectLevel(levelId: string) {
    setSelectedLevelId(levelId);
    setActiveLevelId(levelId);
    setSelection([]);
    setFitElementId(null);
    if (viewKind === 'plan') setViewLevelId(levelId);
  }

  function chooseTool(next: Tool) {
    if (!canEdit && next !== 'select') {
      setMessage('当前角色为查看者，无法使用绘制工具。');
      return;
    }
    setPendingCommand(null);
    setTool(next);
    setDraftStart(null);
    if (next !== 'select') setSelection([]);
  }

  function topLevelFor(baseLevelId: string): { topLevelId: string; topOffset: number } {
    const base = levelById(project, baseLevelId);
    if (!base) return { topLevelId: baseLevelId, topOffset: 3 };
    const above = project.levels
      .filter((level) => level.elevation > base.elevation)
      .sort((a, b) => a.elevation - b.elevation)[0];
    return above ? { topLevelId: above.id, topOffset: 0 } : { topLevelId: base.id, topOffset: 3 };
  }

  function addWall(start: Vec2, end: Vec2) {
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (length < 0.1) {
      setMessage('墙长度小于 0.1 m，已忽略。');
      return;
    }
    const type = project.types.find((item) => item.category === 'wall');
    const levelId = activeLevelId || project.levels[0]?.id;
    if (!type || !levelId) return;
    const top = topLevelFor(levelId);
    const wall: WallInstance = {
      id: createId(),
      name: nextElementName(project, 'wall'),
      category: 'wall',
      typeId: type.id,
      levelId,
      visible: true,
      start,
      end,
      baseOffset: 0,
      topLevelId: top.topLevelId,
      topOffset: top.topOffset,
    };
    commit((document) => ({ ...document, elements: [...document.elements, wall] }), `已创建 ${wall.name}（${length.toFixed(2)} m）`);
    setSelection([wall.id]);
  }

  function addColumn(position: Vec2) {
    const type = project.types.find((item) => item.category === 'column');
    const levelId = activeLevelId || project.levels[0]?.id;
    if (!type || !levelId) return;
    const top = topLevelFor(levelId);
    const column: ColumnInstance = {
      id: createId(),
      name: nextElementName(project, 'column'),
      category: 'column',
      typeId: type.id,
      levelId,
      visible: true,
      position,
      rotation: 0,
      baseOffset: 0,
      topLevelId: top.topLevelId,
      topOffset: top.topOffset,
    };
    commit((document) => ({ ...document, elements: [...document.elements, column] }), `已创建 ${column.name}`);
    setSelection([column.id]);
  }

  function addSlab(start: Vec2, end: Vec2) {
    const width = Math.abs(end[0] - start[0]);
    const depth = Math.abs(end[1] - start[1]);
    if (width < 0.2 || depth < 0.2) {
      setMessage('楼板轮廓小于 0.2 m，已忽略。');
      return;
    }
    const type = project.types.find((item) => item.category === 'slab');
    const levelId = activeLevelId || project.levels[0]?.id;
    if (!type || !levelId) return;
    const minX = Math.min(start[0], end[0]);
    const maxX = Math.max(start[0], end[0]);
    const minY = Math.min(start[1], end[1]);
    const maxY = Math.max(start[1], end[1]);
    const slab: SlabInstance = {
      id: createId(),
      name: nextElementName(project, 'slab'),
      category: 'slab',
      typeId: type.id,
      levelId,
      visible: true,
      points: [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]],
      baseOffset: 0,
    };
    commit((document) => ({ ...document, elements: [...document.elements, slab] }), `已创建 ${slab.name}（${(width * depth).toFixed(1)} m²）`);
    setSelection([slab.id]);
  }

  function addGrid(start: Vec2, end: Vec2) {
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 0.2) {
      setMessage('轴网太短，已忽略。');
      return;
    }
    const grid = { id: createId(), name: nextElementName(project, 'grid'), start, end };
    commit((document) => ({ ...document, grids: [...document.grids, grid] }), `已创建轴网 ${grid.name}`);
  }

  function deleteGrid(id: string) {
    commit((document) => ({ ...document, grids: document.grids.filter((grid) => grid.id !== id) }), '已删除轴网');
  }

  function handlePickPoint(point: Vec2) {
    if (tool === 'column') {
      addColumn(point);
      return;
    }
    if (tool === 'select') return;
    if (!draftStart) {
      setDraftStart(point);
      setMessage(`已确定第一点 (${point[0].toFixed(2)}, ${point[1].toFixed(2)})，再点击确定第二点（Esc 取消）`);
      return;
    }
    if (tool === 'wall') addWall(draftStart, point);
    else if (tool === 'slab') addSlab(draftStart, point);
    else if (tool === 'grid') addGrid(draftStart, point);
    setDraftStart(null);
  }

  function runBoolean(operation: 'union' | 'subtract' | 'intersect') {
    if (!canEdit) {
      setMessage('当前角色为查看者，无法执行布尔运算。');
      return;
    }
    if (selection.length !== 2) {
      setMessage('请先选择 2 个构件（Shift 加选）。');
      return;
    }
    const [first, second] = selection.map((id) => project.elements.find((element) => element.id === id));
    if (!first || !second) return;
    try {
      const result = booleanElement(project, first, second, operation);
      commit(
        (document) => ({
          ...document,
          elements: [
            ...document.elements.filter((element) => element.id !== first.id && element.id !== second.id),
            result,
          ],
        }),
        `已生成 ${result.name}`,
      );
      setSelection([result.id]);
      setFitElementId(result.id);
    } catch (error) {
      console.error('布尔运算失败。', error);
      setMessage(error instanceof Error ? `布尔运算失败：${error.message}` : '布尔运算失败。');
    }
  }

  function exportDocument() {
    if (!project.elements.length) {
      setMessage('当前项目没有可导出的构件。');
      return;
    }
    downloadFile(`${project.name || 'model'}.obj`, exportObj(project), 'text/plain');
    setMessage('已导出 OBJ（Z-up → Y-up）。');
  }

  async function importObjFile(file: File, report: (stage: string, percent: number | null) => void) {
    report('读取 OBJ 文件', 5);
    const text = (await readFileWithProgress(file, 'text', (ratio) => {
      report('读取 OBJ 文件', 5 + ratio * 55);
    })) as string;
    report('解析 OBJ 网格', null);
    const object = new OBJLoader().parse(text);
    object.updateMatrixWorld(true);
    const geometries: BufferGeometry[] = [];
    object.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      const geometry = node.geometry.clone();
      geometry.applyMatrix4(node.matrixWorld);
      const normalized = new BufferGeometry();
      normalized.setAttribute('position', geometry.getAttribute('position').clone());
      normalized.setIndex(geometry.index?.clone() ?? null);
      geometry.dispose();
      geometries.push(normalized.index ? normalized.toNonIndexed() : normalized.clone());
      normalized.dispose();
    });
    report('合并网格', 85);
    const merged = geometries.length ? mergeGeometries(geometries, false) : null;
    geometries.forEach((geometry) => geometry.dispose());
    if (!merged) throw new Error('OBJ 文件中没有可读取的网格。');
    try {
      report('写入项目', 95);
      const element = meshElementFromGeometry(merged, {
        name: file.name.replace(/\.obj$/i, '') || '导入模型',
        color: '#a3adb8',
        levelId: activeLevelId || project.levels[0]!.id,
        source: 'OBJ 导入',
      });
      commit((document) => ({ ...document, elements: [...document.elements, element] }), `已导入 ${file.name}`);
      setSelection([element.id]);
      setFitElementId(element.id);
    } finally {
      merged.dispose();
    }
  }

  async function importStepFile(file: File, report: (stage: string, percent: number | null) => void) {
    // 优先走服务端 OCCT：能取回装配实例上的面颜色（浏览器端 occt-import-js 会丢失）
    if (mode === 'server') {
      try {
        report('上传 STEP 到服务端', 5);
        const serverMesh = await fetchServerStepMesh(file, {
          onProgress: ({ phase, loaded, total }) => {
            if (phase === 'upload') {
              report('上传 STEP 到服务端', total > 0 ? 5 + (loaded / total) * 40 : null);
            } else if (phase === 'convert') {
              report('服务端 OCCT 转换（大模型需数分钟）', null);
            } else {
              report('下载网格数据', total > 0 ? 45 + (loaded / total) * 45 : null);
            }
          },
        });
        if (serverMesh) {
          report('构建构件', 95);
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new Float32BufferAttribute(serverMesh.positions, 3));
          geometry.setAttribute('color', new Float32BufferAttribute(serverMesh.colors, 3));
          try {
            const element = meshElementFromGeometry(geometry, {
              name: file.name.replace(/\.(step|stp)$/i, '') || 'STEP 模型',
              color: '#ffffff',
              levelId: activeLevelId || project.levels[0]!.id,
              source: 'STEP 导入（服务端 OCCT，面颜色）',
            });
            commit((document) => ({ ...document, elements: [...document.elements, element] }), `已导入 ${file.name}`);
            setSelection([element.id]);
            setFitElementId(element.id);
            setMessage(
              `已导入 ${file.name}：服务端 OCCT 解析，`
              + `${serverMesh.stats.coloredFaces.toLocaleString()}/${serverMesh.stats.faces.toLocaleString()} 个面带色，`
              + `${serverMesh.vertexCount.toLocaleString()} 顶点 / ${serverMesh.triangleCount.toLocaleString()} 三角面`,
            );
          } finally {
            geometry.dispose();
          }
          return;
        }
      } catch (error) {
        console.warn('服务端 STEP 转换失败，回退浏览器解析。', error);
        setMessage(`服务端转换失败，改用浏览器解析：${error instanceof Error ? error.message : '未知错误'}`);
      }
    }

    report('读取 STEP 文件', 5);
    const stepBuffer = (await readFileWithProgress(file, 'buffer', (ratio) => {
      report('读取 STEP 文件', 5 + ratio * 25);
    })) as ArrayBuffer;
    report('加载 STEP 内核', null);
    const importer = await loadStepImporter();
    report('解析 STEP', null);
    const result = importer.ReadStepFile(new Uint8Array(stepBuffer), {
      linearUnit: 'meter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001,
      angularDeflection: 0.5,
    });
    if (!result.success) throw new Error('STEP 文件无法解析或不包含有效实体。');

    const meshGeometries: Array<{ geometry: BufferGeometry; mesh: (typeof result.meshes)[number] }> = [];
    for (const [index, mesh] of result.meshes.entries()) {
      const positions = mesh.attributes?.position?.array;
      const indices = mesh.index?.array;
      if (!positions?.length || !indices?.length) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      geometry.name = mesh.name || `构件 ${index + 1}`;
      meshGeometries.push({ geometry, mesh });
    }
    if (!meshGeometries.length) throw new Error('STEP 文件中没有可读取的三角网格。');

    report('合并网格', 85);
    const hasImportedColors = meshGeometries.some(({ mesh }) =>
      Boolean(mesh.color?.length || mesh.brep_faces?.some((face) => face.color?.length)),
    );
    let missingColorTriangles = 0;
    const geometries = meshGeometries.map(({ geometry, mesh }) => {
      const triangleCount = Math.floor((geometry.index?.count ?? 0) / 3);
      if (mesh.color?.length !== 3) {
        const coloredRanges = (mesh.brep_faces ?? [])
          .filter((face) => face.color?.length === 3)
          .map((face) => [Math.max(0, face.first), Math.min(triangleCount - 1, face.last)] as const)
          .filter(([first, last]) => first <= last)
          .sort(([a], [b]) => a - b);
        let next = 0;
        for (const [first, last] of coloredRanges) {
          if (first > next) missingColorTriangles += first - next;
          next = Math.max(next, last + 1);
        }
        missingColorTriangles += Math.max(0, triangleCount - next);
      }
      if (!hasImportedColors) return geometry;
      const nonIndexed = geometry.toNonIndexed();
      geometry.dispose();
      const positions = nonIndexed.getAttribute('position');
      const colors = new Float32Array(positions.count * 3);
      const defaultColor = mesh.color?.length === 3 ? mesh.color : [0.78, 0.79, 0.82];
      for (let vertex = 0; vertex < positions.count; vertex += 1) colors.set(defaultColor, vertex * 3);
      for (const face of mesh.brep_faces ?? []) {
        if (!face.color || face.color.length !== 3) continue;
        const firstVertex = Math.max(0, face.first) * 3;
        const lastVertex = Math.min(Math.floor(positions.count / 3) - 1, face.last) * 3 + 2;
        for (let vertex = firstVertex; vertex <= lastVertex; vertex += 1) colors.set(face.color, vertex * 3);
      }
      nonIndexed.setAttribute('color', new Float32BufferAttribute(colors, 3));
      return nonIndexed;
    });
    const merged = mergeGeometries(geometries, false);
    geometries.forEach((geometry) => geometry.dispose());
    if (!merged) throw new Error('无法合并 STEP 网格。');
    try {
      const element = meshElementFromGeometry(merged, {
        name: file.name.replace(/\.(step|stp)$/i, '') || 'STEP 模型',
        color: hasImportedColors ? '#ffffff' : '#a3adb8',
        levelId: activeLevelId || project.levels[0]!.id,
        source: 'STEP 导入',
      });
      commit((document) => ({ ...document, elements: [...document.elements, element] }), `已导入 ${file.name}`);
      setSelection([element.id]);
      setFitElementId(element.id);
      if (missingColorTriangles) {
        setMessage(`已导入 ${file.name}；导入器未返回 ${missingColorTriangles.toLocaleString('zh-CN')} 个三角面的颜色（见 diagnostics/FINDINGS.md）。`);
      }
    } finally {
      merged.dispose();
    }
  }

  async function importModel(file: File) {
    if (!canEdit) {
      setMessage('当前角色为查看者，无法导入模型。');
      return;
    }
    const extension = file.name.split('.').pop()?.toLowerCase();
    setIsImporting(true);
    const report = (stage: string, percent: number | null) => {
      setImportProgress({
        stage,
        percent: percent === null ? null : Math.max(0, Math.min(100, percent)),
      });
    };
    report('准备导入', 2);
    setMessage(extension === 'step' || extension === 'stp' ? '正在解析 STEP 文件…' : '正在导入 OBJ 文件…');
    try {
      if (extension === 'obj') await importObjFile(file, report);
      else if (extension === 'step' || extension === 'stp') await importStepFile(file, report);
      else throw new Error('仅支持 OBJ、STEP 和 STP 格式。');
      report('完成', 100);
      window.setTimeout(() => {
        setImportProgress((current) => (current?.percent === 100 ? null : current));
      }, 700);
    } catch (error) {
      console.error('模型导入失败。', error);
      setImportProgress(null);
      setMessage(error instanceof Error ? `导入失败：${error.message}` : '模型导入失败。');
    } finally {
      setIsImporting(false);
    }
  }

  async function openProject(id: string) {
    if (!repository || id === projectRef.current.id) return;
    const loaded = await repository.load(id);
    if (!loaded) {
      setMessage('项目不存在或无权访问。');
      return;
    }
    setProject(loaded);
    projectRef.current = loaded;
    lastSavedRef.current = loaded;
    setActiveLevelId(loaded.levels[0]?.id ?? '');
    setSelectedLevelId(null);
    setSelection([]);
    setHistory({ past: [], future: [] });
    setViewKind('3d');
    setViewLevelId(null);
    setTool('select');
    setDraftStart(null);
    setFitElementId(null);
    setConflictRev(null);
    setSaveState('saved');
    await repository.saveLastOpenedId(loaded.id);
    setMessage(`已打开项目「${loaded.name}」`);
  }

  async function createNewProject() {
    if (!repository) return;
    const name = window.prompt('新项目名称', '未命名项目')?.trim();
    if (!name) return;
    const created = createProject({ name });
    await repository.save(created);
    setSummaries(await repository.list());
    await openProject(created.id);
    setMessage(`已创建项目「${name}」`);
  }

  function renameProject() {
    const name = window.prompt('项目名称', project.name)?.trim();
    if (!name || name === project.name) return;
    commit((document) => ({ ...document, name }), `项目已重命名为「${name}」`);
  }

  async function deleteCurrentProject() {
    if (!repository || !isAdmin) return;
    if (!window.confirm(`删除项目「${project.name}」？该操作不可恢复。`)) return;
    try {
      await repository.remove(project.id);
      const list = await repository.list();
      setSummaries(list);
      if (list[0]) {
        await openProject(list[0].id);
      } else {
        const created = createProject({ name: '未命名项目' });
        await repository.save(created);
        setProject(created);
        projectRef.current = created;
        lastSavedRef.current = created;
        setSummaries(await repository.list());
      }
      setMessage('项目已删除');
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : '删除项目失败');
    }
  }

  async function reloadFromServer() {
    if (!repository) return;
    const loaded = await repository.load(project.id);
    if (!loaded) return;
    setProject(loaded);
    projectRef.current = loaded;
    lastSavedRef.current = loaded;
    setConflictRev(null);
    setSaveState('saved');
    setSelection([]);
    setHistory({ past: [], future: [] });
    setMessage('已加载服务端最新文档');
  }

  async function overwriteServer() {
    if (!repository) return;
    try {
      await repository.save(project, { force: true });
      lastSavedRef.current = project;
      setConflictRev(null);
      setSaveState('saved');
      setSummaries(await repository.list());
      setMessage('已覆盖服务端文档');
    } catch (error) {
      setMessage(error instanceof Error ? `覆盖失败：${error.message}` : '覆盖失败');
    }
  }

  function logout() {
    setAuthToken(null);
    setUser(null);
    setSummaries([]);
    setSelection([]);
    setHistory({ past: [], future: [] });
    setHydrated(false);
    lastSavedRef.current = null;
  }

  const toolHint = tool === 'select'
    ? '左键拖拽旋转 · 单击空白开始框选 · 再次单击完成 · 中键平移 · 右键菜单'
    : `左键放置${TOOL_LABELS[tool]} · 左键拖拽旋转 · 中键平移 · Esc 退出`;

  if (mode === 'server' && authReady && !user) {
    return (
      <AuthGate
        onAuthenticated={(nextUser) => {
          setBootstrapError('');
          setUser(nextUser);
        }}
        notice={bootstrapError || undefined}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">STRU<span>BROWSER</span></div>
            <div className="brand-caption">Web BIM 工作台 · 建筑</div>
          </div>
        </div>

        <div className="document-actions">
          <button className="top-action" onClick={() => void createNewProject()}><span>＋</span> 新建项目</button>
          <label className="top-action open-action">
            <span>▣</span> 打开
            <select
              aria-label="打开项目"
              value={project.id}
              onChange={(event) => void openProject(event.target.value)}
            >
              {summaries.length === 0 ? <option value={project.id}>{project.name}</option> : null}
              {summaries.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}{item.role ? ` · ${item.role === 'viewer' ? '只读' : item.role === 'editor' ? '可编辑' : '管理员'}` : ''}
                </option>
              ))}
            </select>
          </label>
          <button className="top-action" onClick={renameProject} disabled={!canEdit}><span>✎</span> 重命名</button>

          <div className="history-actions">
            <button className="icon-action" title="撤销 (Ctrl/Cmd+Z)" onClick={undo} disabled={!canEdit || !history.past.length}>↶</button>
            <button className="icon-action" title="重做 (Shift+Ctrl/Cmd+Z)" onClick={redo} disabled={!canEdit || !history.future.length}>↷</button>
            <button
              className={`icon-action ${settingsOpen ? 'active' : ''}`}
              title="设置（软件偏好 / 用户 / AI）"
              onClick={() => {
                setSettingsTab('view');
                setSettingsOpen(true);
              }}
            >⚙</button>
            <button
              className={`icon-action ${aiOpen ? 'active' : ''}`}
              title="AI 建模助手（服务端模式）"
              onClick={() => {
                if (mode !== 'server') {
                  setMessage('AI 助手需要服务端模式：用 ./start.sh 启动完整前后端');
                  return;
                }
                setAiOpen((open) => !open);
              }}
            >✦</button>
            <button
              className={`icon-action ${isFullscreen ? 'active' : ''}`}
              title={isFullscreen ? '退出全屏' : '全屏（保留菜单）'}
              onClick={() => void toggleFullscreen()}
            >{isFullscreen ? '⤡' : '⤢'}</button>
          </div>

          <div className="save-state">
            <i className={conflictRev !== null ? 'conflict-dot' : ''} />
            {conflictRev !== null ? '冲突' : saveState === 'saving' ? '保存中…' : saveState === 'dirty' ? '未保存' : '已保存'}
            {mode === 'server' && currentSummary?.rev !== undefined ? ` · rev ${currentSummary.rev}` : ''}
          </div>
        </div>

        <div className="account-chip">
          {collabUsers.length ? (
            <div className="presence-stack" title={`在线：${collabUsers.map((member) => member.name).join('、')}`}>
              {collabUsers.slice(0, 4).map((member, index) => (
                <span key={member.id} className={`presence-avatar tone-${index % 5}`}>
                  {member.name.slice(0, 1)}
                </span>
              ))}
              {collabUsers.length > 4 ? <span className="presence-more">+{collabUsers.length - 4}</span> : null}
            </div>
          ) : null}
          <span className={`mode-badge mode-${mode ?? 'pending'}`}>
            {mode === 'server' ? '服务端' : mode === 'local' ? '本地' : '连接中'}
          </span>
          {user ? (
            <>
              <span className="chip-name" title={user.email}>{user.name}</span>
              <button className="logout-action" onClick={logout} title="退出登录">退出</button>
            </>
          ) : (
            <span className="chip-meta">{project.name}</span>
          )}
        </div>
      </header>

      {apiReachable === false ? (
        <div className="connection-bar">
          <span>⚠ 与服务端的连接已断开：API 可能未启动或进程已退出。</span>
          <div className="connection-actions">
            <button onClick={() => void checkApi()}>重新连接</button>
            <code>./start.sh restart</code>
          </div>
        </div>
      ) : null}

      {conflictRev !== null ? (
        <div className="conflict-bar">
          <span>⚠ 服务端文档已被其他会话修改（rev {conflictRev}）。</span>
          <div className="conflict-actions">
            <button onClick={() => void reloadFromServer()}>加载最新</button>
            <button className="danger" onClick={() => void overwriteServer()}>覆盖保存</button>
          </div>
        </div>
      ) : null}

      <Ribbon
        tab={ribbonTab}
        onTabChange={setRibbonTab}
        tool={tool}
        onTool={chooseTool}
        onBoolean={startBoolean}
        onDelete={startDelete}
        onMove={startMove}
        onCopy={startDuplicate}
        onRotate={startRotate}
        onMirror={startMirror}
        onArray={startArray}
        onCopyToClipboard={startCopyClipboard}
        onPaste={pasteSelection}
        viewKind={viewKind}
        onViewKind={(kind) => {
          if (kind === 'plan') activatePlan(selectedLevelId ?? activeLevelId);
          else activate3d();
        }}
        projection={projection}
        onProjection={setProjection}
        onZoomAll={() => {
          setFitElementId(null);
          setZoomAllRequest((request) => request + 1);
        }}
        isImporting={isImporting}
        onImport={(file) => void importModel(file)}
        onExport={exportDocument}
        onNewProject={() => void createNewProject()}
        serverMode={mode === 'server'}
        readOnly={!canEdit}
        onOpenVersions={() => setVersionsOpen(true)}
        onOpenMembers={() => setMembersOpen(true)}
        onDeleteProject={() => void deleteCurrentProject()}
        onOpenSettings={() => {
          setSettingsTab('view');
          setSettingsOpen(true);
        }}
        isAdmin={Boolean(user?.isAdmin)}
        onOpenAdmin={() => window.open('/admin', '_blank', 'noopener')}
      />

      <section className="workspace">
        {browserOpen ? (
        <ProjectBrowser
          onCollapse={() => setBrowserOpen(false)}
          project={project}
          activeLevelId={activeLevelId}
          viewKind={viewKind}
          viewLevelId={viewLevelId}
          selection={selection}
          selectedLevelId={selectedLevelId}
          onActivate3d={activate3d}
          onActivatePlan={activatePlan}
          onSelectLevel={selectLevel}
          onAddLevel={addLevel}
          onSelectElement={selectElement}
          onToggleVisibility={toggleVisibility}
          onDeleteGrid={deleteGrid}
          onRenameProject={renameProject}
        />
        ) : (
          <button className="panel-rail panel-rail-left" onClick={() => setBrowserOpen(true)} title="展开项目浏览器">
            <span className="rail-icon">▤</span>
            <em>项目浏览器</em>
          </button>
        )}

        <section className="viewport-column">
          <div className="viewport-toolbar">
            <div className="view-title">
              <span className="view-cube">{viewKind === 'plan' ? '▦' : '◈'}</span>
              <strong>{viewKind === 'plan' ? `${activeLevel?.name ?? '标高'} 平面` : '三维视图'}</strong>
              <span className="view-tag">
                {viewKind === 'plan' ? '比例 1:100' : projection === 'parallel' ? '平行投影' : '透视投影'}
              </span>
            </div>
            <div className="view-tools"><span className="tool-hint">{toolHint}</span></div>
            <button
              className="zoom-all-button"
              onClick={() => {
                setFitElementId(null);
                setZoomAllRequest((request) => request + 1);
              }}
              title="缩放至全部构件"
            ><span>⊞</span>缩放至全部</button>
          </div>

          <ModelViewport
            project={project}
            selection={selection}
            activeLevelId={activeLevelId}
            viewKind={viewKind}
            projection={projection}
            tool={tool}
            draftStart={draftStart}
            settings={viewSettings}
            onRendererInfo={setRendererInfo}
            onSelect={selectElement}
            onBoxSelect={boxSelect}
            onContextAction={handleContextAction}
            onHover={setHoverPoint}
            onPickPoint={handlePickPoint}
            fitElementId={fitElementId}
            zoomAllRequest={zoomAllRequest}
            onClickEmpty={() => {
              setSelection([]);
              setSelectedLevelId(null);
            }}
          />

          {pendingCommand ? (
            <div className="command-hint">
              <strong>{COMMAND_LABELS[pendingCommand]}</strong>
              <span>
                {pendingCommand === 'union' || pendingCommand === 'subtract' || pendingCommand === 'intersect'
                  ? `请选择 2 个构件（已选 ${selection.length}）`
                  : `已选择 ${selection.length} 个构件 · Enter 继续`}
              </span>
              <button className="primary" onClick={() => continueCommand()} disabled={!selection.length}>继续</button>
              <button onClick={() => cancelCommand()}>取消</button>
            </div>
          ) : null}

          {importProgress ? (
            <div className={`import-progress ${importProgress.percent === null ? 'indeterminate' : ''}`}>
              <div className="import-progress-head">
                <span>{importProgress.stage}</span>
                <b>{importProgress.percent === null ? '处理中…' : `${Math.round(importProgress.percent)}%`}</b>
              </div>
              <div className="import-progress-track">
                <div
                  className="import-progress-bar"
                  style={importProgress.percent === null ? undefined : { width: `${importProgress.percent}%` }}
                />
              </div>
            </div>
          ) : null}

          <label className="view-corner view-mode-control">
            <span className="live-dot" />
            <select
              aria-label="投影方式"
              value={projection}
              onChange={(event) => setProjection(event.target.value === 'parallel' ? 'parallel' : 'perspective')}
            >
              <option value="perspective">透视投影</option>
              <option value="parallel">平行投影</option>
            </select>
            <span className="corner-chevron">⌄</span>
          </label>
          <div className="view-corner compass"><span className="compass-n">N</span><span className="compass-ring">＋</span><span className="compass-e">E</span></div>

          <div className="viewport-toolbar-bottom">
            <span>工作平面：{activeLevel?.name ?? '—'}（{activeLevel ? activeLevel.elevation.toFixed(2) : '0.00'} m）</span>
            <span>单位：米</span>
            {viewKind === 'plan' ? <span className="plan-badge">平面视图 · 旋转已锁定</span> : <span>框选：单击 → 移动 → 单击</span>}
            {draftStart ? <span className="draft-badge">已取第一点 · 再点击确定终点</span> : null}
            {!canEdit ? <span className="readonly-badge">只读</span> : null}
          </div>
        </section>

        {propertiesOpen ? (
        <PropertiesPanel
          onCollapse={() => setPropertiesOpen(false)}
          project={project}
          selection={selectedElements}
          selectedLevel={selectedElements.length ? null : selectedLevel}
          onElementPatch={patchElement}
          onTypePatch={patchType}
          onLevelPatch={patchLevel}
          onDeleteSelection={deleteSelection}
          onBoolean={runBoolean}
          readOnly={!canEdit}
        />
        ) : (
          <button className="panel-rail panel-rail-right" onClick={() => setPropertiesOpen(true)} title="展开属性面板">
            <span className="rail-icon">▥</span>
            <em>属性</em>
          </button>
        )}
      </section>

      <footer className="statusbar">
        <div className="status-left">
          <span className="status-ready"><i />{saveState === 'saving' ? '正在保存' : conflictRev !== null ? '存在冲突' : '就绪'}</span>
          <span className="status-divider" />
          <span>{mode === 'server' ? '服务端项目' : '本地项目'}</span>
          <span className="status-divider" />
          <span>{viewKind === 'plan' ? `${activeLevel?.name ?? ''} 平面` : '三维视图'}</span>
          <span className="status-divider" />
          <span>{role === 'viewer' ? '查看者（只读）' : role === 'editor' ? '编辑者' : role === 'admin' ? '管理者' : '本地用户'}</span>
          <span className="status-divider" />
          <span className={`collab-state ${mode === 'server' ? collabStatus : 'offline'}`}>
            {mode === 'local'
              ? '本地模式'
              : collabStatus === 'online'
                ? `协同在线 · ${collabUsers.length} 人`
                : collabStatus === 'connecting'
                  ? '协同连接中…'
                  : collabStatus === 'error'
                    ? '协同异常'
                    : '协同离线'}
          </span>
          {latencyMs !== null ? (
            <>
              <span className="status-divider" />
              <span className={`latency ${latencyMs > 300 ? 'warn' : ''}`}>延迟 {latencyMs} ms</span>
            </>
          ) : null}
          {selection.length ? <><span className="status-divider" /><span>已选 {selection.length}</span></> : null}
        </div>
        <div className="status-right">
          {viewSettings.showCoordinates ? (
            <>
              <span className="coordinate-label">光标坐标</span>
              {hoverPoint
                ? <span className="coordinate-value">X <b>{hoverPoint.x.toFixed(2)}</b>　Y <b>{hoverPoint.y.toFixed(2)}</b>　Z <b>{hoverPoint.z.toFixed(2)}</b> m</span>
                : <span className="coordinate-value coordinate-placeholder">—　—　—</span>}
            </>
          ) : null}
          {viewSettings.showStats ? (
            <>
              <span className="status-divider" />
              <span>构件 <b>{project.elements.length}</b></span>
              <span className="status-divider" />
              <span className="triangle-icon">△</span><span>三角面 <b>{triangles.toLocaleString()}</b></span>
            </>
          ) : null}
        </div>
      </footer>

      {moveOpen ? (
        <MoveDialog
          selectionCount={selection.length}
            onClose={() => setMoveOpen(false)}
          onApply={(delta) => {
            moveSelection(delta);
            setMoveOpen(false);
          }}
        />
      ) : null}

      {rotateOpen ? (
        <RotateDialog
          selectionCount={selection.length}
            defaultCenter={selectionCenter(selectedElements)}
          onClose={() => setRotateOpen(false)}
          onApply={(delta) => {
            rotateSelection(delta);
            setRotateOpen(false);
          }}
        />
      ) : null}

      {mirrorOpen ? (
        <MirrorDialog
          selectionCount={selection.length}
            onClose={() => setMirrorOpen(false)}
          onApply={(delta) => {
            mirrorSelection(delta);
            setMirrorOpen(false);
          }}
        />
      ) : null}

      {arrayOpen ? (
        <ArrayDialog
          selectionCount={selection.length}
            defaultCenter={selectionCenter(selectedElements)}
          onClose={() => setArrayOpen(false)}
          onApply={(delta) => {
            applyArray(delta);
            setArrayOpen(false);
          }}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          currentUser={user}
          initialTab={settingsTab}
          settings={viewSettings}
          onSettingsChange={setViewSettings}
          diagnostics={{
            renderer: rendererInfo?.renderer,
            software: rendererInfo?.software,
            elements: project.elements.length,
            triangles,
          }}
          onClose={() => setSettingsOpen(false)}
          onToast={(text) => setMessage(text)}
          onSelfUpdated={(nextUser) => setUser(nextUser)}
        />
      ) : null}

      {aiOpen && mode === 'server' ? (
        <AiPanel
          projectId={project.id}
          projectName={project.name}
          canEdit={canEdit}
          selectedIds={selection}
          onClose={() => setAiOpen(false)}
          currentDocument={project}
          onApplied={(document, rev, previous) => {
            setHistory((previousHistory) => ({
              past: [...previousHistory.past.slice(-(HISTORY_LIMIT - 1)), previous],
              future: [],
            }));
            repository?.adoptRevision?.(project.id, rev);
            setProject(document);
            projectRef.current = document;
            lastSavedRef.current = document;
            setSaveState('saved');
            void repository?.list().then(setSummaries);
            setMessage(`AI 已应用修改（rev ${rev}），可用 Ctrl/Cmd+Z 撤销`);
          }}
        />
      ) : null}

      {versionsOpen && mode === 'server' ? (
        <VersionsDialog
          projectId={project.id}
          projectName={project.name}
          canWrite={canEdit}
          onClose={() => setVersionsOpen(false)}
          onRestored={() => { void reloadFromServer(); }}
        />
      ) : null}

      {membersOpen && mode === 'server' ? (
        <MembersDialog
          projectId={project.id}
          currentUserId={user?.id ?? ''}
          isAdmin={isAdmin}
          onClose={() => setMembersOpen(false)}
        />
      ) : null}

      {message && <div className="toast-message" role="status">{message}</div>}
    </main>
  );
}
