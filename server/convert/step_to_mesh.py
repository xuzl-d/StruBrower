#!/usr/bin/env python3
"""
STEP -> 带面颜色的网格（服务端转换器）。

occt-import-js 在“装配实例 + 面着色”的 STEP 上会丢失面颜色（上游 #68），
这里用 OCCT 的 XCAF 样式表（XCAFPrs::CollectStyleSettings）取回每个面的颜色，
再用 BRepMesh 三角化，输出二进制网格交给浏览器。

输出格式（小端）：
  magic  8 bytes  b"STRUMESH"
  version uint32  = 1
  headerLength uint32
  header  JSON(utf8)  {version, vertexCount, triangleCount, stats:{...}}
  positions Float32 * 3 * vertexCount
  colors    Float32 * 3 * vertexCount   (线性 RGB)

用法：
  python step_to_mesh.py --input a.step --output a.bin [--deflection-ratio 0.001]
                         [--angular 0.5] [--preview-bin a.preview.bin] [--scale auto|1|0.001]
"""
import argparse
import array
import json
import math
import re
import struct
import sys
import time

from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.Quantity import Quantity_Color
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDF import TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED, TopAbs_SOLID
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopTools import TopTools_IndexedMapOfShape
from OCP.TopoDS import TopoDS
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.XCAFPrs import XCAFPrs, XCAFPrs_IndexedDataMapOfShapeStyle

DEFAULT_COLOR = (0.78, 0.79, 0.82)

_SI_PREFIX = {
    ".MILLI.": 1e-3,
    ".CENTI.": 1e-2,
    ".DECI.": 1e-1,
    ".KILO.": 1e3,
    ".MICRO.": 1e-6,
}


def _scan_units(text):
    match = re.search(r"CONVERSION_BASED_UNIT\(\s*'([^']*)'", text)
    if match:
        name = match.group(1).upper()
        if "INCH" in name:
            return 0.0254
        if "FOOT" in name or "FEET" in name:
            return 0.3048
        if "MILLIMETRE" in name or "MILLIMETER" in name:
            return 0.001
    match = re.search(r"SI_UNIT\(\s*(\.(?:MILLI|CENTI|DECI|KILO|MICRO)\.)\s*,\s*\.METRE\.", text)
    if match:
        return _SI_PREFIX.get(match.group(1))
    if re.search(r"SI_UNIT\(\s*\$?\s*,\s*\.METRE\.", text):
        return 1.0
    return None


def detect_unit_scale(path):
    """扫描 STEP 文本里的长度单位（单位块可能出现在文件任意位置）。"""
    tail = b""
    try:
        with open(path, "rb") as handle:
            while True:
                chunk = handle.read(8 * 1024 * 1024)
                if not chunk:
                    return None
                scale = _scan_units((tail + chunk).decode("latin-1", "ignore"))
                if scale is not None:
                    return scale
                tail = (tail + chunk)[-512:]
    except OSError:
        return None


def style_color(settings, shape):
    for candidate in (shape, shape.Located(TopLoc_Location())):
        try:
            style = settings.FindFromKey(candidate)
        except Exception:
            continue
        if style.IsSetColorSurf():
            color = style.GetColorSurf()
            return (color.Red(), color.Green(), color.Blue())
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--deflection-ratio", type=float, default=0.001)
    parser.add_argument("--angular", type=float, default=0.5)
    parser.add_argument("--preview-bin", default=None)
    parser.add_argument("--scale", default="auto")
    args = parser.parse_args()

    started = time.time()
    document = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    reader.SetNameMode(True)
    status = reader.ReadFile(args.input)
    if int(status) != 1:
        raise SystemExit(f"STEP 读取失败（status={int(status)}）")
    if not reader.Transfer(document):
        raise SystemExit("STEP 数据转换失败")
    print(f"[convert] XCAF transfer {time.time() - started:.1f}s", file=sys.stderr, flush=True)

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    roots = TDF_LabelSequence()
    shape_tool.GetFreeShapes(roots)
    if roots.Length() < 1:
        raise SystemExit("STEP 中没有可用的形状")
    root_label = roots.Value(1)
    root = shape_tool.GetShape_s(root_label)

    settings = XCAFPrs_IndexedDataMapOfShapeStyle()
    XCAFPrs.CollectStyleSettings_s(root_label, TopLoc_Location(), settings)
    print(f"[convert] style settings {settings.Extent()} ({time.time() - started:.1f}s)", file=sys.stderr, flush=True)

    bbox = Bnd_Box()
    BRepBndLib.Add_s(root, bbox)
    xmin, ymin, zmin, xmax, ymax, zmax = bbox.Get()
    diagonal = math.dist((xmin, ymin, zmin), (xmax, ymax, zmax))
    deflection = max(diagonal * args.deflection_ratio, 1e-6)

    if args.scale != "auto":
        scale = float(args.scale)
    else:
        scale = detect_unit_scale(args.input)
        if scale is None:
            scale = 0.001 if diagonal > 500 else 1.0
            print(f"[convert] 未识别单位，按包围盒推断 scale={scale}", file=sys.stderr)

    mesh_started = time.time()
    BRepMesh_IncrementalMesh(root, deflection, False, args.angular, True)
    print(f"[convert] meshed in {time.time() - mesh_started:.1f}s", file=sys.stderr, flush=True)

    positions = array.array("f")
    colors = array.array("f")
    stats = {"faces": 0, "coloredFaces": 0, "defaultFaces": 0, "solids": 0}

    def emit_face(face, owner_color):
        stats["faces"] += 1
        color = style_color(settings, face) or owner_color
        if color is None:
            stats["defaultFaces"] += 1
            color = DEFAULT_COLOR
        else:
            stats["coloredFaces"] += 1
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, location)
        if triangulation is None:
            return
        transform = location.Transformation()
        reversed_face = face.Orientation() == TopAbs_REVERSED
        for index in range(1, triangulation.NbTriangles() + 1):
            triangle = triangulation.Triangle(index)
            corners = (1, 2, 3) if not reversed_face else (1, 3, 2)
            for corner in corners:
                point = triangulation.Node(triangle.Value(corner)).Transformed(transform)
                positions.extend((point.X() * scale, point.Y() * scale, point.Z() * scale))
                colors.extend(color)

    solids = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(root, TopAbs_SOLID, solids)
    stats["solids"] = solids.Extent()
    for index in range(1, solids.Extent() + 1):
        solid = solids.FindKey(index)
        owner_color = style_color(settings, solid)
        explorer = TopExp_Explorer(solid, TopAbs_FACE)
        while explorer.More():
            emit_face(TopoDS.Face_s(explorer.Current()), owner_color)
            explorer.Next()

    # 不属于任何实体的散面
    loose = TopExp_Explorer(root, TopAbs_FACE, TopAbs_SOLID)
    while loose.More():
        emit_face(TopoDS.Face_s(loose.Current()), None)
        loose.Next()

    vertex_count = len(positions) // 3
    triangle_count = vertex_count // 3
    if triangle_count == 0:
        raise SystemExit("没有生成任何三角面")

    elapsed = time.time() - started
    header = {
        "version": 1,
        "vertexCount": vertex_count,
        "triangleCount": triangle_count,
        "unit": "meter",
        "unitScale": scale,
        "source": "step-xcaf",
        "stats": {
            **stats,
            "elapsedMs": int(elapsed * 1000),
            "bounds": [xmin * scale, ymin * scale, zmin * scale, xmax * scale, ymax * scale, zmax * scale],
        },
    }
    header_bytes = json.dumps(header, ensure_ascii=False).encode("utf-8")
    # 4 字节对齐，浏览器端可直接用 Float32Array 视图读取
    header_bytes += b" " * (-len(header_bytes) % 4)

    if sys.byteorder == "big":
        positions.byteswap()
        colors.byteswap()

    with open(args.output, "wb") as handle:
        handle.write(b"STRUMESH")
        handle.write(struct.pack("<II", 1, len(header_bytes)))
        handle.write(header_bytes)
        positions.tofile(handle)
        colors.tofile(handle)

    if args.preview_bin:
        with open(args.preview_bin, "wb") as handle:
            handle.write(struct.pack("<II", vertex_count, 0))
            handle.write(positions.tobytes())
            handle.write(colors.tobytes())

    print(json.dumps({
        "ok": True,
        "output": args.output,
        "vertexCount": vertex_count,
        "triangleCount": triangle_count,
        "unitScale": scale,
        "stats": header["stats"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
