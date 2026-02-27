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
  // 图标背景色默认使用微信绿 10% 透明度
  iconBgClass = 'bg-[var(--brand-green-10)]',
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

  // 获取状态标签 - 使用微信绿色系
  const getStatusBadge = () => {
    if (isScanning) {
      return (
        <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--brand-green-10)] text-[var(--brand-green)]">
          <Loader2 className="w-3 h-3 animate-spin" />
          扫描中
        </span>
      );
    }
    if (hasError) {
      return (
        <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--color-danger)]/10 text-[var(--color-danger)]">
          <AlertCircle className="w-3 h-3" />
          出错
        </span>
      );
    }
    if (isDone && fileCount > 0) {
      return (
        <span className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--brand-green-10)] text-[var(--brand-green)]">
          可清理
        </span>
      );
    }
    if (isDone && fileCount === 0) {
      return (
        <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--bg-hover)] text-[var(--text-muted)]">
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
        /* 微信风格卡片：纯白背景 + 极淡阴影 + 大圆角 */
        bg-[var(--bg-card)] rounded-2xl overflow-hidden
        transition-all duration-300 ease-out
        ${expanded 
          ? 'shadow-sm ring-1 ring-[var(--brand-green-20)]' 
          : 'shadow-sm hover:shadow-md'
        }
      `}
    >
      {/* 卡片头部 - 增加内边距提供呼吸空间 */}
      <div className="p-6">
        <div className="flex items-center gap-4">
          {/* 展开/收起按钮 */}
          <button
            onClick={onToggleExpand}
            className={`
              text-[var(--text-muted)] transition-transform duration-200 p-1 -ml-1
              hover:text-[var(--text-secondary)]
              ${expanded ? 'rotate-0' : '-rotate-90'}
            `}
          >
            <ChevronDown className="w-5 h-5" />
          </button>

          {/* 模块图标 - 微信绿 10% 透明度圆角容器 */}
          <div className={`w-14 h-14 rounded-2xl ${iconBgClass} flex items-center justify-center shrink-0`}>
            {icon}
          </div>

          {/* 模块信息 - 清晰的文字层次 */}
          <div className="flex-1 min-w-0 cursor-pointer" onClick={onToggleExpand}>
            <div className="flex items-center gap-2.5">
              <h3 className="text-[15px] font-bold text-[var(--text-primary)]">{title}</h3>
              {getStatusBadge()}
            </div>
            <p className="text-[13px] text-[var(--text-muted)] mt-1 truncate">{description}</p>
          </div>

          {/* 统计信息 - 使用 tabular-nums 确保数字稳定不抖动 */}
          {isDone && fileCount > 0 && (
            <div className="text-right shrink-0 mr-3">
              <p className="text-xl font-bold text-[var(--brand-green)] tabular-nums">{formatSize(totalSize)}</p>
              <p className="text-[13px] text-[var(--text-muted)] tabular-nums">{fileCount.toLocaleString()} 个文件</p>
            </div>
          )}

          {/* 额外内容 */}
          {headerExtra}

          {/* 扫描按钮 - 微信风格：主按钮实心微信绿，次按钮幽灵风格 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onScan();
            }}
            disabled={isScanning || scanDisabled}
            className={`
              flex items-center gap-2 px-5 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-200 shrink-0
              ${isScanning || scanDisabled
                ? 'bg-[var(--bg-hover)] text-[var(--text-faint)] cursor-not-allowed'
                : isDone
                  ? 'bg-transparent text-[var(--brand-green)] hover:bg-[var(--brand-green-10)]'  /* Ghost Button 风格 */
                  : 'bg-[var(--brand-green)] text-white hover:bg-[var(--brand-green-hover)]'  /* 实心微信绿按钮 */
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

        {/* 扫描进度条 - 微信绿流光动画 */}
        {isScanning && (
          <div className="mt-5 pt-5 border-t border-[var(--border-muted)]">
            <div className="h-1.5 bg-[var(--bg-hover)] rounded-full overflow-hidden">
              <div 
                className="h-full rounded-full"
                style={{ 
                  width: '100%',
                  background: `linear-gradient(90deg, transparent, var(--brand-green-20), transparent)`,
                  backgroundSize: '200% 100%',
                  animation: 'shimmer 1.5s ease-in-out infinite'
                }} 
              />
            </div>
          </div>
        )}

        {/* 错误信息 */}
        {hasError && error && (
          <div className="mt-4 px-4 py-3 bg-[var(--color-danger)]/10 rounded-xl">
            <p className="text-[13px] text-[var(--color-danger)]">{error}</p>
          </div>
        )}
      </div>

      {/* 展开内容 */}
      {expanded && (
        <div className="border-t border-[var(--border-color)]">
          {children}
        </div>
      )}
    </div>
  );
}

export default ModuleCard;
