// ============================================================================
// 欢迎弹窗组件
// 首次使用时显示欢迎信息，支持"不再显示"选项。
//
// 视觉与尺寸都跟随全局设置：
// - 颜色用主题变量，深色模式自动适配；
// - 所有尺寸用 em，继承 :root 的 font-size（= --base-font-size + --font-size-offset），
//   因此用户调整字号时，弹窗的宽高与文字会与主界面同比例放大缩小。
// ============================================================================

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Shield, Zap, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from './ui/Checkbox';

interface WelcomeModalProps {
  /** 是否显示弹窗 */
  isOpen: boolean;
  /** 关闭弹窗回调 */
  onClose: () => void;
}

const STORAGE_KEY = 'lightc_welcome_dismissed';

export function WelcomeModal({ isOpen, onClose }: WelcomeModalProps) {
  const { t } = useTranslation('ui');
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const enteredRef = useRef(false);
  if (isVisible) enteredRef.current = true;

  useEffect(() => {
    if (isOpen) {
      setIsAnimating(true);
      setIsVisible(true);
    } else {
      setIsVisible(false);
      const timer = setTimeout(() => setIsAnimating(false), 280);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleClose = () => {
    if (dontShowAgain) {
      localStorage.setItem(STORAGE_KEY, 'true');
    }
    onClose();
  };

  if (!isOpen && !isAnimating) return null;

  const features = [
    { icon: Sparkles, text: t('welcomeLight'), desc: t('welcomeLightDesc') },
    { icon: Shield, text: t('welcomeSafe'), desc: t('welcomeSafeDesc') },
    { icon: Zap, text: t('welcomeFast'), desc: t('welcomeFastDesc') },
  ];

  return createPortal(
    // 内部尺寸统一用 em：body 已继承 :root 的字号，勾选/宽度会随全局字号一起缩放。
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div
        className={`absolute inset-0 bg-black/40 backdrop-blur-sm ${isVisible ? 'modal-overlay-in' : enteredRef.current ? 'modal-overlay-out' : 'opacity-0'}`}
        onClick={handleClose}
      />
      {/* 宽度随字号缩放：标准字号下约 400px，同时用 vw 上限兜住大字号的小窗口场景 */}
      <div
        className={`relative mx-[1em] w-[28.5em] max-w-[calc(100vw-2em)] overflow-hidden rounded-[0.86em] border border-[var(--border-default)] bg-[var(--bg-card)] shadow-2xl ${isVisible ? 'modal-content-in' : enteredRef.current ? 'modal-content-out' : 'opacity-0'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-[1.43em]">
          {/* 标题区：图标与标题同行，右侧固定关闭入口 */}
          <div className="flex items-start gap-[0.86em]">
            <div className="flex h-[3.14em] w-[3.14em] shrink-0 items-center justify-center rounded-[0.86em] bg-[var(--brand-green-10)]">
              <span className="text-[1.14em] font-bold text-[var(--brand-green)]">C:</span>
            </div>
            <div className="min-w-0 flex-1 pt-[0.14em]">
              <h2 className="text-[1.14em] font-semibold text-[var(--text-primary)]">
                {t('welcomeTitle')}
              </h2>
              <p className="mt-[0.14em] text-[0.86em] font-medium text-[var(--brand-green)]">
                {t('welcomeSubtitle')}
              </p>
            </div>
            <button
              onClick={handleClose}
              aria-label="close"
              className="-mr-[0.29em] -mt-[0.29em] flex h-[2em] w-[2em] shrink-0 items-center justify-center rounded-[0.57em] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <X className="h-[1.14em] w-[1.14em]" />
            </button>
          </div>

          {/* 描述 */}
          <p className="mt-[1.14em] text-[0.86em] leading-relaxed text-[var(--text-muted)]">
            {t('welcomeDescription')}
          </p>

          {/* 功能亮点：三行列表，用极淡分隔线区分，比并排卡片更贴近面板排版 */}
          <div className="mt-[1.14em] divide-y divide-[var(--border-color)] border-y border-[var(--border-color)]">
            {features.map((feature) => (
              <div key={feature.text} className="flex items-center gap-[0.86em] py-[0.71em]">
                <div className="flex h-[2.29em] w-[2.29em] shrink-0 items-center justify-center rounded-[0.57em] bg-[var(--brand-green-10)]">
                  <feature.icon className="h-[1.14em] w-[1.14em] text-[var(--brand-green)]" />
                </div>
                <div className="min-w-0">
                  <p className="text-[0.86em] font-semibold text-[var(--text-primary)]">
                    {feature.text}
                  </p>
                  <p className="mt-[0.14em] text-[0.79em] leading-tight text-[var(--text-faint)]">
                    {feature.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 底部操作区：复选框在左、主按钮在右，与设置类弹窗一致 */}
        <div className="flex items-center justify-between gap-[0.86em] border-t border-[var(--border-color)] bg-[var(--bg-main)] px-[1.43em] py-[0.86em]">
          <label className="flex cursor-pointer select-none items-center gap-[0.57em]">
            <Checkbox
              checked={dontShowAgain}
              onChange={setDontShowAgain}
            />
            <span className="text-[0.86em] text-[var(--text-muted)]">{t('welcomeDismiss')}</span>
          </label>
          <button
            onClick={handleClose}
            className="rounded-[0.57em] bg-[var(--brand-green)] px-[1.14em] py-[0.57em] text-[0.86em] font-semibold text-white transition-colors hover:bg-[var(--brand-green-hover)]"
          >
            {t('welcomeStart')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * 检查是否应该显示欢迎弹窗
 */
export function shouldShowWelcome(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== 'true';
}

/**
 * 重置欢迎弹窗状态（用于测试）
 */
export function resetWelcomeState(): void {
  localStorage.removeItem(STORAGE_KEY);
}
