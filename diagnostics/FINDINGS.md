# STEP 导入颜色丢失：定位报告

文件：`/Users/hoje/Downloads/crawler-crane-2.snapshot.3/Кран гусиничный1 v10.step`
（121 MB，AP214 `AUTOMOTIVE_DESIGN`，Autodesk Translation Framework v12.14 导出）

## 结论

颜色在文件里、也在 OCCT 里；丢失发生在 **occt-import-js 的 JSON 导出层**，不是 OCCT 的 STEP 解析问题。

- 上游已确认同类缺陷：occt-import-js issue **#68**（open）、PR **#69**（未合并）。
- 该文件是"零件被装配实例化 + 颜色挂在面（`STYLED_ITEM`→`ADVANCED_FACE`）"的组合，正好命中这个缺陷。

## 证据 1：STEP 文件确实带颜色

| 项目 | 数量 |
| --- | --- |
| `COLOUR_RGB` | 22 |
| `STYLED_ITEM` | 604（目标：面 399 / 实体 119 / 壳 2 / 带孔实体 1，其余解析链未展开） |
| `ADVANCED_FACE` | 15 985 |
| `MANIFOLD_SOLID_BREP` | 145 |
| `PRODUCT` | 111 |

## 证据 2：occt-import-js 0.0.23（wasm，OCCT 7.6.1）读出来只剩 36%

`ReadStepFile`（与 App 完全相同的参数：meter / bounding_box_ratio 0.001 / 0.5）：

- 网格 169 个，三角面 289 384，brep 面 21 394
- 带 `mesh.color` 的网格：**84**
- `brep_faces[].color` 非空的：**0**
- 回退到默认灰 `[0.78, 0.79, 0.82]` 的三角面：**185 142（64%）**

App 端最终 `element.vertexColors` 直方图：默认灰占 64.0%，其余 8 种颜色合计 36%。
导入完成提示会显示"导入器未返回 185,142 个三角面的颜色"。

## 证据 3：同一文件交给 OCCT 7.7.2 直接读 XCAF，颜色齐全

用 `cadquery-ocp 7.7.2`（OCP）复现：

- `STEPCAFControl_Reader` + `XCAFDoc`：**603 个带颜色的标签 = 面 455 + 实体 85 + 顶层 63**
- `XCAFPrs::CollectStyleSettings`：**625 条样式 = 面 455 + 实体 167**
- `XCAFPrs_DocumentExplorer`：107 个叶子节点，84 个带整件样式，
  颜色分布（44×黑 0.01、16×黑 0、8×白、6×铬…）与 occt-import-js 返回的 84 个网格完全一致

即：occt-import-js 拿到的"整件颜色"是对的（来自节点样式），**面级颜色一条都没拿到**。

## 机制

1. OCCT 把 `STYLED_ITEM` 解析成 XCAF 里的子形状标签颜色，标签挂在**未带装配位置的引用零件**上。
2. occt-import-js 为每个网格反查颜色时用 `XCAFDoc_ShapeTool::Search(shape)`（importer-xcaf.cpp:
   `XcafShapeMesh::GetColor` / `XcafFace::GetColor`），传入的是**带实例位置的几何**；
   位置的差别使 `Search` 找不到面标签 → `brep_faces[].color` 全为 `null`。
3. 颜色只挂在面上的零件（本文件主体），连整件颜色也拿不到 → 渲染为默认灰。
4. 参考面：`imported-with-occt-import-js.png`（App 现状）与
   `expected-from-occt-styles.png`（用 `XCAFPrs` 样式表重建的同一模型）。

## 附带确认

- 返回的颜色是**线性 RGB**（文件里 sRGB 0.098 → 返回 0.01）。three.js 顶点色按线性使用，
  当前 `ModelViewport.tsx` 直接使用是正确的，不要按 issue #64 改成 sRGB，否则会整体偏亮。
- 与 App 代码无关：`App.tsx` 的面颜色→顶点色映射逻辑正确（`hasImportedColors` 为 true，
  `brep_faces` 为空所以全部走默认灰）。

## 可选修复路线

| 方案 | 工作量 | 说明 |
| --- | --- | --- |
| A. 重建 occt-import-js wasm（合并 PR #69 + 用 `XCAFPrs::CollectStyleSettings` 逐节点取面样式） | 大（emsdk + 编译 OCCT，数小时；且需验证 compound 零件是否覆盖） | 浏览器内一站式，最干净 |
| B. 服务端/本地转换进程（OCP/pythonOCC）：STEP → 带 `COLOR_0` 的 glTF 或自定义 JSON | 中 | 已用本报告的 `xcaf-style-probe.py` 验证可行，生产环境最稳 |
| C. 前端兜底：JS 解析 STEP 文本恢复"整件主色" | 小~中 | 只能到整件级，丢失面级细节；需按名称/顺序与网格对应，脆弱 |

## 复现脚本

- `step-style-audit.cjs`：`node step-style-audit.cjs "<step 路径>"`，统计 STEP 内样式与目标类型
- `xcaf-style-probe.py`：用 OCP 读 XCAF、`CollectStyleSettings` 取面样式、导出二进制（供渲染）
- `render-binary.mjs`：`node render-binary.mjs in.bin out.png 1200 800 color` 软件渲染


## 修复状态（v0.5）

已实现服务端转换器 `server/convert/step_to_mesh.py`（Python + `cadquery-ocp`）：

- 用 `XCAFPrs::CollectStyleSettings` 读取 XCAF 样式表，按「面 → 实体 → 默认灰」解析，三角化后输出
  逐顶点颜色的二进制网格（`STRUMESH` 协议）。
- 同一吊车文件实测：**21,178 / 21,394 个面带色**（浏览器导入器为 0），264,276 三角面 / 18 MB，约 2.5 分钟。
- 前端在服务端模式下优先调用该转换器，失败自动回退浏览器解析；安装方式 `npm run setup:step`。
- 纯浏览器（本地 IndexedDB 模式）仍使用 occt-import-js，面颜色会丢失。
