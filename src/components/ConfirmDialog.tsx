// ============================================================================
// 确认对话框组件 - 用于清理前的二次确认
// ============================================================================

import { memo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ConfirmDialogProps {
  /** 是否显示 */
  isOpen: boolean;
  /** 标题 */
  title: string;
  /** 描述信息 */
  description: string;
  /** 警告信息（可选） */
  warning?: string;
  /** 确认按钮文字 */
  confirmText?: string;
  /** 取消按钮文字 */
  cancelText?: string;
  /** 确认回调 */
  onConfirm: () => void;
  /** 取消回调 */
  onCancel: () => void;
  /** 是否为危险操作 */
  isDanger?: boolean;
}

export const ConfirmDialog = memo(function ConfirmDialog({
  isOpen,
  title,
  description,
  warning,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  isDanger = false,
}: ConfirmDialogProps) {
  const { t } = useTranslation('common');
  // 仅对未指定的按钮使用全局翻译，业务模块仍可提供更具体的操作文案。
  const resolvedConfirmText = confirmText ?? t('confirm');
  const resolvedCancelText = cancelText ?? t('cancel');
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
      const timer = setTimeout(() => {
        setIsAnimating(false);
      }, 190);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!isOpen && !isAnimating) return null;

  return createPortal(
    // 确认弹窗需要压过设置页和模块详情弹窗，避免危险操作确认被父级弹窗遮住。
    <div className="fixed inset-0 z-[10050] flex items-center justify-center">
      {/* 遮罩层 */}
      <div 
        className={`absolute inset-0 bg-black/50 backdrop-blur-sm ${isVisible ? 'modal-overlay-in' : enteredRef.current ? 'modal-overlay-out' : 'opacity-0'}`}
        onClick={onCancel}
      />
      
      {/* 对话框 */}
      {/* 对话框：宽度用 em 跟随全局字号，30em ≈ 标准字号下的 420px */}
      <div className={`relative bg-[var(--bg-elevated)] rounded-xl shadow-2xl border border-[var(--border-default)] w-[30em] max-w-[calc(100vw-2em)] overflow-hidden ${isVisible ? 'modal-content-in' : enteredRef.current ? 'modal-content-out' : 'opacity-0'}`}>
        {/* 头部 */}
        <div className="flex items-center justify-between px-[1.43em] py-[1.14em] border-b border-[var(--border-default)]">
          <div className="flex items-center gap-[0.86em]">
            <div className={`w-[2.86em] h-[2.86em] rounded-full flex items-center justify-center ${
              isDanger ? 'bg-amber-500/15' : 'bg-emerald-500/15'
            }`}>
              <AlertTriangle className={`w-[1.43em] h-[1.43em] ${
                isDanger ? 'text-amber-500' : 'text-emerald-500'
              }`} />
            </div>
            <h3 className="text-[1.14em] font-semibold text-[var(--fg-primary)]">
              {title}
            </h3>
          </div>
          <button
            onClick={onCancel}
            className="p-[0.43em] rounded-lg text-[var(--fg-muted)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <X className="w-[1.14em] h-[1.14em]" />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-[1.43em] py-[1.14em] space-y-[1.14em]">
          <p className="text-[1em] text-[var(--fg-secondary)] leading-relaxed">
            {description}
          </p>
          
          {warning && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-[0.86em]">
              <p className="text-[0.86em] text-amber-600 dark:text-amber-400 leading-relaxed break-words whitespace-pre-wrap">
                {warning}
              </p>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-[0.86em] px-[1.43em] py-[1.14em] border-t border-[var(--border-default)] bg-[var(--bg-card)]">
          <button
            onClick={onCancel}
            className="px-[1.14em] py-[0.57em] rounded-lg text-[1em] font-medium text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            {resolvedCancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`px-[1.14em] py-[0.57em] rounded-lg text-[1em] font-medium text-white transition-all ${
              isDanger
                ? 'bg-gradient-to-r from-rose-500 to-red-500 hover:from-rose-600 hover:to-red-600 shadow-lg shadow-rose-500/25'
                : 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 shadow-lg shadow-emerald-500/25'
            }`}
          >
            {resolvedConfirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
});
