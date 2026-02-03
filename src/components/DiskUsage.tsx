// ============================================================================
// 磁盘使用情况组件 - 支持主题切换
// ============================================================================

import { useRef } from 'react';
import { HardDrive } from 'lucide-react';
import type { DiskInfo } from '../types';
import { formatSize } from '../utils/format';

interface DiskUsageProps {
  diskInfo: DiskInfo | null;
  loading?: boolean;
  compact?: boolean;
  /** 三击时的回调（彩蛋功能） */
  onTripleClick?: () => void;
}

export function DiskUsage({ diskInfo, loading, compact, onTripleClick }: DiskUsageProps) {
  // 三击检测
  const clickCountRef = useRef(0);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = () => {
    clickCountRef.current += 1;
    
    // 清除之前的定时器
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
    }
    
    // 检测三击
    if (clickCountRef.current >= 3) {
      clickCountRef.current = 0;
      onTripleClick?.();
      return;
    }
    
    // 500ms 内没有继续点击则重置计数
    clickTimerRef.current = setTimeout(() => {
      clickCountRef.current = 0;
    }, 500);
  };

  // 加载中或数据为空时显示骨架屏
  if (loading || !diskInfo) {
    return (
      <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-4">
        <div className="animate-pulse flex items-center gap-4">
          <div className="w-12 h-12 bg-[var(--bg-hover)] rounded-lg"></div>
          <div className="flex-1">
            <div className="h-4 bg-[var(--bg-hover)] rounded w-1/3 mb-2"></div>
            <div className="h-2 bg-[var(--bg-hover)] rounded w-full mb-2"></div>
            <div className="h-3 bg-[var(--bg-hover)] rounded w-2/3"></div>
          </div>
        </div>
      </div>
    );
  }

  // 根据使用率确定颜色
  const getUsageColor = (percent: number) => {
    if (percent >= 90) return { bar: 'bg-red-500', text: 'text-red-500' };
    if (percent >= 75) return { bar: 'bg-orange-500', text: 'text-orange-500' };
    if (percent >= 50) return { bar: 'bg-amber-500', text: 'text-amber-500' };
    return { bar: 'bg-emerald-500', text: 'text-emerald-500' };
  };

  const colors = getUsageColor(diskInfo.usage_percent);

  return (
    <div
      onClick={handleClick}
      className={`bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] ${
        compact ? 'p-3' : 'p-4'
      } cursor-default`}
    >
      <div className={`flex items-center ${compact ? 'gap-3' : 'gap-4'}`}>
        {/* 磁盘图标 */}
        <div
          className={`rounded-lg bg-emerald-500/15 flex items-center justify-center ${
            compact ? 'w-10 h-10' : 'w-12 h-12'
          }`}
        >
          <HardDrive className={compact ? 'w-5 h-5 text-emerald-500' : 'w-6 h-6 text-emerald-500'} />
        </div>

        {/* 磁盘信息 */}
        <div className="flex-1 min-w-0">
          <div className={`flex items-center justify-between ${compact ? 'mb-1.5' : 'mb-2'}`}>
            <div>
              <span className={compact ? 'text-xs font-medium text-[var(--fg-primary)]' : 'text-sm font-medium text-[var(--fg-primary)]'}>
                {diskInfo.drive_letter} 盘
              </span>
              <span className={compact ? 'text-[11px] text-[var(--fg-muted)] ml-2' : 'text-xs text-[var(--fg-muted)] ml-2'}>
                系统盘
              </span>
            </div>
            <div className="text-right">
              <span className={`${compact ? 'text-base' : 'text-lg'} font-bold ${colors.text}`}>
                {diskInfo.usage_percent.toFixed(1)}%
              </span>
            </div>
          </div>

          {/* 进度条 */}
          <div className={`${compact ? 'h-1.5' : 'h-2'} bg-[var(--bg-hover)] rounded-full overflow-hidden ${compact ? 'mb-1.5' : 'mb-2'}`}>
            <div
              className={`h-full ${colors.bar} rounded-full`}
              style={{ width: `${diskInfo.usage_percent}%` }}
            />
          </div>

          {/* 统计信息 */}
          <div className={`flex items-center ${compact ? 'gap-3 text-[11px]' : 'gap-4 text-xs'}`}>
            <span className="text-[var(--fg-muted)]">
              总容量 <span className="text-[var(--fg-secondary)] font-medium">{formatSize(diskInfo.total_space)}</span>
            </span>
            <span className="text-[var(--fg-muted)]">
              已用 <span className="text-orange-500 font-medium">{formatSize(diskInfo.used_space)}</span>
            </span>
            <span className="text-[var(--fg-muted)]">
              可用 <span className="text-emerald-500 font-medium">{formatSize(diskInfo.free_space)}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
