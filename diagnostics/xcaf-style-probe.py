import sys, math, time
import numpy as np
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorSurf, XCAFDoc_ColorGen, XCAFDoc_ColorCurv
from OCP.XCAFPrs import XCAFPrs, XCAFPrs_IndexedDataMapOfShapeStyle
from OCP.TDF import TDF_LabelSequence, TDF_Label
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
from OCP.TopoDS import TopoDS
from OCP.TopLoc import TopLoc_Location
from OCP.Quantity import Quantity_Color
from OCP.TopTools import TopTools_IndexedMapOfShape
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRep import BRep_Tool
from OCP.BRepBndLib import BRepBndLib
from OCP.Bnd import Bnd_Box

path = sys.argv[1]
out = sys.argv[2]
t0 = time.time()
doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
rdr = STEPCAFControl_Reader(); rdr.SetColorMode(True); rdr.SetNameMode(True)
rdr.ReadFile(path); rdr.Transfer(doc)
st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
roots = TDF_LabelSequence(); st.GetFreeShapes(roots)
root = st.GetShape_s(roots.Value(1))
print("read+xcaf", round(time.time()-t0,1), flush=True)

bnd = Bnd_Box(); BRepBndLib.Add_s(root, bnd)
xmin, ymin, zmin, xmax, ymax, zmax = bnd.Get()
diag = math.dist((xmin, ymin, zmin), (xmax, ymax, zmax))
defl = max(diag * 0.001, 1e-4)
print("bbox", (round(xmin,2), round(ymin,2), round(zmin,2)), (round(xmax,2), round(ymax,2), round(zmax,2)), "defl", round(defl,4), flush=True)

t1 = time.time()
BRepMesh_IncrementalMesh(root, defl, False, 0.5, True)
print("meshed", round(time.time()-t1,1), flush=True)

# OCCT's own style resolution (label-tree based)
settings = XCAFPrs_IndexedDataMapOfShapeStyle()
XCAFPrs.CollectStyleSettings_s(roots.Value(1), TopLoc_Location(), settings)
print("style settings", settings.Extent(), flush=True)

def style_rgb(style):
    if not style.IsSetColorSurf(): return None
    c = style.GetColorSurf()
    return (c.Red(), c.Green(), c.Blue())

def colour_in_settings(shp):
    for cand in (shp, shp.Located(TopLoc_Location())):
        try:
            sty = settings.FindFromKey(cand)
        except Exception:
            continue
        c = style_rgb(sty)
        if c:
            return c
    return None

DEFAULT = (0.78, 0.79, 0.82)
positions = []
colors = []
nfaces = 0
missing = 0

def emit(face_shape, owner_color):
    global nfaces, missing
    face = TopoDS.Face_s(face_shape)
    loc = TopLoc_Location()
    tri = BRep_Tool.Triangulation_s(face, loc)
    if tri is None:
        return
    fc = colour_in_settings(face)
    col = fc or owner_color
    if col is None:
        missing += 1
        col = DEFAULT
    trsf = loc.Transformation()
    ntri = tri.NbTriangles()
    for i in range(1, ntri+1):
        t = tri.Triangle(i)
        for k in (1, 2, 3):
            p = tri.Node(t.Value(k)).Transformed(trsf)
            positions.extend((p.X(), p.Y(), p.Z()))
            colors.extend(col)
    nfaces += 1

ex = TopExp_Explorer(root, TopAbs_SOLID)
while ex.More():
    sol = ex.Current(); ex.Next()
    owner = colour_in_settings(sol)
    fe = TopExp_Explorer(sol, TopAbs_FACE)
    while fe.More():
        emit(fe.Current(), owner); fe.Next()
# faces not in solids
ex = TopExp_Explorer(root, TopAbs_FACE, TopAbs_SOLID)
while ex.More():
    emit(ex.Current(), None); ex.Next()

pos = np.array(positions, dtype=np.float64).reshape(-1, 3)
col = np.array(colors, dtype=np.float64).reshape(-1, 3)
print("vertices", len(pos), "triangles", len(pos)//3, "faces meshed", nfaces, "faces default grey", missing, flush=True)

# normalize like the app: rotate X -90, center, sit on ground
pos = np.stack([pos[:, 0], pos[:, 2], -pos[:, 1]], axis=1)
mn = pos.min(axis=0); mx = pos.max(axis=0); ctr = (mn+mx)/2
pos[:, 0] -= ctr[0]; pos[:, 1] -= mn[1]; pos[:, 2] -= ctr[2]

n = len(pos)
with open(out, 'wb') as f:
    f.write(np.uint32(n).tobytes()); f.write(np.uint32(0).tobytes())
    f.write(pos.astype(np.float32).tobytes())
    f.write(col.astype(np.float32).tobytes())
print("wrote", out, round(time.time()-t0,1), flush=True)
