// 侧边栏布局导航
// 侧边栏模式将原有悬浮导航变为稳定的内容列，避免菜单遮挡模块结果。

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { APP_MODULE_META, type AppModuleId } from '../config/moduleMeta';
import { FONT_SIZE_CONFIGS, useFontSize, useSettings } from '../contexts';

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'c-cleanup-sidebar-collapsed';
const SIDEBAR_WIDTH_STORAGE_KEY = 'c-cleanup-sidebar-width';
// 宽度以标准字号下的像素保存，实际显示宽度会随用户字号同比缩放。
const SIDEBAR_WIDTH_DEFAULT = 220;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 360;

function readCollapsedState(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch (error) {
    // 存储不可用时使用展开状态，保证用户仍能看到完整的功能名称。
    console.warn('读取侧边栏状态失败:', error);
    return false;
  }
}

function writeCollapsedState(isCollapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isCollapsed));
  } catch (error) {
    // 当前会话的折叠仍然有效，存储失败只影响下次启动的默认状态。
    console.warn('保存侧边栏状态失败:', error);
  }
}

function readSidebarWidth(): number {
  try {
    const savedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(savedWidth)
      ? Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(savedWidth)))
      : SIDEBAR_WIDTH_DEFAULT;
  } catch (error) {
    // 存储不可用时使用默认宽度，避免侧边栏因本地数据问题无法显示。
    console.warn('读取侧边栏宽度失败:', error);
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function writeSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch (error) {
    // 当前会话的拖拽结果仍保留，存储失败只影响下次启动的宽度。
    console.warn('保存侧边栏宽度失败:', error);
  }
}

export function SidebarNav() {
  const { t } = useTranslation('nav');
  const { level, customFontSize } = useFontSize();
  const { settings, updateSettings } = useSettings();
  const [isCollapsed, setIsCollapsed] = useState(readCollapsedState);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [tooltip, setTooltip] = useState<{ label: string; top: number; left: number } | null>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const fontScale = (level === 'custom' ? customFontSize : FONT_SIZE_CONFIGS[level].baseSize + FONT_SIZE_CONFIGS[level].offset) / FONT_SIZE_CONFIGS.standard.baseSize;
  const renderedSidebarWidth = Math.round(sidebarWidth * fontScale);
  const renderedSidebarWidthMin = Math.round(SIDEBAR_WIDTH_MIN * fontScale);
  const renderedSidebarWidthMax = Math.round(SIDEBAR_WIDTH_MAX * fontScale);

  useEffect(() => {
    writeCollapsedState(isCollapsed);
  }, [isCollapsed]);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isCollapsed) setTooltip(null);
  }, [isCollapsed]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resizeStart = resizeStartRef.current;
      if (!resizeStart) return;

      const nextWidth = Math.min(
        SIDEBAR_WIDTH_MAX,
        Math.max(SIDEBAR_WIDTH_MIN, Math.round(resizeStart.width + (event.clientX - resizeStart.x) / fontScale)),
      );
      sidebarWidthRef.current = nextWidth;
      setSidebarWidth(nextWidth);
    };

    const handlePointerUp = () => {
      if (!resizeStartRef.current) return;
      resizeStartRef.current = null;
      writeSidebarWidth(sidebarWidthRef.current);
      setIsResizing(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    // 窗口失焦时也结束本次拖拽，避免鼠标离开应用后宽度状态一直卡在拖拽中。
    window.addEventListener('blur', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('blur', handlePointerUp);
    };
  }, [fontScale]);

  const handleNavigate = (moduleId: AppModuleId) => {
    if (moduleId === settings.activeModuleId) return;
    // 仅更新活动模块，不触碰模块实例，保证扫描中的状态和结果继续保留。
    updateSettings({ activeModuleId: moduleId });
  };

  const toggleLabel = isCollapsed ? t('sidebarExpand') : t('sidebarCollapse');

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isCollapsed) return;
    event.preventDefault();
    resizeStartRef.current = { x: event.clientX, width: sidebarWidthRef.current };
    setIsResizing(true);
  };

  const handleItemMouseEnter = (event: ReactMouseEvent<HTMLButtonElement>, label: string) => {
    if (!isCollapsed) return;
    const itemRect = event.currentTarget.getBoundingClientRect();
    setTooltip({ label, top: itemRect.top + itemRect.height / 2, left: itemRect.right + 10 });
  };

  return (
    <aside
      className={`sidebar-nav${isCollapsed ? ' sidebar-nav--collapsed' : ''}${isResizing ? ' sidebar-nav--resizing' : ''}`}
      style={{ '--sidebar-nav-width': `${renderedSidebarWidth}px` } as CSSProperties}
      aria-label={t('sidebarLabel')}
    >
      <div className="sidebar-nav__header">
        {!isCollapsed && <span className="sidebar-nav__title">{t('sidebarLabel')}</span>}
        <button
          type="button"
          className="sidebar-nav__toggle"
          onClick={() => setIsCollapsed((previous) => !previous)}
          aria-label={toggleLabel}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </button>
      </div>

      <nav className="sidebar-nav__list">
        {APP_MODULE_META.map(({ id, label, icon: Icon }) => {
          const isActive = settings.activeModuleId === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => handleNavigate(id)}
              className={`sidebar-nav__item${isActive ? ' sidebar-nav__item--active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              aria-label={t(label)}
              onMouseEnter={(event) => handleItemMouseEnter(event, t(label))}
              onMouseLeave={() => setTooltip(null)}
            >
              <Icon className="sidebar-nav__item-icon" />
              {!isCollapsed && <span className="sidebar-nav__item-label">{t(label)}</span>}
              {isActive && <span className="sidebar-nav__active-mark" aria-hidden="true" />}
            </button>
          );
        })}
      </nav>
      {!isCollapsed && (
        <div
          className="sidebar-nav__resize-handle"
          role="separator"
          tabIndex={0}
          aria-label={t('sidebarResize')}
          aria-orientation="vertical"
          aria-valuemin={renderedSidebarWidthMin}
          aria-valuemax={renderedSidebarWidthMax}
          aria-valuenow={renderedSidebarWidth}
          style={{ touchAction: 'none' }}
          onPointerDown={handleResizeStart}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const direction = event.key === 'ArrowRight' ? 1 : -1;
            const nextWidth = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, sidebarWidth + direction * Math.max(1, Math.round(10 / fontScale))));
            setSidebarWidth(nextWidth);
            sidebarWidthRef.current = nextWidth;
            writeSidebarWidth(nextWidth);
          }}
        />
      )}
      {isCollapsed && tooltip && createPortal(
        <div
          className="sidebar-nav__tooltip"
          role="tooltip"
          style={{ top: `${tooltip.top}px`, left: `${tooltip.left}px` }}
        >
          {tooltip.label}
        </div>,
        document.body,
      )}
    </aside>
  );
}
