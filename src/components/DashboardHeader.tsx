// ============================================================================
// 仪表盘顶部统计栏组件
// 显示 C 盘健康评分、磁盘使用情况和一键扫描按钮
// ============================================================================

import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { HardDrive, Moon, RefreshCw, ArrowLeftRight, Trash2, Zap, Square } from 'lucide-react';
import { useDashboardActions, useDashboardSummary } from '../contexts/DashboardContext';
import { formatSize } from '../utils/format';
import { useTranslation } from 'react-i18next';
import { defaultDriveLetter, useLocalDrives } from './ui/DriveSelect';
import { DiskSwitchModal } from './DiskSwitchModal';
import { useToast } from './Toast';

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
      labelKey: 'excellent',
    };
  } else if (score >= 60) {
    return {
      text: 'text-[#FA9D3B]',      // 柔和橙
      bg: 'bg-[#FA9D3B]',
      bgLight: 'bg-[#FA9D3B]/10',
      labelKey: 'good',
    };
  } else {
    return {
      text: 'text-[#FA5151]',      // 柔和红
      bg: 'bg-[#FA5151]',
      bgLight: 'bg-[#FA5151]/10',
      labelKey: 'needsOptimization',
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
  /** 页面模式聚焦单模块，隐藏一键扫描可以避免用户误以为只扫描当前页。 */
  hideOneClickScan?: boolean;
}

// ============================================================================
// 组件实现
// ============================================================================

export function DashboardHeader({ onOneClickScan, onShowWelcome, hideOneClickScan = false }: DashboardHeaderProps) {
  const { diskInfo, healthData, isLoadingHealth, isAnyScanning } = useDashboardSummary();
  const { stopAllScans } = useDashboardActions();
  const { t } = useTranslation('common');
  const { showToast } = useToast();

  /**
   * 顶栏的磁盘条支持切换盘符并手动刷新。
   *
   * 数据源用 `useLocalDrives`（它本来就返回每个盘的容量、可用空间、使用率），
   * 而不是 context 里的 `diskInfo` —— 后者只有系统盘一条，切不了盘。
   * `diskInfo` 保留为兜底：磁盘列表还没读回来时先用它撑住，避免首帧空白。
   */
  const { drives, loading: drivesLoading, refresh: refreshDrives } = useLocalDrives();
  const [selectedDrive, setSelectedDrive] = useState('');

  /** 手动刷新：读完弹一条轻提示，成功失败都要说，否则用户不知道按钮有没有生效。 */
  const handleRefreshDrives = useCallback(async () => {
    const succeeded = await refreshDrives();
    showToast(
      succeeded
        ? { type: 'success', title: t('refreshDiskInfoDone') }
        : { type: 'error', title: t('refreshDiskInfoFailed') },
    );
  }, [refreshDrives, showToast, t]);

  // 首次拿到列表时默认选中系统盘（后端标了 is_system 的那块，找不到就退 C:）。
  useEffect(() => {
    if (!selectedDrive && drives.length > 0) {
      setSelectedDrive(defaultDriveLetter(drives));
    }
  }, [drives, selectedDrive]);

  const activeDrive = useMemo(
    () => drives.find((drive) => drive.drive_letter === selectedDrive) ?? null,
    [drives, selectedDrive],
  );
  /** 展示用的一条数据：选中的盘优先，没有就退回 context 的系统盘。 */
  const disk = activeDrive
    ? { drive_letter: activeDrive.drive_letter, free_space: activeDrive.free_space, total_space: activeDrive.total_space, usage_percent: activeDrive.usage_percent }
    : diskInfo;

  // 切换分区用弹窗，不在顶栏塞下拉：顶栏只有几十像素高，下拉的字号和宽度反复对不齐。
  const [isDiskSwitchOpen, setIsDiskSwitchOpen] = useState(false);
  
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
    <div className="glass-chrome glass-header-bottom bg-[var(--bg-card)] border-b border-[var(--border-color)] px-5 py-2.5 sticky top-0 z-10">
      <div className="dashboard-container flex items-center gap-5">
        {/* 健康评分 - 微信风格圆环进度 */}
        <div 
          className="flex items-center gap-3 cursor-pointer min-w-[16.43rem]"
          onClick={handleTripleClick}
        >
          <div className={`relative w-12 h-12 rounded-full ${scoreColor.bgLight} flex items-center justify-center shrink-0`}>
            <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="5" className="text-[var(--border-color)]" />
              <circle
                cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"
                className={scoreColor.text}
                strokeDasharray={`${(healthData?.score ?? 0) * 2.64} 264`}
                style={{ transition: 'stroke-dasharray 0.8s ease-out' }}
              />
            </svg>
            <span className={`text-base font-bold ${scoreColor.text} tabular-nums`}>
              {isLoadingHealth ? '--' : animatedScore}
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[1rem] font-bold text-[var(--text-primary)]">{t('healthScore')}</span>
              {healthData && (
                <span className={`px-2 py-0.5 rounded text-[0.79rem] font-medium ${scoreColor.bg} text-white`}>
                  {t(scoreColor.labelKey)}
                </span>
              )}
            </div>
            {healthData && (
              <div className="flex items-center gap-3 mt-1 text-[0.79rem] text-[var(--text-muted)] tabular-nums">
                <span 
                  className="flex items-center gap-1 cursor-help"
                  title={t('scoreDetails.diskSpace')}
                >
                  <HardDrive className="w-3.5 h-3.5" />
                  {healthData.disk_score}/40
                </span>
                <span 
                  className="flex items-center gap-1 cursor-help"
                  title={t('scoreDetails.hibernation')}
                >
                  <Moon className="w-3.5 h-3.5" />
                  {healthData.hibernation_score}/30
                </span>
                <span 
                  className="flex items-center gap-1 cursor-help"
                  title={t('scoreDetails.junk')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {healthData.junk_score}/30
                </span>
              </div>
            )}
          </div>
        </div>

        {/* 分隔线 */}
        <div className="w-px h-9 bg-[var(--border-color)]" />

        {/* 磁盘使用情况：左侧是当前盘标签 + 手动刷新，右侧是切换图标 + 容量。
            切换分区走弹窗而不是下拉 —— 顶栏只有几十像素高，下拉的字号/宽度/选项截断
            反复对不齐；弹窗里每个盘能完整显示卷标、可用量和占用率。 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              {/* 不写自定义字号：html 的根字号是 calc(14px + --font-size-offset)，
                  继承它才会跟着「设置 - 字号」变化。之前写 text-[0.9rem] 在标准档只有 12.6px，
                  比正文小一档，而且把比例写死了。 */}
              <span className="shrink-0 font-medium text-[var(--text-primary)]">
                {t('diskSpace', { drive: disk?.drive_letter ?? 'C:' })}
              </span>
              <button
                type="button"
                onClick={handleRefreshDrives}
                disabled={drivesLoading}
                title={t('refreshDiskInfo')}
                aria-label={t('refreshDiskInfo')}
                className="shrink-0 rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {/* 读取中转一圈，让"按钮生效了"这件事可见 */}
                <RefreshCw className={`h-4 w-4 ${drivesLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              {/* 切换分区：点击弹窗，不在这一行里展开下拉 */}
              <button
                type="button"
                onClick={() => setIsDiskSwitchOpen(true)}
                title={t('switchDrive')}
                aria-label={t('switchDrive')}
                className="shrink-0 rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <ArrowLeftRight className="h-4 w-4" />
              </button>
              {/* 容量同样继承根字号；层级靠颜色区分，不靠把字调小 */}
              {disk && (
                <span className="truncate tabular-nums text-[var(--text-muted)]">
                  {t('freeOfTotal', { free: formatSize(disk.free_space), total: formatSize(disk.total_space) })}
                </span>
              )}
            </div>
          </div>
          {/* 进度条 - 使用柔和灰色轨道 */}
          <div className="h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden">
            {disk && (
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  disk.usage_percent > 90 ? 'bg-[var(--color-danger)]' :
                  disk.usage_percent > 75 ? 'bg-[var(--color-warning)]' : 'bg-[var(--brand-green)]'
                }`}
                style={{ width: `${disk.usage_percent}%` }}
              />
            )}
          </div>
        </div>

        <DiskSwitchModal
          isOpen={isDiskSwitchOpen}
          onClose={() => setIsDiskSwitchOpen(false)}
          drives={drives}
          selectedDrive={disk?.drive_letter ?? 'C:'}
          onSelect={setSelectedDrive}
        />

        {!hideOneClickScan && (
          <>
            {/* 分隔线 */}
            <div className="w-px h-9 bg-[var(--border-color)]" />

            {/* 一键扫描按钮区域 */}
            <div className="flex items-center gap-2">
              {isAnyScanning ? (
                <button
                  onClick={stopAllScans}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[0.93rem] font-semibold transition-all duration-200 bg-[var(--color-danger)]/20 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/30"
                  title={t('stopScan')}
                >
                  <Square className="w-4 h-4" />
                  {t('stopScan')}
                </button>
              ) : (
                <button
                  onClick={onOneClickScan}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-[0.93rem] font-semibold transition-all duration-200 bg-[var(--brand-green)] text-white hover:bg-[var(--brand-green-hover)] active:scale-[0.98]"
                >
                  <Zap className="w-4 h-4" />
                  {t('oneClickScan')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default DashboardHeader;
