// ============================================================================
// 垃圾清理页面组件
// 展示扫描结果和清理操作
// ============================================================================

import {
  ActionButtons,
  ScanSummary,
  CategoryCard,
  ScanProgress,
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

  return (
    <>
      {/* 工具栏 */}
      <header className="h-14 bg-[var(--bg-elevated)] border-b border-[var(--border-default)] flex items-center px-4 shrink-0">
        <ActionButtons
          status={status}
          hasScanResult={!!scanResult}
          selectedCount={selectedPaths.size}
          totalCount={scanResult?.total_file_count || 0}
          onScan={onScan}
          onDelete={() => setShowDeleteConfirm(true)}
          onSelectAll={onSelectAll}
          onDeselectAll={onDeselectAll}
        />
      </header>

      {/* 扫描进度条 - 扫描中使用模拟进度，完成后显示实际结果 */}
      <ScanProgress
        isScanning={isScanning}
        currentCategory="正在扫描垃圾文件..."
        completedCategories={isScanning ? -1 : scanResult?.categories.length || 0}
        totalCategories={scanResult?.categories.length || 10}
        scannedFileCount={scanResult?.total_file_count || 0}
        scannedSize={scanResult?.total_size || 0}
      />
    </>
  );
}

/** 清理页面内容组件 */
export function CleanupPage({
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
}: Omit<CleanupPageProps, 'status' | 'onScan' | 'onSelectAll' | 'onDeselectAll'>) {
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
        ) : (
          <div className="max-w-5xl mx-auto">
            <EmptyState />
          </div>
        )}
      </div>
    </>
  );
}
