import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
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
  Matrix4,
  MOUSE,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  Scene,
  Sphere,
  SphereGeometry,
  SRGBColorSpace,
  DoubleSide,
  Vector2,
  Vector3,
  WebGLRenderer,
  ACESFilmicToneMapping,
} from 'three';
import type { Object3D } from 'three';
import type { ViewSettings } from './settings';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { pickByScreenRect, rectFromPoints } from './view/boxSelect';
import { buildSnapCandidates, pickSnapCandidate, SNAP_LABELS } from './view/snapping';
import type { SnapCandidate } from './view/snapping';
import { buildElementModel } from './bim/geometry';
import { buildPrimitiveGeometry, defaultPrimitive } from './bim/primitives';
import type { PrimitiveKind } from './bim/primitives';
import { modifyPreview, transformParams } from './bim/modify';
import type { ModifyClick, ModifySession, PreviewSpec } from './bim/modify';
import { colorLockOf, effectiveSurface, isElementVisible } from './bim/layers';
import { cameraAngles, directionFromAngles, frameCamera } from './bim/viewFrame';
import type { ProjectDocument, SolidMaterial, Vec2 } from './bim/types';

export type ViewKind = '3d' | 'plan';
export type Tool = 'select' | 'wall' | 'column' | 'slab' | 'grid' | 'primitive';
/** 视角立方体可切换的标准视角；仍在三维视图里，只是相机朝向改变 */
export type ViewPreset = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

/** 立方体 8 个角点（世界坐标，±1），用于正交投影成 SVG 多边形 */
const CUBE_CORNERS: Array<[number, number, number]> = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];

/** 六个面：法线指向面外侧；front 为 -Y（南），left 为 -X（西），top 为 +Z */
const CUBE_FACES: Array<{ key: ViewPreset; label: string; title: string; normal: [number, number, number]; corners: number[] }> = [
  { key: 'top', label: '顶', title: '顶视图', normal: [0, 0, 1], corners: [4, 5, 6, 7] },
  { key: 'bottom', label: '底', title: '底视图', normal: [0, 0, -1], corners: [0, 3, 2, 1] },
  { key: 'front', label: '前', title: '前视图（南立面）', normal: [0, -1, 0], corners: [0, 1, 5, 4] },
  { key: 'back', label: '后', title: '后视图（北立面）', normal: [0, 1, 0], corners: [2, 3, 7, 6] },
  { key: 'left', label: '左', title: '左视图（西立面）', normal: [-1, 0, 0], corners: [3, 0, 4, 7] },
  { key: 'right', label: '右', title: '右视图（东立面）', normal: [1, 0, 0], corners: [1, 2, 6, 5] },
];

/** 各标准视角的相机方向（target → 相机） */
function presetDirection(preset: ViewPreset): Vector3 {
  switch (preset) {
    case 'top': return new Vector3(0, 0, 1);
    case 'bottom': return new Vector3(0, 0, -1);
    case 'front': return new Vector3(0, -1, 0);
    case 'back': return new Vector3(0, 1, 0);
    case 'left': return new Vector3(-1, 0, 0);
    case 'right': return new Vector3(1, 0, 0);
    default: return new Vector3(1, -1.15, 0.85).normalize();
  }
}

/** AI 巡检时要求的角度：预设视角，或自定义方位角/仰角（度） */
export interface ViewLookRequest {
  view?: 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
  azimuth?: number;
  elevation?: number;
  /** 只框住这个名字 / id 的构件（大小写不敏感，先精确后包含）；找不到就退回整机 */
  focus?: string;
  /** 取景倍数：1 = 整机框满，2 = 推进一倍，0.5 = 退远一半 */
  zoom?: number;
}

/**
 * 交给上层的视口控制接口（AI 助手「操作软件」的那部分）：
 * 截图、转到指定视角、读当前相机、缩放至全部。
 */
export interface ViewportApi {
  capture: () => string | null;
  /** 立即切到指定视角（无补间，方便马上截图）；失败返回 false */
  look: (request: ViewLookRequest) => boolean;
  /** 当前相机（相对观察点的方位角/仰角/距离），用于告诉模型「现在是什么角度」 */
  camera: () => { azimuth: number; elevation: number; distance: number } | null;
  /** 缩放至全部构件，保持当前朝向 */
  fitAll: () => boolean;
}

/** 把「方位角/仰角」换成相机方向：实现见 bim/viewFrame（可单测的纯计算） */

interface ModelViewportProps {
  project: ProjectDocument;
  selection: string[];
  activeLevelId: string;
  viewKind: ViewKind;
  projection: 'perspective' | 'parallel';
  tool: Tool;
  draftStart: Vec2 | null;
  primitiveKind: PrimitiveKind | null;
  settings: ViewSettings;
  modify: ModifySession | null;
  onRendererInfo?: (info: { renderer: string; software: boolean }) => void;
  onSelect: (id: string, additive: boolean) => void;
  onBoxSelect: (ids: string[], additive: boolean) => void;
  onContextAction: (action: 'select-all' | 'select-same-type' | 'clear' | 'cancel' | 'finish', targetId: string | null) => void;
  onHover: (position: Vector3 | null) => void;
  onPickPoint: (point: Vec2) => void;
  onModifyClick: (click: ModifyClick) => void;
  onDragMove: (dx: number, dy: number, copy: boolean, ids: string[]) => void;
  fitElementId: string | null;
  zoomAllRequest: number;
  onClickEmpty: () => void;
  /**
   * 把视口控制能力交给上层（AI 助手用）：截图、转到 AI 指定的视角、读当前相机角度。
   * AI 因此能「自己转着看」模型，而不是只凭特征树的数字猜。
   * 组件卸载/重建时回传 null，调用方据此清掉引用。
   */
  onViewportApi?: (api: ViewportApi | null) => void;
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

/**
 * 特征材质 → MeshStandardMaterial。
 * - entry 为空（null）表示这一个零件跟随构件材质（材质浏览器指派的那个）；
 * - 图层颜色替换 / 类别颜色替换打开时 lockedColor 为真，颜色让位给替换色，
 *   但粗糙度 / 金属度仍然按零件走，这样「看颜色找构件」和「看质感」两件事不打架。
 */
function featureMaterial(
  entry: SolidMaterial | null,
  surface: { color: string; opacity: number; roughness: number; metalness: number },
  lockedColor: boolean,
): MeshStandardMaterial {
  const opacity = Math.min(1, Math.max(0.04, ((entry?.opacity ?? 100) / 100) * surface.opacity));
  return new MeshStandardMaterial({
    color: !lockedColor && entry?.color ? entry.color : surface.color,
    roughness: entry?.roughness ?? surface.roughness,
    metalness: entry?.metalness ?? surface.metalness,
    transparent: opacity < 0.999,
    opacity,
    depthWrite: opacity >= 0.999,
  });
}

/**
 * 贴花材质：把文字 / 图片画进 canvas 当贴图，用 MeshBasicMaterial 直接铺在平面上。
 *
 * 为什么不用 PBR：贴花是"涂装"不是"零件"，跟着光照变暗会显得脏；也不写深度，
 * 避免和机身表面 z-fighting（摆放时再抬高 1–2 cm 即可）。
 */
function decalMaterial(
  spec: { width: number; height: number; text?: string; image?: string; color?: string; background?: string; font?: string },
  opacity: number,
): MeshBasicMaterial {
  const aspect = Math.max(0.05, (spec.width || 1) / Math.max(0.01, spec.height || 1));
  const height = 256;
  const width = Math.round(Math.min(2048, Math.max(64, height * aspect)));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) {
    context.clearRect(0, 0, width, height);
    if (spec.background) {
      context.fillStyle = spec.background;
      context.fillRect(0, 0, width, height);
    }
    if (spec.text) {
      const font = spec.font ?? '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';
      let size = Math.round(height * 0.62);
      context.font = `700 ${size}px ${font}`;
      const measured = context.measureText(spec.text).width;
      if (measured > width * 0.92) {
        size = Math.max(8, Math.floor((size * width * 0.92) / measured));
        context.font = `700 ${size}px ${font}`;
      }
      context.fillStyle = spec.color ?? '#ffffff';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(spec.text, width / 2, height / 2 + size * 0.04);
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
    opacity,
  });

  // 图片贴花：data URL 异步解码，回来后重画到同一张 canvas
  if (!spec.text && spec.image) {
    const image = new Image();
    image.onload = () => {
      if (!context) return;
      context.clearRect(0, 0, width, height);
      if (spec.background) {
        context.fillStyle = spec.background;
        context.fillRect(0, 0, width, height);
      }
      const scale = Math.min(width / image.width, height / image.height);
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
      texture.needsUpdate = true;
    };
    image.src = spec.image;
  }

  return material;
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
    primitiveKind,
    settings,
    modify,
    onRendererInfo,
    onSelect,
    onBoxSelect,
    onContextAction,
    onHover,
    onPickPoint,
    onModifyClick,
    onDragMove,
    fitElementId,
    zoomAllRequest,
    onClickEmpty,
    onViewportApi,
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
  const axisLabelsRef = useRef<SVGSVGElement>(null);
  const viewCubeRef = useRef<SVGSVGElement>(null);
  /** 视角立方体上拖拽旋转：直接复用主视口的轨道旋转 */
  const orbitByRef = useRef<((theta: number, phi: number) => void) | null>(null);
  const cubeDragRef = useRef<{ pointerId: number; lastX: number; lastY: number; moved: boolean } | null>(null);
  /** 拖拽结束后的那次 click 不应再触发「切到该面」 */
  const cubeSuppressClickRef = useRef(false);
  /** 视角切换入口（由相机初始化处赋值），供立方体与快捷键调用 */
  const viewPresetRef = useRef<((preset: ViewPreset) => void) | null>(null);
  /** 视角切换的相机补间：quaternion slerp + 固定观察距离 */
  const viewTweenRef = useRef<{
    from: Quaternion;
    to: Quaternion;
    start: number;
    duration: number;
    target: Vector3;
    dist: number;
  } | null>(null);
  const targetRef = useRef(new Vector3(0, 0, 1.5));
  /** 上一次的相机模式：用于区分「切换投影」与「三维 ↔ 平面」 */
  const modeRef = useRef<{ viewKind: ViewKind; projection: 'perspective' | 'parallel' } | null>(null);
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
  const dimensionRef = useRef<HTMLDivElement | null>(null);
  const ghostRef = useRef<Group | null>(null);
  const softwareRendererRef = useRef(false);
  const orbitingRef = useRef(false);
  const interactionRef = useRef({ tool, draftStart, viewKind, mouseScheme: settings.mouseScheme, modify, selection, primitiveKind });
  const callbacksRef = useRef({ onSelect, onBoxSelect, onContextAction, onHover, onPickPoint, onClickEmpty, onModifyClick, onDragMove });
  const dragStateRef = useRef<{
    kind: 'move' | 'box';
    startPoint: Vec2;
    startHitId: string | null;
    ids: string[];
    copy: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const modifyDragRef = useRef<{ startPoint: Vec2; startHitId: string | null; startX: number; startY: number } | null>(null);
  const rightDragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  /**
   * 左键旋转：按下即“蓄势”，指针移动超过阈值立刻旋转（无延迟）；
   * 全程不移动则视为轻点 —— 点构件选中，点空白开始框选，再点一下完成框选。
   */
  const orbitArmRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  const orbitRef = useRef<{
    pointerId: number; lastX: number; lastY: number; startX: number; startY: number; moved: boolean;
  } | null>(null);
  /** 松开左键后的旋转惯性（弧度/帧），受「旋转惯性」设置控制。 */
  const orbitVelocityRef = useRef({ theta: 0, phi: 0 });
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
  /** 本次按下是否“按下即落框选起点”（修饰键 / 平面视图）；据此区分：松开是完成框选，还是只落下起点 */
  const boxDragRef = useRef(false);

  const activeLevelZ = project.levels.find((level) => level.id === activeLevelId)?.elevation ?? 0;
  activeLevelZRef.current = activeLevelZ;
  projectRef.current = project;
  interactionRef.current = { tool, draftStart, viewKind, mouseScheme: settings.mouseScheme, modify, selection, primitiveKind };
  callbacksRef.current = { onSelect, onBoxSelect, onContextAction, onHover, onPickPoint, onClickEmpty, onModifyClick, onDragMove };

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
    // 色调映射 + 环境光照是「实物感」的一半：没有环境贴图时金属材质只能看到一片死黑，
    // 有它才有高光、反射和明暗过渡；ACES 让高光不过曝，塑料/金属的层次才拉得开。
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    host.appendChild(renderer.domElement);

    const pmrem = new PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = environment;
    scene.environmentIntensity = 1;
    pmrem.dispose();

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

    // 环境贴图已经提供了大部分漫反射照明，直射光只负责高光与方向感，强度相应调低
    scene.add(new AmbientLight('#ffffff', 0.3));
    const keyLight = new DirectionalLight('#ffffff', 1.5);
    keyLight.position.set(10, -12, 18);
    scene.add(keyLight);
    const fillLight = new DirectionalLight('#cfe0ff', 0.4);
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
    const ghost = new Group();
    scene.add(overlay, models, preview, ghost);
    overlayRef.current = overlay;
    modelsRef.current = models;
    previewRef.current = preview;
    ghostRef.current = ghost;
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
    boxHint.textContent = '框选中：再次轻点完成 · Esc 取消';
    boxHint.style.display = 'none';
    host.appendChild(boxHint);
    boxHintRef.current = boxHint;

    const dimension = document.createElement('div');
    dimension.className = 'modify-dimension';
    dimension.style.display = 'none';
    host.appendChild(dimension);
    dimensionRef.current = dimension;

    const contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    contextMenu.style.display = 'none';
    contextMenu.innerHTML = [
      '<button data-action="finish" data-command-only>完成命令 (Enter)</button>',
      '<button data-action="cancel" data-command-only>取消当前步骤 (Esc)</button>',
      '<button data-action="select-all">选择所有</button>',
      '<button data-action="select-same-type">选择同类型</button>',
      '<button data-action="clear">取消选择</button>',
    ].join('');
    host.appendChild(contextMenu);
    contextMenuRef.current = contextMenu;
    contextMenu.addEventListener('click', (event) => {
      const element = (event.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      const action = element?.dataset.action as 'select-all' | 'select-same-type' | 'clear' | 'cancel' | 'finish' | undefined;
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
      const commandActive = interactionRef.current.modify?.status === 'active';
      menu.querySelectorAll<HTMLButtonElement>('[data-command-only]').forEach((button) => {
        button.style.display = commandActive ? 'block' : 'none';
      });
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
      const modifyActive = interactionRef.current.modify?.status === 'active';
      if (active.objectSnap && camera && (interactionRef.current.tool !== 'select' || modifyActive)) {
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

    const pointAt = (event: PointerEvent): Vec2 | null => {
      const hit = projectPoint(event);
      if (!hit) return null;
      const raw = planePoint(hit.ray);
      return raw ? applySnap(event, raw) : null;
    };
    const hitIdAt = (event: PointerEvent): string | null => {
      const hit = projectPoint(event);
      if (!hit) return null;
      const hits = hit.ray.intersectObjects(models.children, false);
      return (hits[0]?.object.userData.elementId as string | undefined) ?? null;
    };
    const commandActive = () => interactionRef.current.modify?.status === 'active';

    const disarmOrbit = () => {
      orbitArmRef.current = null;
    };

    /** 只给惯性用：单帧增量过大会让松手后转飞，限制上限 */
    const trackOrbitVelocity = (theta: number, phi: number) => {
      const limit = 0.06;
      orbitVelocityRef.current = {
        theta: Math.max(-limit, Math.min(limit, theta)),
        phi: Math.max(-limit, Math.min(limit, phi)),
      };
    };

    /** 视角立方体的切视角补间：四元数 slerp，距离保持不变 */
    const advanceViewTween = () => {
      const tween = viewTweenRef.current;
      const camera = cameraRef.current;
      if (!tween || !camera) return;
      const t = Math.min(1, (performance.now() - tween.start) / tween.duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const q = tween.from.clone().slerp(tween.to, eased);
      const forward = new Vector3(0, 0, -1).applyQuaternion(q);
      camera.position.copy(tween.target).addScaledVector(forward, -tween.dist);
      camera.up.set(0, 1, 0).applyQuaternion(q);
      camera.quaternion.copy(q);
      camera.updateMatrixWorld();
      targetRef.current.copy(tween.target);
      if (controlsRef.current) controlsRef.current.target.copy(tween.target);
      needsRenderRef.current = true;
      if (t >= 1) viewTweenRef.current = null;
    };

    /** 左键拖拽旋转：以 OrbitControls 的 target 为球心，Z-up 球坐标。 */
    const orbitCamera = (thetaDelta: number, phiDelta: number) => {
      const controls = controlsRef.current;
      const camera = cameraRef.current;
      if (!controls || !camera) return;
      const offset = camera.position.clone().sub(controls.target);
      const radius = Math.max(0.001, offset.length());
      const theta = Math.atan2(offset.y, offset.x) - thetaDelta;
      const phi = Math.min(
        Math.PI - 0.06,
        Math.max(0.06, Math.acos(Math.min(1, Math.max(-1, offset.z / radius))) - phiDelta),
      );
      camera.position.set(
        controls.target.x + radius * Math.sin(phi) * Math.cos(theta),
        controls.target.y + radius * Math.sin(phi) * Math.sin(theta),
        controls.target.z + radius * Math.cos(phi),
      );
      camera.up.set(0, 0, 1);
      camera.lookAt(controls.target);
      targetRef.current.copy(controls.target);
      needsRenderRef.current = true;
    };
    orbitByRef.current = (theta, phi) => {
      orbitVelocityRef.current = { theta: 0, phi: 0 };
      orbitCamera(theta, phi);
    };

    const startOrbit = (pointerId: number, x: number, y: number) => {
      const controls = controlsRef.current;
      const camera = cameraRef.current;
      if (!controls || interactionRef.current.viewKind === 'plan') return;
      viewTweenRef.current = null;
      // 正上/正下的视角没有方位角：先偏 3.4° 再按 Z-up 球坐标拖拽，避免视角突跳
      if (camera) {
        const offset = camera.position.clone().sub(controls.target);
        const radius = offset.length();
        if (radius > 1e-6 && Math.abs(offset.z) / radius > 0.9995) {
          const tilt = 0.06;
          const sign = offset.z >= 0 ? 1 : -1;
          camera.position
            .copy(controls.target)
            .add(new Vector3(0, -Math.sin(tilt), sign * Math.cos(tilt)).multiplyScalar(radius));
          camera.up.set(0, 0, 1);
          camera.lookAt(controls.target);
          needsRenderRef.current = true;
        }
      }
      orbitArmRef.current = null;
      cancelBox();
      hideMenu();
      hideSnap();
      dragStateRef.current = null;
      modifyDragRef.current = null;
      orbitRef.current = { pointerId, lastX: x, lastY: y, startX: x, startY: y, moved: false };
      orbitVelocityRef.current = { theta: 0, phi: 0 };
      orbitingRef.current = true;
      renderer.domElement.style.cursor = 'grabbing';
      try {
        renderer.domElement.setPointerCapture(pointerId);
      } catch {
        // 某些浏览器/触控场景不支持捕获，忽略即可
      }
    };

    const finishOrbit = (pointerId: number) => {
      const state = orbitRef.current;
      if (!state || state.pointerId !== pointerId) return false;
      orbitRef.current = null;
      orbitingRef.current = false;
      if (!settingsRef.current.rotateDamping) orbitVelocityRef.current = { theta: 0, phi: 0 };
      renderer.domElement.style.cursor = '';
      try {
        renderer.domElement.releasePointerCapture(pointerId);
      } catch {
        // 忽略
      }
      return true;
    };

    let lastHoverAt = 0;
    const handlePointerMove = (event: PointerEvent) => {
      // 在画布外松开左键时收不到 pointerup，用按键状态兜底，避免“没按也旋转”
      const leftHeld = (event.buttons & 1) !== 0;
      // 按下后一移动就旋转，没有等待时间；移动不足阈值则保持“轻点”语义
      const arm = orbitArmRef.current;
      if (arm && arm.pointerId === event.pointerId) {
        if (!leftHeld) {
          disarmOrbit();
          pressRef.current = null;
        } else {
          const dx0 = event.clientX - arm.startX;
          const dy0 = event.clientY - arm.startY;
          if (Math.hypot(dx0, dy0) > 4) {
            startOrbit(arm.pointerId, arm.startX, arm.startY);
            pressRef.current = null;
            const thetaDelta = dx0 * 0.006;
            const phiDelta = dy0 * 0.006;
            trackOrbitVelocity(thetaDelta, phiDelta);
            if (orbitRef.current) orbitRef.current.moved = true;
            orbitCamera(thetaDelta, phiDelta);
            return;
          }
        }
      }
      const orbit = orbitRef.current;
      if (orbit) {
        if (!leftHeld && orbit.pointerId === event.pointerId) {
          finishOrbit(event.pointerId);
          return;
        }
        const dx = event.clientX - orbit.lastX;
        const dy = event.clientY - orbit.lastY;
        // 3px 容差：拖拽起始的轻微抖动不算旋转
        if (!orbit.moved
          && Math.hypot(event.clientX - orbit.startX, event.clientY - orbit.startY) <= 3) {
          return;
        }
        orbit.lastX = event.clientX;
        orbit.lastY = event.clientY;
        orbit.moved = true;
        const thetaDelta = dx * 0.006;
        const phiDelta = dy * 0.006;
        trackOrbitVelocity(thetaDelta, phiDelta);
        orbitCamera(thetaDelta, phiDelta);
        return;
      }
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
      const drag = dragStateRef.current;
      if (drag && press?.moved) drag.moved = true;

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
      if (commandActive()) {
        updateModifyPreview(point);
        return;
      }
      if (drag?.kind === 'move' && drag.moved && point) {
        updateDragPreview(drag.startPoint, point, drag.copy);
        return;
      }
      if (interactionRef.current.tool !== 'select') updatePreview(point);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      viewTweenRef.current = null;
      orbitVelocityRef.current = { theta: 0, phi: 0 };
      hideMenu();
      const hit = projectPoint(event);
      if (!hit) return;
      if (interactionRef.current.tool !== 'select') {
        const raw = planePoint(hit.ray);
        if (raw) callbacksRef.current.onPickPoint(applySnap(event, raw));
        return;
      }
      const hitId = hitIdAt(event);
      const startPoint = pointAt(event);
      pressRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        additive: event.shiftKey || event.ctrlKey || event.metaKey,
        hitId,
      };
      const revit = interactionRef.current.mouseScheme === 'revit';
      const plainPress = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;

      // Revit 方案：左键按下即蓄势，移动就旋转（无延迟）；轻点留给选择 / 两击框选。
      if (revit && !commandActive() && interactionRef.current.viewKind !== 'plan' && plainPress) {
        orbitArmRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
        return;
      }

      if (commandActive()) {
        // Revit：命令中按住左键从基点拖到终点，一样可以完成两点输入
        modifyDragRef.current = startPoint
          ? { startPoint, startHitId: hitId, startX: event.clientX, startY: event.clientY }
          : null;
        return;
      }

      if (revit && !hitId && startPoint) {
        // 平面视图 / Shift·Ctrl 修饰：按下先落框选起点，拖动即出框，松开时若没移动则保留起点等第二下
        if (!boxStateRef.current) {
          startBox(event.clientX, event.clientY, event.shiftKey || event.ctrlKey || event.metaKey);
          boxDragRef.current = true;
          if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !interactionRef.current.modify) {
            callbacksRef.current.onClickEmpty();
          }
        }
        dragStateRef.current = null;
        return;
      }
      if (revit && hitId && startPoint) {
        // 平面视图 / Ctrl·Cmd 修饰：构件拖拽 = 移动，Ctrl/Cmd 为复制
        const currentSelection = interactionRef.current.selection;
        const ids = currentSelection.includes(hitId) ? [...currentSelection] : [hitId];
        dragStateRef.current = {
          kind: 'move', startPoint, startHitId: hitId, ids,
          copy: event.ctrlKey || event.metaKey,
          pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false,
        };
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const orbit = orbitRef.current;
      if (orbit && orbit.pointerId === event.pointerId) {
        const press = pressRef.current;
        pressRef.current = null;
        disarmOrbit();
        finishOrbit(event.pointerId);
        if (!orbit.moved && press?.hitId) callbacksRef.current.onSelect(press.hitId, press.additive);
        return;
      }
      disarmOrbit();
      const press = pressRef.current;
      pressRef.current = null;
      const additive = press?.additive ?? false;
      const moved = Boolean(press?.moved) || Math.hypot(event.clientX - (press?.startX ?? event.clientX), event.clientY - (press?.startY ?? event.clientY)) > 4;
      const drag = dragStateRef.current;
      dragStateRef.current = null;
      const dragModify = modifyDragRef.current;
      modifyDragRef.current = null;
      const revit = interactionRef.current.mouseScheme === 'revit';

      /* Revit 命令中：单击取一点；按住拖动则一次输入基点 + 终点 */
      if (commandActive() && dragModify) {
        const end = pointAt(event);
        if (end) {
          if (moved) {
            callbacksRef.current.onModifyClick({ point: dragModify.startPoint, hitId: dragModify.startHitId });
            callbacksRef.current.onModifyClick({ point: end, hitId: hitIdAt(event) });
          } else {
            callbacksRef.current.onModifyClick({ point: end, hitId: hitIdAt(event) });
          }
        }
        clearModifyPreview();
        return;
      }

      /* 框选进行中：轻点第二下完成；按下即落点的情形，若没拖动就只保留起点 */
      if (boxStateRef.current) {
        const box = boxStateRef.current;
        box.currentX = event.clientX;
        box.currentY = event.clientY;
        const tiny = Math.abs(box.currentX - box.anchorX) < 4 && Math.abs(box.currentY - box.anchorY) < 4;
        const startedOnPress = boxDragRef.current;
        boxDragRef.current = false;
        if (tiny) {
          // 几乎没移动又点中构件：视为点选，避免“先点空白再点构件”被误判成空框
          const id = hitIdAt(event);
          if (id) {
            cancelBox();
            callbacksRef.current.onSelect(id, box.additive || additive);
            return;
          }
        }
        box.additive = box.additive || additive;
        if (startedOnPress && !moved) {
          // 修饰键 / 平面视图下的第一下：保留锚点，等第二下轻点完成
          updateSelectionBox();
          return;
        }
        completeBox();
        clearModifyPreview();
        return;
      }
      boxDragRef.current = false;

      if (!press) return;
      if (drag?.kind === 'move' && revit) {
        if (drag.moved) {
          const end = pointAt(event);
          clearModifyPreview();
          if (end) {
            const dx = end[0] - drag.startPoint[0];
            const dy = end[1] - drag.startPoint[1];
            if (Math.hypot(dx, dy) > 1e-6) callbacksRef.current.onDragMove(dx, dy, drag.copy, drag.ids);
          }
        } else {
          callbacksRef.current.onSelect(drag.startHitId ?? '', additive);
        }
        return;
      }
      if (moved) return; // 经典方案：左键拖拽 = 旋转视角
      if (press.hitId) {
        callbacksRef.current.onSelect(press.hitId, additive);
        return;
      }
      // Revit：空白处轻点 = 取消选择并落下框选起点；移动鼠标后再轻点一下完成框选
      if (
        revit && !additive && interactionRef.current.viewKind !== 'plan'
        && !interactionRef.current.modify
      ) {
        callbacksRef.current.onClickEmpty();
      }
      startBox(event.clientX, event.clientY, additive);
    };

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      // 右键拖拽后不应弹出菜单（右键已不再旋转，但保留拖拽抑制，避免误触菜单）
      if (rightDragRef.current?.moved) {
        rightDragRef.current = null;
        hideMenu();
        return;
      }
      rightDragRef.current = null;
      hideMenu();
      cancelBox();
      const hit = projectPoint(event);
      const hits = hit ? hit.ray.intersectObjects(models.children, false) : [];
      const targetId = (hits[0]?.object.userData.elementId as string | undefined) ?? null;
      // 命令进行中右键不改选择集，只弹出「完成 / 取消」
      if (targetId && !commandActive()) callbacksRef.current.onSelect(targetId, false);
      showMenu(event.clientX, event.clientY, targetId);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      cancelBox();
      hideMenu();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      disarmOrbit();
      boxDragRef.current = false;
      if (finishOrbit(event.pointerId)) pressRef.current = null;
    };

    const trackRightDown = (event: PointerEvent) => {
      if (event.button === 2) rightDragRef.current = { x: event.clientX, y: event.clientY, moved: false };
    };
    const trackRightMove = (event: PointerEvent) => {
      const state = rightDragRef.current;
      if (state && Math.hypot(event.clientX - state.x, event.clientY - state.y) > 4) state.moved = true;
    };
    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);
    renderer.domElement.addEventListener('contextmenu', handleContextMenu);
    renderer.domElement.addEventListener('pointerdown', trackRightDown);
    renderer.domElement.addEventListener('pointermove', trackRightMove);
    renderer.domElement.addEventListener('pointerleave', hideSnap);
    renderer.domElement.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('keydown', handleKeyDown);


    let frame = 0;
    const render = () => {
      advanceViewTween();
      // 拖拽旋转松开后的惯性衰减（关闭「旋转惯性」时 finishOrbit 已清零）
      if (!viewTweenRef.current && !orbitRef.current && settingsRef.current.rotateDamping) {
        const velocity = orbitVelocityRef.current;
        if (Math.abs(velocity.theta) > 1e-5 || Math.abs(velocity.phi) > 1e-5) {
          orbitCamera(velocity.theta, velocity.phi);
          velocity.theta *= 0.92;
          velocity.phi *= 0.92;
        } else if (velocity.theta !== 0 || velocity.phi !== 0) {
          orbitVelocityRef.current = { theta: 0, phi: 0 };
        }
      }
      // 视角补间期间完全接管相机，交给 OrbitControls 会把朝向改回去
      if (!viewTweenRef.current) controlsRef.current?.update();
      const camera = cameraRef.current;
      if (camera && needsRenderRef.current) {
        renderer.render(scene, camera);
        updateAxisIndicator(axisLabelsRef.current, camera);
        updateViewCube(viewCubeRef.current, camera);
        needsRenderRef.current = false;
      }
      frame = requestAnimationFrame(render);
    };
    render();

    /**
     * 按名字 / id 找构件，返回它的包围盒。
     * AI 说「凑近看夹头」时用它把取景范围从整机缩到那一个件——
     * 否则 zoom 只是在放大整机中心，细节还是糊的。
     */
    const boxOfFocus = (focus: string): Box3 | null => {
      const models = modelsRef.current;
      if (!models) return null;
      const key = String(focus ?? '').trim().toLowerCase();
      if (!key) return null;
      const idOf = (child: Object3D) => String(child.userData.elementId ?? '').toLowerCase();
      const nameOf = (child: Object3D) => String(child.userData.elementName ?? '').toLowerCase();
      // 先精确（id 或全名），再退化成包含匹配；id 不做包含，避免 uuid 片段乱命中
      const exact = models.children.find((child) => idOf(child) === key || nameOf(child) === key);
      const loose = exact ?? models.children.find((child) => nameOf(child).includes(key));
      if (loose) {
        const box = new Box3().setFromObject(loose);
        return box.isEmpty() ? null : box;
      }
      // 「夹头」「握把」这类名字是造型里的特征名，不是构件名：命中就框住那个构件。
      // 特征本身没有独立网格（布尔合并成一整块），框构件已经足够看清它。
      const owner = projectRef.current.elements.find((element) => {
        if (element.category !== 'mesh' || element.primitive?.kind !== 'solid') return false;
        return element.primitive.features.some((feature) => String(feature.label ?? '').toLowerCase().includes(key));
      });
      if (!owner) return null;
      const mesh = models.children.find((child) => idOf(child) === String(owner.id).toLowerCase());
      if (!mesh) return null;
      const box = new Box3().setFromObject(mesh);
      return box.isEmpty() ? null : box;
    };

    /**
     * 把相机摆到「看向 bounds 中心、朝向 direction」，并把 bounds 框满画面。
     * AI 巡检用：无论当前模型是 1 m 的小零件还是整栋楼，截出来的图都能看清主体；
     * focus 让它只框住某个构件，zoom 让它再推进去看细节。
     */
    const frameDirection = (direction: Vector3, up: Vector3, framing?: { zoom?: number; focus?: string }): boolean => {
      const models = modelsRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!models || !camera) return false;
      const bounds = (framing?.focus ? boxOfFocus(framing.focus) : null)
        ?? new Box3().setFromObject(models);
      if (bounds.isEmpty()) return false;
      const host = hostRef.current;
      const aspect = host && host.clientHeight > 0 ? host.clientWidth / host.clientHeight : 1;
      if (!frameCamera(camera, bounds, aspect, direction, up, framing?.zoom ?? 1)) return false;
      const center = bounds.getCenter(new Vector3());
      targetRef.current.copy(center);
      // 相机是瞬时摆位的，别让视角补间/惯性在下一帧把它拉回去
      viewTweenRef.current = null;
      orbitVelocityRef.current = { theta: 0, phi: 0 };
      orbitingRef.current = false;
      if (controls) {
        controls.target.copy(center);
        controls.update();
      }
      needsRenderRef.current = true;
      return true;
    };

    // 截取当前视口（给 AI 看成品用）。WebGL 默认不保留绘制缓冲，
    // 必须当场重绘一帧再取像素，否则 toDataURL 可能拿到一张空白图。
    const capture = () => {
      const camera = cameraRef.current;
      if (!camera || renderer.domElement.width < 8) return null;
      try {
        renderer.render(scene, camera);
        const url = renderer.domElement.toDataURL('image/jpeg', 0.72);
        return typeof url === 'string' && url.length > 2048 ? url : null;
      } catch {
        return null;
      }
    };

    onViewportApi?.({
      capture,
      look: (request) => {
        const direction = request.view
          ? presetDirection(request.view as ViewPreset)
          : directionFromAngles(request.azimuth ?? 35, request.elevation ?? 25);
        // 顶/底视角时 (0,0,1) 与视线平行会让 lookAt 退化
        const up = request.view === 'top' || request.view === 'bottom'
          ? new Vector3(0, 1, 0)
          : new Vector3(0, 0, 1);
        return frameDirection(direction, up, { zoom: request.zoom, focus: request.focus });
      },
      camera: () => {
        const camera = cameraRef.current;
        if (!camera) return null;
        const target = controlsRef.current?.target ?? targetRef.current;
        return cameraAngles(camera.position, target);
      },
      fitAll: () => {
        const camera = cameraRef.current;
        if (!camera) return false;
        const target = controlsRef.current?.target ?? targetRef.current;
        const direction = camera.position.clone().sub(target);
        if (direction.lengthSq() < 1e-9) return false;
        return frameDirection(direction, camera.up.clone());
      },
    });

    return () => {
      onViewportApi?.(null);
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      renderer.domElement.removeEventListener('contextmenu', handleContextMenu);
      renderer.domElement.removeEventListener('pointerdown', trackRightDown);
      renderer.domElement.removeEventListener('pointermove', trackRightMove);
      renderer.domElement.removeEventListener('pointerleave', hideSnap);
      renderer.domElement.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('keydown', handleKeyDown);
      orbitByRef.current = null;
      cubeDragRef.current = null;
      disarmOrbit();
      selectionBox.remove();
      boxHint.remove();
      contextMenu.remove();
      dimension.remove();
      selectionBoxRef.current = null;
      boxHintRef.current = null;
      contextMenuRef.current = null;
      dimensionRef.current = null;
      menuTargetRef.current = null;
      pressRef.current = null;
      boxStateRef.current = null;
      dragStateRef.current = null;
      modifyDragRef.current = null;
      controlsRef.current?.dispose();
      disposeGroup(models);
      disposeGroup(overlay);
      disposeGroup(preview);
      clearGhostGroup();
      ghostRef.current = null;
      environment.dispose();
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
      // 可见性 = 构件自身 visible && 图层可见 && 类别可见（Revit VV 语义）
      if (!isElementVisible(project, element)) continue;
      const model = buildElementModel(project, element);
      if (!model) continue;
      const { geometry, materials } = model;
      const vertexColors = element.category === 'mesh' ? element.vertexColors : undefined;
      const surface = effectiveSurface(project, element);
      const decal = element.category === 'mesh' && element.primitive?.kind === 'decal' ? element.primitive : null;
      // 图层 / 类别颜色替换优先于零件自定义色（否则图层着色对特征实体失效）
      const lockedColor = colorLockOf(project, element) !== null;
      let material: MeshStandardMaterial | MeshBasicMaterial | Array<MeshStandardMaterial | MeshBasicMaterial>;
      if (decal) {
        material = decalMaterial(decal, surface.opacity);
      } else if (materials.length > 1) {
        material = materials.map((entry) => featureMaterial(entry, surface, lockedColor));
      } else {
        const single = featureMaterial(materials[0] ?? null, surface, lockedColor || Boolean(vertexColors));
        if (vertexColors) {
          single.vertexColors = true;
          single.color.set('#ffffff');
        }
        material = single;
      }
      const mesh = new Mesh(geometry, material);
      mesh.userData.elementId = element.id;
      // 名字也存一份：AI 说「聚焦到夹头」时不用回查（这个 effect 的闭包拿不到最新 project）
      mesh.userData.elementName = element.name;
      mesh.userData.layerId = element.layerId;
      mesh.castShadow = !decal;
      mesh.receiveShadow = !decal;
      // 贴花最后画，且不参与深度写入，避免被机身盖住
      if (decal) mesh.renderOrder = 2;
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
    const previousCamera = cameraRef.current;
    const previousMode = modeRef.current;
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
      // 只在透视 / 平行互切时保留当前朝向：前视图切平行投影应仍是前视图
      if (previousMode?.viewKind === '3d' && previousMode.projection !== projection && previousCamera) {
        const drift = previousCamera.position.clone().sub(targetRef.current);
        if (drift.lengthSq() > 1e-6) direction.copy(drift.normalize());
        camera.up.copy(previousCamera.up);
      }
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
    controls.addEventListener('start', () => {
      viewTweenRef.current = null;
      orbitingRef.current = true;
      orbitVelocityRef.current = { theta: 0, phi: 0 };
    });
    controls.addEventListener('end', () => { orbitingRef.current = false; });
    // Revit 方案：左键拖拽旋转（自己实现，按下即响应）、轻点选中、空白轻点两下框选；中键平移，滚轮缩放，右键只出菜单
    // 经典方案：左键拖拽旋转交给 OrbitControls，框选用「单击-移动-再单击」
    controls.mouseButtons = settingsRef.current.mouseScheme === 'revit'
      ? { LEFT: null, MIDDLE: MOUSE.PAN, RIGHT: null }
      : { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: null };
    controls.enableRotate = !planMode && !boxStateRef.current;
    controls.update();
    controlsRef.current = controls;

    /* 视角立方体：在当前三维视图内切换相机朝向，保持观察距离与投影方式 */
    viewTweenRef.current = null;
    viewPresetRef.current = planMode ? null : (preset) => {
      const target = controls.target.clone();
      const distance = Math.max(1.5, camera.position.distanceTo(target));
      const up = new Vector3(0, 0, 1);
      if (preset === 'top' || preset === 'bottom') up.set(0, 1, 0);
      const eye = target.clone().addScaledVector(presetDirection(preset), distance);
      const to = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(eye, target, up));
      if (camera.quaternion.angleTo(to) < 0.002) return;
      camera.up.copy(up);
      viewTweenRef.current = {
        from: camera.quaternion.clone(),
        to,
        start: performance.now(),
        duration: 420,
        target,
        dist: distance,
      };
      orbitVelocityRef.current = { theta: 0, phi: 0 };
      orbitingRef.current = false;
      needsRenderRef.current = true;
    };
    modeRef.current = { viewKind, projection };
  }, [viewKind, projection]);

  /* 鼠标方案切换：即时更新 OrbitControls 按键映射 */
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.mouseButtons = settings.mouseScheme === 'revit'
      ? { LEFT: null, MIDDLE: MOUSE.PAN, RIGHT: null }
      : { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: null };
  }, [settings.mouseScheme]);

  /* 工具/视图切换：清掉绘制预览与进行中的框选 */
  useEffect(() => {
    clearPreviewGroup();
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
      // 顶/底视角时视线与 up 平行会让 lookAt 退化，先偏 3.4°
      if (Math.abs(direction.z) > 0.9995) {
        const tilt = 0.06;
        direction.set(0, -Math.sin(tilt), Math.sign(direction.z || 1) * Math.cos(tilt));
      }
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

  /* 命令结束 / 切换：清掉幽灵与临时尺寸 */
  useEffect(() => {
    if (!modify || modify.status !== 'active') clearModifyPreview();
  }, [modify]);

  /* ---------- 视角立方体：拖拽即旋转、单击面切视角、双击回轴测 ---------- */
  function handleCubePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.stopPropagation();
    cubeSuppressClickRef.current = false;
    viewTweenRef.current = null;
    const drag = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: false };
    cubeDragRef.current = drag;
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (cubeDragRef.current === drag) cubeDragRef.current = null;
      cubeSuppressClickRef.current = drag.moved;
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== drag.pointerId) return;
      const dx = pointer.clientX - drag.lastX;
      const dy = pointer.clientY - drag.lastY;
      // 2px 容差：手抖不算拖拽，仍然当单击
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      drag.moved = true;
      drag.lastX = pointer.clientX;
      drag.lastY = pointer.clientY;
      // 正上/正下方没有方位角，先偏 3.4° 再按球坐标转，避免拖拽无反应或视角突跳
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (camera && controls) {
        const offset = camera.position.clone().sub(controls.target);
        const radius = offset.length();
        if (radius > 1e-6 && Math.abs(offset.z) / radius > 0.9995) {
          const tilt = 0.06;
          const sign = offset.z >= 0 ? 1 : -1;
          camera.position
            .copy(controls.target)
            .add(new Vector3(0, -Math.sin(tilt), sign * Math.cos(tilt)).multiplyScalar(radius));
          camera.up.set(0, 0, 1);
          camera.lookAt(controls.target);
          needsRenderRef.current = true;
        }
      }
      orbitByRef.current?.(dx * 0.0075, dy * 0.0075);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  function applyCubePreset(preset: ViewPreset) {
    // 拖拽旋转之后紧跟着的 click 不再切视角
    if (cubeSuppressClickRef.current) {
      cubeSuppressClickRef.current = false;
      return;
    }
    viewPresetRef.current?.(preset);
  }

  return (
    <div className={`viewport-host tool-${tool} ${viewKind === 'plan' ? 'is-plan' : ''}`} ref={hostRef} aria-label="BIM 视口">
      <div className="snap-indicator" ref={snapIndicatorRef} aria-hidden="true">
        <span className="snap-dot" />
        <span className="snap-label" />
      </div>
      {settings.showAxisIndicator ? (
        <svg className="axis-indicator" ref={axisLabelsRef} viewBox="-32 -32 64 64" aria-label="空间坐标系">
          <circle cx="0" cy="0" r="2.2" fill="#d5e0ef" />
          <g>
            <line data-axis-line="x" x1="0" y1="0" x2="23" y2="0" stroke="#ff7777" strokeWidth="2.4" strokeLinecap="round" />
            <polygon data-axis-arrow="x" points="23,0 16,-3.6 16,3.6" fill="#ff7777" />
            <text data-axis-label="x" x="30.5" y="0" fill="#ff7777">X</text>
          </g>
          <g>
            <line data-axis-line="y" x1="0" y1="0" x2="0" y2="-23" stroke="#65d895" strokeWidth="2.4" strokeLinecap="round" />
            <polygon data-axis-arrow="y" points="0,-23 -3.6,-16 3.6,-16" fill="#65d895" />
            <text data-axis-label="y" x="0" y="-30.5" fill="#65d895">Y</text>
          </g>
          <g>
            <line data-axis-line="z" x1="0" y1="0" x2="0" y2="-23" stroke="#76aaff" strokeWidth="2.4" strokeLinecap="round" />
            <polygon data-axis-arrow="z" points="0,-23 -3.6,-16 3.6,-16" fill="#76aaff" />
            <text data-axis-label="z" x="0" y="-30.5" fill="#76aaff">Z</text>
          </g>
        </svg>
      ) : null}
      {viewKind === '3d' ? (
        <div
          className="viewcube"
          aria-label="视角立方体：拖拽旋转、单击面切换视角、双击回到轴测"
          title="拖拽旋转 · 单击面切换视角 · 双击回到轴测"
          onPointerDown={handleCubePointerDown}
          onDoubleClick={() => viewPresetRef.current?.('iso')}
          onContextMenu={(event) => event.preventDefault()}
        >
          <svg className="viewcube-svg" ref={viewCubeRef} viewBox="-44 -44 88 88">
            {CUBE_FACES.map((face) => (
              <g key={face.key}>
                <polygon
                  data-face={face.key}
                  className="viewcube-face"
                  points=""
                  onClick={() => applyCubePreset(face.key)}
                >
                  <title>{face.title}</title>
                </polygon>
                <text data-face-label={face.key} className="viewcube-label" x="0" y="0">{face.label}</text>
              </g>
            ))}
          </svg>
        </div>
      ) : null}
    </div>
  );

  /** 幽灵网格与模型共享 BufferGeometry，只能释放自己的材质。 */
  function clearGhostGroup(): void {
    const ghost = ghostRef.current;
    if (!ghost) return;
    ghost.traverse((child) => {
      if (!(child instanceof Mesh) && !(child instanceof Line)) return;
      if (child.userData.sharedGeometry) disposeMaterial(child);
      else disposeObject(child);
    });
    ghost.clear();
  }

  function clearPreviewGroup(): void {
    const preview = previewRef.current;
    if (preview) {
      disposeGroup(preview);
      preview.clear();
    }
    clearGhostGroup();
    if (dimensionRef.current) dimensionRef.current.style.display = 'none';
  }

  function clearModifyPreview(): void {
    clearGhostGroup();
    if (dimensionRef.current) dimensionRef.current.style.display = 'none';
    needsRenderRef.current = true;
  }

  function ghostMaterial(): MeshBasicMaterial {
    return new MeshBasicMaterial({
      color: '#69c0ff', transparent: true, opacity: 0.34,
      depthWrite: false, side: DoubleSide, toneMapped: false,
    });
  }

  function matrixForTransform(transform: PreviewSpec['ghosts'][number]): Matrix4 {
    const { translation, rotation, mirrorAngle, scale, origin } = transformParams(transform);
    const translate = (x: number, y: number) => new Matrix4().makeTranslation(x, y, 0);
    const rotateZ = (angle: number) => new Matrix4().makeRotationZ(angle);
    const inverse = translate(-origin[0], -origin[1]);
    if (mirrorAngle !== null) {
      return translate(origin[0], origin[1])
        .multiply(rotateZ(mirrorAngle))
        .multiply(new Matrix4().makeScale(1, -1, 1))
        .multiply(rotateZ(-mirrorAngle))
        .multiply(inverse);
    }
    if (rotation) return translate(origin[0], origin[1]).multiply(rotateZ(rotation)).multiply(inverse);
    if (scale !== 1) {
      return translate(origin[0], origin[1])
        .multiply(new Matrix4().makeScale(scale, scale, scale))
        .multiply(inverse);
    }
    return translate(translation[0], translation[1]);
  }

  function screenOfPoint(point: Vec2): { x: number; y: number } | null {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    if (!camera || !renderer) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const projected = new Vector3(point[0], point[1], activeLevelZRef.current + 0.12).project(camera);
    return {
      x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
    };
  }

  /** 绘制 Revit 式幽灵预览、参照线、基点标记与临时尺寸。 */
  function drawPreviewSpec(spec: PreviewSpec, ids: string[]): void {
    const ghost = ghostRef.current;
    const models = modelsRef.current;
    if (!ghost || !models) return;
    clearGhostGroup();
    needsRenderRef.current = true;
    const levelZ = activeLevelZRef.current;
    const selected = new Set(ids);

    for (const transform of spec.ghosts) {
      const matrix = matrixForTransform(transform);
      for (const child of models.children) {
        if (!(child instanceof Mesh) || !selected.has(child.userData.elementId as string)) continue;
        const copy = new Mesh((child as Mesh).geometry, ghostMaterial());
        copy.userData.sharedGeometry = true;
        // 直接写矩阵：镜像是负行列式，matrixAutoUpdate 的分解会丢掉反射方向
        copy.matrixAutoUpdate = false;
        copy.matrix.copy(matrix);
        ghost.add(copy);
      }
    }
    for (const guide of spec.guides) {
      const geometry = new BufferGeometry().setFromPoints([
        new Vector3(guide.from[0], guide.from[1], levelZ + 0.06),
        new Vector3(guide.to[0], guide.to[1], levelZ + 0.06),
      ]);
      ghost.add(new Line(geometry, new LineBasicMaterial({ color: guide.color ?? '#ffd479' })));
    }
    for (const marker of spec.markers) {
      const dot = new Mesh(new SphereGeometry(0.09, 10, 8), new MeshBasicMaterial({ color: '#ffd479' }));
      dot.position.set(marker[0], marker[1], levelZ + 0.09);
      ghost.add(dot);
    }

    const dimension = dimensionRef.current;
    const host = hostRef.current;
    if (dimension && host && spec.label && spec.labelAt) {
      const screen = screenOfPoint(spec.labelAt);
      if (screen) {
        const rect = host.getBoundingClientRect();
        dimension.textContent = spec.label;
        dimension.style.display = 'block';
        dimension.style.left = `${screen.x - rect.left + 14}px`;
        dimension.style.top = `${screen.y - rect.top - 30}px`;
      }
    }
  }

  function updateModifyPreview(point: Vec2 | null): void {
    const session = interactionRef.current.modify;
    if (!session || session.status !== 'active') {
      clearModifyPreview();
      return;
    }
    drawPreviewSpec(modifyPreview(projectRef.current, session, point), session.ids);
  }

  function updateDragPreview(start: Vec2, point: Vec2, copy: boolean): void {
    const dx = point[0] - start[0];
    const dy = point[1] - start[1];
    const ids = dragStateRef.current?.ids ?? interactionRef.current.selection;
    drawPreviewSpec({
      ghosts: [{ kind: 'translate', dx, dy }],
      guides: [{ from: start, to: point }],
      markers: [start],
      label: `${copy ? '复制' : '移动'} ${Math.hypot(dx, dy).toFixed(2)} m　ΔX ${dx.toFixed(2)}　ΔY ${dy.toFixed(2)}`,
      labelAt: point,
    }, ids);
  }

  function updatePreview(point: Vec2 | null): void {
    const preview = previewRef.current;
    if (!preview) return;
    needsRenderRef.current = true;
    clearPreviewGroup();
    const { tool: activeTool, draftStart: start } = interactionRef.current;
    if (!point || activeTool === 'select') return;
    const levelZ = activeLevelZRef.current;
    const doc = projectRef.current;

    if (activeTool === 'primitive') {
      const kind = interactionRef.current.primitiveKind ?? 'box';
      const center = start ?? point;
      const radius = start ? Math.max(0.1, Math.hypot(point[0] - start[0], point[1] - start[1])) : 1;
      let spec = defaultPrimitive(kind, 1, 2);
      if (kind === 'extrude' && start) {
        const minX = Math.min(start[0], point[0]);
        const maxX = Math.max(start[0], point[0]);
        const minY = Math.min(start[1], point[1]);
        const maxY = Math.max(start[1], point[1]);
        if (maxX - minX < 0.05 || maxY - minY < 0.05) return;
        spec = {
          kind: 'extrude',
          profile: [[minX - center[0], minY - center[1]], [maxX - center[0], minY - center[1]],
            [maxX - center[0], maxY - center[1]], [minX - center[0], maxY - center[1]]],
          height: (defaultPrimitive('extrude') as Extract<ReturnType<typeof defaultPrimitive>, { kind: 'extrude' }>).height,
        };
      }
      const mesh = new Mesh(buildPrimitiveGeometry(spec), previewMaterial());
      mesh.position.set(center[0], center[1], levelZ);
      if (kind === 'sphere') mesh.scale.setScalar(radius);
      else if (kind !== 'extrude') mesh.scale.set(radius, radius, 1);
      preview.add(mesh);
      return;
    }

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
    const isSelected = selected.has(child.userData.elementId as string);
    // 特征实体是材质数组（逐零件材质），高亮要作用到每一种材质上
    const list = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of list) {
      if (!(material instanceof MeshStandardMaterial)) continue;
      material.emissive.set(isSelected ? color : '#000000');
      material.emissiveIntensity = isSelected ? 0.45 : 0;
    }
  });
}

function updateViewCube(
  container: SVGSVGElement | null,
  camera: PerspectiveCamera | OrthographicCamera | null,
): void {
  if (!container || !camera) return;
  // 与坐标轴指示器同一套投影：世界方向 → 相机空间 → 正交投影到屏幕
  const rotation = camera.quaternion.clone().invert();
  const scale = 29;
  const project = (vector: Vector3) => {
    const p = vector.clone().applyQuaternion(rotation);
    return { x: p.x * scale, y: -p.y * scale, z: p.z };
  };

  for (const face of CUBE_FACES) {
    const polygon = container.querySelector<SVGPolygonElement>(`polygon[data-face="${face.key}"]`);
    const label = container.querySelector<SVGTextElement>(`text[data-face-label="${face.key}"]`);
    if (!polygon || !label) continue;
    const normal = new Vector3(face.normal[0], face.normal[1], face.normal[2]).applyQuaternion(rotation);
    // 背面剔除：法线朝向观察者（相机空间 +z）才可见
    if (normal.z <= 0.015) {
      polygon.style.display = 'none';
      label.style.display = 'none';
      continue;
    }
    polygon.style.display = '';
    const points = face.corners
      .map((index) => {
        const corner = CUBE_CORNERS[index]!;
        const p = project(new Vector3(corner[0], corner[1], corner[2]));
        return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
      })
      .join(' ');
    polygon.setAttribute('points', points);
    // 越正对观察者越亮，斜看的面稍暗
    polygon.style.opacity = (0.72 + Math.min(1, normal.z) * 0.28).toFixed(2);

    const center = project(new Vector3(face.normal[0], face.normal[1], face.normal[2]));
    label.setAttribute('x', center.x.toFixed(2));
    label.setAttribute('y', center.y.toFixed(2));
    label.style.display = normal.z > 0.24 ? '' : 'none';
    label.style.opacity = Math.min(1, normal.z * 1.5).toFixed(2);
  }
}

function updateAxisIndicator(
  container: SVGSVGElement | null,
  camera: PerspectiveCamera | OrthographicCamera | null,
): void {
  if (!container || !camera) return;
  const rotation = camera.quaternion.clone().invert();
  const radius = 23;
  const axes = [
    { key: 'x', direction: new Vector3(1, 0, 0) },
    { key: 'y', direction: new Vector3(0, 1, 0) },
    { key: 'z', direction: new Vector3(0, 0, 1) },
  ];
  for (const axis of axes) {
    const line = container.querySelector<SVGLineElement>(`[data-axis-line="${axis.key}"]`);
    const arrow = container.querySelector<SVGPolygonElement>(`[data-axis-arrow="${axis.key}"]`);
    const label = container.querySelector<SVGTextElement>(`[data-axis-label="${axis.key}"]`);
    if (!line || !arrow || !label) continue;

    const direction = axis.direction.clone().applyQuaternion(rotation);
    // 正交投影到屏幕：x 向右、y 向上（SVG 的 y 轴向下，所以取负）
    const x = direction.x * radius;
    const y = -direction.y * radius;
    const length = Math.hypot(x, y);
    const unitX = length > 0.001 ? x / length : 0;
    const unitY = length > 0.001 ? y / length : -1;

    line.setAttribute('x2', String(x));
    line.setAttribute('y2', String(y));

    const apexX = x;
    const apexY = y;
    const baseX = x - unitX * 7;
    const baseY = y - unitY * 7;
    const nx = -unitY;
    const ny = unitX;
    arrow.setAttribute(
      'points',
      `${apexX},${apexY} ${baseX + nx * 3.6},${baseY + ny * 3.6} ${baseX - nx * 3.6},${baseY - ny * 3.6}`,
    );

    label.setAttribute('x', String(x + unitX * 7.5));
    label.setAttribute('y', String(y + unitY * 7.5));
    // 指向屏幕深处的轴稍暗；几乎正对相机时隐藏文字，避免堆在原点
    const depth = Math.min(1, length / radius);
    line.style.opacity = String(0.35 + 0.65 * depth);
    arrow.style.opacity = String(0.35 + 0.65 * depth);
    label.style.opacity = length < 6 ? '0' : '1';
  }
}
