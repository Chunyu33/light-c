// ============================================================================
// 欢迎弹窗组件 - 简约圆角风格
// 首次使用时显示欢迎信息，支持"不再显示"选项
// 核心价值：轻量、安全、高效清理
// ============================================================================

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Shield, Zap, Sparkles } from 'lucide-react';

interface WelcomeModalProps {
  /** 是否显示弹窗 */
  isOpen: boolean;
  /** 关闭弹窗回调 */
  onClose: () => void;
}

// ============================================================================
// 可定制区域 - 修改以下内容来定制欢迎信息
// ============================================================================
const WELCOME_CONFIG = {
  // 欢迎标题
  title: '欢迎使用 LightC',
  // 欢迎语
  subtitle: '轻量 · 安全 · 高效',
  // 描述文案
  description: '专为 Windows 用户打造的智能 C 盘清理工具，帮助您轻松释放磁盘空间，让系统运行更流畅。',
  // 功能亮点 - 体现核心价值
  features: [
    { icon: Sparkles, text: '轻量极速', desc: '小巧无广告，启动即用' },
    { icon: Shield, text: '安全可靠', desc: '智能识别，保护系统' },
    { icon: Zap, text: '高效清理', desc: '一键扫描，快速释放' },
  ],
};

const STORAGE_KEY = 'lightc_welcome_dismissed';

export function WelcomeModal({ isOpen, onClose }: WelcomeModalProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isButtonPressed, setIsButtonPressed] = useState(false);
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

  // 开始使用按钮点击 - 带缩放动画
  const handleStart = () => {
    setIsButtonPressed(true);
    setTimeout(() => {
      setIsButtonPressed(false);
      handleClose();
    }, 150);
  };

  if (!isOpen && !isAnimating) return null;

  const { title, subtitle, description, features } = WELCOME_CONFIG;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div 
        className={`absolute inset-0 bg-black/40 backdrop-blur-sm ${isVisible ? 'modal-overlay-in' : enteredRef.current ? 'modal-overlay-out' : 'opacity-0'}`}
        onClick={handleClose}
      />
      <div 
        className={`relative bg-[var(--bg-card)] rounded-2xl shadow-2xl max-w-sm w-full mx-4 overflow-hidden ${isVisible ? 'modal-content-in' : enteredRef.current ? 'modal-content-out' : 'opacity-0'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部渐变装饰条 */}
        <div className="h-1 bg-gradient-to-r from-[var(--brand-green)] via-emerald-400 to-teal-400" />

        {/* 关闭按钮 */}
        <button
          onClick={handleClose}
          className="absolute top-3 right-3 z-10 w-7 h-7 flex items-center justify-center rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        {/* 内容区域 */}
        <div className="px-6 pt-6 pb-5">
          {/* Logo 图标 */}
          <div className="flex justify-center mb-4">
            <div className="w-14 h-14 bg-[var(--brand-green)] rounded-2xl shadow-lg shadow-[var(--brand-green)]/20 flex items-center justify-center">
              <span className="text-xl font-bold text-white">C:</span>
            </div>
          </div>

          {/* 标题 */}
          <h2 className="text-center text-xl font-bold text-[var(--text-primary)] mb-1">
            {title}
          </h2>
          
          {/* 副标题 - 核心价值 */}
          <p className="text-center text-sm font-medium text-[var(--brand-green)] mb-3">
            {subtitle}
          </p>

          {/* 描述 */}
          <p className="text-center text-sm text-[var(--text-muted)] leading-relaxed mb-5">
            {description}
          </p>

          {/* 功能亮点 - 简约卡片风格 */}
          <div className="grid grid-cols-3 gap-2 mb-5">
            {features.map((feature, i) => (
              <div
                key={i}
                className="flex flex-col items-center p-3 rounded-xl bg-[var(--bg-main)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <div className="w-9 h-9 rounded-xl bg-[var(--brand-green)]/10 flex items-center justify-center mb-2">
                  <feature.icon className="w-4 h-4 text-[var(--brand-green)]" />
                </div>
                <span className="text-xs font-medium text-[var(--text-primary)]">{feature.text}</span>
                <span className="text-[10px] text-[var(--text-faint)] text-center mt-0.5 leading-tight">{feature.desc}</span>
              </div>
            ))}
          </div>

          {/* 底部操作区 */}
          <div className="flex items-center justify-between pt-3 border-t border-[var(--border-color)]">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-[var(--border-color)] text-[var(--brand-green)] focus:ring-[var(--brand-green)] focus:ring-offset-0 cursor-pointer"
              />
              <span className="text-xs text-[var(--text-muted)]">不再显示</span>
            </label>
            <button
              onClick={handleStart}
              className={`px-5 py-2 bg-[var(--brand-green)] text-white text-sm font-medium rounded-xl hover:bg-[var(--brand-green-hover)] transition-all shadow-md shadow-[var(--brand-green)]/20 ${
                isButtonPressed ? 'scale-95' : 'scale-100'
              }`}
            >
              开始使用
            </button>
          </div>
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
