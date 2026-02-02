// ============================================================================
// 垃圾清理页面组件
// 展示扫描结果和清理操作
// ============================================================================

import { Loader2, FolderSearch, FileText, HardDrive, Search, Trash2 } from 'lucide-react';
import {
  ScanSummary,
  CategoryCard,
  EmptyState,
  ConfirmDialog,
  BackButton,
} from '../components';
import { formatSize } from '../utils/format';
import type { ScanResult, DeleteResult, AppStatus, FileInfo } from '../types';

interface CleanupPageProps {
  /** 应用状态 */
  status: AppStatus;
  /** 扫描结果 */
  scanResult: ScanResult | null;
  /** 删除结果 */
  deleteResult: DeleteResult | null;
  /** 选中的文件路径 */
  selectedPaths: Set<string>;
  /** 选中文件的总大小 */
  selectedSize: number;
  /** 是否显示删除确认弹窗 */
  showDeleteConfirm: boolean;
  /** 设置删除确认弹窗显示状态 */
  setShowDeleteConfirm: (show: boolean) => void;
  /** 返回首页回调 */
  onBack: () => void;
  /** 开始扫描回调 */
  onScan: () => void;
  /** 开始删除回调 */
  onDelete: () => void;
  /** 全选回调 */
  onSelectAll: () => void;
  /** 取消全选回调 */
  onDeselectAll: () => void;
  /** 切换文件选中状态回调 */
  onToggleFile: (path: string) => void;
  /** 切换分类选中状态回调 */
  onToggleCategory: (files: FileInfo[], selected: boolean) => void;
  /** 清除删除结果回调 */
  onClearDeleteResult: () => void;
}

/** 清理页面工具栏组件 */
export function CleanupToolbar({
  status,
  scanResult,
  selectedPaths,
  setShowDeleteConfirm,
  onScan,
  onSelectAll,
  onDeselectAll,
}: Pick<
  CleanupPageProps,
  | 'status'
  | 'scanResult'
  | 'selectedPaths'
  | 'setShowDeleteConfirm'
  | 'onScan'
  | 'onSelectAll'
  | 'onDeselectAll'
>) {
  const isScanning = status === 'scanning';
  const hasResult = !!scanResult && scanResult.total_file_count > 0;

  return (
    <>
      {/* 顶部操作栏 */}
      <header className="bg-[var(--bg-elevated)] border-b border-[var(--border-default)] px-4 py-3 shrink-0">
        <div className="flex items-center justify-between">
          {/* 左侧：扫描按钮 */}
          <button
            onClick={onScan}
            disabled={isScanning}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all
              ${isScanning
                ? 'bg-emerald-500/20 text-emerald-600 cursor-not-allowed'
                : 'bg-emerald-500 text-white hover:bg-emerald-600 shadow-sm'
              }
            `}
          >
            {isScanning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                扫描中...
              </>
            ) : (
              <>
                <Search className="w-4 h-4" />
                {hasResult ? '重新扫描' : '开始扫描'}
              </>
            )}
          </button>

          {/* 右侧：选择和删除操作 */}
          {hasResult && (
            <div className="flex items-center gap-3">
              <button
                onClick={onSelectAll}
                className="text-xs text-[var(--fg-muted)] hover:text-emerald-600 transition"
              >
                全选
              </button>
              <button
                onClick={onDeselectAll}
                className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg-secondary)] transition"
              >
                取消全选
              </button>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                disabled={selectedPaths.size === 0}
                className={`
                  flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all
                  ${selectedPaths.size === 0
                    ? 'bg-[var(--bg-hover)] text-[var(--fg-faint)] cursor-not-allowed'
                    : 'bg-rose-500 text-white hover:bg-rose-600 shadow-sm'
                  }
                `}
              >
                <Trash2 className="w-4 h-4" />
                清理选中 ({selectedPaths.size.toLocaleString()})
              </button>
            </div>
          )}
        </div>

        {/* 扫描中状态 - 内联显示 */}
        {isScanning && (
          <div className="mt-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-emerald-500/20 rounded-lg flex items-center justify-center">
                <FolderSearch className="w-5 h-5 text-emerald-600 animate-pulse" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-[var(--fg-primary)]">正在扫描垃圾文件...</p>
                <p className="text-xs text-[var(--fg-muted)] mt-0.5">正在检索系统缓存、临时文件等</p>
              </div>
            </div>
            {/* 进度条动画 */}
            <div className="h-1.5 bg-emerald-500/20 rounded-full overflow-hidden">
              <div 
                className="h-full rounded-full"
                style={{ 
                  width: '100%',
                  background: 'linear-gradient(90deg, transparent, rgba(16, 185, 129, 0.6), transparent)',
                  backgroundSize: '200% 100%',
                  animation: 'shimmer 1.5s ease-in-out infinite'
                }} 
              />
            </div>
            {/* 统计信息 */}
            <div className="mt-3 flex items-center gap-4 text-xs text-[var(--fg-muted)]">
              <span className="flex items-center gap-1">
                <FileText className="w-3.5 h-3.5" />
                扫描中...
              </span>
              <span className="flex items-center gap-1">
                <HardDrive className="w-3.5 h-3.5" />
                计算大小...
              </span>
            </div>
          </div>
        )}
      </header>

      {/* shimmer 动画样式 */}
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </>
  );
}

/** 清理页面内容组件 */
export function CleanupPage({
  status,
  scanResult,
  deleteResult,
  selectedPaths,
  selectedSize,
  showDeleteConfirm,
  setShowDeleteConfirm,
  onBack,
  onDelete,
  onToggleFile,
  onToggleCategory,
  onClearDeleteResult,
}: Omit<CleanupPageProps, 'onScan' | 'onSelectAll' | 'onDeselectAll'>) {
  const isScanning = status === 'scanning';
  return (
    <>
      {/* 删除确认弹窗 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title="确认清理"
        description={`您即将删除 ${selectedPaths.size.toLocaleString()} 个文件，预计释放 ${formatSize(selectedSize)} 空间。此操作不可撤销。`}
        warning="免责声明：本软件仅清理常见的系统垃圾文件，但不对任何数据丢失承担责任。请确保您已了解所选文件的内容，重要数据请提前备份。"
        confirmText="确认清理"
        cancelText="取消"
        onConfirm={() => {
          setShowDeleteConfirm(false);
          onDelete();
        }}
        onCancel={() => setShowDeleteConfirm(false)}
        isDanger
      />

      {/* 返回按钮 */}
      <BackButton onClick={onBack} />

      {/* 主内容区 */}
      <div className="space-y-4">
        {/* 扫描结果摘要 */}
        {scanResult && (
          <ScanSummary
            scanResult={scanResult}
            deleteResult={deleteResult}
            selectedCount={selectedPaths.size}
            selectedSize={selectedSize}
            onClearDeleteResult={onClearDeleteResult}
          />
        )}

        {/* 分类列表 */}
        {scanResult ? (
          <div className="space-y-2">
            <h2 className="text-sm font-medium text-[var(--fg-muted)] px-1">垃圾文件分类</h2>
            {scanResult.categories
              .filter((c) => c.files.length > 0)
              .sort((a, b) => b.total_size - a.total_size)
              .map((category) => (
                <CategoryCard
                  key={category.display_name}
                  category={category}
                  selectedPaths={selectedPaths}
                  onToggleFile={onToggleFile}
                  onToggleCategory={onToggleCategory}
                />
              ))}

            {scanResult.categories.every((c) => c.files.length === 0) && (
              <div className="text-center py-12 bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)]">
                <p className="text-[var(--fg-muted)] text-sm">🎉 太棒了！没有发现可清理的垃圾文件</p>
              </div>
            )}
          </div>
        ) : isScanning ? (
          /* 扫描中占位元素 */
          <div className="bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] overflow-hidden">
            <div className="px-5 py-3 bg-[var(--bg-elevated)] border-b border-[var(--border-default)]">
              <h3 className="text-sm font-semibold text-[var(--fg-primary)]">垃圾文件分类</h3>
            </div>
            <div className="py-16 flex flex-col items-center justify-center text-center">
              <div className="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mb-4">
                <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
              </div>
              <p className="text-sm font-medium text-[var(--fg-secondary)]">正在扫描中...</p>
              <p className="text-xs text-[var(--fg-muted)] mt-1">正在检索系统垃圾文件，请稍候</p>
            </div>
          </div>
        ) : (
          <div className="max-w-5xl mx-auto">
            <EmptyState />
          </div>
        )}
      </div>
    </>
  );
}
