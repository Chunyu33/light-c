// ============================================================================
// 支持作者弹窗
//
// 侧边栏爱心图标和「设置 - 意见反馈 - 支持作者」共用这一个弹窗，
// 二维码、支付方式切换、放大预览只有这一份实现。
//
// 标题用「赞助」而不是设置页那个「支持作者」：侧边栏的悬停提示写的是「赞助 LightC」，
// 点进来标题却换了个说法会让人愣一下。两者指的是同一件事。
//
// ⚠️ 不要把弹窗再抄一份到调用方：二维码图片、切换动画、ESC 关闭散在两处，
// 改一次要改两遍，迟早对不上。
// ============================================================================

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import wechatQr from '../assets/r_wechat_qr.jpg';
import alipayQr from '../assets/r_alipay_qr.jpg';
import { MODAL_BACKDROP_MOTION, MODAL_CARD_MOTION } from '../utils/modalMotion';

export type PaymentType = 'wechat' | 'alipay';

/**
 * 弹窗里赞赏码的尺寸（像素）。
 *
 * 设置页卡片里是 176px，弹窗要比它明显大一档才算"放大"。
 * 用像素而不是 rem：项目根字号被字号设置改成 14px，Tailwind 的 rem 尺寸会等比缩小，
 * 码缩到 96px 以下就扫不动了。
 */
const QR_MODAL_SIZE = 220;

/** 支付方式元数据：颜色与文案只在这里定义，所有入口共用 */
export const PAYMENT_OPTIONS: { type: PaymentType; activeClass: string; labelKey: string }[] = [
  { type: 'wechat', activeClass: 'bg-[#07C160]', labelKey: 'wechat' },
  { type: 'alipay', activeClass: 'bg-[#1677FF]', labelKey: 'alipay' },
];

interface SupportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 打开时默认选中的支付方式，由调用方决定（设置页会传卡片上当前选的那个） */
  initialPayment?: PaymentType;
  /** 底部显示的版本号；侧边栏入口传进来，设置页入口不传 */
  version?: string;
}

export function SupportModal({ isOpen, onClose, initialPayment = 'wechat', version }: SupportModalProps) {
  const { t } = useTranslation('common');
  const [paymentType, setPaymentType] = useState<PaymentType>(initialPayment);
  const [isTransitioning, setIsTransitioning] = useState(false);

  // 每次打开都对齐到调用方的选择：设置页卡片上切到支付宝后点开，
  // 弹窗还停在微信会让人以为切换没生效。
  useEffect(() => {
    if (isOpen) setPaymentType(initialPayment);
  }, [isOpen, initialPayment]);

  // 切换支付方式时先淡出再换图：直接换 src 会瞬间跳变，观感生硬
  const handlePaymentChange = (type: PaymentType) => {
    if (type === paymentType) return;
    setIsTransitioning(true);
    window.setTimeout(() => {
      setPaymentType(type);
      setIsTransitioning(false);
    }, 150);
  };

  // ESC 关闭。只在打开时挂监听，避免常驻。
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const qrAlt = paymentType === 'wechat' ? t('wechatQr') : t('alipayQr');
  const qrSrc = paymentType === 'wechat' ? wechatQr : alipayQr;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          {...MODAL_BACKDROP_MOTION}
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            {...MODAL_CARD_MOTION}
            role="dialog"
            aria-modal="true"
            aria-label={t('supportModalTitle')}
            className="relative w-[26em] max-w-[calc(100vw-2em)] max-h-[calc(100vh-2em)] overflow-y-auto rounded-2xl bg-[var(--glass-modal-bg,var(--bg-card))] p-[1.43em] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label={t('close')}
              className="absolute right-[0.86em] top-[0.86em] rounded-lg p-[0.35em] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <X className="h-[1.14em] w-[1.14em]" />
            </button>

            <h3 className="mb-[1em] pr-[2em] text-[1.14em] font-semibold text-[var(--text-primary)]">
              {t('supportModalTitle')}
            </h3>

            {/* 竖排：赞赏码 → 切换 → 说明。微信/支付宝的赞赏页都是这个结构，
                横排会把说明压成一行几个字，读起来费劲。 */}
            <div className="flex flex-col items-center">
              <div
                style={{ width: QR_MODAL_SIZE, height: QR_MODAL_SIZE }}
                className="overflow-hidden rounded-xl border border-[var(--border-color)] bg-white"
              >
                <img
                  src={qrSrc}
                  alt={qrAlt}
                  className={`h-full w-full object-contain transition-opacity duration-150 ${
                    isTransitioning ? 'opacity-0' : 'opacity-100'
                  }`}
                />
              </div>

              <div className="mt-[0.86em] inline-flex rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-1">
                {PAYMENT_OPTIONS.map((option) => (
                  <button
                    key={option.type}
                    type="button"
                    onClick={() => handlePaymentChange(option.type)}
                    className={`rounded-lg px-4 py-1.5 text-xs font-medium transition-all duration-200 ${
                      paymentType === option.type
                        ? `${option.activeClass} text-white shadow-sm`
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {t(option.labelKey)}
                  </button>
                ))}
              </div>

              <p className="mt-[1em] text-center text-sm leading-relaxed text-[var(--text-secondary)]">
                {t('supportDesc')}
              </p>
              <ul className="mt-[0.71em] w-full space-y-[0.5em] text-xs text-[var(--text-muted)]">
                <li className="flex items-start gap-[0.5em]">
                  <Check className="mt-px h-3.5 w-3.5 shrink-0 text-[var(--brand-green)]" />
                  <span>{t('supportPointDev')}</span>
                </li>
                <li className="flex items-start gap-[0.5em]">
                  <Check className="mt-px h-3.5 w-3.5 shrink-0 text-[var(--brand-green)]" />
                  <span>{t('supportPointVoluntary')}</span>
                </li>
              </ul>
            </div>

            {/* 版本号留在这里：侧边栏那个位置换成了爱心图标，
                而用户反馈问题时最常截的就是侧边栏或这个弹窗，版本号不能彻底消失。 */}
            {version && (
              <p className="mt-[1.14em] text-center text-[0.71em] text-[var(--text-faint)] tabular-nums">
                LightC v{version}
              </p>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
