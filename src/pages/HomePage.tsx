// ============================================================================
// 首页组件
// 展示磁盘状态、扫描入口和功能卡片
// ============================================================================

import { useMemo } from 'react';
import { HardDrive, Sparkles, Users, Rocket, ChevronRight } from 'lucide-react';
import { DiskUsage } from '../components';
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
}

export function HomePage({ diskInfo, isScanning, onScanClick, onNavigate }: HomePageProps) {
  // 计算健康评分
  const healthScore = useMemo(() => {
    if (!diskInfo) return 92;
    const score = Math.round(100 - diskInfo.usage_percent);
    return Math.max(0, Math.min(100, score));
  }, [diskInfo]);

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
    <>
      {/* 顶部信息栏 - 紧凑的磁盘使用情况 */}
      <div className="max-w-5xl mx-auto">
        <DiskUsage diskInfo={diskInfo} compact />
      </div>

      {/* 中央扫描区域 */}
      <section className="max-w-5xl mx-auto bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] px-6 py-8">
        <div className="flex flex-col items-center gap-6">
          {/* 健康评分 */}
          <div className="text-center">
            <div className="inline-flex items-center gap-2 text-xs text-emerald-600 bg-emerald-500/10 px-3 py-1 rounded-full">
              <HardDrive className="w-3.5 h-3.5" />
              <span>系统健康评分</span>
            </div>
            <div className="mt-2 text-3xl font-semibold text-[var(--fg-primary)]">
              {healthScore} <span className="text-base text-[var(--fg-muted)]">/100</span>
            </div>
            <p className="mt-1 text-sm text-[var(--fg-muted)]">保持系统轻盈，建议定期扫描清理</p>
          </div>

          {/* 扫描按钮 */}
          <button
            onClick={onScanClick}
            disabled={isScanning}
            className={`relative w-40 h-40 rounded-full flex items-center justify-center text-white text-lg font-semibold shadow-xl transition-all duration-300 ${
              isScanning
                ? 'bg-emerald-400/70 cursor-not-allowed'
                : 'bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600 hover:scale-[1.02] hover:shadow-emerald-500/30'
            }`}
          >
            <span className="absolute inset-2 rounded-full border border-white/30" />
            <span className="absolute -inset-2 rounded-full border border-emerald-400/40 animate-pulse-glow" />
            <span className="relative z-10">{isScanning ? '扫描中...' : '一键扫描'}</span>
          </button>

          {/* 功能入口卡片 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full">
            {featureCards.map((item) => (
              <button
                key={item.title}
                onClick={() => onNavigate(item.target)}
                className="group text-left bg-gradient-to-br from-[var(--bg-card)] to-[var(--bg-elevated)] rounded-xl border border-[var(--border-default)] p-4 flex items-center gap-3 hover:border-emerald-500/50 hover:shadow-lg hover:shadow-emerald-500/10 hover:-translate-y-0.5 transition-all duration-200"
              >
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500/20 to-teal-500/10 flex items-center justify-center group-hover:scale-105 transition-transform">
                  {item.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-[var(--fg-primary)] group-hover:text-emerald-600 transition-colors">{item.title}</div>
                  <p className="text-xs text-[var(--fg-muted)] mt-0.5 leading-relaxed truncate">
                    {item.description}
                  </p>
                </div>
                <ChevronRight className="w-5 h-5 text-[var(--fg-faint)] group-hover:text-emerald-500 group-hover:translate-x-0.5 transition-all shrink-0" />
              </button>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
