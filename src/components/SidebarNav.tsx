// 侧边栏布局导航
// 侧边栏模式将原有悬浮导航变为稳定的内容列，避免菜单遮挡模块结果。

import { useEffect, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { APP_MODULE_META, type AppModuleId } from '../config/moduleMeta';
import { useSettings } from '../contexts';

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'c-cleanup-sidebar-collapsed';

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

export function SidebarNav() {
  const { t } = useTranslation('nav');
  const { settings, updateSettings } = useSettings();
  const [isCollapsed, setIsCollapsed] = useState(readCollapsedState);

  useEffect(() => {
    writeCollapsedState(isCollapsed);
  }, [isCollapsed]);

  const handleNavigate = (moduleId: AppModuleId) => {
    if (moduleId === settings.activeModuleId) return;
    // 仅更新活动模块，不触碰模块实例，保证扫描中的状态和结果继续保留。
    updateSettings({ activeModuleId: moduleId });
  };

  const toggleLabel = isCollapsed ? t('sidebarExpand') : t('sidebarCollapse');

  return (
    <aside className={`sidebar-nav${isCollapsed ? ' sidebar-nav--collapsed' : ''}`} aria-label={t('sidebarLabel')}>
      <div className="sidebar-nav__header">
        {!isCollapsed && <span className="sidebar-nav__title">{t('sidebarLabel')}</span>}
        <button
          type="button"
          className="sidebar-nav__toggle"
          onClick={() => setIsCollapsed((previous) => !previous)}
          aria-label={toggleLabel}
          title={toggleLabel}
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
              title={isCollapsed ? t(label) : undefined}
            >
              <Icon className="sidebar-nav__item-icon" />
              {!isCollapsed && <span className="sidebar-nav__item-label">{t(label)}</span>}
              {isActive && <span className="sidebar-nav__active-mark" aria-hidden="true" />}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
