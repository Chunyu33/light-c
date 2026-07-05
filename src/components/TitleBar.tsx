// ============================================================================
// 自定义标题栏组件
// ============================================================================

import { useState, useEffect, useRef, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X, Settings } from 'lucide-react';

interface TitleBarProps {
  onSettingsClick: () => void;
}

const DRAG_START_THRESHOLD = 4;

export function TitleBar({ onSettingsClick }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const appWindowRef = useRef(getCurrentWindow());
  const appWindow = appWindowRef.current;

  const refreshMaximizedState = useCallback(() => {
    appWindow.isMaximized().then(setIsMaximized).catch((err) => {
      console.error('同步窗口最大化状态失败:', err);
    });
  }, [appWindow]);

  useEffect(() => {
    // 初始化时检查窗口状态
    refreshMaximizedState();

    const unlisteners: Array<() => void> = [];
    let disposed = false;

    Promise.all([
      appWindow.onResized(refreshMaximizedState),
      appWindow.onMoved(refreshMaximizedState),
      appWindow.onScaleChanged(refreshMaximizedState),
      appWindow.onFocusChanged(refreshMaximizedState),
    ]).then((items) => {
      if (disposed) {
        items.forEach((unlisten) => unlisten());
        return;
      }
      unlisteners.push(...items);
    }).catch((err) => {
      console.error('监听窗口状态失败:', err);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [appWindow, refreshMaximizedState]);

  const handleMinimize = () => appWindow.minimize();
  
  const handleMaximize = async () => {
    const maximized = await appWindow.isMaximized();
    if (maximized) {
      await appWindow.unmaximize();
      setIsMaximized(false);
    } else {
      await appWindow.maximize();
      setIsMaximized(true);
    }
  };

  const handleClose = () => appWindow.close();

  const isWindowControl = (target: EventTarget | null) => {
    return target instanceof HTMLElement && Boolean(target.closest('[data-window-control]'));
  };

  const handleTitleBarMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.detail > 1 || isWindowControl(event.target)) return;
    // Windows 多显示器 DPI 不一致时，最大化窗口直接 startDragging 容易触发错误还原坐标。
    if (isMaximized) return;
    dragStartRef.current = { x: event.clientX, y: event.clientY };
  };

  const handleTitleBarMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const dragStart = dragStartRef.current;
    if (!dragStart) return;

    const distanceX = Math.abs(event.clientX - dragStart.x);
    const distanceY = Math.abs(event.clientY - dragStart.y);
    if (distanceX < DRAG_START_THRESHOLD && distanceY < DRAG_START_THRESHOLD) return;

    dragStartRef.current = null;
    appWindow.startDragging().catch((err) => {
      console.error('拖动窗口失败:', err);
    });
  };

  const handleTitleBarMouseUp = () => {
    dragStartRef.current = null;
  };

  const handleTitleBarDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isWindowControl(event.target)) return;
    event.preventDefault();
    dragStartRef.current = null;
    handleMaximize();
  };

  return (
    <div 
      className="h-10 bg-[var(--bg-card)] border-b border-[var(--border-color)] flex items-center justify-between shrink-0 select-none"
      onDoubleClick={handleTitleBarDoubleClick}
      onMouseDown={handleTitleBarMouseDown}
      onMouseMove={handleTitleBarMouseMove}
      onMouseLeave={handleTitleBarMouseUp}
      onMouseUp={handleTitleBarMouseUp}
    >
      {/* 左侧：应用图标和标题 - 使用主文字色 */}
      <div className="flex items-center gap-2 px-3 h-full flex-1">
        <div className="w-6 h-6 rounded-lg bg-[var(--brand-green)] flex items-center justify-center">
          <span className="text-xs font-bold text-white">C:</span>
        </div>
        <span className="text-sm font-semibold text-[var(--text-primary)]">LightC</span>
      </div>

      {/* 右侧：设置 + 窗口控制按钮 - 极简风格 */}
      <div className="flex items-center h-full">
        {/* 设置按钮 - Ghost 风格 */}
        <button
          data-window-control
          onClick={onSettingsClick}
          className="h-full px-3 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          title="设置"
        >
          <Settings className="w-4 h-4" />
        </button>

        {/* 分隔线 */}
        <div className="w-px h-4 bg-[var(--border-color)] mx-1" />

        {/* 最小化 */}
        <button
          data-window-control
          onClick={handleMinimize}
          className="h-full px-3 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          title="最小化"
        >
          <Minus className="w-4 h-4" />
        </button>

        {/* 最大化/还原 */}
        <button
          data-window-control
          onClick={handleMaximize}
          className="h-full px-3 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          title={isMaximized ? "还原" : "最大化"}
        >
          {/* 最大化后显示叠框图标，符合 Windows「还原窗口」的视觉习惯。 */}
          {isMaximized ? <Copy className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
        </button>

        {/* 关闭 */}
        <button
          data-window-control
          onClick={handleClose}
          className="h-full px-3 flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--color-danger)] hover:text-white transition-colors"
          title="关闭"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
