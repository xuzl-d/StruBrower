/**
 * BIM 语义内核数据模型（文档 schema v2）。
 *
 * 与 v1 的区别：构件不再是“顶点 + 索引”的网格，而是“类型 + 参数 + 约束”的族实例，
 * 几何由 buildElementGeometry 按参数实时生成。导入的 STEP/OBJ 仍以 mesh 形式保存，
 * 与参数化构件并存。
 *
 * 坐标约定：世界坐标 Z-up，单位米；标高 elevation 即世界 Z 值。
 */

export type Id = string;
export type Vec2 = [number, number];

/** 标高。同名标高在建 BIM 项目里是构件竖向定位的基准。 */
export interface Level {
  id: Id;
  name: string;
  /** 世界 Z 值，单位米 */
  elevation: number;
}

/** 轴网。平面内的一条线，用于定位构件。 */
export interface Grid {
  id: Id;
  name: string;
  start: Vec2;
  end: Vec2;
}

/**
 * 材质（Revit 材质浏览器的简化模型）。
 * 颜色用于着色显示，透明度/粗糙度/金属度用于真实感渲染，description 为说明。
 */
export interface Material {
  id: Id;
  name: string;
  color: string;
  /** 不透明度 0–100，缺省 100（完全不透明） */
  opacity?: number;
  /** PBR 粗糙度 0–1，缺省 0.62 */
  roughness?: number;
  /** PBR 金属度 0–1，缺省 0.04 */
  metalness?: number;
  /** 材质类别 / 说明，例如 “C30 混凝土” */
  description?: string;
}

/**
 * 图层（Revit 的「可见性/图形」+ CAD 图层管理器的合并模型）。
 * 图层优先级高于构件自身 visible；锁定后构件不可移动/删除/改参数。
 */
export interface Layer {
  id: Id;
  name: string;
  /** 图层颜色；colorOverride 打开时覆盖材质色 */
  color: string;
  visible: boolean;
  locked: boolean;
  /** 是否用图层颜色替换构件材质色 */
  colorOverride?: boolean;
  /** 图层透明度 0–100，与材质透明度叠加 */
  transparency?: number;
}

/** 按类别的可见性/图形替换（Revit「模型类别」页）。 */
export interface CategoryOverride {
  visible: boolean;
  /** 类别颜色替换，留空表示用构件材质色 */
  color?: string;
  /** 类别透明度 0–100 */
  transparency?: number;
}

/** 参数单位标签；内核统一以「米 / 弧度 / 无量纲」存储，单位仅用于显示与字面量换算。 */
export type ParameterUnit = 'length' | 'area' | 'volume' | 'angle' | 'number' | 'count';

/**
 * 项目级全局参数（Revit「项目参数 / 共享参数」）。
 * formula 存在时 value 由 recomputeParameters 计算，界面只读。
 */
export interface ProjectParameter {
  id: Id;
  /** 唯一名称，公式中直接按名称引用（支持中文） */
  name: string;
  value: number;
  unit: ParameterUnit;
  formula?: string;
  description?: string;
  group?: string;
}

/** 参数公式表：键为参数键名，值为表达式。 */
export type FormulaMap = Record<string, string>;

/**
 * 尺寸别名：给一个尺寸路径起个人能念的名字。
 *
 * 路径写法见 shared/dimensions.js：`f3.height`（第 3 个特征的高）、
 * `f2.translate.1`、`param.height`、`primitive.width`。
 * 起名之后公式里可以直接写中文，例如 `{ name: '柱高', path: 'f2.height' }` → `'柱高': '层高 - 0.3'`。
 */
export interface DimensionAlias {
  /** 公式中引用的名字（可为中文），同一构件内唯一 */
  name: string;
  /** 尺寸路径 */
  path: string;
  /** 显示单位，缺省取尺寸本身的单位 */
  unit?: ParameterUnit;
  /** 显示名；缺省用尺寸标签 */
  label?: string;
}

/**
 * 校验式约束（只检查、不改值）。
 *
 * `expr` 写的是**要求**：表达式为假（0）即违规。
 * 例：`{ expr: '柱高 <= 层高 - 0.2', message: '柱高大于层高扣除梁高后的净空' }`。
 * 等式型约束（谁决定谁）用 element.formulas，不要写成 foo == bar —— 那只是检查相等，不会驱动。
 */
export interface CheckConstraint {
  id: Id;
  /** 布尔表达式，为假即违规 */
  expr: string;
  /** 违规时给用户看的说明；缺省用表达式本身 */
  message?: string;
  severity?: 'error' | 'warn';
}

/** 构件级约束定义：别名表 + 校验式（驱动式公式仍存 element.formulas）。 */
export interface ElementConstraints {
  dimensions?: DimensionAlias[];
  checks?: CheckConstraint[];
}


export interface WallType {
  id: Id;
  category: 'wall';
  name: string;
  thickness: number;
  materialId: Id;
  /** 类型参数 → 公式；例如 { thickness: '标准墙厚' } */
  formulas?: FormulaMap;
}

export interface ColumnType {
  id: Id;
  category: 'column';
  name: string;
  width: number;
  depth: number;
  materialId: Id;
  formulas?: FormulaMap;
}

export interface SlabType {
  id: Id;
  category: 'slab';
  name: string;
  thickness: number;
  materialId: Id;
  formulas?: FormulaMap;
}

/** 族类型（Revit 的 Type）。同一类型的实例共享尺寸参数。 */
export type FamilyType = WallType | ColumnType | SlabType;

export interface ElementBase {
  id: Id;
  name: string;
  /** 底部约束：所在标高 */
  levelId: Id;
  /** 类型引用；mesh 构件为空字符串 */
  typeId: Id;
  visible: boolean;
  /** 锁定（Revit Pin）：锁定后不能被移动 / 复制 / 删除，仍可改参数 */
  pinned?: boolean;
  /** 所属图层；缺省时按类别自动归属（兼容旧文档） */
  layerId?: Id;
  /** 图元级材质覆盖（Revit「按图元替换」）；缺省时取类型材质 */
  materialId?: Id;
  /** 实例参数 → 公式；改任一源参数后由 recomputeParameters 统一重算 */
  formulas?: FormulaMap;
  /** 约束：尺寸别名 + 校验式（驱动式公式见 formulas）。造型构件用得多，墙柱板也允许写 */
  constraints?: ElementConstraints;
}

export interface WallInstance extends ElementBase {
  category: 'wall';
  start: Vec2;
  end: Vec2;
  /** 相对底部标高的偏移，米 */
  baseOffset: number;
  /** 顶部约束：顶部标高 + 偏移 */
  topLevelId: Id;
  topOffset: number;
}

export interface ColumnInstance extends ElementBase {
  category: 'column';
  position: Vec2;
  /** 绕 Z 轴转角，弧度 */
  rotation: number;
  baseOffset: number;
  topLevelId: Id;
  topOffset: number;
}

export interface SlabInstance extends ElementBase {
  category: 'slab';
  /** 轮廓（平面坐标，逆时针或顺时针均可），厚度取自类型 */
  points: Vec2[];
  baseOffset: number;
}

/** 三维向量（米，Z-up） */
export type Vec3 = [number, number, number];

/** 阵列：把特征按线性步距、绕轴圆周复制，或镜像出一份（SolidWorks 的线性/圆周/镜像）。 */
export interface SolidPattern {
  type: 'linear' | 'circular' | 'mirror';
  /** 含原始体在内的总数量，1–192；mirror 忽略此值（恒为 2） */
  count?: number;
  /** 线性：每个副本的位移（米） */
  step?: Vec3;
  /** 圆周：旋转轴；镜像：镜面法向轴。缺省 z */
  axis?: 'x' | 'y' | 'z';
  /** 圆周：总角度（度），缺省 360 */
  angle?: number;
  /** 圆周：旋转中心；镜像：镜面上的一点。缺省原点 */
  center?: Vec3;
}

export interface SolidTransform {
  /** 平移（米） */
  translate?: Vec3;
  /** 绕局部轴旋转（度），顺序 X → Y → Z */
  rotate?: Vec3;
  /** 等比或分轴缩放 */
  scale?: number | Vec3;
}

/**
 * 放样截面。三种写法任选其一：
 * - `profile`：手写轮廓点（[[x,y], …]）；
 * - `ellipse`：参数化椭圆 / 超椭圆，由内核采样（机身、短舱这类）；
 * - `airfoil`：参数化翼型（NACA 四位），由内核采样（机翼、尾翼这类）。
 *
 * 参数化截面让「一个机身」从上千个坐标降到十几个数字，模型不必自己算三角函数。
 */
export interface LoftSection {
  /** 截面所在的 z（放样方向），米 */
  z: number;
  profile?: Vec2[];
  /** 椭圆：rx 沿 x、ry 沿 y；power=2 是椭圆，越大越"方"（机身剖面 2.2–2.6） */
  ellipse?: { rx: number; ry: number; power?: number };
  /** 翼型：弦长沿 x（前缘在 +x 侧），厚度沿 y；le 为前缘坐标，camber 为相对弯度 */
  airfoil?: { chord: number; thickness: number; le?: number; camber?: number };
  /** 截面整体偏移（米），在采样之后叠加 */
  offset?: Vec2;
  /** 截面自身扭转（度），绕截面原点 */
  twist?: number;
  /** 参数化截面的采样点数，缺省 24（椭圆）/ 20（翼型） */
  points?: number;
}

/** 造型特征的截面/实体形状。坐标均为特征局部坐标（米，Z-up，XY 以原点为中心）。 */
export type SolidShape =
  | { shape: 'box'; width: number; depth: number; height: number }
  /** 圆角盒：三条棱都倒圆，radius 为倒圆半径（0 < radius < 最短边的一半） */
  | { shape: 'roundedBox'; width: number; depth: number; height: number; radius: number; segments?: number }
  | { shape: 'cylinder'; radius: number; height: number; segments?: number }
  /** 圆管：radius 为外半径，thickness 为壁厚（内半径 = radius - thickness） */
  | { shape: 'tube'; radius: number; thickness: number; height: number; segments?: number }
  /** 胶囊：两端半球封头的圆柱，height 为总高（≥ 2×radius） */
  | { shape: 'capsule'; radius: number; height: number; segments?: number }
  | { shape: 'sphere'; radius: number; segments?: number }
  /** 椭球：三轴半径各自独立 */
  | { shape: 'ellipsoid'; rx: number; ry: number; rz: number; segments?: number }
  | { shape: 'cone'; radius: number; topRadius?: number; height: number; segments?: number }
  | { shape: 'torus'; radius: number; tube: number; segments?: number; tubeSegments?: number }
  /** 任意多边形拉伸；twist 为整体扭转角（度），taper 为顶面缩放 */
  | { shape: 'prism'; profile: Vec2[]; height: number; twist?: number; taper?: number }
  /** 母线（[半径, 高度]）绕 Z 轴旋转；angle 缺省 360 */
  | { shape: 'revolve'; profile: Vec2[]; segments?: number; angle?: number }
  /** 多个截面放样：sections 按 z 从下到上排列；截面可用手写轮廓或参数化椭圆 / 翼型 */
  | { shape: 'loft'; sections: LoftSection[] }
  /** 沿三维路径扫掠；taper 为起止缩放（[起, 止]），用于变截面管件 */
  | {
    shape: 'sweep';
    profile: Vec2[];
    /** 路径。给了 `onRoof` 时可以省略（路径由屋面曲面生成），仅作为兜底 */
    path?: Vec3[];
    closed?: boolean;
    taper?: [number, number];
    /**
     * 贴着同树某个瓦面（通常就是 `pv-tiles`）生成路径。
     *
     * 翼角处屋面被 cornerLift 抬起来、被 cornerOut 挑出去，封檐板 / 戗脊 / 角梁
     * 如果各走各的折线，角上必然错位：木头穿出瓦面、瓦面又露出望板。
     * 声明 onRoof 之后，这些构件用的是**和瓦面同一条** surface(u, s)，
     * 改 cornerLift / cornerOut 时它们会一起动。
     */
    onRoof?: RoofAttachment;
  }
  /** 点集凸包：用若干三维点围出流线外形（整流罩、机头） */
  | { shape: 'hull'; points: Vec3[] }
  /** 子特征组：把多个特征合成一个实体，再整体变换 / 阵列（用于螺旋桨这类子装配） */
  | { shape: 'group'; features: SolidFeature[] }
  /**
   * 瓦面：在多边形 / 圆形坡屋面上**逐片**铺瓦（板瓦凹弧 + 筒瓦半圆 + 逐层叠压 + 瓦当滴水）。
   *
   * 和「截面带波浪的放样」的区别：放样做出来是一条条圆脊（波纹），这里每一片瓦都是
   * 独立的有厚度薄壳，片与片之间沿坡向错开一个台阶，檐口有端头——远看是瓦，近看也是瓦。
   * 瓦片只往屋面上「加」，不参与布尔运算（`mode` 默认 add），所以几万面也不拖慢求值。
   */
  | {
    shape: 'tiles';
    /** 屋面轮廓：从檐口到顶点逐站给 (z, radius)，站间线性插值 = 举折/坡度曲线 */
    rings: Array<{ z: number; radius: number }>;
    /** 多边形边数（3–24）；0 = 圆形屋面 */
    sides?: number;
    /** 每条边（圆形为整圈）的瓦列数，也是筒瓦条数 */
    rows?: number;
    /** 每列沿坡向的瓦片层数 */
    courses?: number;
    /** 瓦厚（米），缺省 0.014 */
    thickness?: number;
    /** 每片瓦下缘抬起量（米），叠压台阶的来源，缺省 0.012 */
    lift?: number;
    /** 筒瓦半径（米），0 = 只铺板瓦 */
    crown?: number;
    /** 板瓦横向内凹深度（米） */
    sag?: number;
    /** 檐口内缩（米），给封檐板让位 */
    margin?: number;
    /**
     * 角部起翘高度（米）。> 0 时屋面在多边形**角**附近（靠近檐口的一段）整体抬起来，
     * 这就是「翼角」：屋面本身翘，而不是在角上另贴一块板。
     */
    cornerLift?: number;
    /** 角部外挑（相对半径的比例），和 cornerLift 一起决定角尖挑出去多远 */
    cornerOut?: number;
    /** 起翘在环向的影响范围：0.3 ≈ 从角到面中 60% 的范围，缺省 0.3 */
    cornerSpan?: number;
    /** 起翘沿坡向的影响深度（占坡长的比例），缺省 0.32 */
    cornerDepth?: number;
    /**
     * 瓦下衬板厚度（米），0 = 不画。
     *
     * 衬板直接用**瓦片的格子**生成（同一批曲面点、同一条法向），所以它必然在瓦面之下，
     * 不会出现「望板从瓦缝里顶出来」。翼角抬起来时衬板一起抬，也不会在角上张嘴。
     */
    board?: number;
    /** 是否铺瓦（默认 true）。false 时只出衬板，用来单独当一个「望板」特征 */
    showTiles?: boolean;
  };

/** sweep 贴瓦面的方式：沿坡向（角上从檐口到顶点）/ 环向（沿檐口绕一圈） */
export interface RoofAttachment {
  /** 参照的瓦面特征 id（在同一棵特征树里按 id 找） */
  surface: string;
  /** slope：沿坡向，路径是角上的一条线；ring：环向，路径是檐口一圈。缺省 slope */
  mode?: 'slope' | 'ring';
  /** 环向参数（slope 模式用）：0 = 多边形角上，1/边数 = 下一个角 */
  u?: number;
  /** 坡长（米，从檐口量起；ring 模式用），缺省 0.06 */
  s?: number;
  /** slope 模式的起止坡长 [起, 止]（米）；省略 = 从檐口到顶点 */
  range?: [number, number];
  /** 沿屋面外法向的偏移（米）：负值压进瓦面以下（角梁/封檐板），正值浮在瓦面之上（戗脊） */
  offset?: number;
  /** 采样点数，缺省 14 */
  samples?: number;
  /** 檐口端额外抬起（米），做翼角翘尖 */
  tipLift?: number;
}

/**
 * 特征级材质（造型实体的「按零件上色」）。
 *
 * 只描述外观，不影响几何：求值时按材质的取值分组，用 geometry.groups 做多材质渲染。
 * 缺省时跟随构件材质（材质浏览器里指派的那一个）。
 */
export interface SolidMaterial {
  /** 显示名，例如「阳极氧化铝」；从预设展开时会自动带上 */
  name?: string;
  /** 颜色 #rrggbb */
  color?: string;
  /** PBR 粗糙度 0–1（0 镜面，1 全漫反射） */
  roughness?: number;
  /** PBR 金属度 0–1（金属 0.9+，塑料/橡胶 0–0.05） */
  metalness?: number;
  /** 不透明度 0–100，缺省 100 */
  opacity?: number;
}

/**
 * 倒圆（棱边圆角）。写数字即可，写对象可以顺带指定采样分段。
 *
 * 只对**凸体**成立：内核的做法是「内缩 r → 拿半径 r 的球滚一遍 → 等价外扩」，
 * 非凸体会被滚成自己的凸包，所以内核会原样返回、不做倒圆。
 */
export interface SolidFillet {
  /** 圆角半径（米） */
  radius: number;
  /** 球面采样分段，缺省 24；只影响圆角本身的圆滑度 */
  segments?: number;
}

/** 抽壳：把实体掏空成一层壁厚。 */
export interface SolidShell {
  /** 壁厚（米），上限为实体最短边的 45% */
  thickness: number;
  /** 开口面：x+ / x- / y+ / y- / z+ / z-，可给数组开多个面；不给就是全封闭空腔 */
  open?: string | string[];
}

/** 曲面偏移：正数外扩、负数内收（米）。 */
export interface SolidOffset {
  distance: number;
}

/** 造型特征：形状 + 变换 + 材质 + 与已有实体的布尔方式 + 可选阵列。 */
export interface SolidFeature extends SolidTransform {
  id: Id;
  /** 界面显示名，例如「机身」「电机阵列」 */
  label?: string;
  /** 与已有实体的合并方式：add 合并 / cut 切除 / intersect 相交；首个特征恒为 add */
  mode?: 'add' | 'cut' | 'intersect';
  pattern?: SolidPattern;
  /** 该零件的材质；缺省时跟随构件材质，子装配里缺省则继承父级 */
  material?: SolidMaterial;
  /** 曲面偏移（米，正外扩负内收），在倒圆/抽壳之前生效 */
  offset?: number | SolidOffset;
  /** 棱边倒圆（只对凸体生效），在抽壳之前生效 */
  fillet?: number | SolidFillet;
  /** 抽壳壁厚（米），最后生效 */
  shell?: number | SolidShell;
  shape: SolidShape;
}

/**
 * 贴花（涂装 / 文字 / logo）：一块带贴图的平面，贴在构件表面上。
 *
 * 文字档由视口用 canvas 现场渲染成贴图（不需要素材），图片档给 data URL。
 * 平面局部位于 XY、法向 +Z，用 `normal` 一次性转到 ±X / ±Y / ±Z 朝向，
 * 再靠构件的 offset / rotation / flip 摆到目标面上。
 */
export interface DecalSpec {
  kind: 'decal';
  width: number;
  height: number;
  /** 贴图朝向（法向，可加负号表示朝反方向），缺省 z；机身左右两侧用 y / -y */
  normal?: 'x' | 'y' | 'z' | '-x' | '-y' | '-z';
  /** 文字内容（与 image 二选一，text 优先） */
  text?: string;
  /** 图片贴图（data:image/…），文字档不填 */
  image?: string;
  /** 文字颜色，缺省 #ffffff */
  color?: string;
  /** 底色（不需要时留空 = 透明） */
  background?: string;
  /** 字体族，缺省系统无衬线 */
  font?: string;
}

/** 参数化基本体：拉伸体、旋转体、长方体、圆柱、球、棱锥、贴花，以及特征造型实体。 */
export type PrimitiveSpec =
  | { kind: 'box'; width: number; depth: number; height: number }
  | { kind: 'cylinder'; radius: number; height: number; segments: number }
  | { kind: 'sphere'; radius: number; segments: number }
  | { kind: 'extrude'; profile: Vec2[]; height: number }
  | { kind: 'revolve'; profile: Vec2[]; segments: number }
  | { kind: 'pyramid'; radius: number; height: number; sides: number }
  | { kind: 'solid'; features: SolidFeature[] }
  | DecalSpec;


/**
 * 参数化模型：文档里只存「模板 + 参数」，几何在求值时由生成器重建。
 *
 * 这是「改柱高，屋顶跟着升」的关键——特征树是按参数算出来的结果，不是源数据。
 * `primitive.features` 里仍保留一份快照（导出 / 明细 / 只读展示用），
 * 但求值优先走模板：参数改了，快照旧了也不影响几何。
 */
export interface ParametricModel {
  /** 模型 id，见 shared/models/*.json（带 params + bindings 的文档才是参数化构件） */
  template: string;
  /** 参数值（米 / 度 / 个数），键名与模板定义一致 */
  params: Record<string, number>;
}

/** 未参数化的导入几何（STEP/OBJ/布尔结果）或参数化基本体。 */
export interface MeshInstance extends ElementBase {
  category: 'mesh';
  /** 参数化基本体存在时 positions / indices 可为空，几何按参数实时生成 */
  positions: number[];
  indices: number[];
  vertexColors?: number[];
  color: string;
  /** 来源描述，例如 “STEP 导入” */
  source: string;
  /** 整体平移量（米），避免移动大网格时重写全部顶点 */
  offset?: [number, number, number];
  /** 绕 Z 轴的整体旋转（弧度），先旋转再平移 */
  rotation?: number;
  /** 整体缩放（缩放命令用，不重写顶点） */
  scale?: number;
  /** 局部 Y 轴镜像标记（任意轴镜像用，不重写顶点） */
  flip?: boolean;
  /** 参数化基本体定义 */
  primitive?: PrimitiveSpec;
  /**
   * 参数化模型（模板 + 参数）。存在时几何由生成器按参数重建，
   * 改一个数就能让整组尺寸联动；手动改特征树即视为断开参数化。
   */
  parametric?: ParametricModel;
}

export type BimElement = WallInstance | ColumnInstance | SlabInstance | MeshInstance;

export type ElementCategory = BimElement['category'];

export interface ProjectDocument {
  schemaVersion: 2;
  id: string;
  name: string;
  updatedAt: string;
  units: 'metric';
  levels: Level[];
  grids: Grid[];
  materials: Material[];
  /** 图层表；旧文档无此字段时由 migrateDocument 补齐默认图层 */
  layers?: Layer[];
  /** 按类别的可见性/图形替换；旧文档缺省时全部可见 */
  categoryOverrides?: Partial<Record<ElementCategory, CategoryOverride>>;
  /** 全局参数表；旧文档无此字段时由 migrateDocument 补默认参数（不自动绑定公式） */
  parameters?: ProjectParameter[];
  types: FamilyType[];
  elements: BimElement[];
}

export const categoryLabels: Record<ElementCategory, string> = {
  wall: '墙',
  column: '柱',
  slab: '楼板',
  mesh: '导入几何',
};
