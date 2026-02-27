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

// 微信风格评分颜色配置
function getScoreColor(score: number) {
  if (score >= 80) {
    return {
      text: 'text-[#07C160]',      // 微信绿
      bg: 'bg-[#07C160]',
      bgLight: 'bg-[#07C160]/10',
      label: '优秀',
    };
  } else if (score >= 60) {
    return {
      text: 'text-[#FA9D3B]',      // 柔和橙
      bg: 'bg-[#FA9D3B]',
      bgLight: 'bg-[#FA9D3B]/10',
      label: '良好',
    };
  } else {
    return {
      text: 'text-[#FA5151]',      // 柔和红
      bg: 'bg-[#FA5151]',
      bgLight: 'bg-[#FA5151]/10',
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
    <div className="bg-[var(--bg-card)] border-b border-[var(--border-muted)] px-6 py-4 sticky top-0 z-10">
      <div className="max-w-5xl mx-auto flex items-center gap-8">
        {/* 健康评分 - 微信风格圆环进度 */}
        <div 
          className="flex items-center gap-4 cursor-pointer"
          onClick={handleTripleClick}
        >
          <div className={`relative w-16 h-16 rounded-full ${scoreColor.bgLight} flex items-center justify-center`}>
            <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="5" className="text-[var(--border-default)]" />
              <circle
                cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"
                className={scoreColor.text}
                strokeDasharray={`${(healthData?.score ?? 0) * 2.64} 264`}
                style={{ transition: 'stroke-dasharray 0.8s ease-out' }}
              />
            </svg>
            <span className={`text-xl font-bold ${scoreColor.text} tabular-nums`}>
              {isLoadingHealth ? '--' : animatedScore}
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-bold text-[var(--fg-primary)]">健康评分</span>
              {healthData && (
                <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${scoreColor.bg} text-white`}>
                  {scoreColor.label}
                </span>
              )}
            </div>
            {healthData && (
              <div className="flex items-center gap-4 mt-1.5 text-[12px] text-[var(--fg-muted)] tabular-nums">
                <span className="flex items-center gap-1">
                  <HardDrive className="w-3.5 h-3.5" />
                  {healthData.disk_score}/40
                </span>
                <span className="flex items-center gap-1">
                  <Moon className="w-3.5 h-3.5" />
                  {healthData.hibernation_score}/30
                </span>
                <span className="flex items-center gap-1">
                  <Trash2 className="w-3.5 h-3.5" />
                  {healthData.junk_score}/30
                </span>
              </div>
            )}
          </div>
        </div>

        {/* 分隔线 */}
        <div className="w-px h-12 bg-[var(--border-default)]" />

        {/* 磁盘使用情况 */}
        <div className="flex-1">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[15px] font-bold text-[var(--fg-primary)]">C 盘空间</span>
            {diskInfo && (
              <span className="text-[13px] text-[var(--fg-muted)] tabular-nums">
                {formatSize(diskInfo.free_space)} 可用 / {formatSize(diskInfo.total_space)}
              </span>
            )}
          </div>
          <div className="h-2.5 bg-[var(--bg-hover)] rounded-full overflow-hidden">
            {diskInfo && (
              <div 
                className={`h-full rounded-full transition-all duration-500 ${
                  diskInfo.usage_percent > 90 ? 'bg-[#FA5151]' :
                  diskInfo.usage_percent > 75 ? 'bg-[#FA9D3B]' : 'bg-[#07C160]'
                }`}
                style={{ width: `${diskInfo.usage_percent}%` }}
              />
            )}
          </div>
        </div>

        {/* 分隔线 */}
        <div className="w-px h-12 bg-[var(--border-default)]" />

        {/* 一键扫描按钮 - 实心微信绿 */}
        <button
          onClick={onOneClickScan}
          disabled={isAnyScanning}
          className={`
            flex items-center gap-2 px-6 py-3 rounded-xl text-[14px] font-semibold transition-all duration-200
            ${isAnyScanning
              ? 'bg-[#07C160]/20 text-[#07C160] cursor-not-allowed'
              : 'bg-[#07C160] text-white hover:bg-[#06AD56] active:scale-[0.98]'
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
