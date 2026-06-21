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
  const { triggerOneClickScan } = useDashboard();
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

      {/* 主内容区 - 模块始终挂在同一个父容器内，布局模式只改变展示方式，避免切换模式时丢失本地状态。 */}
      <main className="flex-1 min-h-0 overflow-hidden bg-[var(--bg-base)]">
        <div className="h-full min-h-0 flex flex-col">
          <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto">
            <div className={`${isPageMode ? 'max-w-6xl min-h-full box-border' : 'max-w-5xl space-y-5'} relative w-full mx-auto p-6`}>
              {APP_MODULES.map((moduleConfig) => {
                const ModuleComponent = moduleConfig.component;
                const isActivePage = visibleModuleId === moduleConfig.id;
                return (
                  <motion.div
                    key={moduleConfig.id}
                    data-module-id={moduleConfig.id}
                    className={
                      isPageMode
                        ? isActivePage
                          ? 'relative z-10 overflow-visible'
                          : 'hidden'
                        : 'relative'
                    }
                    style={isActivePage && isPageMode ? { contentVisibility: 'auto' } : undefined}
                    initial={false}
                    animate={
                      isPageMode
                        ? {
                            opacity: isActivePage ? 1 : 0,
                            y: isActivePage ? 0 : 8,
                            pointerEvents: isActivePage ? 'auto' : 'none',
                          }
                        : { opacity: 1, y: 0, pointerEvents: 'auto' }
                    }
                    transition={{
                      duration: isPageMode && transitionModuleId === moduleConfig.id ? 0.24 : 0,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    <PageTransitionAccent active={isPageMode && isActivePage && transitionModuleId === moduleConfig.id} />
                    <ModuleComponent layoutMode={settings.layoutMode} />
                  </motion.div>
                );
              })}

              {/* 底部留白只给卡片总览使用，页面模式由固定 Footer 承接底部空间。 */}
              {!isPageMode && <div className="h-4" />}
            </div>
          </div>

          {/* Footer 不放进滚动区，短页面不会因为版权区参与滚动而出现额外空白。 */}
          <Footer />
        </div>
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
