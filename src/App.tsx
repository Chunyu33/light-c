// ============================================================================
// C盘清理工具 - 主应用组件
// 单页仪表盘布局，支持浅色/深色/跟随系统主题
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { motion } from 'framer-motion';
import { 
  SettingsModal, 
  TitleBar, 
  ToastProvider, 
  WelcomeModal, 
  shouldShowWelcome,
  UpdateModal,
  DashboardHeader,
  SplashScreen,
  Footer,
  AnchorNav,
} from './components';
import { DashboardProvider, useDashboard, FontSizeProvider, SettingsProvider, useSettings } from './contexts';
import { APP_MODULES } from './config/modules';
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
  // 卡片模式滚动容器用于锚点导航；页面模式单独使用内容滚动区，避免两种布局互相污染滚动状态。
  const scrollContainerRef = useRef<HTMLElement>(null);
  const pageContentRef = useRef<HTMLDivElement>(null);
  const isPageMode = settings.layoutMode === 'pages';
  const [visibleModuleId, setVisibleModuleId] = useState(settings.activeModuleId);
  const [leavingModuleId, setLeavingModuleId] = useState<string | null>(null);
  const visibleModuleIdRef = useRef(settings.activeModuleId);

  // 一键扫描：通过触发器并发启动所有模块扫描
  const handleOneClickScan = useCallback(() => {
    triggerOneClickScan();
  }, [triggerOneClickScan]);

  useEffect(() => {
    if (!isPageMode) {
      setVisibleModuleId(settings.activeModuleId);
      visibleModuleIdRef.current = settings.activeModuleId;
      setLeavingModuleId(null);
      return;
    }

    const previousModuleId = visibleModuleIdRef.current;
    if (settings.activeModuleId === previousModuleId) return;

    // 页面模式下保留旧页面短暂淡出，同时让新页面淡入，避免菜单切换时出现瞬切。
    // 切换前先回到顶部，防止从长页面切到短页面时继承旧 scrollTop，出现大段空白和多余滚动条。
    pageContentRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    setLeavingModuleId(previousModuleId);
    visibleModuleIdRef.current = settings.activeModuleId;
    setVisibleModuleId(settings.activeModuleId);
    const timer = window.setTimeout(() => {
      setLeavingModuleId(null);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [isPageMode, settings.activeModuleId]);

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-base)] overflow-hidden select-none">
      {/* 自定义标题栏 */}
      <TitleBar onSettingsClick={() => setShowSettings(true)} />

      {/* 顶部统计栏 */}
      <DashboardHeader 
        onOneClickScan={handleOneClickScan}
        onShowWelcome={() => setShowWelcome(true)}
        hideOneClickScan={isPageMode}
      />

      {/* 设置弹窗 */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

      {/* 欢迎弹窗 */}
      <WelcomeModal isOpen={showWelcome} onClose={() => setShowWelcome(false)} />

      {/* 自动更新检查弹窗 */}
      <UpdateModal autoCheck={true} />

      {/* 侧边导航：卡片模式滚动到锚点，页面模式切换当前模块。 */}
      <AnchorNav scrollContainerRef={scrollContainerRef} />

      {/* 主内容区 - 两种布局拆开滚动容器，避免页面模式短内容被卡片模式/上一模块滚动高度影响。 */}
      {isPageMode ? (
        <main ref={scrollContainerRef} className="flex-1 min-h-0 overflow-hidden bg-[var(--bg-base)]">
          <div className="h-full min-h-0 flex flex-col">
            <div ref={pageContentRef} className="flex-1 min-h-0 overflow-auto">
              <div className="max-w-6xl relative w-full mx-auto p-6">
                {APP_MODULES.map((moduleConfig) => {
                  const ModuleComponent = moduleConfig.component;
                  const isActivePage = visibleModuleId === moduleConfig.id;
                  const isLeavingPage = leavingModuleId === moduleConfig.id;
                  const shouldRenderInPageMode = isActivePage || isLeavingPage;
                  return (
                    <motion.div
                      key={moduleConfig.id}
                      data-module-id={moduleConfig.id}
                      className={
                        isLeavingPage
                          ? 'absolute inset-x-6 top-6 z-0'
                          : shouldRenderInPageMode
                            ? 'relative z-10'
                            : 'hidden'
                      }
                      initial={false}
                      animate={{
                        opacity: isActivePage ? 1 : 0,
                        y: isActivePage ? 0 : -8,
                        pointerEvents: isActivePage ? 'auto' : 'none',
                      }}
                      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <ModuleComponent layoutMode={settings.layoutMode} />
                    </motion.div>
                  );
                })}
              </div>
            </div>

            {/* Footer 保持在底部但不参与内容区滚动，短页面不会再撑出多余空白。 */}
            <Footer />
          </div>
        </main>
      ) : (
        <main ref={scrollContainerRef} className="flex-1 overflow-auto bg-[var(--bg-base)]">
          <div className="min-h-full flex flex-col">
            <div className="max-w-5xl relative w-full mx-auto p-6 space-y-5">
              {APP_MODULES.map((moduleConfig) => {
                const ModuleComponent = moduleConfig.component;
                return (
                  <motion.div
                    key={moduleConfig.id}
                    data-module-id={moduleConfig.id}
                    initial={false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <ModuleComponent layoutMode={settings.layoutMode} />
                  </motion.div>
                );
              })}

              {/* 底部留白保留给卡片模式，避免最后一个卡片贴住页脚。 */}
              <div className="h-4" />
            </div>

            <div className="mt-auto">
              <Footer />
            </div>
          </div>
        </main>
      )}
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
