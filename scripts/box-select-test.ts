/** 框选几何判定测试（投影、window/crossing 语义、平面正交相机）。 */
import { Box3, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import {
  pickByScreenRect,
  projectBoxToScreen,
  rectContains,
  rectFromPoints,
  rectIntersects,
  rectMatches,
} from '../src/view/boxSelect';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

const normalized = rectFromPoints(200, 300, 100, 120);
check('rectFromPoints 归一化', normalized.minX === 100 && normalized.minY === 120 && normalized.maxX === 200 && normalized.maxY === 300, normalized);

const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
const inner = { minX: 2, minY: 2, maxX: 8, maxY: 8 };
const overlap = { minX: 5, minY: 5, maxX: 15, maxY: 15 };
const outside = { minX: 20, minY: 20, maxX: 30, maxY: 30 };
check('contains：完全包含才为 true', rectContains(box, inner) && !rectContains(box, overlap));
check('intersects：重叠为 true，分离为 false', rectIntersects(box, overlap) && !rectIntersects(box, outside));
check('rectMatches：window / crossing 语义不同', rectMatches(box, overlap, 'crossing') && !rectMatches(box, overlap, 'window'));

const viewport = { width: 800, height: 600 };
const perspective = new PerspectiveCamera(45, viewport.width / viewport.height, 0.1, 1000);
perspective.position.set(0, 0, 10);
perspective.lookAt(0, 0, 0);
perspective.updateMatrixWorld();
perspective.updateProjectionMatrix();

const centered = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
const far = new Box3(new Vector3(20, -1, -1), new Vector3(22, 1, 1));
const projected = projectBoxToScreen(centered, perspective, viewport);
check('透视投影包围盒', Boolean(projected));
check('投影中心落在视口中心', Math.abs((projected!.minX + projected!.maxX) / 2 - 400) < 1 && Math.abs((projected!.minY + projected!.maxY) / 2 - 300) < 1, projected);

// 中心构件投影范围约 x 327..473 / y 228..372，取一个完全包住它的框
const centerRect = { minX: 300, minY: 200, maxX: 500, maxY: 400 };
const entries = [{ id: 'a', box: centered }, { id: 'b', box: far }];
check('window：只命中完全包含的构件', JSON.stringify(pickByScreenRect(entries, perspective, viewport, centerRect, 'window')) === JSON.stringify(['a']));
check('crossing：远处构件不命中', JSON.stringify(pickByScreenRect(entries, perspective, viewport, centerRect, 'crossing')) === JSON.stringify(['a']));

const edgeRect = {
  minX: projected!.minX - 30,
  minY: projected!.minY - 30,
  maxX: projected!.minX + 5,
  maxY: projected!.minY + 5,
};
check('window：部分重叠不选中', pickByScreenRect([{ id: 'a', box: centered }], perspective, viewport, edgeRect, 'window').length === 0, edgeRect);
check('crossing：部分重叠选中', pickByScreenRect([{ id: 'a', box: centered }], perspective, viewport, edgeRect, 'crossing').length === 1, edgeRect);

const plan = new OrthographicCamera(-10, 10, 7.5, -7.5, 0.1, 1000);
plan.position.set(0, 0, 20);
plan.up.set(0, 1, 0);
plan.lookAt(0, 0, 0);
plan.updateMatrixWorld();
plan.updateProjectionMatrix();
const planRect = { minX: 340, minY: 240, maxX: 460, maxY: 360 };
check('平面视图（正交）框选命中中心构件', pickByScreenRect([{ id: 'a', box: centered }, { id: 'b', box: far }], plan, viewport, planRect, 'window').join(',') === 'a');

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
