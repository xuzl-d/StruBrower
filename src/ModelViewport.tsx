import { useEffect, useRef } from 'react';
import {
  AmbientLight,
  Box3,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  Line,
  LineBasicMaterial,
  MOUSE,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  Scene,
  Sphere,
  SRGBColorSpace,
  DoubleSide,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { ViewSettings } from './settings';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { pickByScreenRect, rectFromPoints } from './view/boxSelect';
import { buildSnapCandidates, pickSnapCandidate, SNAP_LABELS } from './view/snapping';
import type { SnapCandidate } from './view/snapping';
import { buildElementGeometry } from './bim/geometry';
import { elementColor } from './bim/document';
import type { ProjectDocument, Vec2 } from './bim/types';

export type ViewKind = '3d' | 'plan';
export type Tool = 'select' | 'wall' | 'column' | 'slab' | 'grid';

interface ModelViewportProps {
  project: ProjectDocument;
  selection: string[];
  activeLevelId: string;
  viewKind: ViewKind;
  projection: 'perspective' | 'parallel';
  tool: Tool;
  draftStart: Vec2 | null;
  settings: ViewSettings;
  onRendererInfo?: (info: { renderer: string; software: boolean }) => void;
  onSelect: (id: string, additive: boolean) => void;
  onBoxSelect: (ids: string[], additive: boolean) => void;
  onContextAction: (action: 'select-all' | 'select-same-type' | 'clear', targetId: string | null) => void;
  onHover: (position: Vector3 | null) => void;
  onPickPoint: (point: Vec2) => void;
  fitElementId: string | null;
  zoomAllRequest: number;
  onClickEmpty: () => void;
}

function snap(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function disposeMaterial(material: Mesh | Line) {
  const list = Array.isArray(material.material) ? material.material : [material.material];
  for (const item of list) {
    const mapped = item as typeof item & { map?: { dispose?: () => void } | null };
    mapped.map?.dispose?.();
    item.dispose();
  }
}

function disposeObject(object: Mesh | Line): void {
  object.geometry.dispose();
  disposeMaterial(object);
}

function disposeGroup(group: Group): void {
  group.traverse((child) => {
    if (child instanceof Mesh || child instanceof Line) disposeObject(child);
  });
}

const GRID_BUBBLE_FONT = '700 128px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

/**
 * 轴网端部气泡：圆环 + 名称，绘制在一块水平面上（落在标高平面内），
 * 不面向屏幕，会被构件正常遮挡。
 */
function createGridBubble(label: string, color: string): Mesh {
  const fontSize = 128;
  const padding = 48;
  const measureCanvas = document.createElement('canvas');
  const measure = measureCanvas.getContext('2d');
  let textWidth = fontSize;
  if (measure) {
    measure.font = GRID_BUBBLE_FONT;
    textWidth = measure.measureText(label || '1').width;
  }
  const size = Math.max(256, Math.ceil(textWidth * 1.2 + padding * 2));

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.clearRect(0, 0, size, size);
    const center = size / 2;
    const radius = size / 2 - 8;
    context.beginPath();
    context.arc(center, center, radius, 0, Math.PI * 2);
    context.fillStyle = 'rgba(10, 18, 28, 0.72)';
    context.fill();
    context.lineWidth = Math.max(4, size * 0.022);
    context.strokeStyle = color;
    context.stroke();
    context.fillStyle = '#eaf7f4';
    context.font = GRID_BUBBLE_FONT;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label || '1', center, center + fontSize * 0.04);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  // 名称越长画布越大，按画布比例放大世界尺寸，保证文字大小一致
  const worldSize = Math.min(2.4, 1.1 * Math.max(1, size / 256));
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
  });
  const bubble = new Mesh(new PlaneGeometry(worldSize, worldSize), material);
  bubble.renderOrder = 1;
  return bubble;
}

function previewMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: '#69c0ff', transparent: true, opacity: 0.4, depthWrite: false });
}

export default function ModelViewport(props: ModelViewportProps) {
  const {
    project,
    selection,
    activeLevelId,
    viewKind,
    projection,
    tool,
    draftStart,
    settings,
    onRendererInfo,
    onSelect,
    onBoxSelect,
    onContextAction,
    onHover,
    onPickPoint,
    fitElementId,
    zoomAllRequest,
    onClickEmpty,
  } = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const modelsRef = useRef<Group | null>(null);
  const overlayRef = useRef<Group | null>(null);
  const previewRef = useRef<Group | null>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<PerspectiveCamera | OrthographicCamera | null>(null);
  const perspectiveRef = useRef<PerspectiveCamera | null>(null);
  const orthoRef = useRef<OrthographicCamera | null>(null);
  const axisLabelsRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef(new Vector3(0, 0, 1.5));
  const previousZoomAllRef = useRef(zoomAllRequest);
  const activeLevelZRef = useRef(0);
  const projectRef = useRef(project);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const rendererInfoRef = useRef(onRendererInfo);
  rendererInfoRef.current = onRendererInfo;
  const groundRef = useRef<GridHelper | null>(null);
  const needsRenderRef = useRef(true);
  const snapCandidatesRef = useRef<SnapCandidate[]>([]);
  const snapIndicatorRef = useRef<HTMLDivElement | null>(null);
  const softwareRendererRef = useRef(false);
  const orbitingRef = useRef(false);
  const interactionRef = useRef({ tool, draftStart, viewKind });
  const callbacksRef = useRef({ onSelect, onBoxSelect, onContextAction, onHover, onPickPoint, onClickEmpty });
  const selectionBoxRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const boxHintRef = useRef<HTMLDivElement | null>(null);
  const menuTargetRef = useRef<string | null>(null);
  const pressRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    additive: boolean;
    hitId: string | null;
  } | null>(null);
  const boxStateRef = useRef<{
    anchorX: number;
    anchorY: number;
    currentX: number;
    currentY: number;
    additive: boolean;
  } | null>(null);

  const activeLevelZ = project.levels.find((level) => level.id === activeLevelId)?.elevation ?? 0;
  activeLevelZRef.current = activeLevelZ;
  projectRef.current = project;
  interactionRef.current = { tool, draftStart, viewKind };
  callbacksRef.current = { onSelect, onBoxSelect, onContextAction, onHover, onPickPoint, onClickEmpty };

  /* 场景初始化（一次） */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new Scene();
    scene.background = new Color(settingsRef.current.backgroundColor);
    // 探测 GPU：服务器/虚拟机常常没有显卡，浏览器会退化为软件渲染（SwiftShader/llvmpipe）
    let gpuName = '';
    try {
      const probe = document.createElement('canvas');
      const probeGl = probe.getContext('webgl2') ?? probe.getContext('webgl');
      if (probeGl) {
        const debugInfo = probeGl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) gpuName = String(probeGl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '');
        probeGl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    } catch {
      // 忽略探测失败
    }
    const softwareRenderer = /swiftshader|llvmpipe|software|basic render|mesa offscreen/i.test(gpuName);
    rendererInfoRef.current?.({ renderer: gpuName || '未知', software: softwareRenderer });
    softwareRendererRef.current = softwareRenderer;

    const renderer = new WebGLRenderer({ antialias: !softwareRenderer, powerPreference: 'high-performance' });
    renderer.setPixelRatio(softwareRenderer ? 1 : Math.min(window.devicePixelRatio, 1.5));
    host.appendChild(renderer.domElement);

    const perspective = new PerspectiveCamera(45, 1, 0.1, 3000);
    perspective.up.set(0, 0, 1);
    perspective.position.set(14, -16, 12);
    perspective.lookAt(new Vector3(0, 0, 1.5));
    const ortho = new OrthographicCamera(-10, 10, 10, -10, 0.1, 3000);
    ortho.up.set(0, 0, 1);
    ortho.position.copy(perspective.position);
    ortho.lookAt(new Vector3(0, 0, 1.5));
    perspectiveRef.current = perspective;
    orthoRef.current = ortho;
    cameraRef.current = perspective;

    scene.add(new AmbientLight('#ffffff', 1.75));
    const keyLight = new DirectionalLight('#ffffff', 2.5);
    keyLight.position.set(10, -12, 18);
    scene.add(keyLight);
    const fillLight = new DirectionalLight('#cfe0ff', 0.85);
    fillLight.position.set(-14, 10, 6);
    scene.add(fillLight);

    const ground = new GridHelper(120, 120, '#3b4a60', '#243044');
    ground.rotation.x = Math.PI / 2;
    ground.position.z = -0.01;
    ground.visible = settingsRef.current.showGroundGrid;
    scene.add(ground);
    groundRef.current = ground;

    const overlay = new Group();
    const models = new Group();
    const preview = new Group();
    scene.add(overlay, models, preview);
    overlayRef.current = overlay;
    modelsRef.current = models;
    previewRef.current = preview;
    sceneRef.current = scene;
    rendererRef.current = renderer;

    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      renderer.setSize(width, height, false);
      perspective.aspect = width / height;
      perspective.updateProjectionMatrix();
      const viewHeight = ortho.top - ortho.bottom;
      const aspect = width / height;
      ortho.left = (-viewHeight * aspect) / 2;
      ortho.right = (viewHeight * aspect) / 2;
      ortho.updateProjectionMatrix();
      needsRenderRef.current = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const workPlane = new Plane(new Vector3(0, 0, 1), 0);
    const tmp = new Vector3();

    const selectionBox = document.createElement('div');
    selectionBox.className = 'selection-box';
    host.appendChild(selectionBox);
    selectionBoxRef.current = selectionBox;

    const boxHint = document.createElement('div');
    boxHint.className = 'box-hint';
    boxHint.textContent = '框选中：再次单击完成 · Esc 取消';
    boxHint.style.display = 'none';
    host.appendChild(boxHint);
    boxHintRef.current = boxHint;

    const contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    contextMenu.style.display = 'none';
    contextMenu.innerHTML = [
      '<button data-action="select-all">选择所有</button>',
      '<button data-action="select-same-type">选择同类型</button>',
      '<button data-action="clear">取消选择</button>',
    ].join('');
    host.appendChild(contextMenu);
    contextMenuRef.current = contextMenu;
    contextMenu.addEventListener('click', (event) => {
      const element = (event.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      const action = element?.dataset.action as 'select-all' | 'select-same-type' | 'clear' | undefined;
      if (!action) return;
      const targetId = menuTargetRef.current;
      hideMenu();
      callbacksRef.current.onContextAction(action, targetId);
    });

    const hostRect = () => host.getBoundingClientRect();

    const hideMenu = () => {
      if (contextMenuRef.current) contextMenuRef.current.style.display = 'none';
      menuTargetRef.current = null;
    };

    const showMenu = (clientX: number, clientY: number, targetId: string | null) => {
      const menu = contextMenuRef.current;
      if (!menu) return;
      menuTargetRef.current = targetId;
      menu.style.display = 'flex';
      const rect = hostRect();
      const left = Math.min(Math.max(4, clientX - rect.left), Math.max(4, rect.width - menu.offsetWidth - 4));
      const top = Math.min(Math.max(4, clientY - rect.top), Math.max(4, rect.height - menu.offsetHeight - 4));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      const sameType = menu.querySelector<HTMLButtonElement>('[data-action="select-same-type"]');
      if (sameType) sameType.disabled = !targetId;
    };

    const setBoxMode = (active: boolean) => {
      const controls = controlsRef.current;
      if (!controls) return;
      controls.enableRotate = !active && interactionRef.current.viewKind === '3d';
    };

    const updateSelectionBox = () => {
      const state = boxStateRef.current;
      const box = selectionBoxRef.current;
      if (!state || !box) return;
      const rect = hostRect();
      box.style.left = `${Math.min(state.anchorX, state.currentX) - rect.left}px`;
      box.style.top = `${Math.min(state.anchorY, state.currentY) - rect.top}px`;
      box.style.width = `${Math.abs(state.currentX - state.anchorX)}px`;
      box.style.height = `${Math.abs(state.currentY - state.anchorY)}px`;
      box.style.display = 'block';
      box.classList.toggle('crossing', state.currentX < state.anchorX);
    };

    const startBox = (clientX: number, clientY: number, additive: boolean) => {
      boxStateRef.current = { anchorX: clientX, anchorY: clientY, currentX: clientX, currentY: clientY, additive };
      setBoxMode(true);
      if (boxHintRef.current) boxHintRef.current.style.display = 'block';
      updateSelectionBox();
    };

    const cancelBox = () => {
      if (!boxStateRef.current) return;
      boxStateRef.current = null;
      if (selectionBoxRef.current) selectionBoxRef.current.style.display = 'none';
      if (boxHintRef.current) boxHintRef.current.style.display = 'none';
      setBoxMode(false);
    };

    const completeBox = () => {
      const state = boxStateRef.current;
      if (!state) return;
      boxStateRef.current = null;
      if (selectionBoxRef.current) selectionBoxRef.current.style.display = 'none';
      if (boxHintRef.current) boxHintRef.current.style.display = 'none';
      setBoxMode(false);
      const rect = hostRect();
      const screen = rectFromPoints(
        state.anchorX - rect.left,
        state.anchorY - rect.top,
        state.currentX - rect.left,
        state.currentY - rect.top,
      );
      const mode = state.currentX >= state.anchorX ? 'window' : 'crossing';
      const camera = cameraRef.current;
      if (!camera) return;
      // 几乎为零的框视为空选择（两次点击间距过小）
      if (screen.maxX - screen.minX < 3 || screen.maxY - screen.minY < 3) {
        callbacksRef.current.onBoxSelect([], state.additive);
        return;
      }
      const entries = models.children
        .filter((child): child is Mesh => child instanceof Mesh && typeof child.userData.elementId === 'string')
        .map((child) => ({ id: child.userData.elementId as string, box: new Box3().setFromObject(child) }));
      const ids = pickByScreenRect(entries, camera, { width: rect.width, height: rect.height }, screen, mode);
      callbacksRef.current.onBoxSelect(ids, state.additive);
    };

    const projectPoint = (event: { clientX: number; clientY: number }): { ray: Raycaster } | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const camera = cameraRef.current;
      if (!camera) return null;
      raycaster.setFromCamera(pointer, camera);
      return { ray: raycaster };
    };

    const planePoint = (ray: Raycaster): Vec2 | null => {
      workPlane.constant = -activeLevelZRef.current;
      if (!ray.ray.intersectPlane(workPlane, tmp)) return null;
      return [tmp.x, tmp.y];
    };

    /* ---------- 对象捕捉 ---------- */
    const snapTmp = new Vector3();
    const screenOf = (camera: PerspectiveCamera | OrthographicCamera, point: [number, number]) => {
      const rect = renderer.domElement.getBoundingClientRect();
      snapTmp.set(point[0], point[1], activeLevelZRef.current).project(camera);
      if (snapTmp.z < -1 || snapTmp.z > 1) return null;
      return {
        x: rect.left + (snapTmp.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-snapTmp.y * 0.5 + 0.5) * rect.height,
      };
    };
    const hideSnap = () => {
      const indicator = snapIndicatorRef.current;
      if (indicator) indicator.style.display = 'none';
    };
    const showSnap = (screen: { x: number; y: number }, label: string) => {
      const indicator = snapIndicatorRef.current;
      if (!indicator) return;
      const rect = host.getBoundingClientRect();
      indicator.style.display = 'block';
      indicator.style.left = `${screen.x - rect.left}px`;
      indicator.style.top = `${screen.y - rect.top}px`;
      const text = indicator.querySelector<HTMLElement>('.snap-label');
      if (text) text.textContent = label;
    };
    const applySnap = (event: PointerEvent, point: Vec2): Vec2 => {
      const active = settingsRef.current;
      const camera = cameraRef.current;
      if (active.objectSnap && camera && interactionRef.current.tool !== 'select') {
        const best = pickSnapCandidate(
          snapCandidatesRef.current,
          (candidate) => screenOf(camera, candidate),
          { x: event.clientX, y: event.clientY },
        );
        if (best) {
          showSnap(best.screen, SNAP_LABELS[best.candidate.kind]);
          return best.candidate.point;
        }
      }
      hideSnap();
      if (!active.gridSnap) return point;
      const step = active.snapStep;
      return [snap(point[0], step), snap(point[1], step)];
    };

    let lastHoverAt = 0;
    const handlePointerMove = (event: PointerEvent) => {
      const hit = projectPoint(event);
      if (!hit) return;

      const box = boxStateRef.current;
      if (box) {
        box.currentX = event.clientX;
        box.currentY = event.clientY;
        updateSelectionBox();
      }
      const press = pressRef.current;
      if (press && press.pointerId === event.pointerId && !press.moved) {
        if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > 4) press.moved = true;
      }

      // 拖动旋转/平移期间不做 hover 与预览，避免整棵 React 树 20fps 重渲染
      if (orbitingRef.current) {
        hideSnap();
        return;
      }

      const raw = planePoint(hit.ray);
      const point = raw ? applySnap(event, raw) : null;
      // 坐标读数 20fps 足够
      const now = performance.now();
      if (now - lastHoverAt > 45) {
        lastHoverAt = now;
        callbacksRef.current.onHover(point ? new Vector3(point[0], point[1], activeLevelZRef.current) : null);
      }
      if (interactionRef.current.tool !== 'select') updatePreview(point);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      hideMenu();
      const hit = projectPoint(event);
      if (!hit) return;
      if (interactionRef.current.tool !== 'select') {
        const raw = planePoint(hit.ray);
        if (raw) callbacksRef.current.onPickPoint(applySnap(event, raw));
        return;
      }
      const hits = hit.ray.intersectObjects(models.children, false);
      pressRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        additive: event.shiftKey || event.ctrlKey || event.metaKey,
        hitId: (hits[0]?.object.userData.elementId as string | undefined) ?? null,
      };
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const press = pressRef.current;
      pressRef.current = null;
      const additive = press?.additive ?? false;

      // 框选进行中：本次点击作为“完成”
      if (boxStateRef.current) {
        const box = boxStateRef.current;
        box.currentX = event.clientX;
        box.currentY = event.clientY;
        const tiny = Math.abs(box.currentX - box.anchorX) < 4 && Math.abs(box.currentY - box.anchorY) < 4;
        if (tiny) {
          // 几乎没移动又点中构件：视为点选，避免“先点空白再点构件”被误判成空框
          const hit = projectPoint(event);
          const hits = hit ? hit.ray.intersectObjects(models.children, false) : [];
          const id = hits[0]?.object.userData.elementId as string | undefined;
          if (id) {
            cancelBox();
            callbacksRef.current.onSelect(id, box.additive || additive);
            return;
          }
        }
        box.additive = box.additive || additive;
        completeBox();
        return;
      }

      if (!press) return;
      const moved = press.moved || Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > 4;
      if (moved) return; // 左键拖拽 = 旋转视角
      if (press.hitId) {
        callbacksRef.current.onSelect(press.hitId, additive);
      } else {
        startBox(event.clientX, event.clientY, additive);
      }
    };

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      hideMenu();
      cancelBox();
      const hit = projectPoint(event);
      const hits = hit ? hit.ray.intersectObjects(models.children, false) : [];
      const targetId = (hits[0]?.object.userData.elementId as string | undefined) ?? null;
      if (targetId) callbacksRef.current.onSelect(targetId, false);
      showMenu(event.clientX, event.clientY, targetId);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      cancelBox();
      hideMenu();
    };

    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);
    renderer.domElement.addEventListener('contextmenu', handleContextMenu);
    renderer.domElement.addEventListener('pointerleave', hideSnap);
    window.addEventListener('keydown', handleKeyDown);


    let frame = 0;
    const render = () => {
      controlsRef.current?.update();
      const camera = cameraRef.current;
      if (camera && needsRenderRef.current) {
        renderer.render(scene, camera);
        updateAxisIndicator(axisLabelsRef.current, camera);
        needsRenderRef.current = false;
      }
      frame = requestAnimationFrame(render);
    };
    render();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      renderer.domElement.removeEventListener('contextmenu', handleContextMenu);
      renderer.domElement.removeEventListener('pointerleave', hideSnap);
      window.removeEventListener('keydown', handleKeyDown);
      selectionBox.remove();
      boxHint.remove();
      contextMenu.remove();
      selectionBoxRef.current = null;
      boxHintRef.current = null;
      contextMenuRef.current = null;
      menuTargetRef.current = null;
      pressRef.current = null;
      boxStateRef.current = null;
      controlsRef.current?.dispose();
      disposeGroup(models);
      disposeGroup(overlay);
      disposeGroup(preview);
      renderer.dispose();
      host.removeChild(renderer.domElement);
      sceneRef.current = null;
      modelsRef.current = null;
      overlayRef.current = null;
      previewRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
      cameraRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 构件网格重建 */
  useEffect(() => {
    const models = modelsRef.current;
    if (!models) return;
    disposeGroup(models);
    models.clear();
    for (const element of project.elements) {
      if (!element.visible) continue;
      const geometry = buildElementGeometry(project, element);
      if (!geometry) continue;
      const vertexColors = element.category === 'mesh' ? element.vertexColors : undefined;
      const material = new MeshStandardMaterial({
        color: vertexColors ? '#ffffff' : elementColor(project, element),
        vertexColors: Boolean(vertexColors),
        roughness: 0.62,
        metalness: 0.04,
      });
      const mesh = new Mesh(geometry, material);
      mesh.userData.elementId = element.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      models.add(mesh);
    }
    applySelection(models, selection, settingsRef.current.highlightColor);
  }, [project]);

  /* 背景色 / 地面网格显示 */
  useEffect(() => {
    const scene = sceneRef.current;
    if (scene) scene.background = new Color(settings.backgroundColor);
  }, [settings.backgroundColor]);

  useEffect(() => {
    if (groundRef.current) groundRef.current.visible = settings.showGroundGrid;
  }, [settings.showGroundGrid]);

  /* 选择高亮 */
  useEffect(() => {
    const models = modelsRef.current;
    if (models) applySelection(models, selection, settings.highlightColor);
  }, [selection, settings.highlightColor]);

  /* 轴网与标高工作平面 */
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    disposeGroup(overlay);
    overlay.clear();

    if (settings.showLevelGrid) {
      const levelGrid = new GridHelper(60, 60, '#4f7fb5', '#2b3b52');
      levelGrid.rotation.x = Math.PI / 2;
      levelGrid.position.z = activeLevelZ + 0.004;
      const gridMaterial = levelGrid.material as LineBasicMaterial;
      gridMaterial.transparent = true;
      gridMaterial.opacity = 0.45;
      overlay.add(levelGrid);
    }

    if (!settings.showGrids) return;
    for (const grid of project.grids) {
      const geometry = new BufferGeometry().setFromPoints([
        new Vector3(grid.start[0], grid.start[1], activeLevelZ + 0.01),
        new Vector3(grid.end[0], grid.end[1], activeLevelZ + 0.01),
      ]);
      overlay.add(new Line(geometry, new LineBasicMaterial({ color: settings.gridColor })));
      if (!settings.showBubbles) continue;
      for (const point of [grid.start, grid.end]) {
        const bubble = createGridBubble(grid.name, settings.bubbleColor);
        bubble.position.set(point[0], point[1], activeLevelZ + 0.03);
        overlay.add(bubble);
      }
    }
  }, [
    project.grids,
    activeLevelZ,
    settings.showLevelGrid,
    settings.showGrids,
    settings.showBubbles,
    settings.gridColor,
    settings.bubbleColor,
  ]);

  /* 相机模式切换（三维 / 平面，透视 / 平行） */
  useEffect(() => {
    const renderer = rendererRef.current;
    const perspective = perspectiveRef.current;
    const ortho = orthoRef.current;
    if (!renderer || !perspective || !ortho) return;
    controlsRef.current?.dispose();
    const host = hostRef.current;
    const aspect = host && host.clientHeight > 0 ? host.clientWidth / host.clientHeight : 1;
    const planMode = viewKind === 'plan';
    const camera: PerspectiveCamera | OrthographicCamera = planMode || projection === 'parallel' ? ortho : perspective;
    cameraRef.current = camera;

    if (planMode) {
      camera.up.set(0, 1, 0);
      const bounds = new Box3().setFromObject(modelsRef.current ?? new Group());
      const extent = bounds.isEmpty()
        ? 20
        : Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, 8) * 1.3;
      camera.position.set(targetRef.current.x, targetRef.current.y, activeLevelZRef.current + extent * 2);
      camera.lookAt(new Vector3(targetRef.current.x, targetRef.current.y, activeLevelZRef.current));
      ortho.top = extent / 2;
      ortho.bottom = -extent / 2;
      ortho.left = (-extent * aspect) / 2;
      ortho.right = (extent * aspect) / 2;
      ortho.near = 0.1;
      ortho.far = extent * 40;
      ortho.updateProjectionMatrix();
    } else {
      camera.up.set(0, 0, 1);
      const direction = new Vector3(1, -1.15, 0.85).normalize();
      if (camera instanceof OrthographicCamera) {
        camera.position.copy(targetRef.current).addScaledVector(direction, 40);
        camera.lookAt(targetRef.current);
        camera.top = 9;
        camera.bottom = -9;
        camera.left = (-18 * aspect) / 2;
        camera.right = (18 * aspect) / 2;
        camera.near = 0.1;
        camera.far = 500;
      } else {
        camera.position.copy(targetRef.current).addScaledVector(direction, 26);
        camera.lookAt(targetRef.current);
        camera.near = 0.1;
        camera.far = 2000;
      }
      camera.updateProjectionMatrix();
    }

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = settingsRef.current.rotateDamping;
    controls.target.copy(planMode
      ? new Vector3(targetRef.current.x, targetRef.current.y, activeLevelZRef.current)
      : targetRef.current);
    controls.addEventListener('change', () => {
      targetRef.current.copy(controls.target);
      needsRenderRef.current = true;
    });
    controls.addEventListener('start', () => { orbitingRef.current = true; });
    controls.addEventListener('end', () => { orbitingRef.current = false; });
    // 左键用于点选/框选；右键旋转；中键平移；滚轮缩放
    // 左键拖拽旋转、中键平移、右键弹菜单（框选用“单击-移动-再单击”）
    controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: null };
    controls.enableRotate = !planMode && !boxStateRef.current;
    controls.update();
    controlsRef.current = controls;
  }, [viewKind, projection]);

  /* 工具/视图切换：清掉绘制预览与进行中的框选 */
  useEffect(() => {
    disposeGroup(previewRef.current ?? new Group());
    previewRef.current?.clear();
    boxStateRef.current = null;
    pressRef.current = null;
    if (selectionBoxRef.current) selectionBoxRef.current.style.display = 'none';
    if (boxHintRef.current) boxHintRef.current.style.display = 'none';
    if (contextMenuRef.current) contextMenuRef.current.style.display = 'none';
    const controls = controlsRef.current;
    if (controls) controls.enableRotate = viewKind === '3d';
  }, [tool, viewKind]);

  /* 缩放至全部 / 定位到构件 */
  useEffect(() => {
    const models = modelsRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!models || !camera || !controls) return;
    const zoomAll = zoomAllRequest !== previousZoomAllRef.current;
    previousZoomAllRef.current = zoomAllRequest;
    if (!zoomAll && !fitElementId) return;

    const targetMesh = fitElementId
      ? models.children.find((child) => child.userData.elementId === fitElementId)
      : null;
    const bounds = targetMesh ? new Box3().setFromObject(targetMesh) : new Box3().setFromObject(models);
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new Vector3());
    const sphere = bounds.getBoundingSphere(new Sphere());
    targetRef.current.copy(center);
    const host = hostRef.current;
    const aspect = host && host.clientHeight > 0 ? host.clientWidth / host.clientHeight : 1;

    if (viewKind === 'plan') {
      const halfHeight = Math.max(sphere.radius * 1.3, 2);
      controls.target.set(center.x, center.y, activeLevelZ);
      camera.position.set(center.x, center.y, activeLevelZ + halfHeight * 6);
      camera.up.set(0, 1, 0);
      camera.lookAt(new Vector3(center.x, center.y, activeLevelZ));
      if (camera instanceof OrthographicCamera) {
        camera.top = halfHeight;
        camera.bottom = -halfHeight;
        camera.left = -halfHeight * aspect;
        camera.right = halfHeight * aspect;
        camera.near = 0.1;
        camera.far = halfHeight * 60;
        camera.updateProjectionMatrix();
      }
    } else {
      camera.up.set(0, 0, 1);
      controls.target.copy(center);
      const direction = camera.position.clone().sub(center).normalize();
      if (camera instanceof PerspectiveCamera) {
        const verticalHalf = (camera.fov * Math.PI) / 360;
        const horizontalHalf = Math.atan(Math.tan(verticalHalf) * aspect);
        const distance = Math.max(sphere.radius / Math.sin(Math.min(verticalHalf, horizontalHalf)) * 1.2, 2);
        camera.position.copy(center).addScaledVector(direction, distance);
        camera.near = Math.max(distance - sphere.radius * 3, 0.05);
        camera.far = Math.max(distance + sphere.radius * 6, 500);
      } else {
        const halfHeight = Math.max(sphere.radius * 1.2, 1);
        camera.position.copy(center).addScaledVector(direction, Math.max(sphere.radius * 5, 20));
        camera.top = halfHeight;
        camera.bottom = -halfHeight;
        camera.left = -halfHeight * aspect;
        camera.right = halfHeight * aspect;
        camera.near = 0.05;
        camera.far = Math.max(sphere.radius * 60, 400);
      }
      camera.updateProjectionMatrix();
    }
    controls.update();
  }, [fitElementId, zoomAllRequest, viewKind, activeLevelZ]);

  useEffect(() => {
    needsRenderRef.current = true;
  });

  useEffect(() => {
    snapCandidatesRef.current = buildSnapCandidates(project);
  }, [project.elements, project.grids, project.types]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (controls) controls.enableDamping = settings.rotateDamping;
    needsRenderRef.current = true;
  }, [settings.rotateDamping]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const host = hostRef.current;
    if (!renderer || !host) return;
    const base = softwareRendererRef.current ? 1 : Math.min(window.devicePixelRatio, 1.5);
    renderer.setPixelRatio(Math.max(0.5, base * settings.renderScale));
    const { width, height } = host.getBoundingClientRect();
    if (width > 0 && height > 0) renderer.setSize(width, height, false);
    needsRenderRef.current = true;
  }, [settings.renderScale]);

  useEffect(() => {
    if (snapIndicatorRef.current) snapIndicatorRef.current.style.display = 'none';
  }, [tool, viewKind]);

  return (
    <div className={`viewport-host tool-${tool} ${viewKind === 'plan' ? 'is-plan' : ''}`} ref={hostRef} aria-label="BIM 视口">
      <div className="snap-indicator" ref={snapIndicatorRef} aria-hidden="true">
        <span className="snap-dot" />
        <span className="snap-label" />
      </div>
      {settings.showAxisIndicator ? <div className="axis-indicator" ref={axisLabelsRef} aria-label="空间坐标系">
        <span className="axis-origin" />
        <span className="axis-arm axis-x" data-axis-arm="x" />
        <span className="axis-arm axis-y" data-axis-arm="y" />
        <span className="axis-arm axis-z" data-axis-arm="z" />
        <span className="axis-label axis-x" data-axis="x">X</span>
        <span className="axis-label axis-y" data-axis="y">Y</span>
        <span className="axis-label axis-z" data-axis="z">Z</span>
      </div> : null}
    </div>
  );

  function updatePreview(point: Vec2 | null): void {
    const preview = previewRef.current;
    if (!preview) return;
    needsRenderRef.current = true;
    disposeGroup(preview);
    preview.clear();
    const { tool: activeTool, draftStart: start } = interactionRef.current;
    if (!point || activeTool === 'select') return;
    const levelZ = activeLevelZRef.current;
    const doc = projectRef.current;

    if (activeTool === 'column') {
      const columnType = doc.types.find((item) => item.category === 'column');
      if (columnType?.category !== 'column') return;
      const mesh = new Mesh(new BoxGeometry(columnType.width, columnType.depth, 0.06), previewMaterial());
      mesh.position.set(point[0], point[1], levelZ + 0.03);
      preview.add(mesh);
      return;
    }

    if (!start) return;

    if (activeTool === 'wall') {
      const wallType = doc.types.find((item) => item.category === 'wall');
      const thickness = wallType?.category === 'wall' ? wallType.thickness : 0.2;
      const length = Math.hypot(point[0] - start[0], point[1] - start[1]);
      if (length < 0.02) return;
      const mesh = new Mesh(new BoxGeometry(length, thickness, 0.07), previewMaterial());
      mesh.rotation.z = Math.atan2(point[1] - start[1], point[0] - start[0]);
      mesh.position.set((start[0] + point[0]) / 2, (start[1] + point[1]) / 2, levelZ + 0.035);
      preview.add(mesh);
      return;
    }

    if (activeTool === 'slab') {
      const width = Math.abs(point[0] - start[0]);
      const depth = Math.abs(point[1] - start[1]);
      if (width < 0.05 || depth < 0.05) return;
      const mesh = new Mesh(new BoxGeometry(width, depth, 0.06), previewMaterial());
      mesh.position.set((start[0] + point[0]) / 2, (start[1] + point[1]) / 2, levelZ + 0.03);
      preview.add(mesh);
      return;
    }

    if (activeTool === 'grid') {
      const geometry = new BufferGeometry().setFromPoints([
        new Vector3(start[0], start[1], levelZ + 0.02),
        new Vector3(point[0], point[1], levelZ + 0.02),
      ]);
      preview.add(new Line(geometry, new LineBasicMaterial({ color: '#ffd479' })));
    }
  }
}

function applySelection(models: Group, selection: string[], color: string): void {
  const selected = new Set(selection);
  models.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const material = child.material;
    if (!(material instanceof MeshStandardMaterial)) return;
    const isSelected = selected.has(child.userData.elementId as string);
    material.emissive.set(isSelected ? color : '#000000');
    material.emissiveIntensity = isSelected ? 0.45 : 0;
  });
}

function updateAxisIndicator(
  container: HTMLElement | null,
  camera: PerspectiveCamera | OrthographicCamera | null,
): void {
  if (!container || !camera) return;
  const axes = [
    { key: 'x', direction: new Vector3(1, 0, 0) },
    { key: 'y', direction: new Vector3(0, 1, 0) },
    { key: 'z', direction: new Vector3(0, 0, 1) },
  ];
  for (const axis of axes) {
    const label = container.querySelector<HTMLElement>(`[data-axis="${axis.key}"]`);
    const arm = container.querySelector<HTMLElement>(`[data-axis-arm="${axis.key}"]`);
    if (!label || !arm) continue;
    const direction = axis.direction.clone().applyQuaternion(camera.quaternion.clone().invert());
    const screenLength = Math.hypot(direction.x, -direction.y);
    const unitX = screenLength > 0.001 ? direction.x / screenLength : 0;
    const unitY = screenLength > 0.001 ? -direction.y / screenLength : 0;
    arm.style.transform = `rotate(${Math.atan2(unitY, unitX) * (180 / Math.PI)}deg)`;
    label.style.transform = `translate(${unitX * 28}px, ${unitY * 28}px)`;
    label.style.opacity = direction.z > 0 ? '1' : '0.42';
  }
}
