#!/usr/bin/env python3
"""生成一个带面颜色的最小 STEP 夹具（用于转换器测试）。"""
import os
import sys

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_StepModelType
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDF import TDF_Label
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_DocumentTool


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "fixtures", "box-colors.step")
    os.makedirs(os.path.dirname(target), exist_ok=True)

    document = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(document.Main())

    box = BRepPrimAPI_MakeBox(10.0, 10.0, 10.0).Shape()
    label = shape_tool.AddShape(box, False)
    TDataStd_Name.Set_s(label, TCollection_ExtendedString("ColoredBox"))
    color_tool.SetColor(label, Quantity_Color(0.5, 0.5, 0.5, Quantity_TOC_RGB), XCAFDoc_ColorSurf)

    explorer = TopExp_Explorer(box, TopAbs_FACE)
    face = TopoDS.Face_s(explorer.Current())
    sub_label = TDF_Label()
    shape_tool.AddSubShape(label, face, sub_label)
    color_tool.SetColor(sub_label, Quantity_Color(1.0, 0.0, 0.0, Quantity_TOC_RGB), XCAFDoc_ColorSurf)

    writer = STEPCAFControl_Writer()
    writer.SetColorMode(True)
    writer.SetNameMode(True)
    writer.Transfer(document, STEPControl_StepModelType.STEPControl_AsIs)
    if writer.Write(target) != 1:
        raise SystemExit("STEP 写入失败")
    print(f"fixture written: {target} ({os.path.getsize(target)} bytes)")


if __name__ == "__main__":
    main()
