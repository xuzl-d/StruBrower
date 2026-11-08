/**
 * 模态弹窗外壳：统一「锁定主界面」的行为。
 * - 遮罩铺满窗口并吞掉所有指针事件，点击空白不再关闭弹窗（避免误点丢输入），
 *   只在卡片上做一次轻微抖动提示「请用 ✕ / 取消 / 完成 关闭」。
 * - 打开时把焦点收进弹窗（Tab / Shift+Tab 在弹窗内循环），关闭后焦点归还给原元素。
 * - 键盘快捷键的屏蔽与 Esc 关闭由 App 统一处理，这里不重复监听。
 */
import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface ModalShellProps {
  children: ReactNode;
  /** 卡片 class，默认 `modal-card`，可追加尺寸类（如 `manager-card`） */
  cardClassName?: string;
  cardStyle?: CSSProperties;
  /** 无障碍名称，一般写弹窗标题 */
  ariaLabel?: string;
}

export default function ModalShell({
  children,
  cardClassName = 'modal-card',
  cardStyle,
  ariaLabel,
}: ModalShellProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const nudgeTimer = useRef<number | null>(null);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    card.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((element) => element.getClientRects().length > 0);
      if (!items.length) {
        event.preventDefault();
        card.focus({ preventScroll: true });
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = Boolean(active && card.contains(active));
      if (!event.shiftKey && (!inside || active === tail)) {
        event.preventDefault();
        head.focus();
      } else if (event.shiftKey && (!inside || active === head)) {
        event.preventDefault();
        tail.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (nudgeTimer.current) window.clearTimeout(nudgeTimer.current);
      if (previous && previous !== document.body && typeof previous.focus === 'function') {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  /** 点空白：不关闭，只抖一下卡片，提示弹窗处于模态状态 */
  const nudge = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 不让焦点跑到遮罩上，弹窗内的输入不被打断
    event.preventDefault();
    const card = cardRef.current;
    if (!card) return;
    card.classList.remove('modal-nudge');
    void card.offsetWidth;
    card.classList.add('modal-nudge');
    if (nudgeTimer.current) window.clearTimeout(nudgeTimer.current);
    nudgeTimer.current = window.setTimeout(() => card.classList.remove('modal-nudge'), 360);
  };

  return (
    <div className="modal-backdrop" onPointerDown={nudge}>
      <div
        ref={cardRef}
        className={cardClassName}
        style={cardStyle}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
