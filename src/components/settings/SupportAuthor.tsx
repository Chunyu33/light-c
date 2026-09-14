// ============================================================================
// 支持作者组件
// 赞赏码切换和放大预览独立维护，避免反馈页与关于页形成组件耦合。
// ============================================================================

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Coffee, X } from 'lucide-react';
import wechatQr from '../../assets/r_wechat_qr.jpg';
import alipayQr from '../../assets/r_alipay_qr.jpg';
import { MODAL_BACKDROP_MOTION, MODAL_CARD_MOTION } from '../../utils/modalMotion';
import { useTranslation } from 'react-i18next';

type PaymentType = 'wechat' | 'alipay';

/**
 * 赞赏码展示尺寸（像素）。
 * 项目根字号被字号设置改成 14px，Tailwind 的 rem 尺寸会等比缩小（w-32 实际只有 112px），
 * 二维码缩到 96px 后将无法识别，因此这里用不随字号变化的像素值固定尺寸。
 */
const QR_DISPLAY_SIZE = 176;

/** 支付方式元数据：颜色与文案只在这里定义，普通视图和放大视图共用，避免两处写法不一致 */
const PAYMENT_OPTIONS: { type: PaymentType; activeClass: string; labelKey: string }[] = [
  { type: 'wechat', activeClass: 'bg-[#07C160]', labelKey: 'wechat' },
  { type: 'alipay', activeClass: 'bg-[#1677FF]', labelKey: 'alipay' },
];

export function SupportAuthor() {
  const { t } = useTranslation('common');
  const [paymentType, setPaymentType] = useState<PaymentType>('wechat');
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // 切换支付方式时先淡出再换图：直接换 src 会瞬间跳变，观感生硬
  const handlePaymentChange = (type: PaymentType) => {
    if (type === paymentType) return;
    setIsTransitioning(true);
    setTimeout(() => {
      setPaymentType(type);
      setIsTransitioning(false);
    }, 150);
  };

  // ESC 键关闭放大视图
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsModalOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const qrAlt = paymentType === 'wechat' ? t('wechatQr') : t('alipayQr');
  const qrSrc = paymentType === 'wechat' ? wechatQr : alipayQr;

  return (
    <>
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Coffee className="w-3.5 h-3.5" />
          {t('supportTitle')}
        </h4>
        <div className="@container bg-[var(--bg-main)] rounded-2xl p-5">
          {/* 左右布局：左侧赞赏码、右侧文案。
              这里用容器查询而不是视口断点：设置弹窗只占视口 76%，右侧内容区更窄，
              按视口宽度判断会在中等窗口下把文案压成一列几个字。 */}
          <div className="flex flex-col @[24rem]:flex-row items-center @[24rem]:items-start gap-5">
            {/* 左列：赞赏码 + 扫描提示 */}
            <div className="flex flex-col items-center shrink-0">
              <div
                onClick={() => setIsModalOpen(true)}
                style={{ width: QR_DISPLAY_SIZE, height: QR_DISPLAY_SIZE }}
                className="relative rounded-xl border border-[var(--border-color)] overflow-hidden bg-white cursor-pointer hover:shadow-lg hover:border-[var(--brand-green)] transition-all duration-200 group"
              >
                <img
                  src={qrSrc}
                  alt={qrAlt}
                  className={`w-full h-full object-contain transition-opacity duration-150 ${isTransitioning ? 'opacity-0' : 'opacity-100'}`}
                />
                {/* 悬停放大提示 */}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-200 flex items-center justify-center">
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-black/60 text-white text-[10px] px-2 py-1 rounded-full">
                    {t('zoom')}
                  </div>
                </div>
              </div>
              <p className="text-[10px] text-[var(--text-faint)] text-center mt-2">
                {t('supportQrHint')}
              </p>
            </div>

            {/* 右列：说明文案 + 支持要点 */}
            <div className="min-w-0 flex-1 space-y-3">
              <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
                {t('supportDesc')}
              </p>
              <ul className="space-y-1.5 text-xs text-[var(--text-muted)]">
                <li className="flex items-start gap-1.5">
                  <Check className="w-3.5 h-3.5 mt-px shrink-0 text-[var(--brand-green)]" />
                  <span>{t('supportPointDev')}</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <Check className="w-3.5 h-3.5 mt-px shrink-0 text-[var(--brand-green)]" />
                  <span>{t('supportPointVoluntary')}</span>
                </li>
              </ul>
            </div>
          </div>

          {/* 支付方式切换：独占一行，按钮不会被窄列挤变形 */}
          <div className="flex justify-center mt-4">
            <div className="inline-flex bg-[var(--bg-card)] rounded-xl p-1 border border-[var(--border-color)]">
              {PAYMENT_OPTIONS.map((option) => (
                <button
                  key={option.type}
                  onClick={() => handlePaymentChange(option.type)}
                  className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${
                    paymentType === option.type
                      ? `${option.activeClass} text-white shadow-sm`
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 放大视图 - 与项目其他弹窗共用同一套动效预设 */}
      {createPortal(
        <AnimatePresence>
          {isModalOpen && (
            <motion.div
              {...MODAL_BACKDROP_MOTION}
              className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm"
              onClick={() => setIsModalOpen(false)}
            >
              <motion.div
                {...MODAL_CARD_MOTION}
                className="relative bg-white rounded-2xl shadow-2xl p-4"
                onClick={(event) => event.stopPropagation()}
              >
                {/* 关闭按钮 */}
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="absolute -top-2 -right-2 w-8 h-8 bg-[var(--bg-card)] rounded-full shadow-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors z-10"
                >
                  <X className="w-4 h-4" />
                </button>

                {/* 高清大图 */}
                <img src={qrSrc} alt={qrAlt} className="w-72 h-72 object-contain" />

                {/* 底部切换 */}
                <div className="flex justify-center mt-4">
                  <div className="inline-flex bg-gray-100 rounded-xl p-1">
                    {PAYMENT_OPTIONS.map((option) => (
                      <button
                        key={option.type}
                        onClick={() => handlePaymentChange(option.type)}
                        className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${
                          paymentType === option.type
                            ? `${option.activeClass} text-white shadow-sm`
                            : 'text-gray-500 hover:text-gray-700'
                        }`}
                      >
                        {t(option.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
