// ============================================================================
// 错误提示组件 - 支持主题切换
// ============================================================================

import { AlertCircle, X } from 'lucide-react';

interface ErrorAlertProps {
  message: string;
  onClose: () => void;
}

export function ErrorAlert({ message, onClose }: ErrorAlertProps) {
  return (
    <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-3">
      <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-red-600 dark:text-red-400 truncate">{message}</p>
      </div>
      <button
        onClick={onClose}
        className="text-red-400 hover:text-red-500 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
