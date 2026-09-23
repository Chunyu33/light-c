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

          {/* 尺寸统一用 em：body 继承 :root 字号，弹窗宽高随全局字号设置缩放 */}
          <motion.div
            className="relative mx-[1em] w-[31.43em] max-w-[calc(100vw-2em)] overflow-hidden rounded-[0.86em] border border-[var(--border-default)] bg-[var(--bg-card)] shadow-2xl"
            {...MODAL_CARD_MOTION}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label={commonT('close')}
              className="absolute right-[1em] top-[1em] z-10 flex h-[2em] w-[2em] items-center justify-center rounded-[0.57em] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <X className="h-[1.14em] w-[1.14em]" />
            </button>

            <div className="p-[1.43em]">
              {/* 标题区：浅绿底图标 + 版本信息，与主界面模块卡片同一语汇 */}
              <div className="mb-[1.14em] flex items-start gap-[0.86em]">
                <div className="flex h-[2.57em] w-[2.57em] shrink-0 items-center justify-center rounded-[0.71em] bg-[var(--brand-green-10)]">
                  <HardDriveDownload className="h-[1.29em] w-[1.29em] text-[var(--brand-green)]" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[1em] font-semibold text-[var(--text-primary)]">
                    {latestVersion ? t('portableUpdateFound', { version: latestVersion }) : t('portableUpdateTitle')}
                  </h2>
                  <p className="mt-[0.14em] flex items-center gap-[0.43em] text-[0.86em] text-[var(--text-muted)]">
                    {isChecking && <RefreshCw className="h-[0.86em] w-[0.86em] shrink-0 animate-spin" />}
                    {subtitle}
                  </p>
                </div>
              </div>

              <p className="text-[0.86em] leading-relaxed text-[var(--text-secondary)]">
                {t('portableUpdateIntro')}
              </p>

              <div className="mt-[1.43em] flex flex-col gap-[0.57em] sm:flex-row">
                <button
                  type="button"
                  onClick={() => onOpenChannel(officialWebsiteUrl, 'website')}
                  className="flex flex-1 items-center justify-center gap-[0.43em] rounded-[0.71em] bg-[var(--brand-green)] px-[1em] py-[0.64em] text-[0.86em] font-semibold text-white transition-colors hover:bg-[var(--brand-green-hover)]"
                >
                  <Globe className="h-[0.86em] w-[0.86em]" />
                  {t('portableUpdateWebsite')}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenChannel(netDiskUrl, 'netDisk')}
                  className="flex flex-1 items-center justify-center gap-[0.43em] rounded-[0.71em] border border-[var(--border-default)] bg-[var(--bg-card)] px-[1em] py-[0.64em] text-[0.86em] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <HardDriveDownload className="h-[0.86em] w-[0.86em]" />
                  {t('portableUpdateNetDisk')}
                </button>
              </div>

              <p className="mt-[0.86em] text-[0.79em] leading-relaxed text-[var(--text-faint)]">
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
