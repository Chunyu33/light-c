// ============================================================================
// 本地数据清理确认弹窗
// ============================================================================

import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, RefreshCw, Trash2, X } from 'lucide-react';
import type { ClearableDataItem } from '../../api/commands';
import { formatSize } from '../../utils/format';
import { MODAL_BACKDROP_MOTION, MODAL_CARD_MOTION } from '../../utils/modalMotion';
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
            {...MODAL_BACKDROP_MOTION}
          />
          {/* 尺寸统一用 em：body 继承 :root 字号，弹窗随全局字号设置缩放，37.14em ≈ 520px */}
          <motion.div
            className="relative w-[37.14em] max-w-[calc(100vw-2em)] overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-2xl"
            {...MODAL_CARD_MOTION}
          >
            <div className="flex items-center justify-between border-b border-[var(--border-color)] px-[1.43em] py-[1.14em]">
              <div className="flex items-center gap-[0.86em]">
                <div className="flex h-[2.86em] w-[2.86em] items-center justify-center rounded-full bg-[var(--color-danger)]/10">
                  <Trash2 className="h-[1.43em] w-[1.43em] text-[var(--color-danger)]" />
                </div>
                <div>
                  <h3 className="text-[1.14em] font-semibold text-[var(--text-primary)]">{t('clearData.title')}</h3>
                  <p className="text-[0.86em] text-[var(--text-muted)]">{t('clearData.subtitle')}</p>
                </div>
              </div>
              <button
                onClick={onCancel}
                className="rounded-lg p-[0.43em] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition"
              >
                <X className="h-[1.14em] w-[1.14em]" />
              </button>
            </div>

            <div className="max-h-[41.43em] overflow-y-auto px-[1.43em] py-[1.14em]">
              <div className="mb-[0.86em] rounded-xl border border-amber-500/20 bg-amber-500/10 p-[0.86em]">
                <p className="text-[0.86em] leading-relaxed text-amber-700 dark:text-amber-300">
                  {t('clearData.warning')}
                </p>
              </div>

              <div className="space-y-[0.57em]">
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
                      className={`w-full rounded-xl border p-[0.86em] text-left transition ${
                        selected
                          ? 'border-[var(--brand-green)] bg-[var(--brand-green)]/10'
                          : 'border-[var(--border-color)] bg-[var(--bg-main)] hover:border-[var(--brand-green)]/30'
                      } ${disabled ? 'cursor-not-allowed opacity-55' : ''}`}
                    >
                      <div className="flex items-start gap-[0.86em]">
                        {/* 勾选标记用 em 跟随字号，与 ui/Checkbox 保持一致的观感 */}
                        <span className={`mt-[0.14em] flex h-[1.14em] w-[1.14em] shrink-0 items-center justify-center rounded border ${
                          selected ? 'border-[var(--brand-green)] bg-[var(--brand-green)]' : 'border-[var(--border-color)]'
                        }`}>
                          {selected && <CheckCircle className="h-[0.86em] w-[0.86em] text-white" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-[0.86em]">
                            <p className="truncate text-[1em] font-semibold text-[var(--text-primary)]">{localizedItem.label}</p>
                            <span className="shrink-0 text-[0.86em] font-semibold tabular-nums text-[var(--brand-green)]">
                              {formatSize(item.size)}
                            </span>
                          </div>
                          <p className="mt-[0.29em] text-[0.86em] leading-relaxed text-[var(--text-muted)]">{localizedItem.description}</p>
                          <p className="mt-[0.29em] truncate text-[0.79em] text-[var(--text-faint)]" title={item.path}>
                            {item.item_type === 'directory' ? t('clearData.directory') : t('clearData.file')} · {t('clearData.fileCount', { count: item.file_count.toLocaleString() })} · {item.path}
                          </p>
                          {localizedItem.warning && (
                            <p className="mt-[0.57em] text-[0.79em] leading-relaxed text-amber-600 dark:text-amber-400">
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

            <div className="flex items-center justify-between gap-[0.86em] border-t border-[var(--border-color)] bg-[var(--bg-main)] px-[1.43em] py-[1.14em]">
              <p className="text-[0.86em] text-[var(--text-muted)]">
                {t('clearData.summary', { count: selectedFileCount.toLocaleString(), size: formatSize(selectedSize) })}
              </p>
              <div className="flex items-center gap-[0.57em]">
                <button
                  onClick={onCancel}
                  className="rounded-lg px-[1.14em] py-[0.57em] text-[1em] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition"
                >
                  {t('clearData.cancel')}
                </button>
                <button
                  onClick={onConfirm}
                  disabled={isClearing || selectedIds.length === 0}
                  className="inline-flex items-center gap-[0.57em] rounded-lg bg-[var(--color-danger)] px-[1.14em] py-[0.57em] text-[1em] font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isClearing && <RefreshCw className="h-[1.14em] w-[1.14em] animate-spin" />}
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
