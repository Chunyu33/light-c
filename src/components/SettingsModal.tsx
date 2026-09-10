// ============================================================================
// 设置弹窗组件
// 只负责弹窗生命周期、左侧导航和页面路由；具体设置页面按功能拆分维护。
// ============================================================================

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FONT_SIZE_CONFIGS, useFontSize, useTheme } from '../contexts';
import { AboutSettings } from './settings/AboutSettings';
import { FeedbackSettings } from './settings/FeedbackSettings';
import { FeatureSettings } from './settings/FeatureSettings';
import { GeneralSettings } from './settings/GeneralSettings';
import { GuideSettings } from './settings/GuideSettings';
import { SecuritySettings } from './settings/SecuritySettings';
import { DiskInfoSettings } from './settings/DiskInfoSettings';
import { SETTINGS_TABS } from './settings/constants';
import type { SettingsTab } from './settings/types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// 导航宽度按标准字号保存像素值，渲染时再乘以字号缩放，与主界面侧边栏保持同一口径：
// 像素值在窗口尺寸变化时不会漂移，比例值则会让菜单在窄窗口里被压得放不下文字。
const SETTINGS_NAV_WIDTH_STORAGE_KEY = 'lightc.settings.navWidth';
const SETTINGS_NAV_WIDTH_DEFAULT = 220;
const SETTINGS_NAV_WIDTH_MIN = 180;
const SETTINGS_NAV_WIDTH_MAX = 360;
// 键盘调整步长（标准字号下的像素），保证焦点在分隔条上时也能微调宽度。
const SETTINGS_NAV_KEYBOARD_STEP = 12;
// 窗口变窄时导航最多占弹窗宽度的比例，避免保存过的较大宽度把右侧内容挤没。
const SETTINGS_NAV_MAX_WIDTH_RATIO = 0.4;
// 弹窗宽度为 76vw，最大不超过 视口 - 24px；导航上限按视口宽度换算回标准字号像素。
const SETTINGS_MODAL_VIEWPORT_WIDTH_RATIO = 0.76;
const SETTINGS_MODAL_VIEWPORT_WIDTH_MARGIN = 24;

/** 按当前视口计算导航的展示宽度上限（像素）：窗口越小，导航允许占用的比例越低。 */
function getSettingsNavMaxRenderedWidth(viewportWidth: number): number {
  const safeViewportWidth = Math.max(1, Math.round(viewportWidth));
  const modalWidth = Math.min(
    safeViewportWidth * SETTINGS_MODAL_VIEWPORT_WIDTH_RATIO,
    safeViewportWidth - SETTINGS_MODAL_VIEWPORT_WIDTH_MARGIN,
  );
  // 用展示宽度做比例约束，避免大字号下最小宽度被放大后挤掉右侧内容。
  return Math.round(modalWidth * SETTINGS_NAV_MAX_WIDTH_RATIO);
}

/** 把展示宽度上限换算回标准字号下的拖拽上限，并收敛到全局上下限之间。 */
function getSettingsNavMaxStoredWidth(viewportWidth: number, fontScale: number): number {
  const ratioLimitedWidth = Math.round(getSettingsNavMaxRenderedWidth(viewportWidth) / fontScale);
  // 视口极小时比例上限可能低于最小宽度，此时下限仍然保留最小宽度，保证菜单文字可读。
  return Math.min(SETTINGS_NAV_WIDTH_MAX, Math.max(SETTINGS_NAV_WIDTH_MIN, ratioLimitedWidth));
}

/** 读取已保存的导航宽度；越界或存储不可用时回退到默认值，避免脏数据撑坏弹窗布局。 */
function readSettingsNavWidth(): number {
  try {
    const savedWidth = Number(localStorage.getItem(SETTINGS_NAV_WIDTH_STORAGE_KEY));
    return Number.isFinite(savedWidth) && savedWidth > 0
      ? Math.min(SETTINGS_NAV_WIDTH_MAX, Math.max(SETTINGS_NAV_WIDTH_MIN, Math.round(savedWidth)))
      : SETTINGS_NAV_WIDTH_DEFAULT;
  } catch (error) {
    console.warn('读取设置导航宽度失败:', error);
    return SETTINGS_NAV_WIDTH_DEFAULT;
  }
}

/** 保存导航宽度；写入失败只影响下次启动的宽度，当前会话拖拽结果仍然有效。 */
function writeSettingsNavWidth(width: number): void {
  try {
    localStorage.setItem(SETTINGS_NAV_WIDTH_STORAGE_KEY, String(width));
  } catch (error) {
    console.warn('保存设置导航宽度失败:', error);
  }
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { t } = useTranslation('settings');
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const { mode, setMode } = useTheme();
  const { level, customFontSize } = useFontSize();
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [navWidth, setNavWidth] = useState(readSettingsNavWidth);
  const [isResizingNav, setIsResizingNav] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  // 记录是否曾经进入可见状态，用于区分首次挂载预隐藏和关闭动画。
  const enteredRef = useRef(false);
  // 拖拽期间通过 ref 读取最新宽度，避免把宽度写进事件监听依赖导致监听器反复重建。
  const navWidthRef = useRef(navWidth);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);
  if (isVisible) enteredRef.current = true;

  const fontScale = (level === 'custom' ? customFontSize : FONT_SIZE_CONFIGS[level].baseSize + FONT_SIZE_CONFIGS[level].offset) / FONT_SIZE_CONFIGS.standard.baseSize;
  const navMaxStoredWidth = getSettingsNavMaxStoredWidth(viewportWidth, fontScale);
  const navMaxRenderedWidth = getSettingsNavMaxRenderedWidth(viewportWidth);
  // 已保存的宽度在窄窗口下可能超过当前上限，展示时按上限收敛，但不覆写存储值。
  const renderedNavWidth = Math.min(
    Math.round(Math.min(navWidth, navMaxStoredWidth) * fontScale),
    navMaxRenderedWidth,
  );
  // 最小宽度只作为拖拽下限，不参与展示收敛：大字号下放不下时优先保右侧内容。
  const renderedNavWidthMin = Math.round(SETTINGS_NAV_WIDTH_MIN * fontScale);
  const renderedNavWidthMax = navMaxRenderedWidth;

  useEffect(() => {
    navWidthRef.current = navWidth;
  }, [navWidth]);

  // 视口宽度决定导航占比上限，窗口尺寸变化时需要重新计算，否则窄窗口会保留过宽的导航。
  useEffect(() => {
    const handleViewportResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleViewportResize);
    return () => window.removeEventListener('resize', handleViewportResize);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setIsAnimating(true);
      setIsVisible(true);
      return;
    }

    setIsVisible(false);
    const timer = setTimeout(() => setIsAnimating(false), 190);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // 拖拽与键盘调整共用同一套边界收敛逻辑，两个入口不会出现宽窄不一致。
  // 上限取当前窗口允许的最大值，因此窄窗口下拖不满、重新放大窗口后也能继续拖宽。
  const applyNavWidth = useCallback((nextWidth: number) => {
    const clampedWidth = Math.min(navMaxStoredWidth, Math.max(SETTINGS_NAV_WIDTH_MIN, Math.round(nextWidth)));
    navWidthRef.current = clampedWidth;
    setNavWidth(clampedWidth);
  }, [navMaxStoredWidth]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resizeStart = resizeStartRef.current;
      if (!resizeStart) return;

      // 鼠标位移按字号还原到标准字号下的宽度，保证不同字号拖拽手感一致。
      applyNavWidth(resizeStart.width + (event.clientX - resizeStart.x) / fontScale);
    };

    const handlePointerUp = () => {
      if (!resizeStartRef.current) return;
      resizeStartRef.current = null;
      // 只在拖拽结束时写一次存储，避免 pointermove 高频写入。
      writeSettingsNavWidth(navWidthRef.current);
      setIsResizingNav(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    // 指针取消或窗口失焦时同样结束拖拽，否则状态会一直停在拖拽中。
    window.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('blur', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('blur', handlePointerUp);
    };
  }, [applyNavWidth, fontScale]);

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeStartRef.current = { x: event.clientX, width: navWidthRef.current };
    setIsResizingNav(true);
  };

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    applyNavWidth(navWidth + direction * SETTINGS_NAV_KEYBOARD_STEP);
    // 键盘调整没有拖拽结束事件，需要立即落盘。
    writeSettingsNavWidth(navWidthRef.current);
  };

  if (!isOpen && !isAnimating) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div
        className={`absolute inset-0 bg-black/40 backdrop-blur-sm ${isVisible ? 'modal-overlay-in' : enteredRef.current ? 'modal-overlay-out' : 'opacity-0'}`}
        onClick={onClose}
      />

      <div className={`relative h-[80vh] w-[76vw] min-h-0 min-w-0 max-h-[calc(100vh-24px)] max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl bg-[var(--bg-card)] shadow-2xl ${isVisible ? 'modal-content-in' : enteredRef.current ? 'modal-content-out' : 'opacity-0'}`}>
        <div className={`flex h-full${isResizingNav ? ' settings-modal--resizing' : ''}`}>
          <aside
            className="relative shrink-0 border-r border-[var(--border-color)] bg-[var(--bg-main)] py-4"
            style={{ width: renderedNavWidth }}
          >
            <div className="mb-4 px-4">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('title')}</h2>
            </div>
            <nav className="space-y-1 px-2">
              {SETTINGS_TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${activeTab === id
                    ? 'bg-[var(--brand-green-10)] font-medium text-[var(--brand-green)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="whitespace-nowrap">{t(label)}</span>
                </button>
              ))}
            </nav>

            {/* 拖拽热区压在左右分界线上，不影响菜单内容宽度，同时支持左右方向键微调。 */}
            <div
              className="settings-modal__nav-resize-handle"
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label={t('navResize')}
              aria-valuemin={renderedNavWidthMin}
              aria-valuemax={renderedNavWidthMax}
              aria-valuenow={renderedNavWidth}
              style={{ touchAction: 'none' }}
              onPointerDown={handleResizeStart}
              onKeyDown={handleResizeKeyDown}
            />
          </aside>

          <section className="flex min-w-0 flex-1 flex-col bg-[var(--bg-card)]">
            <div className="flex min-h-12 items-center justify-between border-b border-[var(--border-color)] px-5">
              <h3 className="text-sm font-medium text-[var(--text-primary)]">
                {t(SETTINGS_TABS.find((tab) => tab.id === activeTab)?.label ?? 'title')}
              </h3>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                aria-label={t('close', { defaultValue: 'Close settings' })}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-5">
              {activeTab === 'general' && <GeneralSettings mode={mode} setMode={setMode} />}
              {activeTab === 'features' && <FeatureSettings />}
              {activeTab === 'disk-info' && <DiskInfoSettings />}
              {activeTab === 'guide' && <GuideSettings />}
              {activeTab === 'security' && <SecuritySettings />}
              {activeTab === 'feedback' && <FeedbackSettings />}
              {activeTab === 'about' && <AboutSettings />}
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default SettingsModal;
