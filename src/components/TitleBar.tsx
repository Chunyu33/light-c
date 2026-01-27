// ============================================================================
// 自定义标题栏组件
// ============================================================================

import { useState, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X, Maximize2, Settings } from 'lucide-react';

interface TitleBarProps {
  onSettingsClick: () => void;
}

export function TitleBar({ onSettingsClick }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const appWindow = getCurrentWindow();

  useEffect(() => {
    // 初始化时检查窗口状态
    appWindow.isMaximized().then(setIsMaximized);
  }, []);

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

  const handleDrag = (e: React.MouseEvent) => {
    // 只有点击拖拽区域才触发
    if ((e.target as HTMLElement).dataset.tauriDragRegion !== undefined) {
      appWindow.startDragging();
    }
  };

  return (
    <div 
      className="h-10 bg-gradient-to-r from-emerald-500 to-teal-500 flex items-center justify-between shrink-0 select-none"
      data-tauri-drag-region
      onMouseDown={handleDrag}
    >
      {/* 左侧：应用图标和标题 */}
      <div 
        className="flex items-center gap-2 px-3 h-full flex-1" 
        data-tauri-drag-region
      >
        <div className="w-6 h-6 rounded bg-white/20 flex items-center justify-center">
          <span className="text-xs font-bold text-white">C:</span>
        </div>
        <span className="text-sm font-medium text-white" data-tauri-drag-region>LightC</span>
      </div>

      {/* 右侧：设置 + 窗口控制按钮 */}
      <div className="flex items-center h-full">
        {/* 设置按钮 */}
        <button
          onClick={onSettingsClick}
          className="h-full px-3 flex items-center justify-center text-white/80 hover:bg-white/10 transition-colors"
          title="设置"
        >
          <Settings className="w-4 h-4" />
        </button>

        {/* 分隔线 */}
        <div className="w-px h-4 bg-white/20 mx-1" />

        {/* 最小化 */}
        <button
          onClick={handleMinimize}
          className="h-full px-3 flex items-center justify-center text-white/80 hover:bg-white/10 transition-colors"
          title="最小化"
        >
          <Minus className="w-4 h-4" />
        </button>

        {/* 最大化/还原 */}
        <button
          onClick={handleMaximize}
          className="h-full px-3 flex items-center justify-center text-white/80 hover:bg-white/10 transition-colors"
          title={isMaximized ? "还原" : "最大化"}
        >
          {/* {isMaximized ? <Square className="w-3 h-3" /> : <Maximize2 className="w-3.5 h-3.5" />} */}
          <Square className="w-3.5 h-3.5" />
        </button>

        {/* 关闭 */}
        <button
          onClick={handleClose}
          className="h-full px-3 flex items-center justify-center text-white/80 hover:bg-red-500 hover:text-white transition-colors"
          title="关闭"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
