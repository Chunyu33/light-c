// ============================================================================
// 支持作者组件
// 赞赏码切换和放大预览独立维护，避免反馈页与关于页形成组件耦合。
// ============================================================================

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Coffee, X } from 'lucide-react';
import wechatQr from '../../assets/r_wechat_qr.jpg';
import alipayQr from '../../assets/r_alipay_qr.jpg';

type PaymentType = 'wechat' | 'alipay';

export function SupportAuthor() {
  const [paymentType, setPaymentType] = useState<PaymentType>('wechat');
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);

  // 切换支付方式时的淡入淡出动画
  const handlePaymentChange = (type: PaymentType) => {
    if (type === paymentType) return;
    setIsTransitioning(true);
    setTimeout(() => {
      setPaymentType(type);
      setIsTransitioning(false);
    }, 150);
  };

  // 打开放大 Modal
  const openModal = () => {
    setShowModal(true);
    requestAnimationFrame(() => setModalVisible(true));
  };

  // 关闭放大 Modal
  const closeModal = () => {
    setModalVisible(false);
    setTimeout(() => setShowModal(false), 200);
  };

  // ESC 键关闭 Modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showModal) {
        closeModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showModal]);

  return (
    <>
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Coffee className="w-3.5 h-3.5" />
          支持作者
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5">
          {/* 文案说明 */}
          <p className="text-sm text-[var(--text-secondary)] text-center mb-4">
            维护不易，如果软件对您有帮助，请我吃个猪脚饭~（自愿原则）
          </p>

          {/* 赞赏码图片 - 可点击放大 */}
          <div className="flex justify-center mb-2">
            <div
              onClick={openModal}
              className="relative w-36 h-36 rounded-xl border border-[var(--border-color)] overflow-hidden bg-white p-2 cursor-pointer hover:shadow-lg hover:border-[var(--brand-green)] transition-all duration-200 group"
            >
              <img
                src={paymentType === 'wechat' ? wechatQr : alipayQr}
                alt={paymentType === 'wechat' ? '微信赞赏码' : '支付宝赞赏码'}
                className={`w-full h-full object-contain transition-opacity duration-150 ${isTransitioning ? 'opacity-0' : 'opacity-100'
                  }`}
              />
              {/* 悬浮放大提示 */}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-200 flex items-center justify-center">
                <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-black/60 text-white text-[10px] px-2 py-1 rounded-full">
                  点击放大
                </div>
              </div>
            </div>
          </div>

          {/* 点击提示文字 */}
          <p className="text-[10px] text-[var(--text-faint)] text-center mb-3">
            点击图片可放大扫描
          </p>

          {/* Segmented Control 切换开关 */}
          <div className="flex justify-center">
            <div className="inline-flex bg-[var(--bg-card)] rounded-xl p-1 border border-[var(--border-color)]">
              <button
                onClick={() => handlePaymentChange('wechat')}
                className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${paymentType === 'wechat'
                    ? 'bg-[#07C160] text-white shadow-sm'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
              >
                微信
              </button>
              <button
                onClick={() => handlePaymentChange('alipay')}
                className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${paymentType === 'alipay'
                    ? 'bg-[#1677FF] text-white shadow-sm'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
              >
                支付宝
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 放大 Modal - 半透明磨砂背景 */}
      {showModal && createPortal(
        <div
          className={`fixed inset-0 z-[10000] flex items-center justify-center transition-all duration-200 ${modalVisible ? 'bg-black/50 backdrop-blur-sm' : 'bg-transparent'
            }`}
          onClick={closeModal}
        >
          <div
            className={`relative bg-white rounded-2xl shadow-2xl p-4 transition-all duration-200 ${modalVisible ? 'scale-100 opacity-100' : 'scale-90 opacity-0'
              }`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 关闭按钮 */}
            <button
              onClick={closeModal}
              className="absolute -top-2 -right-2 w-8 h-8 bg-[var(--bg-card)] rounded-full shadow-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors z-10"
            >
              <X className="w-4 h-4" />
            </button>

            {/* 高清大图 */}
            <img
              src={paymentType === 'wechat' ? wechatQr : alipayQr}
              alt={paymentType === 'wechat' ? '微信赞赏码' : '支付宝赞赏码'}
              className="w-72 h-72 object-contain"
            />

            {/* 底部切换 */}
            <div className="flex justify-center mt-4">
              <div className="inline-flex bg-gray-100 rounded-xl p-1">
                <button
                  onClick={() => handlePaymentChange('wechat')}
                  className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${paymentType === 'wechat'
                      ? 'bg-[#07C160] text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                    }`}
                >
                  微信
                </button>
                <button
                  onClick={() => handlePaymentChange('alipay')}
                  className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${paymentType === 'alipay'
                      ? 'bg-[#1677FF] text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                    }`}
                >
                  支付宝
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}


