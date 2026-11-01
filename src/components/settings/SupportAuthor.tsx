// ============================================================================
// 支持作者组件（设置 - 意见反馈 里的卡片）
//
// 卡片本身只负责"摆出赞赏码 + 切换"，点开后的放大视图由 `SupportModal` 提供。
// 侧边栏的爱心图标用的是同一个弹窗，二维码与切换逻辑只有一份。
// ============================================================================

import { useState } from 'react';
import { Check, Coffee } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import wechatQr from '../../assets/r_wechat_qr.jpg';
import alipayQr from '../../assets/r_alipay_qr.jpg';
import { PAYMENT_OPTIONS, SupportModal, type PaymentType } from '../SupportModal';

/**
 * 卡片里赞赏码的展示尺寸（像素）。
 * 项目根字号被字号设置改成 14px，Tailwind 的 rem 尺寸会等比缩小（w-32 实际只有 112px），
 * 二维码缩到 96px 后将无法识别，因此这里用不随字号变化的像素值固定尺寸。
 */
const QR_DISPLAY_SIZE = 176;

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

  const qrAlt = paymentType === 'wechat' ? t('wechatQr') : t('alipayQr');
  const qrSrc = paymentType === 'wechat' ? wechatQr : alipayQr;

  return (
    <>
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Coffee className="w-3.5 h-3.5" />
          {t('supportTitle')}
        </h4>
        <div className="glass-block @container bg-[var(--bg-main)] rounded-2xl p-5">
          {/* 左右两列：左列是赞赏码与支付方式切换（同属"扫码支持"这一件事），右列只放文案。
              这里用容器查询而不是视口断点：设置弹窗只占视口 76%，右侧内容区更窄，
              按视口宽度判断会在中等窗口下把文案压成一列几个字。 */}
          <div className="flex flex-col @[24rem]:flex-row items-center @[24rem]:items-start gap-5">
            {/* 左列：赞赏码、扫描提示、支付方式切换 */}
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
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-black/60 text-white text-[0.71rem] px-2 py-1 rounded-full">
                    {t('zoom')}
                  </div>
                </div>
              </div>
              <p className="text-[0.71rem] text-[var(--text-faint)] text-center mt-2">
                {t('supportQrHint')}
              </p>

              {/* 支付方式切换：跟赞赏码同列，切换结果直接作用在上方图片上 */}
              <div className="mt-3 inline-flex bg-[var(--bg-card)] rounded-xl p-1 border border-[var(--border-color)]">
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
        </div>
      </div>

      {/* 放大视图：与侧边栏爱心图标共用同一个弹窗组件。
          把卡片上当前选中的支付方式带过去，否则弹窗会停在微信，让人以为切换没生效。 */}
      <SupportModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        initialPayment={paymentType}
      />
    </>
  );
}
