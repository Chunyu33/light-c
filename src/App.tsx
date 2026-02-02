// ============================================================================
// C盘清理工具 - 主应用组件
// 支持浅色/深色/跟随系统主题
// ============================================================================

import { useMemo, useState } from 'react';
import { ErrorAlert, SettingsModal, TitleBar, ToastProvider } from './components';
import { HomePage, CleanupPage, CleanupToolbar, BigFilesPage, PlaceholderPage } from './pages';
import { useCleanup } from './hooks/useCleanup';
import './App.css';

/** 页面类型 */
type PageType = 'home' | 'cleanup' | 'big-files' | 'social-clean' | 'system-slim';

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
    clearDeleteResult,
  } = useCleanup();

  // 设置弹窗状态
  const [showSettings, setShowSettings] = useState(false);
  // 清理确认弹窗状态
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // 当前页面
  const [activePage, setActivePage] = useState<PageType>('home');

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

  // 点击扫描按钮
  const handleScanClick = () => {
    if (!isScanning) {
      startScan();
    }
    setActivePage('cleanup');
  };

  // 导航到指定页面
  const navigateTo = (page: PageType) => setActivePage(page);
  const goHome = () => setActivePage('home');

  return (
    <ToastProvider>
    <div className="h-screen flex flex-col bg-[var(--bg-base)] overflow-hidden select-none">
      {/* 自定义标题栏 */}
      <TitleBar onSettingsClick={() => setShowSettings(true)} />

      {/* 清理页面的工具栏（需要在 main 外部） */}
      {activePage === 'cleanup' && (
        <CleanupToolbar
          status={status}
          scanResult={scanResult}
          selectedPaths={selectedPaths}
          setShowDeleteConfirm={setShowDeleteConfirm}
          onScan={startScan}
          onSelectAll={() => toggleAllSelection(true)}
          onDeselectAll={() => toggleAllSelection(false)}
        />
      )}

      {/* 设置弹窗 */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

      {/* 主内容区 */}
      <main className="flex-1 overflow-auto p-4 space-y-4 bg-[var(--bg-base)]">
        {/* 错误提示 */}
        {error && <ErrorAlert message={error} onClose={clearError} />}

        {/* 首页 */}
        {activePage === 'home' && (
          <HomePage
            diskInfo={diskInfo}
            isScanning={isScanning}
            onScanClick={handleScanClick}
            onNavigate={navigateTo}
          />
        )}

        {/* 清理页面内容 */}
        {activePage === 'cleanup' && (
          <CleanupPage
            scanResult={scanResult}
            deleteResult={deleteResult}
            selectedPaths={selectedPaths}
            selectedSize={selectedSize}
            showDeleteConfirm={showDeleteConfirm}
            setShowDeleteConfirm={setShowDeleteConfirm}
            onBack={goHome}
            onDelete={startDelete}
            onToggleFile={toggleFileSelection}
            onToggleCategory={toggleCategorySelection}
            onClearDeleteResult={clearDeleteResult}
          />
        )}

        {/* 大文件清理页 */}
        {activePage === 'big-files' && <BigFilesPage onBack={goHome} />}

        {/* 社交软件专清页 */}
        {activePage === 'social-clean' && (
          <PlaceholderPage
            title="社交软件专清"
            description="页面已就位，后续将在此展示社交软件缓存清理功能。"
            onBack={goHome}
          />
        )}

        {/* 系统瘦身页 */}
        {activePage === 'system-slim' && (
          <PlaceholderPage
            title="系统瘦身"
            description="页面已就位，后续将在此展示系统组件与备份清理功能。"
            onBack={goHome}
          />
        )}
      </main>
    </div>
    </ToastProvider>
  );
}

export default App;
