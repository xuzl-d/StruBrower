/** 对象捕捉：候选点生成、去重优先级、屏幕距离挑选。 */
import { buildSnapCandidates, pickSnapCandidate, SNAP_PRIORITY } from '../src/view/snapping';
import { createDemoProject } from '../src/bim/template';
import type { ProjectDocument } from '../src/bim/types';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

const demo = createDemoProject();
const candidates = buildSnapCandidates(demo);
const has = (x: number, y: number, kind?: string) => candidates.some((candidate) => (
  Math.abs(candidate.point[0] - x) < 1e-6 && Math.abs(candidate.point[1] - y) < 1e-6
  && (!kind || candidate.kind === kind)
));

check('生成端点候选', has(0, 0, 'endpoint'), candidates.slice(0, 4));
check('生成墙中点候选', has(3, 0, 'midpoint'));
check('生成轴网端点候选', has(0, 4));

const crossing: ProjectDocument = {
  ...demo,
  elements: [
    { id: 'w1', name: '墙 1', category: 'wall', typeId: 'type-wall-200', levelId: demo.levels[0]!.id, visible: true, start: [0, 0], end: [4, 4], baseOffset: 0, topLevelId: demo.levels[1]!.id, topOffset: 0 },
    { id: 'w2', name: '墙 2', category: 'wall', typeId: 'type-wall-200', levelId: demo.levels[0]!.id, visible: true, start: [0, 4], end: [4, 0], baseOffset: 0, topLevelId: demo.levels[1]!.id, topOffset: 0 },
  ],
  grids: [],
};
const crossCandidates = buildSnapCandidates(crossing);
check('计算墙-墙交点', crossCandidates.some((candidate) => (
  candidate.kind === 'intersection' && Math.abs(candidate.point[0] - 2) < 1e-6 && Math.abs(candidate.point[1] - 2) < 1e-6
)), crossCandidates);

const screenOf = (point: [number, number]) => ({ x: point[0] * 10, y: point[1] * 10 });
const picked = pickSnapCandidate(crossCandidates, screenOf, { x: 20.5, y: 20.5 }, 14);
check('优先命中交点', picked?.candidate.kind === 'intersection' && picked.candidate.point[0] === 2, picked);
check('半径外不命中', pickSnapCandidate(crossCandidates, screenOf, { x: 200, y: 200 }, 14) === null);

const endpointVsMidpoint = [
  { point: [0, 0] as [number, number], kind: 'endpoint' as const },
  { point: [0.1, 0] as [number, number], kind: 'midpoint' as const },
];
const prioritized = pickSnapCandidate(endpointVsMidpoint, screenOf, { x: 0.6, y: 0 }, 14);
check('同类距离内端点优先于中点', prioritized?.candidate.kind === 'endpoint', prioritized);

check('优先级定义完整', SNAP_PRIORITY.endpoint > SNAP_PRIORITY.intersection && SNAP_PRIORITY.intersection > SNAP_PRIORITY.midpoint);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
