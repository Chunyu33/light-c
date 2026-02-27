// ============================================================================
// 仪表盘顶部统计栏组件
// 显示 C 盘健康评分、磁盘使用情况和一键扫描按钮
// ============================================================================

import { useEffect, useState, useRef } from 'react';
import { HardDrive, Moon, Trash2, Loader2, Zap } from 'lucide-react';
import { useDashboard } from '../contexts/DashboardContext';
import { formatSize } from '../utils/format';

// ============================================================================
// 数字跳动动画 Hook
// ============================================================================

function useAnimatedNumber(targetValue: number, duration: number = 800) {
  const [displayValue, setDisplayValue] = useState(0);
  const animationRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const startValueRef = useRef<number>(0);

  useEffect(() => {
    startValueRef.current = displayValue;
    startTimeRef.current = null;

    const animate = (currentTime: number) => {
      if (!startTimeRef.current) {
        startTimeRef.current = currentTime;
      }

      const elapsed = currentTime - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      
      // 使用 easeOutExpo 缓动函数
      const easeProgress = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const currentValue = Math.round(startValueRef.current + (targetValue - startValueRef.current) * easeProgress);
      
      setDisplayValue(currentValue);

      if (progress < 1) {
        animationRef.current = requestAnimationFrame(animate);
      }
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [targetValue, duration]);

  return displayValue;
}

// ============================================================================
// 根据分数获取颜色配置
// ============================================================================

function getScoreColor(score: number) {
  if (score >= 80) {
    return {
      text: 'text-emerald-500',
      bg: 'bg-emerald-500',
      bgLight: 'bg-emerald-500/10',
      label: '优秀',
    };
  } else if (score >= 60) {
    return {
      text: 'text-amber-500',
      bg: 'bg-amber-500',
      bgLight: 'bg-amber-500/10',
      label: '良好',
    };
  } else {
    return {
      text: 'text-rose-500',
      bg: 'bg-rose-500',
      bgLight: 'bg-rose-500/10',
      label: '需优化',
    };
  }
}

// ============================================================================
// 组件 Props
// ============================================================================

interface DashboardHeaderProps {
  /** 一键扫描回调 */
  onOneClickScan: () => void;
  /** 显示欢迎弹窗回调（彩蛋） */
  onShowWelcome?: () => void;
}

// ============================================================================
// 组件实现
// ============================================================================

export function DashboardHeader({ onOneClickScan, onShowWelcome }: DashboardHeaderProps) {
  const { diskInfo, healthData, isLoadingHealth, isAnyScanning } = useDashboard();
  
  // 动画数字
  const animatedScore = useAnimatedNumber(healthData?.score ?? 0);
  const scoreColor = getScoreColor(healthData?.score ?? 0);

  // 三连击计数器（彩蛋）
  const [clickCount, setClickCount] = useState(0);
  const clickTimerRef = useRef<number | null>(null);

  const handleTripleClick = () => {
    setClickCount(prev => prev + 1);
    
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
    }
    
    clickTimerRef.current = window.setTimeout(() => {
      setClickCount(0);
    }, 500);

    if (clickCount >= 2) {
      setClickCount(0);
      onShowWelcome?.();
    }
  };

  return (
    <div className="bg-[var(--bg-card)] border-b border-[var(--border-default)] px-4 py-3 sticky top-0 z-10">
      <div className="max-w-5xl mx-auto flex items-center gap-6">
        {/* 健康评分 */}
        <div 
          className="flex items-center gap-3 cursor-pointer"
          onClick={handleTripleClick}
        >
          <div className={`relative w-14 h-14 rounded-full ${scoreColor.bgLight} flex items-center justify-center`}>
            <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="6" className="text-[var(--bg-hover)]" />
              <circle
                cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round"
                className={scoreColor.text}
                strokeDasharray={`${(healthData?.score ?? 0) * 2.64} 264`}
                style={{ transition: 'stroke-dasharray 0.8s ease-out' }}
              />
            </svg>
            <span className={`text-lg font-bold ${scoreColor.text} tabular-nums`}>
              {isLoadingHealth ? '--' : animatedScore}
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-[var(--fg-primary)]">健康评分</span>
              {healthData && (
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${scoreColor.bg} text-white`}>
                  {scoreColor.label}
                </span>
              )}
            </div>
            {healthData && (
              <div className="flex items-center gap-3 mt-1 text-[10px] text-[var(--fg-muted)]">
                <span className="flex items-center gap-1">
                  <HardDrive className="w-3 h-3" />
                  {healthData.disk_score}/40
                </span>
                <span className="flex items-center gap-1">
                  <Moon className="w-3 h-3" />
                  {healthData.hibernation_score}/30
                </span>
                <span className="flex items-center gap-1">
                  <Trash2 className="w-3 h-3" />
                  {healthData.junk_score}/30
                </span>
              </div>
            )}
          </div>
        </div>

        {/* 分隔线 */}
        <div className="w-px h-10 bg-[var(--border-default)]" />

        {/* 磁盘使用情况 */}
        <div className="flex-1">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-[var(--fg-primary)]">C 盘空间</span>
            {diskInfo && (
              <span className="text-xs text-[var(--fg-muted)]">
                {formatSize(diskInfo.free_space)} 可用 / {formatSize(diskInfo.total_space)}
              </span>
            )}
          </div>
          <div className="h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden">
            {diskInfo && (
              <div 
                className={`h-full rounded-full transition-all duration-500 ${
                  diskInfo.usage_percent > 90 ? 'bg-rose-500' :
                  diskInfo.usage_percent > 75 ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${diskInfo.usage_percent}%` }}
              />
            )}
          </div>
        </div>

        {/* 分隔线 */}
        <div className="w-px h-10 bg-[var(--border-default)]" />

        {/* 一键扫描按钮 */}
        <button
          onClick={onOneClickScan}
          disabled={isAnyScanning}
          className={`
            flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all
            ${isAnyScanning
              ? 'bg-emerald-500/20 text-emerald-600 cursor-not-allowed'
              : 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:shadow-lg hover:shadow-emerald-500/25 active:scale-95'
            }
          `}
        >
          {isAnyScanning ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              扫描中...
            </>
          ) : (
            <>
              <Zap className="w-4 h-4" />
              一键扫描
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export default DashboardHeader;
