// ============================================================================
// 模块卡片组件
// 通用的可展开清理模块卡片，用于仪表盘布局
// ============================================================================

import { ReactNode, useRef, useState, useEffect } from 'react';
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
  /** 可清理的总大小（字节） */
  totalSize: number;
  /** fileCount 的单位标签，默认"个文件"。大目录模块可传"个大目录" */
  countLabel?: string;
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
  /** 展示模式：卡片模式保持手风琴，页面模式用于传统 PC 功能页。 */
  variant?: 'card' | 'page';
  /** 页面模式下强制展示内容，避免切换模块后还要再次展开。 */
  forceExpanded?: boolean;
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
  countLabel = '个文件',
  expanded,
  onToggleExpand,
  onScan,
  scanButtonText,
  scanDisabled = false,
  children,
  headerExtra,
  error,
  variant = 'card',
  forceExpanded = false,
}: ModuleCardProps) {
  const isScanning = status === 'scanning';
  const isDone = status === 'done';
  const hasError = status === 'error' || !!error;
  const isPageVariant = variant === 'page';
  const contentExpanded = forceExpanded || expanded;

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
        ${isPageVariant
          ? 'shadow-sm ring-1 ring-[var(--border-color)]'
          : expanded
            ? 'shadow-sm ring-1 ring-[var(--brand-green-20)]'
            : 'shadow-sm hover:shadow-md'
        }
      `}
    >
      {/* 卡片头部 - 增加内边距提供呼吸空间 */}
      <div className="p-6">
        <div className="flex items-center gap-4">
          {/* 展开/收起按钮 */}
          {!isPageVariant && (
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
          )}

          {/* 模块图标 - 微信绿 10% 透明度圆角容器 */}
          <div className={`w-14 h-14 rounded-2xl ${iconBgClass} flex items-center justify-center shrink-0`}>
            {icon}
          </div>

          {/* 模块信息 - 清晰的文字层次 */}
          <div
            className={`flex-1 min-w-0 ${isPageVariant ? '' : 'cursor-pointer'}`}
            onClick={isPageVariant ? undefined : onToggleExpand}
          >
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
              <p className="text-[13px] text-[var(--text-muted)] tabular-nums">{fileCount.toLocaleString()} {countLabel}</p>
            </div>
          )}

          {/* 额外内容 */}
          {headerExtra}

          {/* 扫描按钮：完成态也保留按钮边界，避免“重新扫描/检测”在列表里看起来像普通文字。 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onScan();
            }}
            disabled={isScanning || scanDisabled}
            className={`
              flex items-center gap-2 px-5 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-200 shrink-0
              border shadow-sm active:scale-[0.98]
              ${isScanning || scanDisabled
                ? 'border-[var(--border-color)] bg-[var(--bg-hover)] text-[var(--text-faint)] cursor-not-allowed shadow-none'
                : isDone
                  ? 'border-[var(--brand-green-20)] bg-[var(--brand-green-10)] text-[var(--brand-green)] hover:bg-[var(--brand-green)] hover:text-white hover:border-[var(--brand-green)] hover:shadow-[0_6px_18px_rgba(7,193,96,0.18)]'
                  : 'border-[var(--brand-green)] bg-[var(--brand-green)] text-white hover:bg-[var(--brand-green-hover)] hover:border-[var(--brand-green-hover)] hover:shadow-[0_6px_18px_rgba(7,193,96,0.22)]'
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

      {/* 展开内容 - 手风琴动画 */}
      <AccordionContent expanded={contentExpanded} animated={!isPageVariant}>
        <div className="border-t border-[var(--border-color)] pb-2">
          {children}
        </div>
      </AccordionContent>
    </div>
  );
}

// ============================================================================
// 手风琴动画组件
// ============================================================================

interface AccordionContentProps {
  expanded: boolean;
  children: ReactNode;
  animated?: boolean;
}

function AccordionContent({ expanded, children, animated = true }: AccordionContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>(expanded ? 'auto' : 0);
  const [isAnimating, setIsAnimating] = useState(false);
  const prevExpandedRef = useRef(expanded);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const wasExpanded = prevExpandedRef.current;
    prevExpandedRef.current = expanded;

    if (expanded && !wasExpanded) {
      // 展开：先设置实际高度，动画结束后设为 auto
      const scrollHeight = content.scrollHeight;
      setHeight(scrollHeight);
      setIsAnimating(true);
      
      const timer = setTimeout(() => {
        setHeight('auto');
        setIsAnimating(false);
      }, 300);
      
      return () => clearTimeout(timer);
    } else if (!expanded && wasExpanded) {
      // 折叠：先获取当前高度，再动画到 0
      const scrollHeight = content.scrollHeight;
      // 先设置为具体高度（从 auto 转换）
      setHeight(scrollHeight);
      setIsAnimating(true);
      
      // 使用 requestAnimationFrame 确保浏览器先渲染具体高度
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setHeight(0);
        });
      });
      
      const timer = setTimeout(() => {
        setIsAnimating(false);
      }, 300);
      
      return () => clearTimeout(timer);
    }
  }, [expanded]);

  const shouldRender = expanded || height !== 0 || isAnimating;

  if (!shouldRender) return null;

  if (!animated) {
    // 页面模式下模块内容始终可见，不需要手风琴高度计算，避免隐藏页面切换时产生无意义动画。
    return <div ref={contentRef}>{children}</div>;
  }

  return (
    <div
      ref={contentRef}
      style={{
        height: typeof height === 'number' ? `${height}px` : height,
        overflow: 'hidden',
        transition: 'height 300ms cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {children}
    </div>
  );
}

export default ModuleCard;
