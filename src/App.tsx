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
} from './components';
import { useCleanup } from './hooks/useCleanup';
import './App.css';

function App() {
  const {
    status,
    scanResult,
    deleteResult,
    selectedPaths,
    error,
    startScan,
    startDelete,
    toggleFileSelection,
    toggleCategorySelection,
    toggleAllSelection,
    clearError,
  } = useCleanup();


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

  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-base)] overflow-hidden">
      {/* 自定义标题栏 */}
      <TitleBar onSettingsClick={() => setShowSettings(true)} />

      {/* 工具栏 */}
      <header className="h-11 bg-[var(--bg-elevated)] border-b border-[var(--border-default)] flex items-center px-4 shrink-0">
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

      {/* 设置弹窗 */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

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
        <p className="text-[10px] text-[var(--fg-faint)]">Copyright © {new Date().getFullYear()} LightC. All rights reserved.</p>
      </footer>
    </div>
  );
}

export default App;
