// ============================================================================
// 首页组件
// 展示磁盘状态、扫描入口和功能卡片
// ============================================================================

import { useEffect, useState, useRef } from 'react';
import { HardDrive, Sparkles, Users, Rocket, ChevronRight, Moon, Trash2 } from 'lucide-react';
import { DiskUsage } from '../components';
import { getHealthScore, HealthScoreResult } from '../api/commands';
import type { DiskInfo } from '../types';

type PageType = 'home' | 'cleanup' | 'big-files' | 'social-clean' | 'system-slim';

interface HomePageProps {
  /** 磁盘信息 */
  diskInfo: DiskInfo | null;
  /** 是否正在扫描 */
  isScanning: boolean;
  /** 点击扫描按钮回调 */
  onScanClick: () => void;
  /** 切换页面回调 */
  onNavigate: (page: PageType) => void;
  /** 刷新健康评分的触发器 */
  refreshTrigger?: number;
}

// 数字跳动动画 Hook
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

// 根据分数获取颜色配置
function getScoreColor(score: number) {
  if (score >= 80) {
    return {
      text: 'text-emerald-500',
      bg: 'bg-emerald-500',
      bgLight: 'bg-emerald-500/10',
      border: 'border-emerald-500/30',
      gradient: 'from-emerald-500 to-teal-500',
      label: '优秀',
    };
  } else if (score >= 60) {
    return {
      text: 'text-amber-500',
      bg: 'bg-amber-500',
      bgLight: 'bg-amber-500/10',
      border: 'border-amber-500/30',
      gradient: 'from-amber-500 to-orange-500',
      label: '良好',
    };
  } else {
    return {
      text: 'text-rose-500',
      bg: 'bg-rose-500',
      bgLight: 'bg-rose-500/10',
      border: 'border-rose-500/30',
      gradient: 'from-rose-500 to-red-500',
      label: '需优化',
    };
  }
}

export function HomePage({ diskInfo, isScanning, onScanClick, onNavigate, refreshTrigger }: HomePageProps) {
  const [healthData, setHealthData] = useState<HealthScoreResult | null>(null);
  const [isLoadingScore, setIsLoadingScore] = useState(true);

  // 加载健康评分
  const loadHealthScore = async () => {
    setIsLoadingScore(true);
    try {
      const result = await getHealthScore();
      setHealthData(result);
    } catch (error) {
      console.error('获取健康评分失败:', error);
    } finally {
      setIsLoadingScore(false);
    }
  };

  // 初始加载和刷新触发
  useEffect(() => {
    loadHealthScore();
  }, [refreshTrigger]);

  // 动画数字
  const animatedScore = useAnimatedNumber(healthData?.score ?? 0);
  const scoreColor = getScoreColor(healthData?.score ?? 0);

  // 功能入口卡片配置
  const featureCards = [
    {
      title: '大文件清理',
      description: '识别占用空间的大文件与重复数据',
      icon: <Sparkles className="w-5 h-5 text-emerald-500" />,
      target: 'big-files' as const,
    },
    {
      title: '社交软件专清',
      description: '清理聊天缓存与图片视频残留',
      icon: <Users className="w-5 h-5 text-teal-500" />,
      target: 'social-clean' as const,
    },
    {
      title: '系统瘦身',
      description: '卸载冗余组件与系统备份',
      icon: <Rocket className="w-5 h-5 text-emerald-600" />,
      target: 'system-slim' as const,
    },
  ];

  return (
    <div className="max-w-5xl mx-auto flex flex-col h-full">
      {/* 顶部信息栏 - 紧凑的磁盘使用情况 */}
      <DiskUsage diskInfo={diskInfo} compact />

      {/* 主内容区域 - 两列布局 */}
      <section className="flex-1 mt-4 grid grid-cols-2 gap-4">
        {/* 左侧：健康评分（扩展显示） */}
        <div className="bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] p-4 flex flex-col h-full">
          {/* 标题 */}
          <div className="flex items-center gap-2 mb-3">
            <span className="text-base font-semibold text-[var(--fg-primary)]">系统健康评分</span>
            {healthData && (
              <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${scoreColor.bg} text-white`}>
                {scoreColor.label}
              </span>
            )}
          </div>

          {/* 评分圆环 - 居中显示，flex-1撑满剩余空间 */}
          <div className="flex-1 flex items-center justify-center">
            <div className={`relative w-28 h-28 rounded-full ${scoreColor.bgLight} flex items-center justify-center`}>
              <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="6" className="text-[var(--bg-hover)]" />
                <circle
                  cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round"
                  className={scoreColor.text}
                  strokeDasharray={`${(healthData?.score ?? 0) * 2.64} 264`}
                  style={{ transition: 'stroke-dasharray 0.8s ease-out' }}
                />
              </svg>
              <div className="relative z-10 text-center">
                <span className={`text-4xl font-bold ${scoreColor.text} tabular-nums`}>
                  {isLoadingScore ? '--' : animatedScore}
                </span>
                <span className="text-xs text-[var(--fg-muted)] block">/ 100</span>
              </div>
            </div>
          </div>

          {/* 评分细项 */}
          {healthData && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2" title="C盘剩余空间占比，空间越充足分数越高（满分40分）">
                <HardDrive className={`w-4 h-4 shrink-0 ${healthData.disk_score >= 30 ? 'text-emerald-500' : healthData.disk_score >= 20 ? 'text-amber-500' : 'text-rose-500'}`} />
                <span className="text-xs text-[var(--fg-secondary)] w-16 cursor-help">磁盘空间</span>
                <div className="flex-1 h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${healthData.disk_score >= 30 ? 'bg-emerald-500' : healthData.disk_score >= 20 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${(healthData.disk_score / 40) * 100}%` }} />
                </div>
                <span className={`text-xs font-medium w-10 text-right ${healthData.disk_score >= 30 ? 'text-emerald-600' : healthData.disk_score >= 20 ? 'text-amber-600' : 'text-rose-600'}`}>{healthData.disk_score}/40</span>
              </div>
              <div className="flex items-center gap-2" title="休眠文件(hiberfil.sys)状态，无休眠文件满分，文件越大扣分越多（满分30分）">
                <Moon className={`w-4 h-4 shrink-0 ${healthData.hibernation_score >= 25 ? 'text-emerald-500' : healthData.hibernation_score >= 15 ? 'text-amber-500' : 'text-rose-500'}`} />
                <span className="text-xs text-[var(--fg-secondary)] w-16 cursor-help">休眠文件</span>
                <div className="flex-1 h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${healthData.hibernation_score >= 25 ? 'bg-emerald-500' : healthData.hibernation_score >= 15 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${(healthData.hibernation_score / 30) * 100}%` }} />
                </div>
                <span className={`text-xs font-medium w-10 text-right ${healthData.hibernation_score >= 25 ? 'text-emerald-600' : healthData.hibernation_score >= 15 ? 'text-amber-600' : 'text-rose-600'}`}>{healthData.hibernation_score}/30</span>
              </div>
              <div className="flex items-center gap-2" title="临时文件和缓存大小，垃圾越少分数越高（满分30分）">
                <Trash2 className={`w-4 h-4 shrink-0 ${healthData.junk_score >= 25 ? 'text-emerald-500' : healthData.junk_score >= 15 ? 'text-amber-500' : 'text-rose-500'}`} />
                <span className="text-xs text-[var(--fg-secondary)] w-16 cursor-help">垃圾文件</span>
                <div className="flex-1 h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${healthData.junk_score >= 25 ? 'bg-emerald-500' : healthData.junk_score >= 15 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${(healthData.junk_score / 30) * 100}%` }} />
                </div>
                <span className={`text-xs font-medium w-10 text-right ${healthData.junk_score >= 25 ? 'text-emerald-600' : healthData.junk_score >= 15 ? 'text-amber-600' : 'text-rose-600'}`}>{healthData.junk_score}/30</span>
              </div>
            </div>
          )}
        </div>

        {/* 右侧：扫描按钮 + 功能入口 */}
        <div className="flex flex-col gap-4">
          {/* 扫描按钮区域 */}
          <div className="bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] p-5 flex items-center justify-center">
            <button
              onClick={onScanClick}
              disabled={isScanning}
              className={`relative w-28 h-28 rounded-full flex items-center justify-center text-white text-lg font-semibold shadow-xl transition-all duration-300 ${
                isScanning
                  ? 'bg-emerald-400/70 cursor-not-allowed'
                  : 'bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600 hover:scale-105 hover:shadow-emerald-500/40'
              }`}
            >
              <span className="absolute inset-2 rounded-full border border-white/30" />
              <span className="absolute -inset-3 rounded-full border-2 border-emerald-400/20 animate-pulse" />
              <span className="relative z-10">{isScanning ? '扫描中...' : '一键扫描'}</span>
            </button>
          </div>

          {/* 功能入口列表 */}
          <div className="flex-1 flex flex-col gap-2">
            {featureCards.map((item) => (
              <button
                key={item.title}
                onClick={() => onNavigate(item.target)}
                className="group flex-1 w-full text-left bg-[var(--bg-card)] rounded-xl border border-[var(--border-default)] p-3 hover:border-emerald-500/50 hover:shadow-md transition-all duration-200"
              >
                <div className="flex items-center gap-3 h-full">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500/20 to-teal-500/10 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                    {item.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-[var(--fg-primary)] group-hover:text-emerald-600 transition-colors">{item.title}</div>
                    <p className="text-[11px] text-[var(--fg-muted)] truncate">{item.description}</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-[var(--fg-faint)] group-hover:text-emerald-500 transition-all shrink-0" />
                </div>
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
