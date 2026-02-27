// ============================================================================
// 模块卡片组件
// 通用的可展开清理模块卡片，用于仪表盘布局
// ============================================================================

import { ReactNode } from 'react';
import { ChevronDown, Loader2, Search, CheckCircle2, AlertCircle } from 'lucide-react';
import { formatSize } from '../utils/format';
import type { ModuleStatus } from '../contexts/DashboardContext';

// ============================================================================
// 类型定义
// ============================================================================

export interface ModuleCardProps {
  /** 模块唯一标识 */
  id: string;
  /** 模块标题 */
  title: string;
  /** 模块描述 */
  description: string;
  /** 模块图标 */
  icon: ReactNode;
  /** 图标背景色类名 */
  iconBgClass?: string;
  /** 模块状态 */
  status: ModuleStatus;
  /** 发现的文件数量 */
  fileCount: number;
  /** 可清理的总大小 */
  totalSize: number;
  /** 是否展开 */
  expanded: boolean;
  /** 展开/收起回调 */
  onToggleExpand: () => void;
  /** 扫描按钮点击回调 */
  onScan: () => void;
  /** 扫描按钮文本 */
  scanButtonText?: string;
  /** 是否禁用扫描按钮 */
  scanDisabled?: boolean;
  /** 展开后的内容 */
  children: ReactNode;
  /** 头部右侧额外内容 */
  headerExtra?: ReactNode;
  /** 错误信息 */
  error?: string | null;
}

// ============================================================================
// 组件实现
// ============================================================================

export function ModuleCard({
  // id 保留用于未来扩展（如数据追踪）
  id: _id,
  title,
  description,
  icon,
  iconBgClass = 'bg-emerald-500/15',
  status,
  fileCount,
  totalSize,
  expanded,
  onToggleExpand,
  onScan,
  scanButtonText,
  scanDisabled = false,
  children,
  headerExtra,
  error,
}: ModuleCardProps) {
  const isScanning = status === 'scanning';
  const isDone = status === 'done';
  const hasError = status === 'error' || !!error;

  // 获取状态标签
  const getStatusBadge = () => {
    if (isScanning) {
      return (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-600">
          <Loader2 className="w-3 h-3 animate-spin" />
          扫描中
        </span>
      );
    }
    if (hasError) {
      return (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-rose-500/10 text-rose-600">
          <AlertCircle className="w-3 h-3" />
          出错
        </span>
      );
    }
    if (isDone && fileCount > 0) {
      return (
        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-600">
          可清理
        </span>
      );
    }
    if (isDone && fileCount === 0) {
      return (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-[var(--bg-hover)] text-[var(--fg-muted)]">
          <CheckCircle2 className="w-3 h-3" />
          已清理
        </span>
      );
    }
    return null;
  };

  // 获取扫描按钮文本
  const getButtonText = () => {
    if (scanButtonText) return scanButtonText;
    if (isScanning) return '扫描中...';
    if (isDone) return '重新扫描';
    return '开始扫描';
  };

  return (
    <div 
      className={`
        bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] overflow-hidden
        transition-all duration-200
        ${expanded ? 'shadow-lg border-emerald-500/30' : 'hover:border-emerald-500/20'}
      `}
    >
      {/* 卡片头部 */}
      <div className="p-4">
        <div className="flex items-center gap-4">
          {/* 展开/收起按钮 */}
          <button
            onClick={onToggleExpand}
            className={`
              text-[var(--fg-muted)] transition-transform duration-200 p-1 -ml-1
              hover:text-[var(--fg-secondary)]
              ${expanded ? 'rotate-0' : '-rotate-90'}
            `}
          >
            <ChevronDown className="w-5 h-5" />
          </button>

          {/* 模块图标 */}
          <div className={`w-12 h-12 rounded-xl ${iconBgClass} flex items-center justify-center shrink-0`}>
            {icon}
          </div>

          {/* 模块信息 */}
          <div className="flex-1 min-w-0 cursor-pointer" onClick={onToggleExpand}>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-[var(--fg-primary)]">{title}</h3>
              {getStatusBadge()}
            </div>
            <p className="text-xs text-[var(--fg-muted)] mt-0.5 truncate">{description}</p>
          </div>

          {/* 统计信息 */}
          {isDone && fileCount > 0 && (
            <div className="text-right shrink-0 mr-2">
              <p className="text-lg font-bold text-emerald-600">{formatSize(totalSize)}</p>
              <p className="text-xs text-[var(--fg-muted)]">{fileCount.toLocaleString()} 个文件</p>
            </div>
          )}

          {/* 额外内容 */}
          {headerExtra}

          {/* 扫描按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onScan();
            }}
            disabled={isScanning || scanDisabled}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all shrink-0
              ${isScanning || scanDisabled
                ? 'bg-[var(--bg-hover)] text-[var(--fg-muted)] cursor-not-allowed'
                : 'bg-emerald-500 text-white hover:bg-emerald-600 shadow-sm hover:shadow'
              }
            `}
          >
            {isScanning ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            {getButtonText()}
          </button>
        </div>

        {/* 扫描进度条 */}
        {isScanning && (
          <div className="mt-4 pt-4 border-t border-[var(--border-default)]">
            <div className="h-1.5 bg-[var(--bg-hover)] rounded-full overflow-hidden">
              <div 
                className="h-full rounded-full"
                style={{ 
                  width: '100%',
                  background: 'linear-gradient(90deg, transparent, rgba(16, 185, 129, 0.6), transparent)',
                  backgroundSize: '200% 100%',
                  animation: 'shimmer 1.5s ease-in-out infinite'
                }} 
              />
            </div>
          </div>
        )}

        {/* 错误信息 */}
        {hasError && error && (
          <div className="mt-3 px-3 py-2 bg-rose-500/10 border border-rose-500/20 rounded-lg">
            <p className="text-xs text-rose-600">{error}</p>
          </div>
        )}
      </div>

      {/* 展开内容 */}
      {expanded && (
        <div className="border-t border-[var(--border-default)]">
          {children}
        </div>
      )}
    </div>
  );
}

export default ModuleCard;
