// ============================================================================
// 本地数据清理确认弹窗
// ============================================================================

import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, RefreshCw, Trash2, X } from 'lucide-react';
import type { ClearableDataItem } from '../../api/commands';
import { formatSize } from '../../utils/format';
import { useTranslation } from 'react-i18next';

const DATA_ITEM_TRANSLATION_KEYS: Record<string, string> = {
  install_history: 'clearDataItems.installHistory',
  logs: 'clearDataItems.logs',
  reg_backups: 'clearDataItems.registryBackups',
  shell_icon_logs: 'clearDataItems.shellIconLogs',
  shell_icon_backups: 'clearDataItems.shellIconBackups',
  driver_backups: 'clearDataItems.driverBackups',
};

// 使用后端稳定 ID 映射翻译，避免把当前语言状态传入数据目录和清理逻辑。
function localizeDataItem(item: ClearableDataItem, translate: (key: string, options?: Record<string, unknown>) => string) {
  const fixedKey = DATA_ITEM_TRANSLATION_KEYS[item.id];
  const snapshotPrefix = 'disk_growth_snapshots_';
  const drive = item.id.startsWith(snapshotPrefix)
    ? item.id.slice(snapshotPrefix.length).toUpperCase()
    : undefined;
  const translationKey = fixedKey ?? (drive ? 'clearDataItems.diskGrowthSnapshot' : undefined);

  if (!translationKey) {
    return { label: item.id, description: '', warning: undefined };
  }

  const options = drive ? { drive } : undefined;
  return {
    label: translate(`${translationKey}.label`, options),
    description: translate(`${translationKey}.description`, options),
    warning: translate(`${translationKey}.warning`, options),
  };
}

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
  const { t } = useTranslation('settings');
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
                  <h3 className="text-base font-semibold text-[var(--text-primary)]">{t('clearData.title')}</h3>
                  <p className="text-xs text-[var(--text-muted)]">{t('clearData.subtitle')}</p>
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
                  {t('clearData.warning')}
                </p>
              </div>

              <div className="space-y-2">
                {items.map(item => {
                  const selected = selectedIds.includes(item.id);
                  const disabled = !item.exists || item.file_count === 0;
                  const localizedItem = localizeDataItem(item, t);

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
                            <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{localizedItem.label}</p>
                            <span className="shrink-0 text-xs font-semibold tabular-nums text-[var(--brand-green)]">
                              {formatSize(item.size)}
                            </span>
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{localizedItem.description}</p>
                          <p className="mt-1 truncate text-[11px] text-[var(--text-faint)]" title={item.path}>
                            {item.item_type === 'directory' ? t('clearData.directory') : t('clearData.file')} · {t('clearData.fileCount', { count: item.file_count.toLocaleString() })} · {item.path}
                          </p>
                          {localizedItem.warning && (
                            <p className="mt-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                              {localizedItem.warning}
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
                {t('clearData.summary', { count: selectedFileCount.toLocaleString(), size: formatSize(selectedSize) })}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={onCancel}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition"
                >
                  {t('clearData.cancel')}
                </button>
                <button
                  onClick={onConfirm}
                  disabled={isClearing || selectedIds.length === 0}
                  className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isClearing && <RefreshCw className="h-4 w-4 animate-spin" />}
                  {t('clearData.confirm')}
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
