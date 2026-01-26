// ============================================================================
// 操作按钮组件 - 现代化设计风格
// 特点：渐变背景、发光效果、流畅动画
// ============================================================================

import { memo } from 'react';
import { Trash2, Loader2, RefreshCw, CheckSquare, Square, Sparkles, HardDrive } from 'lucide-react';
import type { AppStatus } from '../types';
import { openDiskCleanup } from '../api/commands';

// ============================================================================
// 类型定义
// ============================================================================

interface ActionButtonsProps {
  /** 当前应用状态 */
  status: AppStatus;
  /** 是否有扫描结果 */
  hasScanResult: boolean;
  /** 已选中的文件数量 */
  selectedCount: number;
  /** 总文件数量 */
  totalCount: number;
  /** 扫描回调 */
  onScan: () => void;
  /** 删除回调 */
  onDelete: () => void;
  /** 全选回调 */
  onSelectAll: () => void;
  /** 取消全选回调 */
  onDeselectAll: () => void;
}

// ============================================================================
// 主按钮组件 - 带渐变和发光效果
// ============================================================================

interface PrimaryButtonProps {
  onClick: () => void;
  disabled: boolean;
  variant: 'scan' | 'delete';
  isLoading: boolean;
  children: React.ReactNode;
}

const PrimaryButton = memo(function PrimaryButton({
  onClick,
  disabled,
  variant,
  isLoading,
  children,
}: PrimaryButtonProps) {
  // 根据变体选择颜色方案
  const colorScheme = {
    scan: {
      gradient: 'from-emerald-500 via-teal-500 to-emerald-600',
      glow: 'shadow-emerald-500/30',
      hoverGlow: 'hover:shadow-emerald-500/50',
      ring: 'focus:ring-emerald-500/50',
    },
    delete: {
      gradient: 'from-rose-500 via-red-500 to-rose-600',
      glow: 'shadow-rose-500/30',
      hoverGlow: 'hover:shadow-rose-500/50',
      ring: 'focus:ring-rose-500/50',
    },
  }[variant];

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        relative group flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold
        transition-all duration-300 ease-out
        focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[var(--bg-elevated)]
        ${disabled
          ? 'bg-[var(--bg-hover)] text-[var(--fg-faint)] cursor-not-allowed shadow-none'
          : `
            bg-gradient-to-r ${colorScheme.gradient}
            text-white
            shadow-lg ${colorScheme.glow}
            ${colorScheme.hoverGlow}
            hover:shadow-xl hover:-translate-y-0.5
            active:translate-y-0 active:shadow-md
            ${colorScheme.ring}
            ${isLoading ? '' : 'animate-gradient'}
          `
        }
      `}
    >
      {/* 按钮内容 */}
      <span className="relative z-10 flex items-center gap-2">
        {children}
      </span>
      
      {/* 悬停时的光晕效果 */}
      {!disabled && (
        <span className="absolute inset-0 rounded-lg bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
      )}
    </button>
  );
});

// ============================================================================
// 次要按钮组件 - 轻量级样式
// ============================================================================

interface SecondaryButtonProps {
  onClick: () => void;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
}

const SecondaryButton = memo(function SecondaryButton({
  onClick,
  disabled,
  icon,
  label,
}: SecondaryButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium
        transition-all duration-200
        ${disabled
          ? 'text-[var(--fg-faint)] cursor-not-allowed'
          : `
            text-[var(--fg-secondary)]
            hover:text-emerald-500 hover:bg-emerald-500/10
            active:bg-emerald-500/20
          `
        }
      `}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
});

// ============================================================================
// 主组件
// ============================================================================

export const ActionButtons = memo(function ActionButtons({
  status,
  hasScanResult,
  selectedCount,
  totalCount,
  onScan,
  onDelete,
  onSelectAll,
  onDeselectAll,
}: ActionButtonsProps) {
  // 状态判断
  const isScanning = status === 'scanning';
  const isDeleting = status === 'deleting';
  const isBusy = isScanning || isDeleting;
  const hasSelection = selectedCount > 0;
  const isAllSelected = selectedCount === totalCount && totalCount > 0;

  return (
    <div className="flex items-center gap-3">
      {/* ========== 扫描按钮 ========== */}
      <PrimaryButton
        onClick={onScan}
        disabled={isBusy}
        variant="scan"
        isLoading={isScanning}
      >
        {isScanning ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>扫描中...</span>
          </>
        ) : (
          <>
            {hasScanResult ? (
              <RefreshCw className="w-4 h-4" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            <span>{hasScanResult ? '重新扫描' : '开始扫描'}</span>
          </>
        )}
      </PrimaryButton>

      {/* ========== 清理按钮 ========== */}
      {hasScanResult && (
        <PrimaryButton
          onClick={onDelete}
          disabled={isBusy || !hasSelection}
          variant="delete"
          isLoading={isDeleting}
        >
          {isDeleting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>清理中...</span>
            </>
          ) : (
            <>
              <Trash2 className="w-4 h-4" />
              <span>清理选中 ({selectedCount.toLocaleString()})</span>
            </>
          )}
        </PrimaryButton>
      )}

      {/* ========== 分隔线 ========== */}
      {hasScanResult && totalCount > 0 && (
        <div className="w-px h-7 bg-[var(--border-default)] mx-1" />
      )}

      {/* ========== 全选/取消全选 ========== */}
      {hasScanResult && totalCount > 0 && (
        <div className="flex items-center gap-1">
          <SecondaryButton
            onClick={onSelectAll}
            disabled={isBusy || isAllSelected}
            icon={<CheckSquare className="w-3.5 h-3.5" />}
            label="全选"
          />
          <SecondaryButton
            onClick={onDeselectAll}
            disabled={isBusy || !hasSelection}
            icon={<Square className="w-3.5 h-3.5" />}
            label="取消全选"
          />
        </div>
      )}

      {/* ========== 分隔线 ========== */}
      <div className="w-px h-7 bg-[var(--border-default)] mx-1" />

      {/* ========== 系统磁盘清理 ========== */}
      <SecondaryButton
        onClick={() => openDiskCleanup()}
        disabled={isBusy}
        icon={<HardDrive className="w-3.5 h-3.5" />}
        label="系统清理"
      />
    </div>
  );
});
