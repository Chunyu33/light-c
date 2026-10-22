// 侧边栏布局导航
// 侧边栏模式将原有悬浮导航变为稳定的内容列，避免菜单遮挡模块结果。

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Github, Globe, ScrollText, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { APP_MODULE_META, type AppModuleId } from '../config/moduleMeta';
import { FONT_SIZE_CONFIGS, useFontSize, useSettings } from '../contexts';
import { getDistributionChannel, type DistributionChannel } from '../api/commands';
import { AUTHOR_HOMEPAGE_URL, LIGHTC_CHANGELOG_URL, LIGHTC_GITHUB_URL, LIGHTC_OFFICIAL_WEBSITE_URL } from '../config/officialLinks';

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'c-cleanup-sidebar-collapsed';
const SIDEBAR_WIDTH_STORAGE_KEY = 'c-cleanup-sidebar-width';
// 宽度以标准字号下的像素保存，实际显示宽度会随用户字号同比缩放。
const SIDEBAR_WIDTH_DEFAULT = 220;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 360;

/**
 * 侧边栏分组。
 *
 * 分组的轴是**"动哪里"**，不是"清理的粒度"（后者是硬凑的：12 个里 8 个都叫清理，
 * 按粒度切怎么切都不准 —— Evan 指出来过）。
 *   清理：删的是**文件**（缓存、大文件、聊天记录、卸载残留的文件）
 *   系统：动的是**系统配置**（系统组件、驱动仓库、注册表、右键菜单、外壳图标）
 *   分析：**只读**，不改任何东西（占用分布、变化量、模型空间）
 * 三层轴互不重叠，用户看一眼就知道这一组会不会动我的系统设置。
 */
const SIDEBAR_GROUPS: { id: string; ids: AppModuleId[] }[] = [
  { id: 'cleanup', ids: ['junk-clean', 'big-files', 'social-clean', 'leftovers'] },
  { id: 'system', ids: ['system-slim', 'driver-cleanup', 'registry', 'context-menu', 'shell-icons'] },
  { id: 'analyze', ids: ['hotspot', 'disk-growth', 'ai-models'] },
];

/** 模块 id → 元信息，供分组渲染时按 id 取图标与文案 */
const MODULE_META_BY_ID = new Map(APP_MODULE_META.map((meta) => [meta.id, meta]));

/**
 * 自绘的折叠图标：圆角外框 + 一条圆头竖线。
 *
 * 为什么不用图标库的 PanelLeft：那个外框圆角太小、线条偏硬，和侧边栏的
 * 大圆角面板/胶囊选中态不是一套语言（Evan 明确说"一看就是默认图标库的"）。
 * 这里把圆角放大到 4.5/16、线宽降到 1.5，并让竖线在折叠后翻到右侧，
 * 让图标本身就能表达当前状态。
 */
function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 20 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="18" height="14" rx="4.5" />
      <path d={collapsed ? 'M12.5 2v12' : 'M8 2v12'} />
    </svg>
  );
}

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
  // 版本/渠道的文案在 settings 命名空间里（关于页已经在用），这里直接复用，不复制一份
  const { t: settingsT } = useTranslation('settings');
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

  /**
   * 底部的版本信息。
   *
   * 只放**确定的事实**：程序版本、发行渠道（便携/安装）。这两项来自应用自身与安装登记，
   * 不存在"统计口径"问题 —— 之前那个"累计释放"是从清理日志汇总的，
   * 日志会被轮转，数字并不等于真实累计，所以撤掉了。
   */
  const [appVersion, setAppVersion] = useState('');
  const [channel, setChannel] = useState<DistributionChannel | null>(null);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch((error) => console.warn('读取版本号失败:', error));
    getDistributionChannel()
      .then(setChannel)
      .catch((error) => console.warn('读取发行渠道失败:', error));
  }, []);

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
      className={`sidebar-nav glass-chrome${isCollapsed ? ' sidebar-nav--collapsed' : ''}${isResizing ? ' sidebar-nav--resizing' : ''}`}
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
          <SidebarToggleIcon collapsed={isCollapsed} />
        </button>
      </div>

      <nav className="sidebar-nav__list">
        {SIDEBAR_GROUPS.map((group) => (
          <div key={group.id} className="sidebar-nav__group-block">
            {/* 折叠态没有文字，这一条会变成一根极淡的分组线（见 layout.css） */}
            <span className="sidebar-nav__group">{t(`groups.${group.id}`)}</span>
            {group.ids.map((moduleId) => {
              const meta = MODULE_META_BY_ID.get(moduleId);
              // 元信息缺项时跳过这一项，不让整个侧边栏崩掉
              if (!meta) return null;
              const { id, label, icon: Icon } = meta;
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
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* 底部：一行「官网 + 版本」，排版照抄菜单项（同左边缘、同图标间距），
          让它读起来是菜单的收尾，而不是两块散落的元信息。
          版本号右对齐用表格数字；渠道（便携/安装）放进 title，不占版面。 */}
      <div className="sidebar-nav__footer">
        {/* 折叠态只剩官网一个图标（4.25em 宽放不下两个，而且此时用户是在"图标模式"，
            多一个入口反而更难认）。文案一律走 title/aria-label。 */}
        <a
          href={LIGHTC_OFFICIAL_WEBSITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="sidebar-nav__footer-icon"
          aria-label={t('footerWebsite')}
          title={t('footerWebsite')}
        >
          <Globe size={15} strokeWidth={1.7} />
        </a>
        {!isCollapsed && (
          <a
            href={LIGHTC_CHANGELOG_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="sidebar-nav__footer-icon"
            aria-label={t('footerChangelog')}
            title={t('footerChangelog')}
          >
            <ScrollText size={15} strokeWidth={1.7} />
          </a>
        )}
        {!isCollapsed && (
          <a
            href={LIGHTC_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="sidebar-nav__footer-icon"
            aria-label="GitHub"
            title="GitHub"
          >
            <Github size={15} strokeWidth={1.7} />
          </a>
        )}
        {!isCollapsed && (
          <a
            href={AUTHOR_HOMEPAGE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="sidebar-nav__footer-icon"
            aria-label={t('footerAuthor')}
            title={t('footerAuthor')}
          >
            <UserRound size={15} strokeWidth={1.7} />
          </a>
        )}
        {!isCollapsed && appVersion ? (
          <span
            className="sidebar-nav__footer-version"
            title={channel ? settingsT(channel === 'portable' ? 'about.portable' : 'about.installer') : undefined}
          >
            v{appVersion}
          </span>
        ) : null}
      </div>

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
