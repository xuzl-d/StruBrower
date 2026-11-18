/**
 * 输入法（IME）组合态测试：回车上屏候选词时不能触发发送 / 提交。
 *
 * 覆盖：组合中、上屏瞬间、宽限窗口过后、Chrome 的 isComposing、
 * Safari/Firefox 的 keyCode 229 / 'Process'、React 事件形状、失焦复位、
 * 全局事件接线、表单隐式提交与「明确点按钮」的区别，以及源码接线不被人改丢。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  attachImeTracker, createImeTracker, ime, isImeComposing, isImeSubmit,
  type KeyLike,
} from '../src/ime';

let failed = 0;
let total = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

const enter: KeyLike = { key: 'Enter', keyCode: 13, isComposing: false };

/* 1. 纯状态机 */
{
  const t = createImeTracker();
  check('普通回车不算组合态', !t.isComposing(enter, 1000));
  t.noteStart();
  check('组词中的回车被拦下', t.isComposing(enter, 1000));
  check('组词中的 Escape 也被交还给输入法', t.isComposing({ key: 'Escape', keyCode: 27 }, 1000));
  t.noteEnd(1000);
  check('上屏那一下（Chrome：keydown 先于 compositionend）仍被拦', t.isComposing(enter, 1000));
  check('宽限窗口内（Safari：compositionend 先于 keydown）仍被拦', t.isComposing(enter, 1079));
  check('宽限窗口过后放行', !t.isComposing(enter, 1080));
  check('时间参数不影响普通按键', !t.isComposing({ key: 'a', keyCode: 65 }, 1080));
}

/* 2. 各家浏览器给的信号 */
{
  const t = createImeTracker();
  check('Chrome：nativeEvent.isComposing', t.isComposing({
    key: 'Enter', keyCode: 13, nativeEvent: { key: 'Enter', keyCode: 13, isComposing: true },
  }, 1000));
  check('Chrome：顶层 isComposing', t.isComposing({ key: 'Enter', isComposing: true }, 1000));
  check('Safari：keyCode 229', t.isComposing({ key: 'Enter', keyCode: 229 }, 1000));
  check('Firefox：key = Process', t.isComposing({ key: 'Process', keyCode: 229 }, 1000));
  check('React 事件：nativeEvent 里带 229', t.isComposing({
    key: 'Enter', keyCode: 13, nativeEvent: { key: 'Process', keyCode: 229 },
  }, 1000));
  t.noteStart();
  t.noteReset();
  check('失焦 / 切窗口收不到 compositionend 时不会卡住', !t.isComposing(enter, 1000));
}

/* 3. DOM 事件接线（fake document / window） */
function fakeTarget() {
  const handlers = new Map<string, Array<() => void>>();
  return {
    addEventListener(type: string, fn: () => void) {
      handlers.set(type, [...(handlers.get(type) ?? []), fn]);
    },
    removeEventListener(type: string, fn: () => void) {
      handlers.set(type, (handlers.get(type) ?? []).filter((item) => item !== fn));
    },
    emit(type: string) {
      for (const fn of handlers.get(type) ?? []) fn();
    },
    count(type: string) {
      return (handlers.get(type) ?? []).length;
    },
  };
}
{
  const doc = fakeTarget();
  const win = fakeTarget();
  const t = createImeTracker();
  const detach = attachImeTracker(doc as never, win as never, t);
  check('注册了 compositionstart / compositionend / focusout / blur',
    doc.count('compositionstart') === 1 && doc.count('compositionend') === 1
    && doc.count('focusout') === 1 && win.count('blur') === 1);
  doc.emit('compositionstart');
  check('compositionstart 事件驱动组合态', t.isComposing(enter, 1000));
  doc.emit('focusout');
  check('focusout 复位', !t.isComposing(enter, 1000));
  doc.emit('compositionstart');
  win.emit('blur');
  check('window blur 复位', !t.isComposing(enter, 1000));
  doc.emit('compositionend');
  check('compositionend 后立刻仍在宽限窗口', t.isComposing(enter));
  detach();
  check('解绑后所有监听都移除', doc.count('compositionstart') === 0 && win.count('blur') === 0);
  // 把宽限窗口拨过去，否则上一次 compositionend 的真实时间戳会盖过虚拟时间
  t.noteEnd(Date.now() - 1000);
  doc.emit('compositionstart');
  check('解绑后事件不再影响状态', !t.isComposing(enter));
}

/* 4. 全局 tracker / 表单隐式提交 */
{
  const doc = fakeTarget();
  const win = fakeTarget();
  const detach = attachImeTracker(doc as never, win as never);
  check('全局判定初始放行', !isImeComposing(enter, 1000));
  doc.emit('compositionstart');
  check('全局判定接住组合态', isImeComposing(enter, 1000));
  doc.emit('compositionend');
  // 把结束时间拨回过去，模拟宽限窗口已过
  ime.noteEnd(Date.now() - 1000);
  check('组合结束后放行', !isImeComposing(enter));
  const plainSubmit = { nativeEvent: new Event('submit') };
  check('普通提交不被拦', !isImeSubmit(plainSubmit));
  doc.emit('compositionstart');
  check('组合中的隐式提交被拦', isImeSubmit(plainSubmit));

  // 模拟浏览器原生 SubmitEvent：点按钮触发的提交永远不该被吞
  class FakeSubmitEvent extends Event {
    submitter: unknown;
    constructor(submitter: unknown) {
      super('submit');
      this.submitter = submitter;
    }
  }
  const globals = globalThis as unknown as { SubmitEvent?: unknown };
  const previous = globals.SubmitEvent;
  globals.SubmitEvent = FakeSubmitEvent;
  check('明确点击提交按钮不受组合态影响', !isImeSubmit({ nativeEvent: new FakeSubmitEvent({}) }));
  check('不带 submitter 的隐式提交仍被拦', isImeSubmit({ nativeEvent: new FakeSubmitEvent(null) }));
  if (previous === undefined) delete globals.SubmitEvent;
  else globals.SubmitEvent = previous;
  detach();
  ime.noteReset();
}

/* 5. 源码接线：防止以后重构时把守卫删掉 */
{
  const root = process.cwd();
  const sourceFiles = [
    'src/components/AiPanel.tsx',
    'src/components/VersionsDialog.tsx',
    'src/components/MembersDialog.tsx',
    'src/components/account/ProjectsSection.tsx',
    'src/components/account/UsersSection.tsx',
    'src/components/account/ProfileSection.tsx',
  ];
  let enterHandlers = 0;
  for (const file of sourceFiles) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    let at = src.indexOf("event.key === 'Enter'");
    while (at >= 0) {
      enterHandlers += 1;
      const around = src.slice(Math.max(0, at - 260), at + 260);
      check(`${file} 的回车处理带 IME 守卫`, around.includes('isImeComposing'));
      at = src.indexOf("event.key === 'Enter'", at + 1);
    }
  }
  check('覆盖 7 处「回车即动作」输入框', enterHandlers >= 7, enterHandlers);

  const ai = fs.readFileSync(path.join(root, 'src/components/AiPanel.tsx'), 'utf8');
  const branch = ai.indexOf("event.key !== 'Enter' || event.shiftKey");
  const guard = ai.indexOf('if (isImeComposing(event)) return;', branch);
  const send = ai.indexOf('void send();', branch);
  check('AI 输入框：先判 IME，再 preventDefault + send', branch > 0 && guard > branch && send > guard);
  check('AI 表单 onSubmit 有隐式提交守卫', ai.includes('if (isImeSubmit(event)) return;'));
  const users = fs.readFileSync(path.join(root, 'src/components/account/UsersSection.tsx'), 'utf8');
  check('创建用户表单 onSubmit 有隐式提交守卫', users.includes('if (isImeSubmit(event)) return;'));
}

console.log(failed === 0
  ? `\n输入法组合态测试 ${total} 项全部通过 ✅`
  : `\n输入法组合态测试失败 ${failed}/${total} 项 ❌`);
if (failed) process.exit(1);
