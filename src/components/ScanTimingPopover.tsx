// ============================================================================
// 扫描耗时明细浮层
//
// 阶段耗时、$MFT 分段/读盘/解析这类数字是排查和继续优化的依据，
// 但对普通用户是噪音 —— 发版后统一收进这个「小秒表」按钮，点开才看。
//
// 为什么用点击而不是悬停：悬停浮层一按截图快捷键就消失（原生 title 也一样的毛病），
// 而这类数据恰恰是要截图反馈的。点开之后鼠标可以移开、可以随便截。
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface TimingRow {
  label: string;
  value: string;
}

export interface TimingGroup {
  /** 分组标题（如「C: 盘」）；传空串则不渲染标题行 */
  title: string;
  rows: TimingRow[];
  /** 分组备注，适合放「MFT 分段 11 · 读盘 2.4s、解析 1.1s」这种一行长文案 */
  note?: string;
}

interface ScanTimingPopoverProps {
  groups: TimingGroup[];
  /** 浮层贴左侧还是右侧，靠近页面右边缘时用 right 免得溢出 */
  align?: 'left' | 'right';
}

export function ScanTimingPopover({ groups, align = 'right' }: ScanTimingPopoverProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 点空白处 / 按 Esc 关闭：浮层不是模态，不应该逼用户找关闭按钮
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // 没有任何可展示的数字时干脆不出现，避免留下一个点不出东西的按钮
  const hasContent = groups.some((group) => group.rows.length > 0 || Boolean(group.note));
  if (!hasContent) return null;

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-label={t('timingDetails')}
        title={t('timingDetails')}
        className={`inline-flex h-5 w-5 items-center justify-center rounded-md transition ${
          open
            ? 'bg-[var(--bg-hover)] text-[var(--brand-green)]'
            : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--brand-green)]'
        }`}
      >
        <Timer className="h-3.5 w-3.5" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className={`absolute top-full z-40 mt-1 w-[18rem] ${align === 'right' ? 'right-0' : 'left-0'}`}
          >
            <div className="glass-overlay rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-3 text-xs shadow-lg">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="font-semibold text-[var(--text-primary)]">{t('timingDetails')}</span>
                <span className="text-[var(--text-faint)]">{t('timingDetailsHint')}</span>
              </div>
              <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
                {groups.map((group) => (
                  <div key={group.title || group.note} className="space-y-1">
                    {group.title && (
                      <div className="font-medium text-[var(--text-muted)]">{group.title}</div>
                    )}
                    {group.rows.map((row) => (
                      <div
                        key={row.label}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
                      >
                        <span className="truncate text-[var(--text-muted)]">{row.label}</span>
                        <span className="tabular-nums text-[var(--text-primary)]">{row.value}</span>
                      </div>
                    ))}
                    {group.note && (
                      <div className="leading-snug text-[var(--text-faint)]">{group.note}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
