// ============================================================================
// 扫描中的「停止」按钮
//
// 位置固定在卡片头部（`ModuleCard` 的 `headerExtra`），和"扫描中…"按钮、开关同一行：
// 用户想中断扫描时视线本来就在右上角，按钮不该随正文内容滚动、更不该被骨架屏挤走。
//
// 垃圾清理 / 热点分析 / 磁盘变化分析三处共用，样式只在这里维护一份 ——
// 之前三个模块各画了一个橙色按钮，颜色和内边距都对不齐。
// 配色走 `--color-warning`（不是硬编码 amber），深浅主题下都不会糊。
// ============================================================================

import { StopCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface StopScanButtonProps {
  onClick: () => void;
  /** 覆盖默认文案（默认取 `common:stop`） */
  label?: string;
}

export function StopScanButton({ onClick, label }: StopScanButtonProps) {
  const { t } = useTranslation('common');

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] px-3 py-1.5 text-xs font-medium text-[var(--color-warning)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-warning)_22%,transparent)]"
    >
      <StopCircle className="h-3.5 w-3.5" />
      {label ?? t('stop')}
    </button>
  );
}

export default StopScanButton;
