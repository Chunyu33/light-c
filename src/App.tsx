// ============================================================================
// C盘清理工具 - 主应用组件
// 支持浅色/深色/跟随系统主题
// ============================================================================

import { useMemo, useState } from 'react';
import {
  ScanSummary,
  CategoryCard,
  ActionButtons,
  ErrorAlert,
  EmptyState,
  SettingsModal,
  TitleBar,
  ScanProgress,
  DiskUsage,
} from './components';
import { useCleanup } from './hooks/useCleanup';
import './App.css';

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
    clearError,
  } = useCleanup();

  // 设置弹窗状态
  const [showSettings, setShowSettings] = useState(false);

  // 使用useMemo优化计算已选文件大小
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

  // 判断是否正在扫描
  const isScanning = status === 'scanning';

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-base)] overflow-hidden select-none">
      {/* 自定义标题栏 */}
      <TitleBar onSettingsClick={() => setShowSettings(true)} />

      {/* 工具栏 */}
      <header className="h-14 bg-[var(--bg-elevated)] border-b border-[var(--border-default)] flex items-center px-4 shrink-0">
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
      </header>

      {/* 扫描进度条 - 位于工具栏下方 */}
      <ScanProgress
        isScanning={isScanning}
        currentCategory="正在扫描垃圾文件..."
        completedCategories={isScanning ? 0 : (scanResult?.categories.length || 0)}
        totalCategories={10}
        scannedFileCount={scanResult?.total_file_count || 0}
        scannedSize={scanResult?.total_size || 0}
      />

      {/* 设置弹窗 */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

      {/* 主内容区 */}
      <main className="flex-1 overflow-auto p-4 space-y-3 bg-[var(--bg-base)]">
        {/* 错误提示 */}
        {error && <ErrorAlert message={error} onClose={clearError} />}

        {/* C盘使用情况 - 始终显示 */}
        <DiskUsage diskInfo={diskInfo} />

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
          /* 未扫描时显示软件特色介绍 */
          <EmptyState />
        )}
      </main>
    </div>
  );
}

export default App;
