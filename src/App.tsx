// ============================================================================
// C盘清理工具 - 主应用组件
// 单页仪表盘布局，支持浅色/深色/跟随系统主题
// ============================================================================

import { useState, useCallback } from 'react';
import { 
  SettingsModal, 
  TitleBar, 
  ToastProvider, 
  WelcomeModal, 
  shouldShowWelcome,
  DashboardHeader,
  JunkCleanModule,
  BigFilesModule,
  SocialCleanModule,
  SystemSlimModule,
} from './components';
import { DashboardProvider, useDashboard } from './contexts';
import './App.css';

// ============================================================================
// 仪表盘内容组件
// ============================================================================

function DashboardContent() {
  const { triggerOneClickScan } = useDashboard();

  // 设置弹窗状态
  const [showSettings, setShowSettings] = useState(false);
  // 欢迎弹窗状态
  const [showWelcome, setShowWelcome] = useState(() => shouldShowWelcome());

  // 一键扫描：通过触发器并发启动所有模块扫描
  const handleOneClickScan = useCallback(() => {
    triggerOneClickScan();
  }, [triggerOneClickScan]);

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-base)] overflow-hidden select-none">
      {/* 自定义标题栏 */}
      <TitleBar onSettingsClick={() => setShowSettings(true)} />

      {/* 顶部统计栏 */}
      <DashboardHeader 
        onOneClickScan={handleOneClickScan}
        onShowWelcome={() => setShowWelcome(true)}
      />

      {/* 设置弹窗 */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

      {/* 欢迎弹窗 */}
      <WelcomeModal isOpen={showWelcome} onClose={() => setShowWelcome(false)} />

      {/* 主内容区 - 模块卡片列表 */}
      <main className="flex-1 overflow-auto bg-[var(--bg-base)]">
        <div className="max-w-5xl mx-auto p-4 space-y-4">
          {/* 垃圾清理模块 */}
          <JunkCleanModule />

          {/* 大文件清理模块 */}
          <BigFilesModule />

          {/* 社交软件专清模块 */}
          <SocialCleanModule />

          {/* 系统瘦身模块 */}
          <SystemSlimModule />

          {/* 底部留白 */}
          <div className="h-4" />
        </div>
      </main>
    </div>
  );
}

// ============================================================================
// 主应用组件
// ============================================================================

function App() {
  return (
    <ToastProvider>
      <DashboardProvider>
        <DashboardContent />
      </DashboardProvider>
    </ToastProvider>
  );
}

export default App;
