// ============================================================================
// Toast 轻提示组件 - 全局通知系统
// 支持 success/error/warning/info 四种类型
// ============================================================================

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';

// ============================================================================
// 类型定义
// ============================================================================

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
  duration?: number;
}

interface ToastContextValue {
  toasts: ToastItem[];
  showToast: (toast: Omit<ToastItem, 'id'>) => void;
  hideToast: (id: string) => void;
}

// ============================================================================
// Context
// ============================================================================

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

// ============================================================================
// Provider
// ============================================================================

interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const newToast: ToastItem = { ...toast, id };
    
    setToasts((prev) => [...prev, newToast]);

    // 自动消失
    const duration = toast.duration ?? 4000;
    if (duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    }
  }, []);

  const hideToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, showToast, hideToast }}>
      {children}
      <ToastContainer toasts={toasts} onClose={hideToast} />
    </ToastContext.Provider>
  );
}

// ============================================================================
// Toast 容器
// ============================================================================

interface ToastContainerProps {
  toasts: ToastItem[];
  onClose: (id: string) => void;
}

function ToastContainer({ toasts, onClose }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 right-6 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <ToastItemComponent key={toast.id} toast={toast} onClose={() => onClose(toast.id)} />
      ))}
    </div>
  );
}

// ============================================================================
// 单个 Toast
// ============================================================================

interface ToastItemComponentProps {
  toast: ToastItem;
  onClose: () => void;
}

const iconMap = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const colorMap = {
  success: {
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/30',
    icon: 'text-emerald-500',
  },
  error: {
    bg: 'bg-rose-500/10',
    border: 'border-rose-500/30',
    icon: 'text-rose-500',
  },
  warning: {
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    icon: 'text-amber-500',
  },
  info: {
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/30',
    icon: 'text-blue-500',
  },
};

function ToastItemComponent({ toast, onClose }: ToastItemComponentProps) {
  const Icon = iconMap[toast.type];
  const colors = colorMap[toast.type];

  return (
    <div
      className={`
        ${colors.bg} ${colors.border}
        border rounded-xl p-4 shadow-lg backdrop-blur-sm
        animate-in slide-in-from-right-5 fade-in duration-300
        flex items-start gap-3
      `}
    >
      <Icon className={`w-5 h-5 ${colors.icon} shrink-0 mt-0.5`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--fg-primary)]">{toast.title}</p>
        {toast.description && (
          <p className="text-xs text-[var(--fg-muted)] mt-0.5">{toast.description}</p>
        )}
      </div>
      <button
        onClick={onClose}
        className="text-[var(--fg-muted)] hover:text-[var(--fg-primary)] transition shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export default ToastProvider;
