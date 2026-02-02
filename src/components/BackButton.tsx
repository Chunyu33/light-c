// ============================================================================
// 返回按钮组件 - 统一的返回首页按钮
// 固定定位在功能页右上角
// ============================================================================

import { ArrowLeft } from 'lucide-react';

interface BackButtonProps {
  /** 点击回调 */
  onClick: () => void;
  /** 按钮文字，默认"返回首页" */
  label?: string;
}

/**
 * 统一的返回按钮组件
 * 固定定位在页面右上角
 */
export function BackButton({ onClick, label = '返回首页' }: BackButtonProps) {
  return (
    <button
      onClick={onClick}
      className="fixed top-20 right-6 z-40 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 bg-emerald-500/10 hover:bg-emerald-500/15 px-3 py-1.5 rounded-full transition shadow-sm border border-emerald-500/20"
    >
      <ArrowLeft className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

export default BackButton;
