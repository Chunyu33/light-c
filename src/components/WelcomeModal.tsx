// ============================================================================
// 欢迎弹窗组件
// 首次使用时显示欢迎信息，支持"不再显示"选项
// ============================================================================

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Shield, Zap, Heart } from 'lucide-react';

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
  // 用户名称（留空则显示通用欢迎语）
  userName: '',
  // 欢迎标题
  title: '欢迎使用 LightC',
  // 欢迎语（支持多行）
  messages: [
    '感谢您选择 LightC！',
    '这是一款专为 Windows 用户打造的 C 盘清理工具，',
    '帮助您轻松释放磁盘空间，让系统运行更流畅。',
  ],
  // 功能亮点
  features: [
    { icon: Shield, text: '安全可靠', desc: '智能识别垃圾文件，保护系统安全' },
    { icon: Zap, text: '高效清理', desc: '一键扫描，快速释放磁盘空间' },
    { icon: Heart, text: '简洁易用', desc: '清爽界面，操作简单直观' },
  ],
};

const STORAGE_KEY = 'lightc_welcome_dismissed';

export function WelcomeModal({ isOpen, onClose }: WelcomeModalProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsAnimating(true);
    }
  }, [isOpen]);

  const handleClose = () => {
    if (dontShowAgain) {
      localStorage.setItem(STORAGE_KEY, 'true');
    }
    setIsAnimating(false);
    setTimeout(onClose, 200);
  };

  if (!isOpen) return null;

  const { userName, title, messages, features } = WELCOME_CONFIG;

  return createPortal(
    <div 
      className={`fixed inset-0 z-[9999] flex items-center justify-center transition-all duration-300 ${
        isAnimating ? 'bg-black/50 backdrop-blur-sm' : 'bg-transparent'
      }`}
      onClick={handleClose}
    >
      <div 
        className={`relative bg-[var(--bg-card)] rounded-3xl shadow-2xl max-w-md w-full mx-4 transition-all duration-300 ${
          isAnimating ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部渐变区域 - 包含图标和标题 */}
        <div className="relative bg-gradient-to-br from-rose-500 via-pink-500 to-fuchsia-500 rounded-t-3xl px-6 pt-8 pb-12">
          {/* 动态粒子效果 */}
          <div className="absolute inset-0 overflow-hidden rounded-t-3xl">
            {[...Array(6)].map((_, i) => (
              <div
                key={i}
                className="absolute w-2 h-2 bg-white/20 rounded-full animate-float"
                style={{
                  left: `${15 + i * 14}%`,
                  top: `${20 + (i % 3) * 25}%`,
                  animationDelay: `${i * 0.4}s`,
                  animationDuration: `${2.5 + i * 0.3}s`,
                }}
              />
            ))}
          </div>

          {/* 关闭按钮 */}
          <button
            onClick={handleClose}
            className="absolute top-4 right-4 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>

          {/* 图标 - 在渐变区域内 */}
          <div className="flex justify-center mb-4">
            <div className="w-16 h-16 bg-white rounded-2xl shadow-lg flex items-center justify-center">
              <Heart className="w-8 h-8 text-rose-500" />
            </div>
          </div>

          {/* 标题 - 在渐变区域内，白色文字 */}
          <h2 className="text-center text-2xl font-bold text-white">
            {userName ? `${userName}，${title}` : title}
          </h2>
        </div>

        {/* 白色内容区域 */}
        <div className="px-6 py-6">
          {/* 欢迎语 */}
          <div className="text-center mb-6 space-y-1">
            {messages.map((msg, i) => (
              <p key={i} className="text-sm text-[var(--fg-secondary)] leading-relaxed">
                {msg}
              </p>
            ))}
          </div>

          {/* 功能亮点 */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            {features.map((feature, i) => (
              <div
                key={i}
                className="flex flex-col items-center p-3 rounded-2xl bg-gradient-to-b from-rose-500/5 to-transparent hover:from-rose-500/12 transition-colors group"
              >
                <div className="w-10 h-10 rounded-full bg-rose-500/12 group-hover:bg-rose-500/22 flex items-center justify-center mb-2 transition-colors">
                  <feature.icon className="w-5 h-5 text-rose-500" />
                </div>
                <span className="text-xs font-semibold text-[var(--fg-primary)]">{feature.text}</span>
                <span className="text-[10px] text-[var(--fg-muted)] text-center mt-0.5">{feature.desc}</span>
              </div>
            ))}
          </div>

          {/* 分隔线 */}
          <div className="border-t border-[var(--border-default)] my-3" />

          {/* 底部操作区 */}
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
                className="w-4 h-4 rounded border-[var(--border-default)] text-emerald-500 focus:ring-emerald-500 focus:ring-offset-0"
              />
              <span className="text-xs text-[var(--fg-muted)]">不再显示</span>
            </label>
            <button
              onClick={handleClose}
              className="px-6 py-2.5 bg-gradient-to-r from-rose-500 via-pink-500 to-fuchsia-500 text-white text-sm font-semibold rounded-full hover:from-rose-600 hover:via-pink-600 hover:to-fuchsia-600 transition-all shadow-md hover:shadow-lg"
            >
              开始使用
            </button>
          </div>
        </div>
      </div>

      {/* 浮动动画样式 */}
      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0) scale(1); opacity: 0.3; }
          50% { transform: translateY(-10px) scale(1.2); opacity: 0.6; }
        }
        .animate-float {
          animation: float 3s ease-in-out infinite;
        }
      `}</style>
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
