// ============================================================================
// C盘清理工具 - 主应用组件
// 单页仪表盘布局，支持浅色/深色/跟随系统主题
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
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
  // Footer,
  AnchorNav,
  BackToTopButton,
} from './components';
import { DashboardProvider, useDashboardActions, FontSizeProvider, SettingsProvider, useSettings } from './contexts';
import { APP_MODULES } from './config/modules';
import './App.css';

function PageTransitionAccent({ active }: { active: boolean }) {
  if (!active) return null;

  return (
    <motion.div
      // 只动画一条轻量流光，不让大结果 DOM 参与复杂过渡，兼顾质感和性能。
      className="pointer-events-none absolute inset-x-3 top-0 z-20 h-1 overflow-hidden rounded-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 1, 0.85, 0] }}
      transition={{ duration: 0.56, ease: 'easeOut' }}
    >
      <motion.div
        className="h-full w-2/3 rounded-full bg-gradient-to-r from-transparent via-[var(--brand-green)] to-transparent shadow-[0_0_18px_rgba(7,193,96,0.65)]"
        initial={{ x: '-130%' }}
        animate={{ x: '170%' }}
        transition={{ duration: 0.56, ease: [0.22, 1, 0.36, 1] }}
      />
    </motion.div>
  );
}

// ============================================================================
// 仪表盘内容组件
// ============================================================================

function DashboardContent() {
  const { triggerOneClickScan } = useDashboardActions();
  const { settings } = useSettings();

  // 设置弹窗状态
  const [showSettings, setShowSettings] = useState(false);
  // 欢迎弹窗状态
  const [showWelcome, setShowWelcome] = useState(() => shouldShowWelcome());
  // 两种布局共用同一个内容滚动区，模块实例不会因为模式切换被卸载，扫描结果和展开状态才能保留。
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isPageMode = settings.layoutMode === 'pages';
  const [visibleModuleId, setVisibleModuleId] = useState(settings.activeModuleId);
  const [transitionModuleId, setTransitionModuleId] = useState(settings.activeModuleId);
  const [pageTransitionSequence, setPageTransitionSequence] = useState(0);
  const visibleModuleIdRef = useRef(settings.activeModuleId);

  // 一键扫描：通过触发器并发启动所有模块扫描
  const handleOneClickScan = useCallback(() => {
    triggerOneClickScan();
  }, [triggerOneClickScan]);

  useEffect(() => {
    if (!isPageMode) {
      setVisibleModuleId(settings.activeModuleId);
      setTransitionModuleId(settings.activeModuleId);
      visibleModuleIdRef.current = settings.activeModuleId;
      return;
    }

    const previousModuleId = visibleModuleIdRef.current;
    if (settings.activeModuleId === previousModuleId) return;

    // 页面模式下只让新页面做轻量入场动画，旧页面立即隐藏。
    // 大目录/全盘分析这类结果 DOM 很重，如果旧页面也参与离场动画，会触发大面积合成和掉帧。
    // 切换前先回到顶部，防止从长页面切到短页面时继承旧 scrollTop，出现大段空白和多余滚动条。
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    visibleModuleIdRef.current = settings.activeModuleId;
    // 用序号切换两组等价 class，避免重新挂载模块也能稳定重播 CSS 入场动画。
    setPageTransitionSequence((current) => current + 1);
    setTransitionModuleId(settings.activeModuleId);
    setVisibleModuleId(settings.activeModuleId);
  }, [isPageMode, settings.activeModuleId]);

  useEffect(() => {
    if (!isPageMode) return;

    // 从卡片模式进入页面模式时也回到顶部，避免继承卡片总览的滚动位置。
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [isPageMode]);

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
      <BackToTopButton scrollContainerRef={scrollContainerRef} />

      {/* 主内容区 - 页面模式下模块实例仍常驻，但 inactive 模块会自行跳过重结果 DOM。 */}
      <main className="flex-1 min-h-0 overflow-hidden bg-[var(--bg-base)]">
        <div className="h-full min-h-0 flex flex-col">
          <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto">
            <div className={`${isPageMode ? 'min-h-full box-border' : 'space-y-5'} relative p-6 dashboard-container`}>
              {APP_MODULES.map((moduleConfig) => {
                const ModuleComponent = moduleConfig.component;
                const isActivePage = visibleModuleId === moduleConfig.id;
                const shouldPlayPageEnter = isPageMode && isActivePage && transitionModuleId === moduleConfig.id;
                const pageEnterClass = shouldPlayPageEnter
                  ? pageTransitionSequence % 2 === 0
                    ? 'page-content-enter-even'
                    : 'page-content-enter-odd'
                  : '';
                return (
                  <div
                    key={moduleConfig.id}
                    data-module-id={moduleConfig.id}
                    className={
                      isPageMode
                        ? isActivePage
                          ? `relative z-10 overflow-visible ${pageEnterClass}`
                          : 'hidden'
                        : 'relative'
                    }
                    style={isActivePage && isPageMode ? { contentVisibility: 'auto' } : undefined}
                  >
                    <PageTransitionAccent active={isPageMode && isActivePage && transitionModuleId === moduleConfig.id} />
                    <ModuleComponent layoutMode={settings.layoutMode} isPageActive={isActivePage} />
                  </div>
                );
              })}

              {/* 底部留白只给卡片总览使用，页面模式由固定 Footer 承接底部空间。 */}
              {!isPageMode && <div className="h-4" />}
            </div>
          </div>

          {/* Footer 不放进滚动区，短页面不会因为版权区参与滚动而出现额外空白。 */}
          {/* <Footer /> */}
        </div>
      </main>
    </div>
  );
}

// ============================================================================
// 主应用组件
// ============================================================================

function App() {
  const [showSplash, setShowSplash] = useState(true);
  const handleSplashComplete = useCallback(() => setShowSplash(false), []);

  // 启动屏和主界面共用同一个 WebView，避免双窗口初始化和窗口切换开销。
  if (showSplash) {
    return <SplashScreen onComplete={handleSplashComplete} />;
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
