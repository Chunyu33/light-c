// ============================================================================
// 便携版更新引导弹窗
//
// 便携版不能走安装器式自动更新，否则会把 NSIS 包静默装到系统里。这个弹窗只做二次确认
// 与渠道引导：告诉用户便携版需要手动替换文件，并提供官网与网盘两个官方入口。
// 与 ClearLocalDataDialog 保持一致，统一用 framer-motion 处理进出场动画。
// ============================================================================

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Globe, HardDriveDownload, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MODAL_BACKDROP_MOTION, MODAL_CARD_MOTION } from '../../utils/modalMotion';

export interface PortableUpdateDialogProps {
  isOpen: boolean;
  /** 远端最新版本号；未查到时为 null，此时只展示渠道引导。 */
  latestVersion: string | null;
  /** 当前应用版本号。 */
  currentVersion: string;
  /** 正在查询远端版本。 */
  isChecking: boolean;
  /** 版本查询是否失败（失败时不谎称"已是最新"）。 */
  checkFailed?: boolean;
  /** 作者网盘入口，取自官方 download.json，失败时回退内置地址。 */
  netDiskUrl: string;
  /** 官方网站入口。 */
  officialWebsiteUrl: string;
  /** 点击渠道按钮时回调，由调用方负责打开外部链接。 */
  onOpenChannel: (url: string, channel: 'website' | 'netDisk') => void;
  onClose: () => void;
}

export function PortableUpdateDialog({
  isOpen,
  latestVersion,
  currentVersion,
  isChecking,
  checkFailed = false,
  netDiskUrl,
  officialWebsiteUrl,
  onOpenChannel,
  onClose,
}: PortableUpdateDialogProps) {
  const { t } = useTranslation('ui');
  const { t: commonT } = useTranslation('common');

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // 三种状态依次降级：查询中 → 查到新版本 → 已是最新 / 查询失败。
  const subtitle = isChecking && !latestVersion
    ? t('portableUpdateChecking')
    : latestVersion
      ? t('portableUpdateCurrent', { version: currentVersion })
      : checkFailed
        ? t('portableUpdateCheckFailed')
        : t('portableUpdateUpToDate', { version: currentVersion });

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[10000] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
        >
          <motion.div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
            {...MODAL_BACKDROP_MOTION}
          />

          <motion.div
            className="relative w-[440px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-2xl"
            {...MODAL_CARD_MOTION}
          >
            <div className="h-1.5 bg-gradient-to-r from-[var(--brand-green)] via-emerald-400 to-teal-400" />

            <button
              type="button"
              onClick={onClose}
              aria-label={commonT('close')}
              className="absolute right-4 top-4 z-10 rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="p-6">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--brand-green)] to-emerald-500 shadow-lg">
                  <HardDriveDownload className="h-6 w-6 text-white" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                    {latestVersion ? t('portableUpdateFound', { version: latestVersion }) : t('portableUpdateTitle')}
                  </h2>
                  <p className="mt-0.5 flex items-center gap-1.5 text-sm text-[var(--text-muted)]">
                    {isChecking && <RefreshCw className="h-3 w-3 shrink-0 animate-spin" />}
                    {subtitle}
                  </p>
                </div>
              </div>

              <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
                {t('portableUpdateIntro')}
              </p>

              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={() => onOpenChannel(officialWebsiteUrl, 'website')}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--brand-green)] px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-[var(--brand-green)]/20 transition-colors hover:bg-[var(--brand-green-hover)]"
                >
                  <Globe className="h-4 w-4" />
                  {t('portableUpdateWebsite')}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenChannel(netDiskUrl, 'netDisk')}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--brand-green)]/10 px-4 py-2.5 text-sm font-medium text-[var(--brand-green)] transition-colors hover:bg-[var(--brand-green)]/20"
                >
                  <HardDriveDownload className="h-4 w-4" />
                  {t('portableUpdateNetDisk')}
                </button>
              </div>

              <p className="mt-3 text-xs leading-relaxed text-[var(--text-faint)]">
                {t('portableUpdateHint')}
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export default PortableUpdateDialog;
