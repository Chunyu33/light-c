// ============================================================================
// 操作按钮组件 - 支持主题切换
// ============================================================================

import { Search, Trash2, Loader2, RefreshCw, CheckSquare, Square } from 'lucide-react';
import type { AppStatus } from '../types';

interface ActionButtonsProps {
  status: AppStatus;
  hasScanResult: boolean;
  selectedCount: number;
  totalCount: number;
  onScan: () => void;
  onDelete: () => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

export function ActionButtons({
  status,
  hasScanResult,
  selectedCount,
  totalCount,
  onScan,
  onDelete,
  onSelectAll,
  onDeselectAll,
}: ActionButtonsProps) {
  const isScanning = status === 'scanning';
  const isDeleting = status === 'deleting';
  const isBusy = isScanning || isDeleting;

  return (
    <div className="flex items-center gap-2">
      {/* 扫描按钮 */}
      <button
        onClick={onScan}
        disabled={isBusy}
        className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all
          ${isBusy
            ? 'bg-[var(--bg-hover)] text-[var(--fg-faint)] cursor-not-allowed'
            : 'bg-emerald-500 text-white hover:bg-emerald-600 active:bg-emerald-700'
          }`}
      >
        {isScanning ? (
          <><Loader2 className="w-4 h-4 animate-spin" /><span>扫描中...</span></>
        ) : (
          <>{hasScanResult ? <RefreshCw className="w-4 h-4" /> : <Search className="w-4 h-4" />}
            <span>{hasScanResult ? '重新扫描' : '开始扫描'}</span></>
        )}
      </button>

      {/* 删除按钮 */}
      {hasScanResult && (
        <button
          onClick={onDelete}
          disabled={isBusy || selectedCount === 0}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all
            ${isBusy || selectedCount === 0
              ? 'bg-[var(--bg-hover)] text-[var(--fg-faint)] cursor-not-allowed'
              : 'bg-red-500 text-white hover:bg-red-600 active:bg-red-700'
            }`}
        >
          {isDeleting ? (
            <><Loader2 className="w-4 h-4 animate-spin" /><span>清理中...</span></>
          ) : (
            <><Trash2 className="w-4 h-4" /><span>清理选中 ({selectedCount.toLocaleString()})</span></>
          )}
        </button>
      )}

      {/* 分隔线 */}
      {hasScanResult && totalCount > 0 && <div className="w-px h-6 bg-[var(--border-default)] mx-1" />}

      {/* 全选/取消全选 */}
      {hasScanResult && totalCount > 0 && (
        <>
          <button
            onClick={onSelectAll}
            disabled={isBusy || selectedCount === totalCount}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs transition-all
              ${isBusy || selectedCount === totalCount
                ? 'text-[var(--fg-faint)] cursor-not-allowed'
                : 'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-hover)]'
              }`}
          >
            <CheckSquare className="w-3.5 h-3.5" />
            <span>全选</span>
          </button>
          <button
            onClick={onDeselectAll}
            disabled={isBusy || selectedCount === 0}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs transition-all
              ${isBusy || selectedCount === 0
                ? 'text-[var(--fg-faint)] cursor-not-allowed'
                : 'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-hover)]'
              }`}
          >
            <Square className="w-3.5 h-3.5" />
            <span>取消全选</span>
          </button>
        </>
      )}
    </div>
  );
}
