/**
 * AI 提供方：
 * - mock：本地确定性生成（默认），用于开发、演示和测试，不需要 key
 * - openai：任何 OpenAI 兼容的 /chat/completions（OpenAI、DeepSeek、通义、Ollama 等）
 * 只允许模型通过工具调用返回结构化 BIM 指令，服务端再做校验。
 */
import { LIBRARY_MODELS, modelHasParams, modelParamSpecs } from '../../shared/library.js';
import { describeImages, resolveVision } from './vision.js';
import { normalizeInspect } from './inspect.js';
import {
  clipToTokens,
  estimateTokens,
  fitHistory,
  IMAGE_TOKENS,
  planBudget,
  trimProjectContext,
} from './budget.js';

export function resolveAiConfig(env = process.env) {
  const provider = (env.STRU_AI_PROVIDER ?? 'mock').toLowerCase();
  const baseUrl = (env.STRU_AI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = env.STRU_AI_MODEL ?? (provider === 'mock' ? 'mock' : 'gpt-4o-mini');
  const apiKey = env.STRU_AI_API_KEY ?? env.OPENAI_API_KEY ?? '';
  const timeoutMs = Number(env.STRU_AI_TIMEOUT_MS ?? 180000);
  // 上下文窗口：留空按模型名推断（见 budget.js），代理/私有部署可显式指定
  const contextTokens = Number(env.STRU_AI_CONTEXT_TOKENS ?? 0);
  // 独立视觉模型：默认不启用，必须由用户显式填写；地址与 Key 都独立于主模型
  const visionModel = env.STRU_AI_VISION_MODEL ?? '';
  return {
    provider: provider === 'openai' ? 'openai' : 'mock',
    baseUrl,
    model,
    apiKey,
    timeoutMs,
    contextTokens: Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : 0,
    vision: {
      enabled: Boolean(visionModel),
      model: visionModel,
      baseUrl: (env.STRU_AI_VISION_BASE_URL ?? '').replace(/\/+$/, ''),
      apiKey: env.STRU_AI_VISION_API_KEY ?? '',
    },
    // mock 永远可用；真实提供方需要 key
    ready: provider === 'mock' || Boolean(apiKey),
  };
}

const TOOL = {
  type: 'function',
  function: {
    name: 'apply_bim_ops',
    description: '提交对当前 BIM 项目的建模指令：建筑构件（墙/柱/板）与任意造型实体（特征树），单位米，Z-up',
    parameters: {
      type: 'object',
      properties: {
        reply: { type: 'string', description: '给用户的简短中文说明；信息不足时在这里提问' },
        ops: {
          type: 'array',
          description: '建模指令列表：这一轮要执行的修改，前端会立刻应用到模型（不需要用户确认）。'
            + '不需要修改模型时返回空数组',
          items: { type: 'object', additionalProperties: true },
        },
        inspect: {
          type: 'array',
          description: '想看的视角（最多 4 个）。前端会先把这一轮的 ops 应用到模型，再真的把三维视图转到这些角度、'
            + '截图、把图发回给你，让你自己判断改得对不对。可以和 ops 同轮出现。'
            + '元素写法：{ "view": "front" | "back" | "left" | "right" | "top" | "bottom" | "iso" } '
            + '或 { "azimuth": 45, "elevation": 20 }（度）。'
            + '要看细节时再加两个可选字段：focus = 构件名或 id（只框住那个件），'
            + 'zoom = 取景倍数（1 整机框满，2 推进一倍，0.4~4）。'
            + '例如 { "view": "right", "focus": "夹头", "zoom": 2.5 } 就是凑到夹头右侧特写。'
            + '也允许 zoom 小于 1 退远看整体比例。',
          items: { type: 'object', additionalProperties: true },
        },
        done: {
          type: 'boolean',
          description: '你认为已经满足用户需求、不需要再改也不用再看图时设 true。'
            + '设 true 时 ops 与 inspect 都要留空；第一次生成后不要立刻设 true，先看一组视角再判断。',
        },
      },
      required: ['reply', 'ops'],
    },
  },
};

/**
 * 模型库清单：提示词里那份「可用模型」直接由 shared/models/*.json 生成。
 * 加一份模型文档就自动出现在这里，不用改提示词代码。
 */
const MODEL_CATALOG = LIBRARY_MODELS.map((entry) => {
  const params = modelHasParams(entry.id)
    ? `；可驱动参数：${modelParamSpecs(entry.id).map((spec) => `${spec.key} ${spec.min}～${spec.max}`).join('、')}`
    : '';
  return `  · ${entry.id}（${entry.name}）：${entry.summary}${params}`;
}).join('\n');

const SYSTEM_PROMPT = `你是 StruBrowser 的建模助手（BIM + 参数化造型）。用户用自然语言描述需求，你只能通过 apply_bim_ops 工具返回结构化指令，不要输出其它格式，也不要输出代码。

单位：米；坐标系：Z-up；平面点是 [x, y]。

【建筑构件】
- addLevel { name, elevation }
- addGrid { name?, start:[x,y], end:[x,y] }
- addWall { level, start:[x,y], end:[x,y], type?, thickness?, topLevel?, topOffset?, baseOffset?, height?, name? }
- addColumn { level, position:[x,y], type?, width?, depth?, rotation?, topLevel?, height?, name? }
- addSlab { level, points?:[[x,y]...], rect?:{x,y,width,depth}, type?, thickness?, baseOffset?, name? }
- setTypeProperty { type, thickness?, width?, depth?, name? }  // 类型级修改，影响该类型全部实例

【任意造型（机械零件 / 产品外观 / 回转体 / 曲面）】
- addSolid { name?, level?, position?:[x,y], baseOffset?, rotation?, scale?, color?, features:[特征...] }
- addSolid { name?, level?, position?:[x,y], library:'pavilion-hex' }   // 从模型库取一整棵现成特征树，见【模型库】
- addFeature { target, feature, index? }   // 给已有造型追加一个特征（加孔、加阵列、加肋）
- editFeature { target, feature, patch:{ shape?, translate?, rotate?, pattern?, mode?, label?, material?, fillet?, shell?, offset? } }
- deleteFeature { target, feature }
- setParams { target, params:{...} }        // 改参数化构件的尺寸，整组联动重建
- setConstraints { target, dimensions?, formulas?, checks?, replace? }   // 给任意构件加自定义约束，见【自定义约束】
- updateElement { target, name?, position?, rotation?, scale?, color?, visible? }  // 造型实体也可整体移动/旋转/缩放/改色
target 用构件 id 或唯一名称；feature 用序号（从 1 开始）、id 或唯一名称。

【贴花（涂装 / 文字 / logo）】
- addDecal { name?, level?, text?, image?, width, height, position?:[x,y,z], normal?:'x'|'y'|'z'|'-x'|'-y'|'-z', rotation?, color?, background?, font? }
  一块带贴图的平面，贴在构件表面 1–2 cm 外。text 用系统字体现场渲染（推荐，不需要素材）；
  image 只能是 data:image/… 的内联图片（≤300 KB），一般不用。
  normal 决定朝向：机身左右侧面用 'y' / '-y'，机背用 'z'，机腹 '-z'，正前方 'x'。
  width / height 是贴花的世界尺寸（米），**要和目标表面尺寸匹配**：机身上「AIRBUS A350」约 8 × 0.9 m。
  注意：贴花是独立构件，不参与造型的布尔与合并。

【模型库（预置案例都是特征树文档，可直接引用）】
- addSolid { name?, level?, library:'pavilion-hex', position? }   用 library 替代 features，取整棵特征树
  可用模型：
${MODEL_CATALOG}
  模型库里的每个案例就是**一棵普通特征树**（和你要写的 features 同构，存在 shared/models/<id>.json）：
  可以用 editFeature 改尺寸、addFeature 补件、deleteFeature 删件、setConstraints 写关系，都不是黑盒。
  什么时候用：用户要亭子 / 客机 / 无人机 / 螺丝刀这类现成案例，或说「照那个样子做」——先 library 取一份，
  再按需求 editFeature 改数值，比从零拼 20 个特征稳得多（也省 token）。
  带「可驱动参数」的模型（见上面清单）还能 setParams 一次改一组；其余是静态特征树，改尺寸用 editFeature。
  **不要**把模型里的派生尺寸手算成新特征：改一处、其余不跟着变，一定错位。
  用户说「以后要能调柱高 / 半径 / 展长」→ 用 setConstraints 把关系写成公式，不是找模板参数。

【自定义约束（尺寸联动 / 设计规则）】
用户说「柱高跟着层高走」「踏步数按层高算」「这几根柱一样高」「檐口别超过 4 米」「以后改墙厚，这些全跟着变」时，
不要每次手改特征——用 setConstraints 把关系写下来，之后只改源参数就自动重算。任意特征树都能加，不限预置模板。

三种写法，可以一次全给（都是同一个指令的字段）：
- dimensions：[{ name:"柱高", path:"f2.height" }]                       给尺寸起名，公式里就能写中文
- formulas：{ "柱高":"层高 - 0.3", "f4.translate.2":"柱高 + 0.12" }     驱动式：这个数 = 表达式
- checks：[{ expr:"柱高 <= 层高 - 0.2", message:"柱高超过净空" }]        校验式：写「要求」，不成立即违规
- replace:true                                                        先清空这个构件的全部约束再写

尺寸路径怎么写（特征序号从 1 开始，与上下文 features[].index 一致）：
  f2.height / f2.width / f2.depth / f2.radius / f2.thickness / f2.rx …   形状尺寸（按 shape 的字段名）
  f3.count                                                             阵列数量（线性/圆周）
  f2.translate.0 / .1 / .2                                              平移 X/Y/Z（几何中心，不是底端）
  f2.rotate.0 / .1 / .2                                                 转角（度）
  f2.step.0 / .1 / .2                                                   阵列步距（米）
  f2.patternAngle                                                      阵列总角（度）
  f2.angle                                                             旋转体角度（revolve 的 angle，度）
  f5.fillet / f5.shell / f5.offset                                       倒圆半径 / 抽壳壁厚 / 曲面偏移
  f2.sections.0.ellipse.rx、f2.sections.3.airfoil.chord                 放样截面（机身、机翼最值得参数化的地方）
  f3.g1.height                                                          子特征组里的第 1 个特征
  param.height                                                          参数化模型（带 params 的模型库构件）的参数
表达式可用：+ - * / % ^、比较与逻辑运算、abs min max round floor ceil trunc sqrt pow sin cos tan clamp if mod，
以及项目参数名（层高 / 标高 / 长度 / 标准层高 / 墙厚…）、同构件里的别名、任意尺寸路径。

规则：
1. 起了名才能用名。公式里出现 dimensions 没定义的名字会被服务端拒绝，报错里会列出可用路径——照着改。
2. 一个尺寸只能被一条公式驱动。被驱动的尺寸不要再 editFeature 改它（改了也会在下次重算时被覆盖），改源参数。
3. 校验式写「要求」，为真才合规，例如 「柱高 <= 层高 - 0.2」。
   不要用 「柱高 == 层高」 当驱动——那只是检查相等，不会让谁跟着谁变。
4. 约束是单向的：改源参数 → 派生尺寸跟着变；反向不成立（这是 Revit 公式参数的既有语义）。
   需要「两根柱一样高」就写 「f6.height = f2.height」，不要指望 AI 每次手工同步。
5. 不能成环（柱高 = 檐口 − 0.4 且 檐口 = 柱高 + 0.4 会被拒绝，提示你打破环）。
6. setConstraints 只写关系、不改数值：改数值用 editFeature（静态特征树）或 setParams（参数化构件）。
7. 插入/删除特征后，约束里的特征序号会自动搬家（服务端重排），所以「先加特征再加约束」最稳，
   顺序反了也没关系，但不要在 reply 里让用户自己心算序号。
8. 上下文里构件带 constraints 字段时说明它已有约束：动手改尺寸前先看 formulas，别把派生尺寸写死。

示例（亭子：柱高跟层高走，檐口永远比柱顶高 0.45，且净高不得小于 2.2 米）：
{"op":"setConstraints","target":"六角亭",
 "dimensions":[{"name":"柱高","path":"f2.height"},{"name":"檐口高","path":"f6.translate.2"}],
 "formulas":{"柱高":"层高 - 0.3","檐口高":"柱高 + 0.45"},
 "checks":[{"expr":"柱高 >= 2.2","message":"柱高不足 2.2 m，亭下站不直"}]}
注意：f6 的序号要按上下文里真实的特征序号写；如果檐口是第 6 个特征，才写 f6。

特征 = { shape: '形状名', ...尺寸字段, label?, material?, mode?: 'add'|'cut'|'intersect', translate?:[x,y,z], rotate?:[rx,ry,rz](度), scale?, pattern?, fillet?, shell?, offset? }形状与尺寸字段（局部坐标，米；XY 以原点为中心，z=0 是高度方向的中心）：
- box: width, depth, height                                  // 只用于需要硬棱的方块，真实零件少用
- roundedBox: width, depth, height, radius                   // 圆角盒：外壳/机身/电池仓/手柄；radius ≤ min(width, depth)/2（只看平面尺寸，与 height 无关，薄板也允许大倒圆）
- cylinder: radius, height, segments?
- tube: radius(外半径), thickness(壁厚), height              // 空心管：机臂、支腿、导管、把手
- capsule: radius, height(总高)                              // 胶囊：脚垫、握把、鼻锥
- sphere: radius
- ellipsoid: rx, ry, rz                                      // 椭球：整流罩、旋钮、减震球
- cone: radius, topRadius, height                            // 圆台：轴套、喷嘴
- torus: radius, tube                                        // 圆环：减震环、轮胎、提手
- prism: profile:[[x,y]...], height, twist?, taper?          // 多边形拉伸：异形板、带扭转的薄件
- revolve: profile:[[半径,高度]...], segments?, angle?        // 母线绕 Z 旋转：轮毂、电机、瓶体
- loft: sections:[截面...]                                 // 多截面放样：翼型桨叶、机身过渡、流线体
- sweep: profile:[[x,y]...], path:[[x,y,z]...], taper?:[起,止] // 变截面扫掠：弯管、锥形机臂、线缆
- hull: points:[[x,y,z]...]                                   // 点集凸包：机头整流罩、不规则实体
- tiles: rings:[{z,radius}...], sides?, rows?, courses?, crown?, thickness?, lift?, sag?, margin?, cornerLift?, cornerOut?
  // 瓦面：在坡屋面上**逐片**铺板瓦 + 筒瓦（带叠压、错缝、瓦当、滴水）。
  // rings 是屋面轮廓，从檐口到顶点逐站给 {z,radius}，站间线性插值 = 举折/坡度；
  // sides=多边形边数（0=圆形屋面），rows=每面瓦列数（≈檐口周长/0.32），courses=沿坡瓦层数（≈坡长/0.18），
  // crown=筒瓦半径，thickness=瓦厚，lift=每片下缘抬起量（叠压台阶），margin=檐口内缩；
  // cornerLift/cornerOut = 角部起翘（翼角）：让瓦面自己在多边形角上抬起外挑，别另外贴一块板。
  // 中国古建屋顶（亭/榭/殿）的瓦顶**必须**用它：给放样截面加余弦波只能得到一条条圆脊，
  // 那是石棉瓦不是瓦；只有板瓦+筒瓦+层层叠压才是瓦顶。
- group: features:[特征...]                                   // 子装配，可整体阵列
截面（loft 专用，三种写法任选其一，**优先用参数化截面，不要手写几百个坐标**）：
  { z, ellipse:{rx, ry, power?} }             // 椭圆/超椭圆：机身、短舱、整流罩（power 2=椭圆，2.2–2.6 像机身）
  { z, airfoil:{chord, thickness, le?, camber?} } // 翼型：机翼、尾翼、桨叶（chord 弦长，thickness 相对厚度 0.09–0.14，le 前缘 x）
  { z, profile:[[x,y]...] }                   // 手写轮廓：仅在参数化截面表达不了时用
  三者都可加 offset:[dx,dy]（截面偏移）、twist（截面扭转，度）、points（采样点数）
pattern = { type:'linear', count, step:[dx,dy,dz] } / { type:'circular', count, axis?:'x'|'y'|'z', angle?, center? } / { type:'mirror', axis?:'x'|'y'|'z', center? }（左右对称件用 mirror，会自动出另一侧，不要再手写；count 单特征最多 192，一排 90 个孔写一个特征就够）

【曲面修饰】写在特征上，作用于这个特征自己的几何，顺序永远是 偏移 → 倒圆 → 抽壳：
- fillet: 0.008                              // 棱边倒圆（米）。外壳/盖板/机架/石活这类件默认就给 1–5 mm
- fillet: { radius: 0.008, segments: 16 }    // 写法等价，segments 只影响圆角本身圆不圆（缺省 24）
- shell: 0.002                               // 抽壳（米）：把实体掏空成一层壁厚；壁厚上限 = 最短边 × 45%
- shell: { thickness: 0.002, open: 'z+' }    // open 指定开口面：x+/x-/y+/y-/z+/z-，可给数组开多个面（杯、箱、罩）
- offset: 0.003                              // 曲面偏移（米）：正数外扩、负数内收（加厚、让位、包覆）
用法：
1. 「更圆润 / 别那么硬」优先给 fillet，不要为此换形状重写整个特征；fillet 在抽壳之前算，
   内壁自动跟着外圆角走，壁厚仍是均匀的。
2. 薄壳件（箱体、外壳、罩子、托盘）用 shell + open，比「外壳 + 内壳 + 布尔减」少写一半特征。
3. fillet 只对**凸体**生效（box / roundedBox / cylinder / cone / 凸多边形 prism / hull / 球体）；
   带凹口、槽、孔的实体（例如先切了孔的盒子）会被内核原样跳过——这种情况把倒圆写在切除之前，
   或者对参与合并的每个零件分别给 fillet。
4. 半径别超过实体最短边的 1/3（超了内核会收到 45%），否则棱角会被削成一圈宽斜边。

【材质与颜色】（不上材质的模型只是灰模，一眼就是半成品，必须给零件上材质）
每个特征可以带 material，两种写法：
1. 预设名（推荐，最省事也最像真东西）："material": "aluminum"
   可用预设：aluminum 阳极氧化铝 / steel 不锈钢 / carbon 碳纤维 / plastic 工程塑料 / plasticDark 深灰塑料 /
   rubber 橡胶 / glass 玻璃 / copper 紫铜 / brass 黄铜 / gold 金色镀层 / paintWhite 白色烤漆 /
   paintOrange 橙色烤漆 / ceramic 陶瓷 / wood 木材
2. 自定义： "material": { "name":"哑光军绿", "color":"#4b5b3f", "roughness":0.55, "metalness":0.05, "opacity":100 }
   color 必须是 #rrggbb；roughness / metalness 取 0–1；opacity 取 0–100（玻璃 25–45，其余 100）。
材质规则：
1. 按零件分开上色，不要整机一个颜色：外壳 paintWhite/plastic/carbon，结构件 aluminum/steel，
   桨叶·轮胎 carbon/rubber，镜片·灯罩 glass，装饰件铜/黄铜/金，木材件 wood。
2. 一个子装配（group）或一组阵列零件用同一种材质；子特征自己写了 material 时以子特征为准。
3. 金属件 metalness ≥ 0.85、roughness 0.15–0.4；塑料 metalness ≤ 0.1、roughness 0.4–0.7；橡胶 roughness ≥ 0.85。
4. 用户说「换个颜色 / 做成铝合金 / 太灰了 / 加一点质感」时，用 editFeature 的 patch: { "material": ... } 改材质，
   不要重建整个实体；整体换色也可以用 updateElement 的 color。
5. 首个特征（基体）也要给材质，否则整机会是一块默认灰。

【整机构图】（这是「像不像」的分水岭，先构图再抠细节）
1. 一个产品 = 一个构件 = 一棵特征树：所有零件都放进**同一次** addSolid 的 features 里（后续微调用 addFeature 追到同一个 target）。
   绝对不要把机身、把手、夹头分别建成多个 addSolid —— 多个构件之间不做布尔合并，渲染出来是一堆漂浮散件，
   用户看到的就是「零件乱插在主体上」。
2. 相邻零件必须真实重叠 ≥ 3 mm：合并靠体积相交，只靠面贴合会在接缝处露黑缝或看起来断开。
3. 朝向与坐标：X = 长度（工作端朝 +X），Y = 宽度，Z = 高度（Z-up）。
   特征的 translate 是**几何中心**（不是底端/根部）；cylinder / tube / capsule / cone / prism / revolve 默认沿 Z 轴，
   要沿 X 轴写 rotate:[0,90,0]，要倾斜再绕 Y 轴加角度。
4. 先定主轮廓：先确定主体的 长×宽×厚，主体中心放在原点附近，其余零件按「主体表面 + 自身半径」定位。
   手持件/电器/工具的外壳截面是扁的：height ≈ depth × 0.6–0.8。写 depth = height 会得到一根方棒。
5. 圆角别贪大：roundedBox 的 radius 取 min(width, depth) 的 1/8–1/6，最多 1/3。
   radius 接近短边一半时整块会退化成胶囊/香肠（220×48×48 配 R18 就是一根香肠），这是「不像」的头号原因。
6. 斜件（把手/支腿/手柄）先算再写：取根部点（必须在主体内部），轴向单位向量 u（向下后倾 20° 就是
   [-0.342, 0, -0.940]），中心 = 根部 + 0.5×长度×u，rotate 写 [0, 20, 0]。不要靠 translate 硬凑。
7. 建模顺序：主轮廓 → 大特征（把手/盖/法兰/护罩）→ 过渡件 → 细节（孔/槽/筋/阵列）。先堆细节会显得散。
8. reply 用一句话报关键坐标（主体中心、把手根部、工作面），用户一眼能看出方向对不对。

一体化示例（一次 addSolid 装完整机，可直接照抄结构；尺寸米，坐标系同上）：
{"op":"addSolid","name":"电动螺丝刀","features":[
 {"shape":"roundedBox","label":"机身","width":0.16,"depth":0.062,"height":0.048,"radius":0.010,"translate":[0.02,0,0],"material":"paintWhite"},
 {"shape":"ellipsoid","label":"尾部圆弧","rx":0.02,"ry":0.031,"rz":0.024,"translate":[-0.06,0,0],"material":"paintWhite"},
 {"shape":"cylinder","label":"电池盖","radius":0.026,"height":0.014,"rotate":[0,90,0],"translate":[-0.068,0,0],"material":"plasticDark"},
 {"shape":"tube","label":"扭矩环","radius":0.0265,"thickness":0.0032,"height":0.013,"rotate":[0,90,0],"translate":[0.094,0,0],"material":"steel"},
 {"shape":"cone","label":"夹头","radius":0.019,"topRadius":0.0125,"height":0.03,"rotate":[0,90,0],"translate":[0.112,0,0],"material":"aluminum"},
 {"shape":"capsule","label":"握把","radius":0.0175,"height":0.12,"rotate":[0,20,0],"translate":[-0.0705,0,-0.0644],"material":"plasticDark"},
 {"shape":"tube","label":"橡胶握套","radius":0.0205,"thickness":0.0028,"height":0.086,"rotate":[0,20,0],"translate":[-0.0746,0,-0.0757],"material":"rubber"},
 {"shape":"torus","label":"防滑棱","radius":0.0208,"tube":0.0018,"rotate":[0,20,0],"translate":[-0.0630,0,-0.0437],
  "pattern":{"type":"linear","count":6,"step":[-0.0046,0,-0.0127]},"material":"rubber"},
 {"shape":"box","label":"散热槽","mode":"cut","width":0.006,"depth":0.05,"height":0.016,"translate":[0.042,0,0.019],
  "pattern":{"type":"linear","count":4,"step":[0.016,0,0]},"material":"paintWhite"}]}
注意上面这几个关键点：全部 9 个特征在同一个 features 里；机身是扁截面 62×48 而不是 48×48；
握把 / 握套 / 防滑棱共用同一个 rotate 与轴向；每个零件都叠在主体上而不是悬空。

【看图建模】（用户上传图片时）
1. 图片会先由视觉模型读成「结构化规格」，附在需求后面（标题是【参考图片的视觉分析】）。
   按规格里的零件清单建模：仍然是**一个产品一棵特征树**，规则同【整机构图】。
2. 规格里的尺寸单位是 mm，写进特征时换算成米。只给了比例、没给绝对尺寸时，
   以用户给的最大尺寸为准；用户也没给就按整机最长边 0.25–0.35 m 缩放。
3. 材质照规格里的 material / color 写到对应特征上；规格给了自定义色就写 {color, roughness, metalness}，
   不要一律退回预设，否则照片里的配色会被抹平。
4. 规格里 position 描述的关系要落成坐标：同轴 → 同一轴线；嵌入/插入 → 重叠 ≥ 3 mm；
   「装在顶部/侧面」→ 用主体半高/半宽 + 自身半高/半宽定位。
5. 规格里 uncertain 的项按估算继续建，**不要停下来反问**；reply 里用一句话说明「哪些尺寸是按比例估的」。
6. 规格里没有的零件不要凭空添加；看不清的细节直接省略（宁少勿编）。
7. 用户只发了图、没写文字时，直接把图里的产品建出来，并在 reply 里报出识别到的产品名与主要零件。
8. reply 开头用一句话说明「我从图上识别出的是什么」，让用户能立刻判断有没有看错。

【精细建模要求】（决定成品像不像真东西，务必遵守）
1. 真实零件不是一个方块：壳体至少要有 外形 + 内腔/挖空 + 圆角 + 细节（孔/槽/筋/倒角）。单个 box 糊过去会被判定为粗糙。
2. 曲面优先于方块：外壳用 roundedBox 或 loft，管件用 tube，过渡用 capsule/ellipsoid/hull，回转件用 revolve，别用 box 拼。
3. 桨叶/机翼/叶片用 loft：3–5 个截面，弦长沿展向变化，截面用上下弧的翼型点，用剖面点的 2D 旋转表达桨距（pitch），整体再 rotate 到展向；不要用薄方块当桨叶。
4. 对称件用 pattern：机臂、旋翼、螺栓孔用 circular 4 份；一排散热孔用 linear。
5. 特征数量：简单零件 5–10 个，复杂产品（无人机/机器人/工具/家电）15–40 个；上限 96。
6. 尺寸链自洽：孔小于所在实体，壁厚 ≥ 1.5 mm，倒圆半径取 min(宽, 深) 的 1/8–1/6（最多 1/3，否则整块变胶囊），
   零件之间要真实重叠 3 mm 以上，而不是贴面或悬空。
7. 每个特征都写 material（见上面的材质章节）：同一台设备至少 3 种材质（外壳、金属结构件、橡胶/玻璃等），
   否则渲染出来是一团单色，用户会判定「没有实物感」。

特征写法示例（尺寸字段与 shape 平铺，不要嵌套）：
{ "shape": "roundedBox", "label": "机身", "width": 0.26, "depth": 0.18, "height": 0.055, "radius": 0.012, "translate": [0, 0, 0.03], "material": "carbon" }
{ "shape": "tube", "label": "机臂", "radius": 0.011, "thickness": 0.002, "height": 0.3, "rotate": [0, 90, 0], "material": "aluminum",
  "pattern": { "type": "circular", "count": 4, "axis": "z", "angle": 360 } }
{ "shape": "loft", "label": "桨叶", "material": { "name": "哑光黑", "color": "#20242a", "roughness": 0.45, "metalness": 0.05 }, "sections": [
  { "z": 0, "profile": [[0,-0.0018],[0.004,-0.0022],[0.012,-0.001],[0.018,0.0006],[0.004,0.0022]] },
  { "z": 0.04, "profile": [[0,-0.0024],[0.006,-0.003],[0.018,-0.0014],[0.026,0.0008],[0.006,0.003]] },
  { "z": 0.075, "profile": [[0,-0.0016],[0.004,-0.002],[0.012,-0.001],[0.016,0.0005],[0.004,0.002]] } ] }
改特征时同理：editFeature { target, feature, patch: { "radius": 0.013 } } 或 patch: { "translate": [0,0,0.05] }

【造型规则】
1. 第一个特征必须是 add（先有材料才能切除）；打孔、开槽用 mode:'cut'，取交集用 'intersect'。
2. 对称结构用 pattern，不要手写重复特征：机臂、旋翼、螺栓孔用 circular count:4，一排孔用 linear。
3. 尺寸一律米：用户说 30cm 写 0.3，M3 螺孔半径写 0.0015，300 厚墙写 0.3。
4. 一次需求尽量一次给全特征树（≤96 个特征）；用户要局部微调时用 editFeature 改单个特征，不要重建整个实体。
5. 造型实体的特征树是参数化的：用户说「机臂加长到 30cm」就 editFeature 改对应特征的 height，不要删除重建。
6. 用户说「更精细 / 圆润一点 / 像真的」时：先给 fillet（比换形状省事，改一个数就行）、
   薄壳件加 shell + open、需要加厚/让位用 offset，再加过渡（capsule/ellipsoid/hull）、加细节孔与阵列。
7. 一个产品只建一个造型构件：整机都在 addSolid 的 features 里，需要补零件用 addFeature 追到同一个 target；
   不要为了「分零件」而建多个 addSolid（那样它们不会合并成一个实体）。
8. 判断成品像不像，先看三件事：主轮廓比例、关键件朝向、零件是否连成一体。三项错了，再多细节也救不回来。
9. 用户要求「参数可调 / 尺寸驱动 / 之后能改高度」→ 用 setConstraints 把关系写成公式（见【自定义约束】）；
   要现成案例先用 library 取特征树，再按需求 editFeature。不要为「可调」另建一套模型。
10. 用户要求「这几个尺寸之间有关系 / 跟着层高走 / 别超过多少」→ 用 setConstraints 写驱动式或校验式，
   不要靠每次手工同步；任意特征树都可以，不限预置模板（见【自定义约束】）。

【自检闭环】（你能自己转视图、自己改，直到满足需求——这是「像不像」的关键手段）
1. 你在一个多步循环里工作。每一轮可以给出三样东西中的任意几样：
   - ops：要执行的修改。**前端会立刻应用到模型**，不需要用户点确认；
   - inspect：要转过去截图的视角（最多 4 个）。顺序固定：先应用这一轮的 ops，再切视角截图，再把图发回给你；
   - done：你认为已经满足用户需求了。
   所以「改完马上看结果」要写在**同一轮**里（ops + inspect），不要拆成两轮。
   视角写法：{ "view": "iso" | "front" | "back" | "left" | "right" | "top" | "bottom" }，
   或用自定义角度 { "azimuth": 45, "elevation": 20 }（方位角从 +X 沿 +Y 逆时针，仰角从水平面向上，单位度）。
   默认选 [front, right, iso]；要看左右对称加 back/left，要看高矮与平面布局加 top。
   **要看细节就加 focus 与 zoom**：focus 填构件名（用上下文里出现过的名字）或 id，界面会把镜头只框住那个件；
   zoom 是取景倍数（1 = 整机框满，2 = 推进一倍，0.4~4，等比缩放）。
   例如 [{ "view": "right" }, { "view": "iso", "focus": "夹头", "zoom": 2.5 }] = 一张整机右视 + 一张夹头特写。
   什么时候该特写：怀疑两件没咬合 / 有穿模 / 螺纹或倒角没做出来 / 孔位偏了 / 薄壁厚度不对——整机图上看不出这些。
   不要四个视角全用来特写：至少留一张整机图核对整体比例。
2. 判断标准是**用户的需求原话**，不是「看着还行」。看到图先核对四件事：主轮廓比例、关键件朝向、
   零件是否连成一体（有没有悬空、断开、穿模）、该有的件有没有缺。发现问题必须自己改：
   用 editFeature / addFeature 精确修正，不要推倒重建（除非整体构图就错了）；改完再给 inspect 复核。
3. **只有真的核对过才写 done: true**。第一次生成后不要马上 done——至少截一组视角看过再判断。
   例外：只是改尺寸、换材质、加孔、改名字这类从特征树就能确认的改动，可以改完直接 done。
4. 不要问用户「要不要继续 / 这样行不行」。能自己判断的自己判断；确实缺关键信息（尺寸、用途、参照物）才停下来提问：
   此时 ops 与 inspect 都留空、done 为 false，reply 里问那一个问题。
5. 同一组视角不要反复要：看过就改，改完再换角度复核。循环有步数上限，用户也随时可能中止，
   所以每一步都要有实质进展（改了东西、或看了新的角度），reply 里说清「从哪个视角看出什么问题、改了什么」。

【通用规则】
0. 每条指令都必须带 op 字段，值就是上面列出的指令名（例如 { "op": "addSolid", "features": [...] }）；不要写成 action / type / kind。
1. 优先使用上下文中已有的标高名与类型名；只有确实需要时才 addLevel。
2. 默认墙/柱高度到上一层标高；没有上一层时用 height: 3。
3. 不要发明不存在的构件名称；修改/删除前先在上下文中确认目标（elements 里带 solid 的条目列出了该造型每个特征的序号、id、形状与材质）。
4. 需求含糊时，reply 里提一个简短的问题，ops 返回空数组。但如果消息里带着【服务端校验反馈】（说明你的上一条指令被拒绝），不要反问、不要只解释——直接按提示把字段改到范围内，重新输出完整指令。
5. 坐标要合理：建筑构件之间避免重叠；造型零件之间要重叠 3 mm 以上（布尔合并需要体积相交），
   但不要重叠到把相邻零件整个吞掉。前面【整机构图】的朝向与比例规则必须遵守。
6. 不要编造单位换算：用户没说单位时按米理解，明显是毫米级的小零件（螺丝、手机壳）按常识折算成米。
7. 指令会在服务端 dry-run 校验：报错信息里会指出「哪个特征的哪个字段、允许范围是多少、为什么」，照着改就是。`;

function parseToolArguments(message) {
  const call = message?.tool_calls?.[0];
  if (call?.function?.arguments) {
    try {
      const parsed = JSON.parse(call.function.arguments);
      return {
        reply: typeof parsed.reply === 'string' ? parsed.reply : '',
        ops: Array.isArray(parsed.ops) ? parsed.ops : [],
        inspect: normalizeInspect(parsed.inspect),
        done: parsed.done === true,
      };
    } catch {
      return null;
    }
  }
  if (typeof message?.content === 'string' && message.content.trim()) {
    const match = message.content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return {
          reply: typeof parsed.reply === 'string' ? parsed.reply : '',
          ops: Array.isArray(parsed.ops) ? parsed.ops : [],
          inspect: normalizeInspect(parsed.inspect),
          done: parsed.done === true,
        };
      } catch {
        // 忽略
      }
    }
    return { reply: message.content, ops: [], inspect: [], done: false };
  }
  return null;
}

/** 纯 JSON 兜底提示：thinking 模式或部分模型不接受 tools / tool_choice 时改用 */
const JSON_ONLY_PROMPT = `本次不再使用工具调用。请只输出一个 JSON 对象，不要输出 Markdown 代码块或任何解释文字：
{"reply": "给用户的简短中文说明；信息不足时在这里提问", "ops": [ ... 建模指令 ... ], "inspect": [ ... 想看的视角 ... ], "done": false}
不需要修改模型时 ops 返回空数组；指令格式与规则同前面的说明。
想看模型就把 inspect 写成 [{ "view": "front" }, { "view": "right" }, { "view": "iso" }]（最多 4 个），
可以和 ops 同轮出现（先应用修改再截图）。确认已满足需求时 done 为 true、ops 与 inspect 都留空。`;

/** 判断 400 是否属于「不支持工具调用 / 强制 tool_choice」这一类可降级错误 */
const TOOL_REJECT_PATTERN = /tool_choice|tool choice|thinking mode|thinking 模式|does not support (this )?tool|tools? (is |are )?not supported|unsupported.*tools?/i;

class AiRequestError extends Error {
  constructor(message, body, status) {
    super(message);
    this.name = 'AiRequestError';
    this.body = body;
    this.status = status;
  }
}

/** 可重试的 HTTP 状态：网关抖动、限流、上游过载 */
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
const HTML_HEAD = /^\s*<(?:!doctype|html|head|body|\?xml)/i;
const MAX_ATTEMPTS = 2;

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 把响应体压成一行人话，用于错误提示：空体 / HTML 错误页 / 普通文本分别说明 */
function describeBody(text, contentType = '') {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '（响应体为空）';
  if (HTML_HEAD.test(flat) || /text\/html/i.test(contentType)) {
    const title = flat.match(/<title[^>]*>([^<]{0,80})<\/title>/i)?.[1]?.trim();
    return `上游返回的是网页${title ? `「${title}」` : ''}而不是接口数据（常见于 baseUrl 少了 /v1、被网关/代理拦截或鉴权页跳转）：${flat.slice(0, 160)}`;
  }
  return flat.slice(0, 200);
}

/** 兼容网关无视 stream:false 强制 SSE 的情况：把事件流拼成一次完整响应 */
function completionFromSse(text) {
  const chunks = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.*)$/);
    if (!match) continue;
    const data = match[1].trim();
    if (!data || data === '[DONE]') continue;
    try {
      chunks.push(JSON.parse(data));
    } catch {
      // 单条事件损坏不影响其它事件
    }
  }
  if (!chunks.length) return null;

  // 网关可能直接整段返回非流式的 completion 对象
  const whole = chunks.filter((chunk) => chunk?.choices?.[0]?.message).at(-1);
  if (whole) return whole;

  let content = '';
  let reasoning = '';
  const toolCalls = [];
  for (const chunk of chunks) {
    const delta = chunk?.choices?.[0]?.delta ?? {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    for (const call of delta.tool_calls ?? []) {
      const index = Number.isInteger(call?.index) ? call.index : 0;
      toolCalls[index] ??= { type: 'function', function: { name: '', arguments: '' } };
      if (call?.function?.name) toolCalls[index].function.name += call.function.name;
      if (call?.function?.arguments) toolCalls[index].function.arguments += call.function.arguments;
    }
  }
  if (!content && !toolCalls.length) return null;
  return {
    choices: [{
      message: {
        role: 'assistant',
        content,
        reasoning_content: reasoning,
        tool_calls: toolCalls.filter(Boolean),
      },
    }],
  };
}

/** 200 但拿不到结构化 completion：区分空体 / HTML / SSE / 其它文本 */
function parseCompletion(text, contentType) {
  const trimmed = String(text ?? '').trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // 落到下面的 SSE / HTML 分支
    }
    if (/text\/event-stream/i.test(contentType) || /^data:\s/m.test(trimmed)) {
      const fromSse = completionFromSse(trimmed);
      if (fromSse) return fromSse;
    }
  }
  return null;
}

function timeoutMessage(config) {
  const seconds = Math.max(1, Math.round((Number(config.timeoutMs) || 60000) / 1000));
  return `AI 请求超时（${seconds} 秒未返回）：模型思考时间过长或上游限流，可缩短需求描述、换更快的模型，或在 AI 设置里调大超时`;
}

async function requestCompletion(config, payload) {
  const url = `${config.baseUrl}/chat/completions`;
  // 显式 stream:false：部分网关/模型默认按流式返回，会让 JSON.parse 直接失败
  const body = JSON.stringify({ ...payload, stream: false });
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await delay(500 * (attempt - 1));
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
          Accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      // 超时不重试（再等一次只会让用户更久），其余网络错误（连接重置 / DNS 抖动）重试一次
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error(timeoutMessage(config));
      lastError = new Error(`AI 服务连接失败：${error?.cause?.code ?? error?.message ?? '未知网络错误'}（${url}）`);
      if (attempt < MAX_ATTEMPTS) continue;
      throw lastError;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text().catch(() => '');

    if (!response.ok) {
      const error = new AiRequestError(
        `AI 服务返回 ${response.status}：${describeBody(text, contentType)}`,
        text,
        response.status,
      );
      if (RETRY_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
        lastError = error;
        continue;
      }
      throw error;
    }

    const data = parseCompletion(text, contentType);
    if (data) return data;

    // 200 却不给 JSON：多半是网关抖动或反代截断，重试一次再报
    lastError = new AiRequestError(
      `AI 服务返回了非 JSON 响应（HTTP ${response.status}，${contentType || '无 content-type'}）：${describeBody(text, contentType)}`,
      text,
      response.status,
    );

    // 关键兜底：非流式通道拿到空体/残体时，改走流式通道再试一次。
    // 上游的 /chat/completions 非流式与流式经常不是同一套实现（前者被网关缓存/超时截断，
    // 后者长连接直通），「HTTP 200 + 空响应体」在流式通道上通常能正常拿到数据。
    // 返回网页的就没必要试了：那是 baseUrl / 网关鉴权的问题。
    const looksHtml = HTML_HEAD.test(text) || /text\/html/i.test(contentType);
    if (attempt === MAX_ATTEMPTS && !looksHtml) {
      try {
        const streamed = await streamCompletion(config, payload);
        if (streamed) return streamed;
      } catch {
        // 流式也失败：保留非流式的原始错误，报错信息更有指导性
      }
    }
  }

  throw lastError ?? new Error('AI 调用失败');
}

/* ---------- 流式（SSE）请求层 ---------- */

/**
 * 发起 stream:true 请求，边读边把增量回调出去，结束时返回与 requestCompletion 同构的对象。
 * onEvent 可省略（内部兜底只需要最终结果）。
 *
 * 事件类型：
 * - status  { text }              阶段提示（连接、降级、收尾）
 * - reasoning { delta }           思考过程增量（thinking 模型的 reasoning_content）
 * - content { delta }             正文增量
 * - tool    { name }              模型决定调用工具
 * - plan    { chars }             工具参数累计长度（特征树越来越大）
 */
async function streamCompletion(config, payload, onEvent = null, options = {}) {
  const url = `${config.baseUrl}/chat/completions`;
  const emit = (event) => {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch {
      // 客户端断开等：不影响主流程
    }
  };
  const controller = new AbortController();
  const externalSignal = options.signal;
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  // 流式用「空闲超时」而不是总超时：thinking 模型可以连续吐 5 分钟思考内容，
  // 只要还在来字节就说明连接是活的。
  const idleLimit = Math.max(20000, Number(options.timeoutMs ?? config.timeoutMs) || 180000);
  let lastActivity = Date.now();
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > idleLimit) controller.abort();
  }, 5000);
  idleTimer.unref?.();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...payload, stream: true }),
      signal,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AiRequestError(
        `AI 服务返回 ${response.status}：${describeBody(text, contentType)}`,
        text,
        response.status,
      );
    }
    if (!response.body) {
      throw new AiRequestError(`AI 服务没有返回响应体（HTTP ${response.status}）`, '', response.status);
    }

    // 网关无视 stream:true，直接回整段 JSON：当成一次性响应处理
    if (/application\/json/i.test(contentType)) {
      const text = await response.text().catch(() => '');
      lastActivity = Date.now();
      const data = parseCompletion(text, contentType);
      if (!data) {
        throw new AiRequestError(
          `AI 服务返回了非 JSON 响应（HTTP ${response.status}，${contentType}）：${describeBody(text, contentType)}`,
          text,
          response.status,
        );
      }
      const message = data?.choices?.[0]?.message;
      if (typeof message?.reasoning_content === 'string' && message.reasoning_content) {
        emit({ type: 'reasoning', delta: message.reasoning_content });
      }
      if (typeof message?.content === 'string' && message.content) {
        emit({ type: 'content', delta: message.content });
      }
      return data;
    }

    const state = { content: '', reasoning: '', toolCalls: [], reportedChars: [], whole: null };
    const decoder = new TextDecoder();
    let buffer = '';

    const handleLine = (rawLine) => {
      const line = rawLine.replace(/\r$/, '').trim();
      if (!line || line.startsWith(':')) return; // 注释 / 心跳
      const dataText = line.startsWith('data:') ? line.slice(5).trim() : line;
      if (!dataText || dataText === '[DONE]') return;
      let chunk;
      try {
        chunk = JSON.parse(dataText);
      } catch {
        return; // 单条事件损坏不影响整体
      }
      lastActivity = Date.now();
      if (chunk?.error) {
        throw new AiRequestError(
          `AI 服务返回错误事件：${String(chunk.error?.message ?? chunk.error).slice(0, 200)}`,
          JSON.stringify(chunk).slice(0, 2000),
          200,
        );
      }
      const choice = chunk?.choices?.[0];
      // 有的网关把完整 completion 当成一条事件发过来
      if (choice?.message) {
        state.whole = chunk;
        return;
      }
      const delta = choice?.delta ?? {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        state.reasoning += delta.reasoning_content;
        emit({ type: 'reasoning', delta: delta.reasoning_content });
      }
      if (typeof delta.content === 'string' && delta.content) {
        state.content += delta.content;
        emit({ type: 'content', delta: delta.content });
      }
      for (const call of delta.tool_calls ?? []) {
        const index = Number.isInteger(call?.index) ? call.index : 0;
        if (!state.toolCalls[index]) {
          state.toolCalls[index] = { type: 'function', function: { name: '', arguments: '' } };
        }
        const target = state.toolCalls[index];
        if (call?.function?.name) {
          if (!target.function.name) emit({ type: 'tool', name: call.function.name });
          target.function.name += call.function.name;
        }
        if (call?.function?.arguments) {
          target.function.arguments += call.function.arguments;
          const chars = target.function.arguments.length;
          const reported = state.reportedChars[index] ?? 0;
          // 每 160 字符报一次进度：太密会让前端每秒重渲染几十次，太疏又看不出在动
          if (reported === 0 || chars - reported >= 160) {
            state.reportedChars[index] = chars;
            emit({ type: 'plan', chars });
          }
        }
      }
    };

    for await (const chunk of response.body) {
      lastActivity = Date.now();
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line);
      }
    }
    if (buffer.trim()) handleLine(buffer);

    if (state.whole) return state.whole;
    if (!state.content && !state.reasoning && !state.toolCalls.length) return null;
    return {
      choices: [{
        message: {
          role: 'assistant',
          content: state.content,
          reasoning_content: state.reasoning,
          tool_calls: state.toolCalls.filter(Boolean),
        },
        finish_reason: 'stop',
      }],
    };
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      if (externalSignal?.aborted) throw new Error('AI 请求已取消');
      throw new Error(`AI 请求超时（${Math.round(idleLimit / 1000)} 秒没有收到任何数据）：可缩短需求、换更快的模型，或在 AI 设置里调大超时`);
    }
    if (error instanceof AiRequestError) throw error;
    if (error instanceof SyntaxError) throw error;
    throw new Error(`AI 流式连接失败：${error?.cause?.code ?? error?.message ?? '未知网络错误'}（${url}）`);
  } finally {
    clearInterval(idleTimer);
  }
}

/**
 * 上下文按 token 预算分配（见 budget.js），不再「只留 6 条」也不再切 JSON 字符串：
 * - 滚动摘要（更早的对话）占一小块；
 * - 项目上下文结构化裁剪，装不下时降特征数 / 少列构件，并把省略量告诉模型；
 * - 历史原文从最新往前塞满剩余额度。
 * 返回 messages 与实际用量，调用方把用量回给前端（用户能看到上下文吃紧）。
 */
export function buildPrompt({ message, context, history, images = [], memory = '', model, contextTokens }) {
  const memoryText = String(memory ?? '').trim();
  const budget = planBudget({
    model,
    contextTokens,
    systemTokens: estimateTokens(SYSTEM_PROMPT) + estimateTokens(JSON_ONLY_PROMPT),
    messageTokens: estimateTokens(message),
    imageCount: images.length,
  });

  const memoryPart = memoryText ? clipToTokens(memoryText, budget.memory) : '';
  const project = trimProjectContext(context, budget.project);
  const fitted = fitHistory(history, budget.history);

  const userContent = images.length
    ? [
      ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
      { type: 'text', text: String(message) },
    ]
    : String(message);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(memoryPart
      ? [{
        role: 'system',
        content: `更早的对话摘要（原文已不在上下文里，需要时可据此回答「之前改过什么」）：\n${memoryPart}`,
      }]
      : []),
    {
      role: 'system',
      content: `当前项目上下文（JSON）：\n${JSON.stringify(project.context)}`,
    },
    // 预算裁掉了摘要之后的一段历史：必须让模型知道「记忆有断档」，否则它会当成没发生过
    ...(fitted.dropped > 0
      ? [{
        role: 'system',
        content: `注意：还有 ${fitted.dropped} 条更早的对话因超出上下文预算未加载。`
          + '涉及更早的决定时先向用户确认，不要臆测。',
      }]
      : []),
    ...fitted.items,
    { role: 'user', content: userContent },
  ];

  const breakdown = {
    system: estimateTokens(SYSTEM_PROMPT),
    memory: estimateTokens(memoryPart),
    project: project.tokens,
    history: fitted.tokens,
    message: estimateTokens(message),
    images: images.length * IMAGE_TOKENS,
  };
  const usage = {
    model,
    window: budget.window,
    budget: budget.available,
    output: budget.output,
    tokens: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
    breakdown,
    historyItems: fitted.items.length,
    historyDropped: fitted.dropped,
    elements: project.context.elements?.length ?? 0,
    omittedElements: project.omitted?.elements ?? 0,
    omittedFeatures: project.omitted?.features ?? 0,
    featureLimit: project.featureLimit ?? null,
    selectedDegraded: Boolean(project.selectedDegraded),
    // 历史被丢掉几条 = 这一段已经被摘要替代；前端据此显示「已压缩」
    compressed: fitted.dropped,
  };

  return { messages, usage };
}

const SUMMARY_PROMPT = `把下面这段「用户与建模助手」的历史对话压缩成一份技术备忘，供后续继续建模时参考。
用固定小标题输出，每项一行；没有内容的写「无」：
【目标】用户最终要做什么、整体风格与用途
【关键参数】已确定的尺寸、零件名、材质与颜色（保留具体数值与单位，不要写成「若干」）
【已完成的修改】按时间顺序列出改了什么；被撤销或被否决的做法也要注明，避免重复踩坑
【未决问题】用户还没确认、或明确说「不像/不对」但尚未修正的点
【偏好】用户表达过的偏好与禁忌
只保留后续建模需要的信息：寒暄、重复内容、完整 JSON 指令与思考过程全部丢弃。
用中文写，300 字以内，只输出备忘正文，不要任何前缀说明。`;

/**
 * 会话摘要输入：把历史消息压成一段文本。
 * 超长时按 token 裁（保留最近的部分）——以前用 `.slice(-8000)` 按字符裁，
 * 中文实际只有 8000 字符，且可能切在半句上。
 */
function historyForSummary(messages) {
  const joined = messages
    .map((item) => `${item.role === 'user' ? '用户' : '助手'}：${String(item.content ?? '').slice(0, 800)}`)
    .join('\n');
  return clipToTokens(joined, 9000);
}

/**
 * 有图片时先过一遍读图判定：
 * - 主模型能读图（或无法判断）：内联进建模请求，一次调用
 * - 主模型明确不支持：用用户单独配置并启用的视觉模型产出规格文本（不做任何自动挑选）
 */
async function prepareImages(config, message, images, { onEvent = null, signal = null } = {}) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return { message, images: [], vision: null };

  const target = await resolveVision(config);
  if (target.inline) {
    onEvent?.({ type: 'status', text: `已附加 ${list.length} 张参考图片，${config.model} 直接看图建模…` });
    return {
      message,
      images: list,
      vision: { model: target.model, inline: true, object: '', parts: 0 },
    };
  }

  onEvent?.({ type: 'status', text: `正在用视觉模型 ${target.model} 识别图片（${list.length} 张）…` });
  const analysis = await describeImages(config, list, { message, signal, resolved: target });
  onEvent?.({
    type: 'vision',
    model: analysis.model,
    object: analysis.object,
    parts: analysis.parts,
  });
  return {
    message: `${message}\n\n${analysis.text}`,
    images: [],
    vision: { model: analysis.model, inline: false, object: analysis.object, parts: analysis.parts },
  };
}

/**
 * 内联路径的兜底：主模型其实是纯文本、网关又没给模态信息时，模型会回「我看不到图片」。
 * 这种情况不能把一句「无法查看图片」当结果交给用户，要直接告诉他去配视觉模型。
 */
const BLIND_REPLY = /(无法|不能|没法|没能)\s*(查看|读取|看到|识别|访问).{0,8}(图片|图像)|unsupported image|cannot (?:see|view|read|access).{0,12}image/i;

function rejectBlindReply(result, vision) {
  if (!vision?.inline) return result;
  const hasOps = Array.isArray(result?.ops) && result.ops.length > 0;
  if (hasOps) return result;
  if (!BLIND_REPLY.test(String(result?.reply ?? ''))) return result;
  throw new Error(
    '主模型返回「看不到图片」，说明它其实是纯文本模型（网关的模型清单也没给出模态信息）。'
    + '请到「用户与系统 → AI 设置」勾选「独立视觉模型」，填入读图模型、接口地址与它自己的 API Key；'
    + '或者把主模型换成多模态模型。',
  );
}

function createOpenAiProvider(config) {
  const provider = {
    id: config.provider,
    async plan({ message, context, history = [], memory = '', images = [] }) {
      const prepared = await prepareImages(config, message, images);
      const { messages, usage } = buildPrompt({
        message: prepared.message,
        context,
        history,
        images: prepared.images,
        memory,
        model: config.model,
        contextTokens: config.contextTokens,
      });
      const base = { model: config.model, messages, temperature: 0.2 };
      const vision = prepared.vision;

      // 首选工具调用，但**不强制** tool_choice：thinking 模型（qwen3 / GLM 等）会直接 400
      // 「Thinking mode does not support this tool_choice」。默认 auto 由模型自行决定。
      let firstError = null;
      let needFallback = false;
      try {
        const data = await requestCompletion(config, { ...base, tools: [TOOL] });
        const parsed = parseToolArguments(data?.choices?.[0]?.message);
        if (parsed) return rejectBlindReply({ ...parsed, model: config.model, vision, context: usage }, vision);
        needFallback = true;
      } catch (error) {
        // 400 一律降级重试一次：OpenAI 兼容实现的差异很大（thinking / tools / temperature 都可能被拒绝），
        // 401 / 403 / 404 / 429 / 5xx 这类配置或配额问题直接抛出。
        if (error instanceof AiRequestError && error.status === 400) {
          firstError = error;
          needFallback = true;
        } else {
          throw error;
        }
      }

      if (needFallback) {
        // 兜底：去掉 tools / temperature，追加「只输出 JSON」指令，解析逻辑不变（仍走 ops 校验）
        try {
          const data = await requestCompletion(config, {
            model: config.model,
            messages: [...messages, { role: 'system', content: JSON_ONLY_PROMPT }],
          });
          const parsed = parseToolArguments(data?.choices?.[0]?.message);
          if (parsed) return rejectBlindReply({ ...parsed, model: config.model, degraded: true, vision, context: usage }, vision);
        } catch (error) {
          if (error instanceof AiRequestError) {
            const hint = TOOL_REJECT_PATTERN.test(error.body) || TOOL_REJECT_PATTERN.test(firstError?.body ?? '')
              ? '（当前模型不支持 function calling 或处于 thinking 模式，可换用 gpt-4o-mini / qwen-plus 等支持工具调用的模型，或在模型设置里关闭 thinking）'
              : '';
            throw new Error(`${error.message}${hint}`);
          }
          throw error;
        }
      }

      throw new Error('AI 返回内容无法解析为建模指令');
    },

    /**
     * 流式版 plan：边收边把「思考过程 / 输出草稿 / 参数生成进度」推给调用方，
     * 返回值与 plan 完全一致（同样经过 ops 校验）。thinking 模型一次要几十秒到几分钟，
     * 有中间过程用户才不会以为卡死。
     */
    async planStream({ message, context, history = [], memory = '', images = [], onEvent = null, signal = null }) {
      const emit = (event) => {
        try {
          onEvent?.(event);
        } catch {
          // 客户端断开：继续把结果算完（可能已经扣了 token）
        }
      };
      const prepared = await prepareImages(config, message, images, { onEvent: emit, signal });
      const { messages, usage } = buildPrompt({
        message: prepared.message,
        context,
        history,
        images: prepared.images,
        memory,
        model: config.model,
        contextTokens: config.contextTokens,
      });
      const base = { model: config.model, messages, temperature: 0.2 };
      const vision = prepared.vision;

      emit({ type: 'status', text: `已连接 ${config.model}，等待模型响应…` });
      let firstError = null;
      let needFallback = false;
      try {
        const data = await streamCompletion(config, { ...base, tools: [TOOL] }, emit, { signal });
        const parsed = data ? parseToolArguments(data.choices?.[0]?.message) : null;
        if (parsed) return rejectBlindReply({ ...parsed, model: config.model, vision, context: usage }, vision);
        needFallback = true;
      } catch (error) {
        // 400 与「只有空流」都降级；401/403/429/5xx 直接抛
        if (error instanceof AiRequestError && error.status === 400) {
          firstError = error;
          needFallback = true;
        } else {
          throw error;
        }
      }

      if (needFallback) {
        emit({ type: 'status', text: '模型不支持工具调用，改用纯 JSON 输出…' });
        try {
          const data = await streamCompletion(config, {
            model: config.model,
            messages: [...messages, { role: 'system', content: JSON_ONLY_PROMPT }],
          }, emit, { signal });
          const parsed = data ? parseToolArguments(data.choices?.[0]?.message) : null;
          if (parsed) return rejectBlindReply({ ...parsed, model: config.model, degraded: true, vision, context: usage }, vision);
        } catch (error) {
          if (!(error instanceof AiRequestError && error.status === 400)) throw error;
          firstError ??= error;
        }
      }

      // 流式两条路都没拿到东西：退回一次性请求（内部还有重试 + 反向走流式通道的兜底）
      // 注意传 prepared.message：图片此时已换成文字规格，不必再读一遍图
      emit({ type: 'status', text: '流式通道没有返回内容，改用普通请求重试…' });
      try {
        const result = await provider.plan({ message: prepared.message, context, history, memory, images: prepared.images });
        return rejectBlindReply({ ...result, degraded: true, vision }, vision);
      } catch (error) {
        if (error instanceof Error && firstError && !TOOL_REJECT_PATTERN.test(error.message)) {
          throw new Error(`${error.message}`);
        }
        throw error;
      }
    },

    /**
     * 滚动摘要：把更早的对话压成一段备忘，让长对话不必把所有原文塞回上下文。
     * 失败由调用方静默忽略（摘要只是优化，不该影响主流程）。
     */
    async summarize({ previous = '', messages = [] }) {
      const body = [
        previous && String(previous).trim()
          ? `已有的备忘（在此基础上补充，不要丢失其中的关键信息）：\n${clipToTokens(String(previous), 2400)}`
          : '',
        historyForSummary(messages),
      ].filter(Boolean).join('\n\n---\n\n');
      if (!body.trim()) return '';
      const data = await requestCompletion(config, {
        model: config.model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: SUMMARY_PROMPT },
          { role: 'user', content: body },
        ],
      });
      const text = data?.choices?.[0]?.message?.content;
      return typeof text === 'string' ? text.trim() : '';
    },
  };
  return provider;
}

/** 本地 Mock：按关键词生成确定性的建模指令，便于无 key 体验与自动化测试。 */
function createMockProvider() {
  return {
    id: 'mock',
    async plan({ message, context, images = [] }) {
      const text = String(message ?? '').trim();
      // 自检闭环的跟进轮（[自检第 n/m 步]）：Mock 不读图，但要把这条链路走通——
      // 收到截图就当作「已经核对过」，直接收工，前端因此能演示完整的改→看→确认。
      if (/^\[自检第 \d+\/\d+ 步\]/.test(text)) {
        return {
          reply: '（Mock 模式）已看过回传的视角截图：主轮廓比例与零件连接正常，视为满足需求。'
            + '真实模型会在这里指出具体问题并继续修。',
          ops: [],
          inspect: [],
          done: true,
          mock: true,
          vision: { model: 'mock', inline: false, object: '', parts: 0 },
        };
      }
      // Mock 是本地规则引擎，没有读图能力：明确说清楚，别让用户以为图没传上去
      if (Array.isArray(images) && images.length) {
        return {
          reply: `（Mock 模式）已收到 ${images.length} 张图片，但 Mock 是本地规则引擎、不读图。`
            + '要试「传图建模」，请到「用户与系统 → AI 设置」切换到真实模型；主模型不能读图时勾选「独立视觉模型」并填好模型与 Key。',
          ops: [],
          mock: true,
          vision: { model: 'mock', inline: false, object: '', parts: 0 },
        };
      }
      const ops = [];
      const notes = [];
      const level = context.levels?.[0]?.name ?? '标高 1';
      const wallType = context.types?.find((type) => type.category === 'wall')?.name;
      const slabType = context.types?.find((type) => type.category === 'slab')?.name;
      const columnType = context.types?.find((type) => type.category === 'column')?.name;
      const numbers = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(mm|毫米|m|米)?/gi)]
        .map((match) => ({ value: Number(match[1]), unit: (match[2] ?? '').toLowerCase() }));
      const size = text.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
      const width = size ? Number(size[1]) : numbers[0]?.value ?? 6;
      const depth = size ? Number(size[2]) : numbers[1]?.value ?? 4;

      const wantsDelete = /删除|移除|去掉/.test(text);
      const wantsThickness = /加厚|改厚|厚度|变厚/.test(text);

      // 视角巡检演示：Mock 也能「转动视图」，用于无 key 体验与前端联调
      const hasSolid = (context.elements ?? []).some((element) => element.solid);
      if (!wantsDelete && hasSolid && /换个角度|转一圈|多角度|从侧面|看看模型|检查一下|视角/.test(text)) {
        // 提到「细节 / 特写 / 咬合」时演示取景能力：一张整机 + 一张推进的特写
        const wantsDetail = /特写|细节|放大|螺纹|咬合|穿模|对齐/.test(text);
        return {
          reply: wantsDetail
            ? '（Mock 模式）先看整机，再凑近看局部细节，判断零件有没有对齐与穿模。'
            : '（Mock 模式）先切三个视角看一眼现有模型：前视、右视、等轴测。看完我再判断哪里不对。',
          ops: [],
          inspect: wantsDetail
            ? normalizeInspect([{ view: 'iso' }, { view: 'right', zoom: 2.5 }])
            : normalizeInspect(['front', 'right', 'iso']),
          mock: true,
        };
      }

      // 造型类：四翼螺旋桨无人机。特征树与「设计库」模板同源，走同一条 addSolid 指令。
      // 带「加长/改成」这类微调词时不重建，交给下面的 editFeature 分支。
      if (!wantsDelete && !/(加长|加宽|缩短|变长|改成|改为|长到|宽到)/.test(text)
        && /无人机|旋翼|螺旋桨|drone|quadcopter|uav/i.test(text)) {
        const spanMatch = text.match(/(?:轴距|span)[^\d]*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米)?/i);
        let span = 0.62;
        if (spanMatch) {
          const raw = Number(spanMatch[1]);
          const unit = (spanMatch[2] ?? '').toLowerCase();
          span = unit === 'mm' || unit === '毫米' ? raw / 1000
            : unit === 'cm' || unit === '厘米' ? raw / 100
              : raw > 5 ? raw / 1000 : raw;
        }
        return {
          reply: `（Mock 模式）已生成四翼螺旋桨无人机特征树：机身 + 电池舱 + 4 机臂（圆周阵列）+ 4 组旋翼（电机 / 双叶桨 / 桨毂罩）+ 起落架 + 前视相机，轴距 ${span.toFixed(2)} m。确认后点「应用到模型」；之后可以说「机臂加长到 30cm」这类话让 AI 改单个特征。`,
          ops: [{
            op: 'addSolid',
            name: '四翼螺旋桨无人机',
            level,
            color: '#8fb9e8',
            // 模型库取特征树：与设计库同一份数据（shared/models/quadcopter.json），
            // 轴距差异用整体 scale 表达（文档按 0.62 m 轴距建模）
            library: 'quadcopter',
            scale: span / 0.62,
          }],
          mock: true,
        };
      }

      // 造型类：一体化电动螺丝刀（「整机构图」规则的参考实现：一棵特征树装完整机）
      if (!wantsDelete && !/(加长|加宽|缩短|变长|改成|改为|长到|宽到)/.test(text)
        && /螺丝刀|起子|电批|screwdriver/i.test(text)) {
        return {
          reply: '（Mock 模式）已生成一体化电动螺丝刀：扁圆角机身 + 尾部圆弧 + 电池盖 + 扭矩环（12 齿滚花）+ 分瓣夹头（六角批头孔）+ 20° 后倾握把（橡胶握套 + 6 道防滑棱）+ 橙色拨钮 + 4 条散热槽 + 指示灯，共 14 个特征、7 种材质。整机是一棵特征树，不是 14 个散件；确认后点「应用到模型」。',
          ops: [{
            op: 'addSolid',
            name: '电动螺丝刀',
            level,
            color: '#eef2f5',
            library: 'screwdriver',
          }],
          mock: true,
        };
      }

      // 造型换色：只改材质，不动几何（演示 material 接口）
      const colorWords = {
        黑: { name: '哑光黑', color: '#20242a', roughness: 0.45, metalness: 0.05 },
        白: { name: '白色烤漆', color: '#eef2f5', roughness: 0.35, metalness: 0.04 },
        红: { name: '红色烤漆', color: '#c8382f', roughness: 0.35, metalness: 0.05 },
        橙: { name: '橙色烤漆', color: '#e2622a', roughness: 0.35, metalness: 0.05 },
        黄: { name: '黄色漆', color: '#e8c14a', roughness: 0.35, metalness: 0.05 },
        绿: { name: '军绿漆', color: '#4b5b3f', roughness: 0.55, metalness: 0.05 },
        蓝: { name: '蓝色漆', color: '#2f6fb0', roughness: 0.35, metalness: 0.05 },
        灰: { name: '深空灰', color: '#4a525c', roughness: 0.42, metalness: 0.18 },
        银: { name: '银色金属', color: '#b9c2cb', roughness: 0.28, metalness: 0.92 },
        金: { name: '金色镀层', color: '#d8b24a', roughness: 0.2, metalness: 1 },
      };
      const colorWord = text.match(/(黑|白|红|橙|黄|绿|蓝|灰|银|金)(?:色)?/);
      const recolorFeature = text.match(/(机身|机臂|桨叶|上盖|脚垫|云台|电机|天线|起落架)/);
      if (colorWord && recolorFeature && /(改|换|涂|变|调)/.test(text)) {
        const material = colorWords[colorWord[1]];
        return {
          reply: `（Mock 模式）把${recolorFeature[1]}换成${material.name}（${material.color}）：只改这一个零件的材质，几何不动。`,
          ops: [{
            op: 'editFeature',
            target: '四翼螺旋桨无人机',
            feature: recolorFeature[1],
            patch: { material },
          }],
          mock: true,
        };
      }

      // 造型微调：只改一个特征，不重建整棵树（演示 editFeature）
      const armMatch = text.match(/(?:把|将)?\s*(机臂|机身)\s*(?:加长|加宽|缩短|变长|改成|改为|长到|宽到)[^\d]*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米)?/i);
      if (!wantsDelete && armMatch) {
        const raw = Number(armMatch[2]);
        const unit = (armMatch[3] ?? '').toLowerCase();
        const size = unit === 'mm' || unit === '毫米' ? raw / 1000
          : unit === 'cm' || unit === '厘米' ? raw / 100
            : raw > 5 ? raw / 1000 : raw;
        if (size > 0) {
          // 机臂是圆管（沿高度方向即臂长），机身是圆角盒（加长改宽度）
          const isArm = armMatch[1] === '机臂';
          return {
            reply: `（Mock 模式）把${armMatch[1]}${isArm ? '长度' : '宽度'}改成 ${size.toFixed(3)} m，只改这一个特征，其它零件不动。`,
            ops: [{
              op: 'editFeature',
              target: '四翼螺旋桨无人机',
              feature: armMatch[1],
              patch: { shape: isArm ? { height: size } : { width: size } },
            }],
            mock: true,
          };
        }
      }

      if (wantsDelete) {
        const target = text.match(/(?:删除|移除|去掉)\s*([^\s，,。；;]+(?:\s*\d+)?)/)?.[1]?.trim();
        if (target) {
          ops.push({ op: 'deleteElement', target });
          notes.push(`删除构件「${target}」`);
        } else {
          return { reply: '请告诉我要删除哪个构件（用名称或 ID）。', ops: [], mock: true };
        }
      }

      if (!wantsDelete && /房间|小屋|房子|room|house|户型/.test(text)) {
        const w = Math.min(Math.max(width, 1), 50);
        const d = Math.min(Math.max(depth, 1), 50);
        const corners = [[0, 0], [w, 0], [w, d], [0, d]];
        for (let index = 0; index < 4; index += 1) {
          ops.push({
            op: 'addWall',
            level,
            start: corners[index],
            end: corners[(index + 1) % 4],
            ...(wallType ? { type: wallType } : {}),
          });
        }
        if (slabType) {
          ops.push({ op: 'addSlab', level, rect: { x: 0, y: 0, width: w, depth: d }, type: slabType });
        }
        notes.push(`在「${level}」上建 ${w} × ${d} m 的房间（4 面墙${slabType ? ' + 楼板' : ''}）`);
      } else if (!wantsDelete && /墙|wall/i.test(text) && !wantsThickness) {
        const length = Math.min(Math.max(numbers[0]?.value ?? 5, 0.5), 100);
        ops.push({
          op: 'addWall',
          level,
          start: [0, 0],
          end: [length, 0],
          ...(wallType ? { type: wallType } : {}),
        });
        notes.push(`新增一段 ${length} m 长的墙`);
      }

      if (!wantsDelete && /柱|column/i.test(text)) {
        const positions = size ? [[0, 0], [width, 0], [width, depth], [0, depth]] : [[0, 0]];
        for (const position of positions) {
          ops.push({
            op: 'addColumn',
            level,
            position,
            ...(columnType ? { type: columnType } : {}),
          });
        }
        notes.push(`新增 ${positions.length} 根柱`);
      }

      if (!wantsDelete && wantsThickness && wallType) {
        const raw = numbers.find((item) => item.value > 0)?.value;
        if (raw) {
          const unit = numbers.find((item) => item.value === raw)?.unit;
          const thickness = unit === 'mm' || unit === '毫米' || raw > 5 ? raw / 1000 : raw;
          ops.push({ op: 'setTypeProperty', type: wallType, thickness: Number(thickness.toFixed(3)) });
          notes.push(`把墙类型「${wallType}」的厚度改为 ${(thickness * 1000).toFixed(0)} mm`);
        }
      }

      if (!ops.length) {
        return {
          reply: '（Mock 模式）我能按“建一个 6×4 的房间 / 加一面 5 米的墙 / 加一根柱 / 把墙加厚到 300 / 删除墙 1”这类说法生成建模指令。你可以换个说法试试。',
          ops: [],
          mock: true,
        };
      }

      return {
        reply: `（Mock 模式）${notes.join('；')}。确认后点“应用到模型”，可随时撤销。`,
        ops,
        mock: true,
      };
    },

    // Mock 不做摘要：没有真实模型可调，返回空串让调用方跳过压缩
    async summarize() {
      return '';
    },
  };

  // Mock 也报一份上下文用量：无 key 时前端照样能看到「上下文吃紧」并试压缩按钮
  const rawPlan = provider.plan;
  provider.plan = async (args) => {
    const result = await rawPlan(args);
    try {
      const { usage } = buildPrompt({
        message: String(args?.message ?? ''),
        context: args?.context ?? {},
        history: args?.history ?? [],
        images: args?.images ?? [],
        memory: args?.memory ?? '',
        model: 'mock',
      });
      return { ...result, context: usage };
    } catch {
      return result;
    }
  };
  return provider;
}

export function createProvider(config) {
  const provider = config.provider === 'mock' ? createMockProvider() : createOpenAiProvider(config);
  // Mock / 未来其它提供方没有流式实现时，用「阶段事件 + 一次性结果」包一层，
  // 保证前端只有一条代码路径（Mock 也有中间过程，UI 才能被真正测到）。
  if (typeof provider.planStream === 'function') return provider;
  return {
    ...provider,
    async planStream({ onEvent, ...args }) {
      onEvent?.({ type: 'status', text: '正在解析需求…' });
      await new Promise((resolve) => { setTimeout(resolve, 120); });
      onEvent?.({ type: 'status', text: '正在生成建模指令…' });
      const result = await provider.plan(args);
      onEvent?.({ type: 'plan', chars: JSON.stringify(result.ops ?? []).length });
      return result;
    },
  };
}

