// ============================================================================
// AI 面板尺寸：可拖拽调整 + 持久化
//
// 两个容易忽略的点：
//
// 1. **内联样式会压过 CSS 里的 max-* 上限**。面板默认用 em + vw/vh 计算尺寸，
//    一旦用户在拖拽时写入内联 px，CSS 那层"随窗口缩小"的保护就失效了 ——
//    所以夹紧必须在这里自己做，而且窗口尺寸变化时也要重算。
// 2. **拖拽要钳制在合理区间**：太小看不清、太大盖住模块主页面（正是不想要的）。
// ============================================================================

import { useCallback, useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

const STORAGE_KEY = 'c-cleanup-ai-panel-size';

/** 拖拽下限：再小就没法读对话了。 */
const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;
/** 与视口之间至少留出的边距（右侧 20px + 左侧留白）。 */
const VIEWPORT_MARGIN_X = 48;
const VIEWPORT_MARGIN_Y = 120;

export interface AiPanelSize {
  width: number;
  height: number;
}

function readStoredSize(): AiPanelSize | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AiPanelSize>;
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return null;
    if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return null;
    return { width: parsed.width, height: parsed.height };
  } catch {
    // 存储损坏就当没存过，不能让设置读不出就崩溃
    return null;
  }
}

/** 把尺寸夹到"当前视口允许的最大值"之间。窗口变小后必须重新夹。 */
function clampToViewport(size: AiPanelSize): AiPanelSize {
  const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN_X);
  const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN_Y);
  return {
    width: Math.min(Math.max(size.width, MIN_WIDTH), maxWidth),
    height: Math.min(Math.max(size.height, MIN_HEIGHT), maxHeight),
  };
}

export interface UsePanelSizeResult {
  /** 铺到面板上的内联尺寸；用默认尺寸时宽度交给 CSS（em 计算，跟随字号设置） */
  sizeStyle: CSSProperties;
  hasCustomSize: boolean;
  startResize: (event: ReactPointerEvent<HTMLElement>) => void;
  resetSize: () => void;
}

export function usePanelSize(): UsePanelSizeResult {
  const [size, setSize] = useState<AiPanelSize | null>(() => {
    const stored = readStoredSize();
    return stored ? clampToViewport(stored) : null;
  });

  // 视口变化时重新夹紧：否则用户拖大过、之后窗口缩小，面板会顶出屏幕。
  useEffect(() => {
    if (!size) return;
    const handleResize = () => setSize((previous) => (previous ? clampToViewport(previous) : previous));
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
    // 依赖里用 size 的引用会让每次拖拽都重挂监听，这里只需要"存在自定义尺寸"这个事实
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size !== null]);

  const startResize = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // 面板固定在右下角，所以拖拽发生在左上角手柄：
    // 指针向左/上移动 = 面板变大，取反即可。
    const panel = event.currentTarget.parentElement as HTMLElement | null;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = { width: rect.width, height: rect.height };

    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);

    // 用 ref 记住最新尺寸：松手时直接读它落盘。
    // 不能把写 localStorage 放进 setSize 的 updater 里 —— 那是纯函数，
    // StrictMode 下会被调用两次，写盘就成了副作用。
    let latest = initial;

    const handleMove = (moveEvent: PointerEvent) => {
      latest = clampToViewport({
        width: initial.width + (startX - moveEvent.clientX),
        height: initial.height + (startY - moveEvent.clientY),
      });
      setSize(latest);
    };
    const handleUp = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', handleMove);
      handle.removeEventListener('pointerup', handleUp);
      // 松手时才落盘：拖拽过程中反复写 localStorage 是没必要的 IO
      localStorage.setItem(STORAGE_KEY, JSON.stringify(latest));
    };

    handle.addEventListener('pointermove', handleMove);
    handle.addEventListener('pointerup', handleUp);
  }, []);

  const resetSize = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setSize(null);
  }, []);

  return {
    sizeStyle: size ? { width: size.width, height: size.height } : {},
    hasCustomSize: size !== null,
    startResize,
    resetSize,
  };
}
