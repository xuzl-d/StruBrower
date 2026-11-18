/**
 * 只读特征树查询（describe）：请求规范化 + 对当前文档求值。
 *
 * 覆盖：类型白名单与上限、分页参数夹取、默认 type、完整 shape 不被裁剪、
 * 单特征查询、关键词检索、目标解析错误文字，以及 agentLoop 的回灌闭环。
 */
import { MAX_DESCRIBE_COUNT, MAX_DESCRIBE_REQUESTS, normalizeDescribe } from '../server/ai/describe.js';
import { MAX_TOTAL_CHARS, runDescribe } from '../src/ai/describe';
import { runAgentLoop } from '../src/ai/agentLoop';
import type { AiDescribeRequest } from '../src/data';
import type { ProjectDocument } from '../src/bim/types';

let failed = 0;
let total = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

const bigLoft = {
  shape: 'loft',
  sections: Array.from({ length: 8 }, (_, index) => ({
    z: index * 0.1,
    profile: [[0, 0], [0.4, -0.1], [0.8, 0], [0.4, 0.1]],
  })),
};

function makeDocument() {
  const features = [
    { id: 'body', label: '车身主轮廓', shape: { shape: 'roundedBox', width: 4.2, depth: 1.8, height: 0.9, radius: 0.2 }, translate: [0, 0, 0.6], material: 'paintOrange' },
    { id: 'glass', label: '前风挡', shape: bigLoft, translate: [0.4, 0, 1.2], material: 'glass' },
    { id: 'mirror-l', label: '左后视镜支座', shape: { shape: 'box', width: 0.12, depth: 0.08, height: 0.1 }, translate: [0.8, 0.9, 1.1], mode: 'add' },
    { id: 'hole', label: '车门开孔', shape: { shape: 'cylinder', radius: 0.05, height: 0.2 }, mode: 'cut' },
  ];
  return {
    name: '测试项目',
    levels: [{ id: 'L0', name: '标高 0', elevation: 0 }],
    types: [],
    grids: [],
    materials: [],
    elements: [
      { id: 'e1', name: '黄色运动轿跑', category: 'mesh', offset: [1, 2, 0], primitive: { kind: 'solid', features } },
      { id: 'e2', name: '场地', category: 'slab' },
    ],
  } as unknown as ProjectDocument;
}

/* 1. 服务端规范化 */
{
  const normalized = normalizeDescribe([
    { type: 'element', target: '黄色运动轿跑', from: 2, count: 3 },
    { type: 'feature', target: 'e1', feature: 2 },
    { type: 'search', query: '镜' },
    { target: 'e1' },
    { type: 'feature', target: 'e1' },
    { type: 'unknown', target: 'e1' },
    { type: 'search', query: '   ' },
    null,
  ]) as AiDescribeRequest[];
  check('最多 4 条 + 非法项丢弃', normalized.length === Math.min(4, MAX_DESCRIBE_REQUESTS), normalized);
  check('element 保留 from/count', normalized[0]?.type === 'element' && normalized[0].from === 2 && normalized[0].count === 3);
  check('feature 支持数字序号', normalized[1]?.type === 'feature' && normalized[1].feature === 2);
  check('search 保留关键词', normalized[2]?.type === 'search' && normalized[2].query === '镜');
  check('没写 type 但有 target 视为 element', normalized[3]?.type === 'element');

  const defaulted = normalizeDescribe([{ target: 'e1' }]) as AiDescribeRequest[];
  check('缺省 from=1 / count=上限', defaulted[0]?.type === 'element' && defaulted[0].from === 1 && defaulted[0].count === MAX_DESCRIBE_COUNT);
  const clamped = normalizeDescribe([{ type: 'element', from: -5, count: 9999 }, { type: 'search', query: 'x'.repeat(300) }]) as AiDescribeRequest[];
  check('from / count 夹到合法区间', clamped[0]?.type === 'element' && clamped[0].from === 1 && clamped[0].count === MAX_DESCRIBE_COUNT);
  check('query 超长被截断', clamped[1]?.type === 'search' && clamped[1].query.length === 80);
  check('非数组输入返回空', normalizeDescribe(null).length === 0 && normalizeDescribe('x').length === 0);
}

/* 2. 前端求值 */
{
  const doc = makeDocument();
  const all = runDescribe(doc, [
    { type: 'element', target: 'e1', from: 1, count: 24 },
  ] as AiDescribeRequest[]);
  check('输出带只读说明与序号约定', all.includes('[特征树查询结果]') && all.includes('index 从 1 起'));
  check('完整 shape 原始数据在场（未被裁剪）', all.includes('"sections"') && all.includes('"profile"'));
  check('变换与材质字段都在', all.includes('"translate"') && all.includes('"material"'));
  check('切除模式也在', all.includes('"mode":"cut"'));
  check('构件元信息带 position', all.includes('position=[1,2]'));

  const page = runDescribe(doc, [{ type: 'element', target: '黄色运动轿跑', from: 3, count: 1 }] as AiDescribeRequest[]);
  check('分页只列指定区间', page.includes('3)') && !page.includes('"id":"body"') && !page.includes('"id":"hole"'));
  check('分页末尾提示续查', page.includes('from=4') && page.includes('还有'));

  const one = runDescribe(doc, [{ type: 'feature', feature: 2 }] as AiDescribeRequest[]);
  check('单特征查询给出完整定义', one.includes('特征 2 的完整定义') && one.includes('"id":"glass"') && one.includes('"sections"'));

  const found = runDescribe(doc, [{ type: 'search', query: '镜' }] as AiDescribeRequest[]);
  check('search 找到特征与序号', found.includes('特征 3') && found.includes('左后视镜支座'));
  const none = runDescribe(doc, [{ type: 'search', query: '不存在的部件' }] as AiDescribeRequest[]);
  check('search 无结果给出下一步指引', none.includes('没有匹配') && none.includes('type":"element'));

  const missing = runDescribe(doc, [{ type: 'feature', feature: 99 }, { type: 'element', target: '不存在' }] as AiDescribeRequest[]);
  check('目标解析失败不抛异常，逐条写清原因', missing.includes('超出范围') && missing.includes('找不到造型构件'));

  const multi = makeDocument();
  (multi.elements as Array<Record<string, unknown>>).push({
    id: 'e3', name: '另一台车', category: 'mesh', primitive: { kind: 'solid', features: [{ id: 'x', label: '车身', shape: { shape: 'box', width: 1, depth: 1, height: 1 } }] },
  });
  const ambiguous = runDescribe(multi, [{ type: 'element', from: 1, count: 2 }] as AiDescribeRequest[]);
  check('多个造型构件时要求指定 target，并列出候选', ambiguous.includes('请用 target 指定') && ambiguous.includes('另一台车'));
  const byNumber = runDescribe(multi, [{ type: 'element', target: 2, from: 1, count: 1 }] as AiDescribeRequest[]);
  check('target 用数字序号能定位第二个构件', byNumber.includes('另一台车'));

  // 总预算：4 条请求各吐 2 万就是 8 万字符，回灌时会被裁掉大半，
  // 模型「以为看全了其实只看了一半」，所以按总预算分配、超出就明说没执行。
  const wide = makeDocument();
  const profile = Array.from({ length: 20 }, (_, i) => [
    +(0.01 * Math.cos((i / 20) * Math.PI * 2)).toFixed(4),
    +(0.01 * Math.sin((i / 20) * Math.PI * 2)).toFixed(4),
  ]);
  (wide.elements[0] as unknown as { primitive: { features: unknown[] } }).primitive.features = Array.from(
    { length: 120 },
    (_, i) => ({
      id: `f${i}`,
      label: `薄片 ${i}`,
      shape: { shape: 'prism', profile, height: 0.002 },
      translate: [0, 0, i * 0.001],
    }),
  );
  const four = runDescribe(wide, Array.from(
    { length: 4 },
    () => ({ type: 'element', target: 'e1', from: 1, count: 24 }),
  ) as AiDescribeRequest[]);
  check('4 条大请求的总输出压在预算内', four.length < MAX_TOTAL_CHARS + 2000, four.length);
  check('预算耗尽后的请求写明「没有执行」，不留空白让模型以为结果是空', four.includes('没有执行'), four.slice(-180));
  check('预算内的结果仍带分页续查提示', /from=\d+/.test(four), four.slice(-180));
}

// [合并说明] 此闭环段针对远程扁平 describe 架构；当前主干为注册表工具循环，
// 等价的只读工具回灌/打转检测由 agent-loop-test 与 agent-tools-test 覆盖。
// /* 3. 自检闭环：describe 结果会回灌，并参与打转检测 */
// {
//   const seen: string[] = [];
//   const first = { text: '把车身调长一点', images: [], thumbs: [], files: [], shots: 0 };
//   const run = await runAgentLoop(first, {
//     goal: '调整车身',
//     plan: async (round) => {
//       seen.push(round.text);
//       if (seen.length === 1) return { reply: '先查一下完整特征树', describe: [{ type: 'feature', feature: 2 }] as AiDescribeRequest[] };
//       return { reply: '改好了', ops: [{ op: 'updateElement', target: 'e1', color: '#ff0000' }], done: true, inspect: [{ view: 'front', label: '前视' }] };
//     },
//     apply: async () => ({ note: '已应用 1 条指令' }),
//     inspect: async () => [{ label: '前视', dataUrl: 'data:image/png;base64,AA', thumb: 'data:image/png;base64,AA' }],
//     describe: async (requests) => runDescribe(makeDocument(), requests),
//     stopped: () => false,
//     ensureFirstLook: false,
//     maxSteps: 4,
//   });
//   check('闭环把查询结果回灌到下一轮', seen.length >= 2 && seen[1]!.includes('[特征树查询结果]') && seen[1]!.includes('"id":"glass"'), seen[1]);
//   check('查询轮不会提前收工', run.reason === 'done' || run.reason === 'max-steps', run.reason);
// 
//   const repeated = await runAgentLoop(first, {
//     goal: '反复查同一个特征',
//     plan: async () => ({ reply: '再查一次', describe: [{ type: 'feature', feature: 2 }] as AiDescribeRequest[] }),
//     apply: async () => ({ note: '' }),
//     inspect: async () => [],
//     describe: async () => '[特征树查询结果] 同一份定义',
//     stopped: () => false,
//     maxSteps: 6,
//   });
//   check('同一查询反复出现且没有任何修改会被判打转', repeated.reason === 'repeated', repeated.reason);
// }

console.log(failed === 0
  ? `\n特征树查询测试 ${total} 项全部通过 ✅`
  : `\n特征树查询测试失败 ${failed}/${total} 项 ❌`);
if (failed) process.exit(1);
