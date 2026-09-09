// 布局切换时的窗口尺寸协调
// 侧边栏需要稳定的内容宽度，因此在切换前先完成窗口约束和必要的扩展。

import { currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition } from '@tauri-apps/api/window';
import type { LayoutMode } from '../config/moduleMeta';

export const BASE_WINDOW_MIN_SIZE = { width: 820, height: 610 } as const;
export const SIDEBAR_WINDOW_MIN_SIZE = { width: 1080, height: 610 } as const;

interface WindowLayoutSize {
  width: number;
  height: number;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function getSavedLayoutMode(): LayoutMode {
  try {
    const savedSettings = JSON.parse(localStorage.getItem('c-cleanup-settings') ?? '{}') as { layoutMode?: unknown };
    return savedSettings.layoutMode === 'pages' || savedSettings.layoutMode === 'sidebar' ? savedSettings.layoutMode : 'cards';
  } catch (error) {
    // 设置损坏时使用最小窗口布局，避免启动阶段因尺寸策略阻断主界面。
    console.warn('读取窗口布局设置失败:', error);
    return 'cards';
  }
}

function toLogicalSize(physicalSize: { width: number; height: number }, scaleFactor: number): WindowLayoutSize {
  return {
    width: physicalSize.width / scaleFactor,
    height: physicalSize.height / scaleFactor,
  };
}

export function getWindowMinimumSize(layoutMode: LayoutMode) {
  return layoutMode === 'sidebar' ? SIDEBAR_WINDOW_MIN_SIZE : BASE_WINDOW_MIN_SIZE;
}

async function setWindowMinimumSize(layoutMode: LayoutMode) {
  const minimumSize = getWindowMinimumSize(layoutMode);
  await getCurrentWindow().setMinSize(new LogicalSize(minimumSize.width, minimumSize.height));
}

async function expandWindowForSidebar(): Promise<void> {
  const appWindow = getCurrentWindow();
  if (await appWindow.isMaximized()) return;

  const scaleFactor = await appWindow.scaleFactor();
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return;

  const [physicalInnerSize, monitor, outerPosition, outerSize] = await Promise.all([
    appWindow.innerSize(),
    currentMonitor(),
    appWindow.outerPosition(),
    appWindow.outerSize(),
  ]);
  const currentSize = toLogicalSize(physicalInnerSize, scaleFactor);
  if (currentSize.width >= SIDEBAR_WINDOW_MIN_SIZE.width) return;

  // 多显示器和高 DPI 下优先服从当前工作区，无法达到目标时仍切换布局并交给 CSS 收缩适配。
  const maximumWidth = monitor
    ? Math.max(BASE_WINDOW_MIN_SIZE.width, Math.floor(monitor.workArea.size.width / scaleFactor) - 24)
    : SIDEBAR_WINDOW_MIN_SIZE.width;
  const nextWidth = Math.min(SIDEBAR_WINDOW_MIN_SIZE.width, maximumWidth);
  const nextSize = new LogicalSize(nextWidth, Math.max(BASE_WINDOW_MIN_SIZE.height, Math.round(currentSize.height)));
  await appWindow.setSize(nextSize);

  if (!monitor) return;

  // 扩展时尽量保持窗口中心不变，并把结果限制在当前显示器工作区内，避免右侧内容被屏幕截断。
  const nextPhysicalWidth = nextWidth * scaleFactor;
  const centeredX = outerPosition.x - (nextPhysicalWidth - outerSize.width) / 2;
  const workAreaLeft = monitor.workArea.position.x;
  const workAreaRight = workAreaLeft + monitor.workArea.size.width;
  const nextX = clamp(centeredX, workAreaLeft, workAreaRight - nextPhysicalWidth);
  if (Math.round(nextX) !== outerPosition.x) {
    await appWindow.setPosition(new PhysicalPosition(Math.round(nextX), outerPosition.y));
  }
}

export async function prepareWindowForLayout(layoutMode: LayoutMode): Promise<void> {
  // 先更新最小尺寸，再扩展当前窗口，保证切换完成后用户不能立即拖回不适合的宽度。
  await setWindowMinimumSize(layoutMode);
  if (layoutMode === 'sidebar') {
    await expandWindowForSidebar();
  }
}

export async function prepareWindowForSavedLayout(): Promise<LayoutMode> {
  const savedLayoutMode = getSavedLayoutMode();
  await prepareWindowForLayout(savedLayoutMode);
  return savedLayoutMode;
}
