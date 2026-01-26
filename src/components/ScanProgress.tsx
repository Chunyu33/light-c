// ============================================================================
// 扫描进度组件 - 居中弹窗样式
// 特点：固定定位居中显示，扫描完成后显示结果并延迟消失
// ============================================================================

import { useEffect, useState, useRef, memo } from 'react';
import { CheckCircle, FolderSearch, FileText, HardDrive } from 'lucide-react';

// ============================================================================
// 常量配置
// ============================================================================

/** 完成状态显示时长（毫秒） */
const COMPLETION_DISPLAY_DURATION = 2000;
/** 退出动画时长（毫秒） */
const EXIT_ANIMATION_DURATION = 300;

// ============================================================================
// 类型定义
// ============================================================================

/** 组件内部状态 */
type ProgressState = 'idle' | 'scanning' | 'completing' | 'exiting';

interface ScanProgressProps {
  /** 是否正在扫描 */
  isScanning: boolean;
  /** 当前扫描的分类名称 */
  currentCategory?: string;
  /** 已完成的分类数量 */
  completedCategories?: number;
  /** 总分类数量 */
  totalCategories?: number;
  /** 当前已扫描的文件数量 */
  scannedFileCount?: number;
  /** 当前已扫描的文件大小 */
  scannedSize?: number;
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 格式化文件大小
 */
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

// ============================================================================
// 环形进度条组件
// ============================================================================

interface CircularProgressProps {
  progress: number;
  size?: number;
  strokeWidth?: number;
  isCompleted?: boolean;
}

const CircularProgress = memo(function CircularProgress({ 
  progress, 
  size = 80, 
  strokeWidth = 6,
  isCompleted = false 
}: CircularProgressProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (progress / 100) * circumference;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      {/* 背景圆环 */}
      <svg className="transform -rotate-90" width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--bg-hover)"
          strokeWidth={strokeWidth}
        />
        {/* 进度圆环 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={isCompleted ? '#10b981' : 'url(#progressGradient)'}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-500 ease-out"
        />
        <defs>
          <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#10b981" />
            <stop offset="100%" stopColor="#14b8a6" />
          </linearGradient>
        </defs>
      </svg>
      {/* 中心内容 */}
      <div className="absolute inset-0 flex items-center justify-center">
        {isCompleted ? (
          <CheckCircle className="w-8 h-8 text-emerald-500" />
        ) : (
          <span className="text-lg font-bold text-emerald-500">{Math.round(progress)}%</span>
        )}
      </div>
    </div>
  );
});

// ============================================================================
// 主组件
// ============================================================================

export function ScanProgress({
  isScanning,
  currentCategory = '准备中',
  completedCategories = 0,
  totalCategories = 10,
  scannedFileCount = 0,
  scannedSize = 0,
}: ScanProgressProps) {
  // 组件内部状态管理
  const [state, setState] = useState<ProgressState>('idle');
  const [isVisible, setIsVisible] = useState(false);
  
  // 保存完成时的扫描数据
  const completedDataRef = useRef({
    scannedFileCount: 0,
    scannedSize: 0,
    totalCategories: 10,
  });
  
  // 记录上一次的扫描状态
  const prevIsScanningRef = useRef(false);

  // 状态机：处理扫描状态变化
  useEffect(() => {
    const wasScanning = prevIsScanningRef.current;
    prevIsScanningRef.current = isScanning;
    
    if (isScanning && !wasScanning) {
      // 刚开始扫描
      setState('scanning');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsVisible(true);
        });
      });
    } else if (!isScanning && wasScanning) {
      // 扫描刚结束
      completedDataRef.current = {
        scannedFileCount,
        scannedSize,
        totalCategories,
      };
      setState('completing');
      
      // 完成状态显示后开始退出
      const completionTimer = setTimeout(() => {
        setIsVisible(false);
        setState('exiting');
        
        setTimeout(() => {
          setState('idle');
        }, EXIT_ANIMATION_DURATION);
      }, COMPLETION_DISPLAY_DURATION);
      
      return () => clearTimeout(completionTimer);
    }
  }, [isScanning, scannedFileCount, scannedSize, totalCategories]);

  // 不渲染时返回 null
  if (state === 'idle') return null;

  const isCompleted = state === 'completing' || state === 'exiting';
  const displayFileCount = isCompleted ? completedDataRef.current.scannedFileCount : scannedFileCount;
  const displaySize = isCompleted ? completedDataRef.current.scannedSize : scannedSize;
  const displayTotal = isCompleted ? completedDataRef.current.totalCategories : totalCategories;
  const progress = isCompleted ? 100 : (totalCategories > 0 ? (completedCategories / totalCategories) * 100 : 0);

  return (
    <div 
      className={`
        fixed inset-0 z-50 flex items-center justify-center
        transition-all duration-300 ease-out
        ${isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}
      `}
    >
      {/* 半透明遮罩 */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      
      {/* 弹窗内容 */}
      <div 
        className={`
          relative bg-[var(--bg-elevated)] rounded-2xl shadow-2xl 
          border border-[var(--border-default)] p-6 w-80
          transition-all duration-300 ease-out
          ${isVisible ? 'scale-100 translate-y-0' : 'scale-95 translate-y-4'}
          ${isCompleted ? 'border-emerald-500/30' : ''}
        `}
      >
        {/* 顶部：进度环 */}
        <div className="flex flex-col items-center mb-5">
          <CircularProgress progress={progress} isCompleted={isCompleted} />
          
          {/* 状态文字 */}
          <h3 className="mt-4 text-base font-semibold text-[var(--fg-primary)]">
            {isCompleted ? '扫描完成' : '正在扫描'}
          </h3>
          <p className="text-xs text-[var(--fg-muted)] mt-1">
            {isCompleted ? '已完成所有分类扫描' : currentCategory}
          </p>
        </div>

        {/* 统计信息卡片 */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-[var(--bg-card)] rounded-lg p-3 text-center">
            <FileText className="w-4 h-4 text-emerald-500 mx-auto mb-1" />
            <p className="text-sm font-semibold text-[var(--fg-primary)]">
              {displayFileCount.toLocaleString()}
            </p>
            <p className="text-[10px] text-[var(--fg-muted)]">文件数</p>
          </div>
          
          <div className="bg-[var(--bg-card)] rounded-lg p-3 text-center">
            <HardDrive className="w-4 h-4 text-teal-500 mx-auto mb-1" />
            <p className="text-sm font-semibold text-[var(--fg-primary)]">
              {formatSize(displaySize)}
            </p>
            <p className="text-[10px] text-[var(--fg-muted)]">可清理</p>
          </div>
          
          <div className="bg-[var(--bg-card)] rounded-lg p-3 text-center">
            <FolderSearch className="w-4 h-4 text-amber-500 mx-auto mb-1" />
            <p className="text-sm font-semibold text-[var(--fg-primary)]">
              {isCompleted ? displayTotal : completedCategories}/{displayTotal}
            </p>
            <p className="text-[10px] text-[var(--fg-muted)]">分类</p>
          </div>
        </div>

        {/* 扫描中的动画指示器 */}
        {!isCompleted && (
          <div className="mt-4 flex justify-center">
            <div className="flex gap-1">
              <span className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 bg-teal-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ScanProgress;
