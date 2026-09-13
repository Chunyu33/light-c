// 布局切换时的窗口尺寸协调
// 侧边栏需要稳定的内容宽度，因此在切换前先完成窗口约束和必要的扩展。

import { currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition } from '@tauri-apps/api/window';
import { DEFAULT_LAYOUT_MODE, type LayoutMode } from '../config/moduleMeta';

export const BASE_WINDOW_MIN_SIZE = { width: 820, height: 610 } as const;
// 侧边栏包含完整功能菜单和页面内容，720px 高度可减少底部菜单被截断的情况。
export const SIDEBAR_WINDOW_MIN_SIZE = { width: 1080, height: 720 } as const;
// 预留少量工作区边距，避免窗口贴边时被任务栏或系统缩放误判为超出屏幕。
export const WINDOW_WORK_AREA_MARGIN = 24;

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
    // 没有缓存（首次启动）时与设置默认值保持一致，否则窗口最小尺寸会按卡片模式准备，
    // 而界面已经渲染侧边栏，导致菜单被裁切。
    return savedSettings.layoutMode === 'pages' || savedSettings.layoutMode === 'sidebar'
      ? savedSettings.layoutMode
      : savedSettings.layoutMode === 'cards'
        ? 'cards'
        : DEFAULT_LAYOUT_MODE;
  } catch (error) {
    // 设置损坏时使用默认布局，避免启动阶段因尺寸策略阻断主界面。
    console.warn('读取窗口布局设置失败:', error);
    return DEFAULT_LAYOUT_MODE;
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

export function getMaximumLogicalWindowSize(
  workArea: { width: number; height: number },
  scaleFactor: number,
): WindowLayoutSize | null {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return null;

  // 工作区尺寸来自物理像素，边距也先按物理像素扣除，保证不同 DPI 下规则一致。
  return {
    width: Math.max(1, Math.floor((workArea.width - WINDOW_WORK_AREA_MARGIN) / scaleFactor)),
    height: Math.max(1, Math.floor((workArea.height - WINDOW_WORK_AREA_MARGIN) / scaleFactor)),
  };
}

export function getEffectiveWindowMinimumSize(
  layoutMode: LayoutMode,
  maximumSize: WindowLayoutSize | null,
): WindowLayoutSize {
  const configuredMinimum = getWindowMinimumSize(layoutMode);
  if (!maximumSize) return configuredMinimum;

  // 小分辨率设备无法达到设计目标时服从工作区，避免最小尺寸大于屏幕可用空间。
  return {
    width: Math.max(1, Math.min(configuredMinimum.width, maximumSize.width)),
    height: Math.max(1, Math.min(configuredMinimum.height, maximumSize.height)),
  };
}

interface WindowBounds {
  currentSize: WindowLayoutSize;
  maximumSize: WindowLayoutSize | null;
  outerPosition: { x: number; y: number };
  outerSize: WindowLayoutSize;
}

async function readWindowBounds(): Promise<WindowBounds> {
  const appWindow = getCurrentWindow();
  const scaleFactor = await appWindow.scaleFactor();
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error('无法读取当前窗口缩放比例');
  }

  const [physicalInnerSize, monitor, outerPosition, physicalOuterSize] = await Promise.all([
    appWindow.innerSize(),
    currentMonitor(),
    appWindow.outerPosition(),
    appWindow.outerSize(),
  ]);

  return {
    currentSize: toLogicalSize(physicalInnerSize, scaleFactor),
    maximumSize: monitor
      ? getMaximumLogicalWindowSize({ width: monitor.workArea.size.width, height: monitor.workArea.size.height }, scaleFactor)
      : null,
    outerPosition,
    outerSize: toLogicalSize(physicalOuterSize, scaleFactor),
  };
}

async function setWindowMinimumSize(layoutMode: LayoutMode, maximumSize: WindowLayoutSize | null) {
  const minimumSize = getEffectiveWindowMinimumSize(layoutMode, maximumSize);
  await getCurrentWindow().setMinSize(new LogicalSize(minimumSize.width, minimumSize.height));
}

async function expandWindowForSidebar(bounds: WindowBounds, minimumSize: WindowLayoutSize): Promise<void> {
  const appWindow = getCurrentWindow();
  if (await appWindow.isMaximized()) return;

  const scaleFactor = await appWindow.scaleFactor();
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return;

  const nextWidth = Math.max(bounds.currentSize.width, minimumSize.width);
  const nextHeight = Math.max(bounds.currentSize.height, minimumSize.height);
  if (nextWidth === bounds.currentSize.width && nextHeight === bounds.currentSize.height) return;

  // 当前窗口如果已经大于工作区，不因切换布局而强制缩小，避免覆盖用户主动设置的尺寸。
  const safeWidth = bounds.maximumSize
    ? Math.max(bounds.currentSize.width, Math.min(nextWidth, bounds.maximumSize.width))
    : nextWidth;
  const safeHeight = bounds.maximumSize
    ? Math.max(bounds.currentSize.height, Math.min(nextHeight, bounds.maximumSize.height))
    : nextHeight;
  const nextSize = new LogicalSize(Math.round(safeWidth), Math.round(safeHeight));
  await appWindow.setSize(nextSize);

  const monitor = await currentMonitor();
  if (!monitor) return;

  // 扩展时尽量保持窗口中心不变，并把结果限制在当前显示器工作区内，避免窗口边缘跑出屏幕。
  const nextOuterWidth = bounds.outerSize.width + (safeWidth - bounds.currentSize.width) * scaleFactor;
  const nextOuterHeight = bounds.outerSize.height + (safeHeight - bounds.currentSize.height) * scaleFactor;
  const centeredX = bounds.outerPosition.x - (nextOuterWidth - bounds.outerSize.width) / 2;
  const centeredY = bounds.outerPosition.y - (nextOuterHeight - bounds.outerSize.height) / 2;
  const workAreaLeft = monitor.workArea.position.x;
  const workAreaTop = monitor.workArea.position.y;
  const workAreaRight = workAreaLeft + monitor.workArea.size.width;
  const workAreaBottom = workAreaTop + monitor.workArea.size.height;
  // 极端情况下旧窗口可能本来就大于工作区，此时保留原位置，不制造反向跳动。
  const nextX = nextOuterWidth <= monitor.workArea.size.width
    ? clamp(centeredX, workAreaLeft, workAreaRight - nextOuterWidth)
    : bounds.outerPosition.x;
  const nextY = nextOuterHeight <= monitor.workArea.size.height
    ? clamp(centeredY, workAreaTop, workAreaBottom - nextOuterHeight)
    : bounds.outerPosition.y;
  if (Math.round(nextX) !== bounds.outerPosition.x || Math.round(nextY) !== bounds.outerPosition.y) {
    await appWindow.setPosition(new PhysicalPosition(Math.round(nextX), Math.round(nextY)));
  }
}

export async function prepareWindowForLayout(layoutMode: LayoutMode): Promise<void> {
  const bounds = await readWindowBounds();
  const minimumSize = getEffectiveWindowMinimumSize(layoutMode, bounds.maximumSize);

  // 先更新最小尺寸，再扩展当前窗口，保证切换完成后用户不能立即拖回不适合的宽度。
  await setWindowMinimumSize(layoutMode, bounds.maximumSize);
  if (layoutMode === 'sidebar') {
    await expandWindowForSidebar(bounds, minimumSize);
  }
}

export async function prepareWindowForSavedLayout(): Promise<LayoutMode> {
  const savedLayoutMode = getSavedLayoutMode();
  await prepareWindowForLayout(savedLayoutMode);
  return savedLayoutMode;
}
