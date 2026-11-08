/** 相机摆位测试：AI 视角巡检要「转到某个角度、把整个模型框进画面」，这里断言那套纯计算。 */
import { Box3, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { cameraAngles, directionFromAngles, frameCamera } from '../src/bim/viewFrame';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

const near = (a: number, b: number, epsilon = 1e-6) => Math.abs(a - b) < epsilon;

// 方向向量：Z-up，方位角从 +X 沿 +Y 逆时针
const front = directionFromAngles(-90, 0);
check('方位 -90° = 从 -Y 方向看（前视）', near(front.x, 0) && near(front.y, -1) && near(front.z, 0), front.toArray());
const top = directionFromAngles(0, 90);
check('仰角 90° = 从 +Z 方向看（俯视）', near(top.x, 0, 1e-9) && near(top.z, 1, 1e-9), top.toArray());
const iso = directionFromAngles(45, 30);
check('任意角度是单位向量', near(iso.length(), 1, 1e-9), iso.length());
check('仰角决定高度分量', iso.z > 0 && near(iso.z, Math.sin(Math.PI / 6), 1e-9), iso.z);

// 透视相机：把包围球框进画面
const box = new Box3(new Vector3(-0.1, -0.05, -0.02), new Vector3(0.1, 0.05, 0.02));
const perspective = new PerspectiveCamera(45, 16 / 9, 0.01, 100);
const okFront = frameCamera(perspective, box, 16 / 9, directionFromAngles(-90, 0), new Vector3(0, 0, 1));
const center = box.getCenter(new Vector3());
check('透视：摆位成功', okFront);
check('透视：相机在观察点 -Y 侧', perspective.position.y < center.y - 0.1, perspective.position.toArray().map((value) => Number(value.toFixed(3))));
check('透视：相机朝向中心（前向与视线同向）',
  (() => {
    const forward = new Vector3(0, 0, -1).applyQuaternion(perspective.quaternion);
    const toCenter = center.clone().sub(perspective.position).normalize();
    return forward.dot(toCenter) > 0.999;
  })());
check('透视：近裁剪面在模型之前、远裁剪面在其后',
  perspective.near < perspective.position.distanceTo(center)
  && perspective.far > perspective.position.distanceTo(center),
  { near: perspective.near, far: perspective.far });
check('透视：距离随模型变大',
  (() => {
    const big = new PerspectiveCamera(45, 16 / 9, 0.01, 5000);
    frameCamera(big, new Box3(new Vector3(-2, -2, -2), new Vector3(2, 2, 2)), 16 / 9, directionFromAngles(-90, 0), new Vector3(0, 0, 1));
    return big.position.length() > perspective.position.length();
  })());

// 窄画面（竖屏）要比宽画面退得更远，否则左右会被切边
const wide = new PerspectiveCamera(45, 2, 0.01, 100);
const narrow = new PerspectiveCamera(45, 0.5, 0.01, 100);
frameCamera(wide, box, 2, directionFromAngles(-90, 0), new Vector3(0, 0, 1));
frameCamera(narrow, box, 0.5, directionFromAngles(-90, 0), new Vector3(0, 0, 1));
check('窄画面退得更远（不切边）', narrow.position.length() > wide.position.length(), {
  wide: wide.position.length(),
  narrow: narrow.position.length(),
});

// 正交相机：距离只影响裁剪，画面范围由 top/bottom 决定
const ortho = new OrthographicCamera(-1, 1, 1, -1, 0.01, 500);
frameCamera(ortho, box, 2, directionFromAngles(0, 90), new Vector3(0, 1, 0));
check('正交：上下范围覆盖包围球', ortho.top >= 0.11 && ortho.bottom === -ortho.top, { top: ortho.top, bottom: ortho.bottom });
check('正交：按宽高比展开左右', near(ortho.right, ortho.top * 2), { right: ortho.right, top: ortho.top });
check('正交：俯视时 up 用 +Y 避免退化', ortho.up.y === 1 && near(ortho.up.z, 0), ortho.up.toArray());

check('空包围盒不摆位', frameCamera(perspective, new Box3(), 1, new Vector3(0, 0, 1), new Vector3(0, 1, 0)) === false);

// 读回当前角度
const angles = cameraAngles(new Vector3(1, -1, 1), new Vector3(0, 0, 0));
check('方位角从 +X 逆时针（+X/-Y → -45°）', angles?.azimuth === -45, angles);
check('仰角从水平面向上', angles?.elevation === 35.3, angles);
check('距离按欧氏距离（保留 3 位）', angles?.distance === 1.7321, angles);
check('退化情况返回 null', cameraAngles(new Vector3(0, 0, 0), new Vector3(0, 0, 0)) === null);
check('镜头平视时仰角为 0', cameraAngles(new Vector3(3, 0, 0), new Vector3(0, 0, 0))?.elevation === 0);

// ── 取景倍数 zoom：AI 靠它凑近看细节（focus 只改包围盒，不改这里） ──────────
{
  const shot = (zoom?: number) => {
    const camera = new PerspectiveCamera(45, 16 / 9, 0.01, 100);
    frameCamera(camera, box, 16 / 9, directionFromAngles(-90, 0), new Vector3(0, 0, 1), zoom);
    return camera.position.distanceTo(center);
  };
  const fit = shot(1);
  const close = shot(2);
  check('zoom=1 就是框满（与不传一致）', near(shot(undefined), fit), { fit, none: shot(undefined) });
  check('zoom=2 推进到约一半距离', close < fit * 0.55 && close > fit * 0.45, { fit, close });
  check('zoom<1 退远（看整体关系）', shot(0.5) > fit * 1.9, { fit, far: shot(0.5) });
  check('非法 zoom 退回框满（不把相机推进模型里）',
    near(shot(0), fit) && near(shot(Number.NaN), fit) && near(shot(-3), fit), { fit, zero: shot(0) });
  const radius = box.getSize(new Vector3()).length() / 2;
  check('放大不会近到穿进包围球（保底留出半径的 1/3）', shot(99) >= radius * 0.34, { shot: shot(99), radius });

  const orthoZoom = (zoom: number) => {
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 500);
    frameCamera(camera, box, 2, directionFromAngles(0, 90), new Vector3(0, 1, 0), zoom);
    return camera.top;
  };
  check('正交：zoom=2 时取景高度减半', near(orthoZoom(2), orthoZoom(1) / 2, 1e-9), { one: orthoZoom(1), two: orthoZoom(2) });
  check('正交：zoom 再大也有下限（画面不塌成 0）', orthoZoom(99) >= 0.02, orthoZoom(99));
}

if (failed) {
  console.log(`\n${failed} 项相机摆位测试失败`);
  process.exit(1);
}
console.log('\n相机摆位测试通过（AI 巡检会按这套数值转动视图）');
