// ============================================================================
// 主窗口尺寸持久化
// 保存用户调整后的普通窗口尺寸，避免最大化尺寸覆盖下次启动的默认尺寸。
// ============================================================================

import { useEffect } from 'react';
import { currentMonitor, getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { getEffectiveWindowMinimumSize, getMaximumLogicalWindowSize, prepareWindowForSavedLayout } from './windowLayout';

const WINDOW_STATE_STORAGE_KEY = 'c-cleanup-window-state';
const WINDOW_STATE_VERSION = 1;
const WINDOW_RESIZE_SAVE_DELAY = 250;

// 与 tauri.conf.json 保持一致，防止历史缓存把窗口恢复到不可用尺寸。
interface WindowSize {
  width: number;
  height: number;
}

interface PersistedWindowState extends WindowSize {
  version: number;
}

function readPersistedWindowSize(): WindowSize | null {
  try {
    const raw = localStorage.getItem(WINDOW_STATE_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PersistedWindowState>;
    const width = Number(parsed.width);
    const height = Number(parsed.height);

    // 只接受有限正数，避免手动修改 localStorage 后向 Tauri 传入非法尺寸。
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }

    return {
      width: Math.round(width),
      height: Math.round(height),
    };
  } catch (error) {
    console.error('读取窗口尺寸失败:', error);
    return null;
  }
}

function clampWindowSize(size: WindowSize, maximumSize: WindowSize | null, minimumSize: WindowSize): WindowSize {
  const maxWidth = Math.max(minimumSize.width, maximumSize?.width ?? Number.POSITIVE_INFINITY);
  const maxHeight = Math.max(minimumSize.height, maximumSize?.height ?? Number.POSITIVE_INFINITY);

  return {
    width: Math.min(maxWidth, Math.max(minimumSize.width, Math.round(size.width))),
    height: Math.min(maxHeight, Math.max(minimumSize.height, Math.round(size.height))),
  };
}

async function getMaximumLogicalSize(): Promise<WindowSize | null> {
  const [monitor, scaleFactor] = await Promise.all([currentMonitor(), getCurrentWindow().scaleFactor()]);
  if (!monitor || !Number.isFinite(scaleFactor) || scaleFactor <= 0) return null;

  // Tauri 的显示器工作区尺寸是物理像素，恢复窗口时需要转换为逻辑像素。
  return getMaximumLogicalWindowSize(
    { width: monitor.workArea.size.width, height: monitor.workArea.size.height },
    scaleFactor,
  );
}

export function useWindowStatePersistence(): void {
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let restoring = true;
    let resizeTimer: number | null = null;
    let unlistenResize: (() => void) | null = null;

    const persistCurrentSize = async (physicalSize?: { width: number; height: number }) => {
      try {
        // 最大化时记录到的是工作区尺寸，必须保留用户最后一次普通窗口尺寸。
        if (await appWindow.isMaximized()) return;

        const scaleFactor = await appWindow.scaleFactor();
        const size = physicalSize ?? await appWindow.innerSize();
        if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return;

        const state: PersistedWindowState = {
          version: WINDOW_STATE_VERSION,
          width: Math.round(size.width / scaleFactor),
          height: Math.round(size.height / scaleFactor),
        };
        localStorage.setItem(WINDOW_STATE_STORAGE_KEY, JSON.stringify(state));
      } catch (error) {
        console.error('保存窗口尺寸失败:', error);
      }
    };

    const restoreWindowSize = async () => {
      try {
        const savedLayoutMode = await prepareWindowForSavedLayout();
        const savedSize = readPersistedWindowSize();
        if (!savedSize) return;

        const maximumSize = await getMaximumLogicalSize();
        const minimumSize = getEffectiveWindowMinimumSize(savedLayoutMode, maximumSize);
        const restoredSize = clampWindowSize(savedSize, maximumSize, minimumSize);
        await appWindow.setSize(new LogicalSize(restoredSize.width, restoredSize.height));
      } catch (error) {
        console.error('恢复窗口尺寸失败:', error);
      } finally {
        restoring = false;
      }
    };

    const registerResizeListener = async () => {
      try {
        const unlisten = await appWindow.onResized(({ payload }) => {
          if (disposed || restoring) return;

          if (resizeTimer !== null) {
            window.clearTimeout(resizeTimer);
          }
          resizeTimer = window.setTimeout(() => {
            resizeTimer = null;
            void persistCurrentSize(payload);
          }, WINDOW_RESIZE_SAVE_DELAY);
        });
        if (disposed) {
          // 监听注册期间组件可能已经卸载，立即解除异步完成后才拿到的监听器。
          unlisten();
          return;
        }
        unlistenResize = unlisten;
      } catch (error) {
        console.error('监听窗口尺寸变化失败:', error);
      }
    };

    // 先注册监听再恢复尺寸，确保用户恢复后继续拖拽时不会漏掉事件。
    void registerResizeListener();
    void restoreWindowSize();

    return () => {
      disposed = true;
      restoring = true;
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }
      unlistenResize?.();
    };
  }, []);
}
