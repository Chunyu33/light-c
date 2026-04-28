// ============================================================================
// C盘清理工具 - 主应用组件
// 单页仪表盘布局，支持浅色/深色/跟随系统主题
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { 
  SettingsModal, 
  TitleBar, 
  ToastProvider, 
  WelcomeModal, 
  shouldShowWelcome,
  // UpdateModal, // 自动更新功能已停用
  DashboardHeader,
  JunkCleanModule,
  BigFilesModule,
  SocialCleanModule,
  SystemSlimModule,
  LeftoversModule,
  RegistryModule,
  HotspotModule,
  ContextMenuModule,
  ProgramDataModule,
  SplashScreen,
  Footer,
  AnchorNav,
} from './components';
import { DashboardProvider, useDashboard, FontSizeProvider, SettingsProvider, useSettings } from './contexts';
import './App.css';

// ============================================================================
// 仪表盘内容组件
// ============================================================================

function DashboardContent() {
  const { triggerOneClickScan } = useDashboard();
  const { settings } = useSettings();

  // 设置弹窗状态
  const [showSettings, setShowSettings] = useState(false);
  // 欢迎弹窗状态
  const [showWelcome, setShowWelcome] = useState(() => shouldShowWelcome());
  // 滚动容器 ref（用于锚点导航）
  const scrollContainerRef = useRef<HTMLElement>(null);

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

      {/* 自动更新检查弹窗 - 功能已停用 */}
      {/* <UpdateModal autoCheck={true} /> */}

      {/* 锚点导航（根据设置显示） */}
      {settings.showAnchorNav && <AnchorNav scrollContainerRef={scrollContainerRef} />}

      {/* 主内容区 - 微信风格柔和灰白背景，增加间距 */}
      <main ref={scrollContainerRef} className="flex-1 overflow-auto bg-[var(--bg-base)]">
        <div className="max-w-5xl mx-auto p-6 space-y-5">
          {/* 垃圾清理模块 */}
          <div data-module-id="junk-clean">
            <JunkCleanModule />
          </div>

          {/* 大文件清理模块 */}
          <div data-module-id="big-files">
            <BigFilesModule />
          </div>

          {/* 社交软件专清模块 */}
          <div data-module-id="social-clean">
            <SocialCleanModule />
          </div>

          {/* 系统瘦身模块 */}
          <div data-module-id="system-slim">
            <SystemSlimModule />
          </div>

          {/* 卸载残留模块 [深度] */}
          <div data-module-id="leftovers">
            <LeftoversModule />
          </div>

          {/* 注册表冗余模块 [中风险] */}
          <div data-module-id="registry">
            <RegistryModule />
          </div>

          {/* 右键菜单清理模块 [中风险] */}
          <div data-module-id="context-menu">
            <ContextMenuModule />
          </div>

          {/* 大目录分析模块 */}
          <div data-module-id="hotspot">
            <HotspotModule />
          </div>

          {/* ProgramData 分析模块 */}
          <div data-module-id="programdata">
            <ProgramDataModule />
          </div>

          {/* 底部留白 */}
          <div className="h-4" />
        </div>

        {/* 底部版权声明 */}
        <Footer />
      </main>
    </div>
  );
}

// ============================================================================
// 主应用组件
// ============================================================================

function App() {
  const [windowLabel, setWindowLabel] = useState<string | null>(null);

  useEffect(() => {
    getCurrentWindow().label && setWindowLabel(getCurrentWindow().label);
  }, []);

  // 等待窗口标签检测完成
  if (windowLabel === null) {
    return null;
  }

  // 启动屏幕窗口
  if (windowLabel === 'splashscreen') {
    return <SplashScreen />;
  }

  // 主窗口
  return (
    <FontSizeProvider>
      <SettingsProvider>
        <ToastProvider>
          <DashboardProvider>
            <DashboardContent />
          </DashboardProvider>
        </ToastProvider>
      </SettingsProvider>
    </FontSizeProvider>
  );
}

export default App;
