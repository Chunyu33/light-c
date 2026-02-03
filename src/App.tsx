// ============================================================================
// C盘清理工具 - 主应用组件
// 支持浅色/深色/跟随系统主题
// ============================================================================

import { useMemo, useState, useRef } from 'react';
import { ErrorAlert, SettingsModal, TitleBar, ToastProvider, PageTransition, WelcomeModal, shouldShowWelcome } from './components';
import { HomePage, CleanupPage, CleanupToolbar, BigFilesPage, SocialCleanPage, SystemSlimPage } from './pages';
import { useCleanup } from './hooks/useCleanup';
import './App.css';

/** 页面类型 */
type PageType = 'home' | 'cleanup' | 'big-files' | 'social-clean' | 'system-slim';

// 页面层级，用于判断前进/后退
const PAGE_ORDER: Record<PageType, number> = {
  'home': 0,
  'cleanup': 1,
  'big-files': 1,
  'social-clean': 1,
  'system-slim': 1,
};

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
  // 欢迎弹窗状态
  const [showWelcome, setShowWelcome] = useState(() => shouldShowWelcome());
  // 清理确认弹窗状态
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // 当前页面
  const [activePage, setActivePage] = useState<PageType>('home');
  // 页面切换方向
  const [transitionDirection, setTransitionDirection] = useState<'forward' | 'back'>('forward');
  // 上一个页面
  const prevPageRef = useRef<PageType>('home');
  // 健康评分刷新触发器
  const [healthRefreshTrigger, setHealthRefreshTrigger] = useState(0);

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
    navigateTo('cleanup');
  };

  // 导航到指定页面（带方向判断）
  const navigateTo = (page: PageType) => {
    const currentOrder = PAGE_ORDER[activePage];
    const targetOrder = PAGE_ORDER[page];
    setTransitionDirection(targetOrder >= currentOrder ? 'forward' : 'back');
    prevPageRef.current = activePage;
    setActivePage(page);
  };
  
  const goHome = () => {
    setTransitionDirection('back');
    prevPageRef.current = activePage;
    setActivePage('home');
  };

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

      {/* 欢迎弹窗 */}
      <WelcomeModal isOpen={showWelcome} onClose={() => setShowWelcome(false)} />

      {/* 主内容区 */}
      <main className="flex-1 overflow-hidden bg-[var(--bg-base)]">
        {/* 错误提示 */}
        {error && <div className="p-4"><ErrorAlert message={error} onClose={clearError} /></div>}

        {/* 页面内容（带过渡动画） */}
        <PageTransition pageKey={activePage} direction={transitionDirection}>
          <div className="h-full overflow-auto p-4 space-y-4">
            {/* 首页 */}
            {activePage === 'home' && (
              <HomePage
                diskInfo={diskInfo}
                isScanning={isScanning}
                onScanClick={handleScanClick}
                onNavigate={navigateTo}
                refreshTrigger={healthRefreshTrigger}
                onShowWelcome={() => setShowWelcome(true)}
              />
            )}

            {/* 清理页面内容 */}
            {activePage === 'cleanup' && (
              <CleanupPage
                status={status}
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
            {activePage === 'big-files' && <BigFilesPage onBack={goHome} onCleanupComplete={() => setHealthRefreshTrigger(n => n + 1)} />}

            {/* 社交软件专清页 */}
            {activePage === 'social-clean' && <SocialCleanPage onBack={goHome} onCleanupComplete={() => setHealthRefreshTrigger(n => n + 1)} />}

            {/* 系统瘦身页 */}
            {activePage === 'system-slim' && <SystemSlimPage onBack={goHome} onCleanupComplete={() => setHealthRefreshTrigger(n => n + 1)} />}
          </div>
        </PageTransition>
      </main>
    </div>
    </ToastProvider>
  );
}

export default App;
