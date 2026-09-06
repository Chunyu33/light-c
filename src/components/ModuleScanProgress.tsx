// ============================================================================
// 模块内联扫描状态
// 用于扫描页面内部的等待状态，避免不同模块重复维护一套低矮的 Loading UI。
// ============================================================================

import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ModuleScanProgressProps {
  /** 扫描阶段标题 */
  title: string;
  /** 扫描阶段说明 */
  description?: string;
  /** 模块专属图标 */
  icon?: ReactNode;
  /** 额外的阶段信息或操作按钮 */
  footer?: ReactNode;
  /** 补充样式类名 */
  className?: string;
}

export function ModuleScanProgress({
  title,
  description,
  icon,
  footer,
  className = '',
}: ModuleScanProgressProps) {
  const { t } = useTranslation('common');

  return (
    <div
      className={`module-scan-progress-area flex flex-col items-center justify-center rounded-2xl border border-[var(--brand-green-20)] bg-[var(--brand-green-10)] p-5 text-center sm:p-6 ${className}`}
    >
      <div className="flex w-fit max-w-full items-start justify-center gap-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[var(--bg-card)] shadow-sm">
          {icon ?? <Loader2 className="h-7 w-7 animate-spin text-[var(--brand-green)]" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h4>
            <span className="rounded-full bg-[var(--bg-card)] px-2 py-0.5 text-[10px] font-medium text-[var(--brand-green)]">
              {t('scanningShort')}
            </span>
          </div>
          {description && (
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{description}</p>
          )}
        </div>
      </div>

      {footer && <div className="mt-4 w-full">{footer}</div>}
    </div>
  );
}

export default ModuleScanProgress;
