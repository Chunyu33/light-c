// ============================================================================
// 磁盘切换弹窗
//
// 顶栏那一行只有几十像素高，塞下拉框时字号、宽度、选项截断反复对不齐；
// 改成点图标弹窗后，每个分区能完整显示卷标、可用/总量和使用率。
//
// ⚠️ position: fixed 的弹窗必须 createPortal 到 document.body：
// 顶栏容器有入场 transform，fixed 会退化成 absolute，遮罩盖不住整个窗口。
// ============================================================================

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { driveOptionLabel } from './ui/DriveSelect';
import { formatSize } from '../utils/format';
import { MODAL_BACKDROP_MOTION, MODAL_CARD_MOTION } from '../utils/modalMotion';
import type { LocalDriveInfo } from '../api/commands';

interface DiskSwitchModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 所有固定磁盘的信息，由顶栏的 useLocalDrives 提供，不在这里重复读取 */
  drives: LocalDriveInfo[];
  /** 当前展示的盘符，例如 "C:" */
  selectedDrive: string;
  onSelect: (driveLetter: string) => void;
}

export function DiskSwitchModal({
  isOpen,
  onClose,
  drives,
  selectedDrive,
  onSelect,
}: DiskSwitchModalProps) {
  const { t } = useTranslation('common');

  // ESC 关闭：弹窗统一用这个键，和项目里其它弹窗保持一致
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          {...MODAL_BACKDROP_MOTION}
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm glass-backdrop"
          onClick={onClose}
        >
          <motion.div
            {...MODAL_CARD_MOTION}
            role="dialog"
            aria-modal="true"
            aria-label={t('diskSwitchTitle')}
            className="glass-dialog relative w-[30em] max-w-[calc(100vw-2em)] max-h-[calc(100vh-2em)] overflow-y-auto rounded-2xl bg-[var(--glass-modal-bg,var(--bg-card))] p-[1.43em] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-[1em] flex items-center justify-between gap-2">
              <h2 className="text-[1.07em] font-semibold text-[var(--text-primary)]">{t('diskSwitchTitle')}</h2>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('close')}
                className="rounded-lg p-[0.35em] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <X className="h-[1.14em] w-[1.14em]" />
              </button>
            </div>

            {drives.length === 0 ? (
              <p className="py-[1.4em] text-center text-[0.93em] text-[var(--text-muted)]">{t('diskSwitchEmpty')}</p>
            ) : (
              <div className="space-y-[0.57em]">
                {drives.map((drive) => {
                  const isSelected = drive.drive_letter === selectedDrive;
                  return (
                    <button
                      key={drive.drive_letter}
                      type="button"
                      onClick={() => {
                        onSelect(drive.drive_letter);
                        onClose();
                      }}
                      className={`w-full rounded-xl border p-[0.86em] text-left transition-colors ${
                        isSelected
                          ? 'border-[var(--brand-green)] bg-[var(--brand-green)]/5'
                          : 'border-[var(--border-color)] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-[var(--text-primary)]">{driveOptionLabel(drive)}</p>
                          <p className="mt-0.5 tabular-nums text-[0.86em] text-[var(--text-muted)]">
                            {t('freeOfTotal', {
                              free: formatSize(drive.free_space),
                              total: formatSize(drive.total_space),
                            })}
                          </p>
                        </div>
                        {isSelected && <Check className="mt-0.5 h-[1.14em] w-[1.14em] shrink-0 text-[var(--brand-green)]" />}
                      </div>
                      {/* 使用率条：和顶栏同一套配色阈值，两处读起来是同一种信息 */}
                      <div className="mt-[0.57em] h-1.5 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                        <div
                          className={`h-full rounded-full ${
                            drive.usage_percent > 90 ? 'bg-[var(--color-danger)]' :
                            drive.usage_percent > 75 ? 'bg-[var(--color-warning)]' : 'bg-[var(--brand-green)]'
                          }`}
                          style={{ width: `${drive.usage_percent}%` }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
