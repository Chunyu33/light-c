// ============================================================================
// 本地数据清理确认弹窗
// ============================================================================

import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, RefreshCw, Trash2, X } from 'lucide-react';
import type { ClearableDataItem } from '../../api/commands';
import { formatSize } from '../../utils/format';

export function ClearLocalDataDialog({
  isOpen,
  items,
  selectedIds,
  isClearing,
  onToggleItem,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean;
  items: ClearableDataItem[];
  selectedIds: string[];
  isClearing: boolean;
  onToggleItem: (itemId: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const selectedItems = items.filter(item => selectedIds.includes(item.id));
  const selectedSize = selectedItems.reduce((sum, item) => sum + item.size, 0);
  const selectedFileCount = selectedItems.reduce((sum, item) => sum + item.file_count, 0);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        // 清理确认会打断用户操作流，入退场动画用于降低突然弹出/消失的割裂感。
        <motion.div
          className="fixed inset-0 z-[10050] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <motion.div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={onCancel}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          />
          <motion.div
            className="relative w-[520px] max-w-[92vw] overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-2xl"
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          >
            <div className="flex items-center justify-between border-b border-[var(--border-color)] px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-danger)]/10">
                  <Trash2 className="h-5 w-5 text-[var(--color-danger)]" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-[var(--text-primary)]">清理本地数据</h3>
                  <p className="text-xs text-[var(--text-muted)]">只清理下列白名单数据，应用配置独立保留</p>
                </div>
              </div>
              <button
                onClick={onCancel}
                className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[58vh] overflow-y-auto px-5 py-4">
              <div className="mb-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
                <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                  这些数据可以安全清理，不会删除应用配置。磁盘变化分析快照已按盘符拆分，可单独保留某个磁盘的基线；被清理的磁盘下次扫描会重新建立基线，第二次扫描后才会重新显示变化对比。
                </p>
              </div>

              <div className="space-y-2">
                {items.map(item => {
                  const selected = selectedIds.includes(item.id);
                  const disabled = !item.exists || item.file_count === 0;

                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => onToggleItem(item.id)}
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        selected
                          ? 'border-[var(--brand-green)] bg-[var(--brand-green)]/10'
                          : 'border-[var(--border-color)] bg-[var(--bg-main)] hover:border-[var(--brand-green)]/30'
                      } ${disabled ? 'cursor-not-allowed opacity-55' : ''}`}
                    >
                      <div className="flex items-start gap-3">
                        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          selected ? 'border-[var(--brand-green)] bg-[var(--brand-green)]' : 'border-[var(--border-color)]'
                        }`}>
                          {selected && <CheckCircle className="h-3 w-3 text-white" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{item.label}</p>
                            <span className="shrink-0 text-xs font-semibold tabular-nums text-[var(--brand-green)]">
                              {formatSize(item.size)}
                            </span>
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{item.description}</p>
                          <p className="mt-1 truncate text-[11px] text-[var(--text-faint)]" title={item.path}>
                            {item.item_type === 'directory' ? '目录内容' : '文件'} · {item.file_count.toLocaleString()} 个文件 · {item.path}
                          </p>
                          {item.warning && (
                            <p className="mt-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                              {item.warning}
                            </p>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-[var(--border-color)] bg-[var(--bg-main)] px-5 py-4">
              <p className="text-xs text-[var(--text-muted)]">
                将删除 {selectedFileCount.toLocaleString()} 个文件，预计释放 {formatSize(selectedSize)}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={onCancel}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition"
                >
                  取消
                </button>
                <button
                  onClick={onConfirm}
                  disabled={isClearing || selectedIds.length === 0}
                  className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isClearing && <RefreshCw className="h-4 w-4 animate-spin" />}
                  确认清理
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

