// ============================================================================
// 通用空数据占位组件
// ============================================================================

import type { ComponentType, ReactNode } from 'react';
import { CheckCircle2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface EmptyStateProps {
  /** 用图标承载当前状态，避免不同模块各自写一套空白占位。 */
  icon?: ComponentType<{ className?: string }>;
  title?: string;
  description?: string;
  action?: ReactNode;
  tone?: 'neutral' | 'success';
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = 'neutral',
  compact = false,
  className = '',
}: EmptyStateProps) {
  const { t } = useTranslation('common');
  // 默认空状态由公共语言包提供，业务页面传入的专属标题仍然优先保留。
  const resolvedTitle = title ?? t('noData');
  const resolvedDescription = description ?? t('emptyDescription');
  const Icon = icon ?? (tone === 'success' ? CheckCircle2 : Sparkles);
  const iconClassName = tone === 'success'
    ? 'bg-[var(--brand-green-10)] text-[var(--brand-green)]'
    : 'bg-[var(--brand-green-10)] text-[var(--brand-green)]';

  return (
    <div
      className={`relative overflow-hidden flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border-color)] bg-[linear-gradient(135deg,var(--bg-main),var(--brand-green-10))] px-6 text-center ${
        compact ? 'min-h-[160px] py-8' : 'min-h-[220px] py-14'
      } ${className}`}
    >
      {/* 用低对比度背景层增加空状态质感，避免纯灰色占位在页面模式下显得空。 */}
      <div className="pointer-events-none absolute -left-10 -top-10 h-32 w-32 rounded-full bg-[var(--brand-green)]/5" />
      <div className="pointer-events-none absolute -right-12 bottom-4 h-28 w-28 rounded-full bg-[var(--brand-green)]/5" />
      <div className={`relative mb-3 flex h-14 w-14 items-center justify-center rounded-2xl shadow-sm ${iconClassName}`}>
        <Icon className="h-6 w-6" />
      </div>
      <p className="relative text-sm font-semibold text-[var(--text-primary)]">{resolvedTitle}</p>
      {resolvedDescription && (
        <p className="relative mt-1 max-w-sm text-xs leading-relaxed text-[var(--text-muted)]">
          {resolvedDescription}
        </p>
      )}
      {action && <div className="relative mt-4">{action}</div>}
    </div>
  );
}
