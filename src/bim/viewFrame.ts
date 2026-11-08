/**
 * 相机摆位数学（AI 视角巡检 / 缩放至全部共用）。
 *
 * 抽出来的原因：这里全是纯数值计算，可以脱离 WebGL 在 node 里断言；
 * `ModelViewport` 只负责把结果同步到 refs / OrbitControls。
 */
import { Box3, OrthographicCamera, PerspectiveCamera, Sphere, Vector3 } from 'three';

type Camera = PerspectiveCamera | OrthographicCamera;

/** 方位角/仰角（度）→ 相机方向。Z-up：方位角从 +X 沿 +Y 逆时针，仰角从水平面向上 */
export function directionFromAngles(azimuth: number, elevation: number): Vector3 {
  const az = (azimuth * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  return new Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)).normalize();
}

/** 相机相对观察点的球坐标（度 / 米），用于告诉模型「现在是什么角度」 */
export function cameraAngles(position: Vector3, target: Vector3): { azimuth: number; elevation: number; distance: number } | null {
  const offset = position.clone().sub(target);
  const distance = offset.length();
  if (distance < 1e-6) return null;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    azimuth: round((Math.atan2(offset.y, offset.x) * 180) / Math.PI),
    elevation: round((Math.asin(Math.min(1, Math.max(-1, offset.z / distance))) * 180) / Math.PI),
    distance: round(distance * 1000) / 1000,
  };
}

/**
 * 把相机摆到「朝向 direction 看向 bounds 中心」，并按投影方式把 bounds 框满画面。
 * - 透视：距离由竖直/水平半视角里较小的那个决定（窄画面时左右才不会切边）
 * - 正交：按包围球设 top/bottom/left/right，距离只影响裁剪面
 * - zoom > 1 表示往里推（看细节），< 1 表示往后退（看整体关系）；只改取景范围，不改朝向
 * 返回 false 表示 bounds 为空（没有构件）。
 */
export function frameCamera(
  camera: Camera,
  bounds: Box3,
  aspect: number,
  direction: Vector3,
  up: Vector3,
  zoom = 1,
): boolean {
  if (bounds.isEmpty()) return false;
  const center = bounds.getCenter(new Vector3());
  const sphere = bounds.getBoundingSphere(new Sphere());
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const dir = direction.clone().normalize();
  // 非法的 zoom（0 / NaN / 负数）一律当 1，别让一张截图把相机推到模型内部
  const scale = Number.isFinite(zoom) && zoom > 0 ? Math.min(8, Math.max(0.2, zoom)) : 1;
  camera.up.copy(up);

  if (camera instanceof PerspectiveCamera) {
    const verticalHalf = (camera.fov * Math.PI) / 360;
    const horizontalHalf = Math.atan(Math.tan(verticalHalf) * ratio);
    const fit = Math.max((sphere.radius / Math.sin(Math.min(verticalHalf, horizontalHalf))) * 1.18, 0.6);
    // 放大时不能离得比包围球半径还近：穿进模型内部会拍到一堆背面
    const distance = Math.max(fit / scale, sphere.radius * 0.35, 0.05);
    camera.position.copy(center).addScaledVector(dir, distance);
    camera.near = Math.max(distance - sphere.radius * 4, 0.01);
    camera.far = Math.max(distance + sphere.radius * 8, 200);
  } else {
    const halfHeight = Math.max((sphere.radius * 1.25) / scale, 0.02);
    camera.position.copy(center).addScaledVector(dir, Math.max(sphere.radius * 6, 5));
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.left = -halfHeight * ratio;
    camera.right = halfHeight * ratio;
    camera.near = 0.01;
    camera.far = Math.max(sphere.radius * 80, 400);
  }

  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return true;
}
