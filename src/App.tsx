// ============================================================================
// C盘清理工具 - 主应用组件
// 支持浅色/深色/跟随系统主题
// ============================================================================

import { useEffect, useMemo } from 'react';
import {
  DiskUsage,
  ScanSummary,
  CategoryCard,
  ActionButtons,
  ErrorAlert,
  EmptyState,
  ThemeToggle,
} from './components';
import { useCleanup } from './hooks/useCleanup';
import { HardDrive } from 'lucide-react';

function App() {
  const {
    status,
    scanResult,
    deleteResult,
    diskInfo,
    selectedPaths,
    error,
    startScan,
    startDelete,
    toggleFileSelection,
    toggleCategorySelection,
    toggleAllSelection,
    refreshDiskInfo,
    clearError,
  } = useCleanup();

  useEffect(() => {
    refreshDiskInfo();
  }, [refreshDiskInfo]);

  // 使用useMemo优化计算
  const selectedSize = useMemo(() => {
    if (!scanResult) return 0;
    let total = 0;
    for (const category of scanResult.categories) {
      for (const f of category.files) {
        if (selectedPaths.has(f.path)) {
          total += f.size;
        }
      }
    }
    return total;
  }, [scanResult, selectedPaths]);

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-base)] overflow-hidden no-select">
      {/* 标题栏 */}
      <header 
        className="h-12 bg-[var(--bg-elevated)] border-b border-[var(--border-default)] flex items-center px-4 shrink-0"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-3 flex-1" data-tauri-drag-region>
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <HardDrive className="w-4 h-4 text-white" />
          </div>
          <div data-tauri-drag-region>
            <h1 className="text-sm font-semibold text-[var(--fg-primary)]">C盘清理工具</h1>
            <p className="text-[10px] text-[var(--fg-muted)]">Windows 智能瘦身助手</p>
          </div>
        </div>

        {/* 操作按钮 */}
        <ActionButtons
          status={status}
          hasScanResult={!!scanResult}
          selectedCount={selectedPaths.size}
          totalCount={scanResult?.total_file_count || 0}
          onScan={startScan}
          onDelete={startDelete}
          onSelectAll={() => toggleAllSelection(true)}
          onDeselectAll={() => toggleAllSelection(false)}
        />

        {/* 主题切换 */}
        <div className="ml-3 pl-3 border-l border-[var(--border-default)]">
          <ThemeToggle />
        </div>
      </header>

      {/* 主内容区 */}
      <main className="flex-1 overflow-auto p-4 space-y-3 bg-[var(--bg-base)]">
        {/* 扫描中Loading */}
        {status === 'scanning' && (
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-[var(--bg-card)] rounded-xl p-6 shadow-2xl border border-[var(--border-default)] flex flex-col items-center gap-4">
              <div className="w-12 h-12 border-4 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
              <div className="text-center">
                <p className="text-[var(--fg-primary)] font-medium">正在扫描中...</p>
                <p className="text-[var(--fg-muted)] text-sm mt-1">请稍候，正在分析C盘文件</p>
              </div>
            </div>
          </div>
        )}
        {/* 错误提示 */}
        {error && <ErrorAlert message={error} onClose={clearError} />}

        {/* 磁盘使用情况 */}
        <DiskUsage diskInfo={diskInfo} loading={status === 'scanning' && !diskInfo} />

        {/* 扫描结果摘要 */}
        {scanResult && (
          <ScanSummary
            scanResult={scanResult}
            deleteResult={deleteResult}
            selectedCount={selectedPaths.size}
            selectedSize={selectedSize}
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
                  onToggleFile={toggleFileSelection}
                  onToggleCategory={toggleCategorySelection}
                />
              ))}

            {scanResult.categories.every((c) => c.files.length === 0) && (
              <div className="text-center py-12 bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)]">
                <p className="text-[var(--fg-muted)] text-sm">🎉 太棒了！没有发现可清理的垃圾文件</p>
              </div>
            )}
          </div>
        ) : (
          <EmptyState />
        )}
      </main>

      {/* 底部状态栏 */}
      <footer className="h-7 bg-[var(--bg-elevated)] border-t border-[var(--border-default)] flex items-center justify-center px-4 shrink-0">
        <p className="text-[10px] text-[var(--fg-faint)]">Copyright © 2025 Chunyu. All rights reserved.</p>
      </footer>
    </div>
  );
}

export default App;
