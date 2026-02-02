// ============================================================================
// 返回按钮组件 - 统一的返回首页按钮
// 支持拖拽定位，位置持久化到 localStorage
// ============================================================================

import { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowLeft, GripVertical } from 'lucide-react';

const STORAGE_KEY = 'back-button-position';

interface Position {
  x: number;
  y: number;
}

interface BackButtonProps {
  /** 点击回调 */
  onClick: () => void;
  /** 按钮文字，默认"返回" */
  label?: string;
}

// 获取保存的位置
function getSavedPosition(): Position | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {
    // ignore
  }
  return null;
}

// 保存位置
function savePosition(pos: Position) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
  } catch {
    // ignore
  }
}

/**
 * 统一的返回按钮组件
 * 支持拖拽定位，位置持久化
 */
export function BackButton({ onClick, label = '返回' }: BackButtonProps) {
  const buttonRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>(() => {
    const saved = getSavedPosition();
    // 默认位置：右侧中间偏上
    return saved || { x: window.innerWidth - 80, y: 320 };
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; posX: number; posY: number } | null>(null);

  // 限制位置在窗口范围内
  const clampPosition = useCallback((x: number, y: number): Position => {
    const btnWidth = 80;
    const btnHeight = 32;
    return {
      x: Math.max(0, Math.min(window.innerWidth - btnWidth, x)),
      y: Math.max(40, Math.min(window.innerHeight - btnHeight, y)), // top 40 避免遮挡标题栏
    };
  }, []);

  // 鼠标按下
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: position.x,
      posY: position.y,
    };
  }, [position]);

  // 鼠标移动
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      const newPos = clampPosition(
        dragStartRef.current.posX + dx,
        dragStartRef.current.posY + dy
      );
      setPosition(newPos);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
      // 保存位置
      savePosition(position);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, position, clampPosition]);

  // 窗口大小变化时调整位置
  useEffect(() => {
    const handleResize = () => {
      setPosition(prev => clampPosition(prev.x, prev.y));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [clampPosition]);

  return (
    <div
      ref={buttonRef}
      className={`
        fixed z-40 inline-flex items-center rounded-full shadow-md border
        bg-slate-100 border-slate-300 
        ${isDragging ? 'cursor-grabbing shadow-lg scale-105' : ''}
        transition-shadow
      `}
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      {/* 拖拽手柄 */}
      <div
        onMouseDown={handleMouseDown}
        className={`
          px-1.5 py-1.5 cursor-grab text-slate-400 hover:text-slate-600 
          border-r border-slate-300 rounded-l-full hover:bg-slate-200 transition
          ${isDragging ? 'cursor-grabbing text-slate-600 bg-slate-200' : ''}
        `}
        title="拖拽移动"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </div>
      
      {/* 返回按钮 */}
      <button
        onClick={onClick}
        className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 hover:bg-slate-200 px-2.5 py-1.5 rounded-r-full transition"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        {label}
      </button>
    </div>
  );
}

export default BackButton;
