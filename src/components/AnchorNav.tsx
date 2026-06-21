// ============================================================================
// 模块侧边导航组件
// 卡片布局下执行锚点滚动；页面布局下切换当前模块页面。
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigation, PanelLeft } from 'lucide-react';
import { APP_MODULE_META, type AppModuleId } from '../config/moduleMeta';
import { useSettings } from '../contexts';

interface AnchorNavProps {
  /** 滚动容器的 ref；卡片模式下用于监听滚动和执行滚动。 */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
}

export function AnchorNav({ scrollContainerRef }: AnchorNavProps) {
  const { settings, updateSettings } = useSettings();
  const [isHovered, setIsHovered] = useState(false);
  const [activeAnchorId, setActiveAnchorId] = useState<AppModuleId>(settings.activeModuleId);
  const hoverTimeoutRef = useRef<number | null>(null);
  // 点击锁定用于平滑滚动期间保持高亮，避免滚动事件把 active 状态短暂切到相邻模块。
  const clickLockRef = useRef<{ id: AppModuleId; timeout: number } | null>(null);
  const isPageMode = settings.layoutMode === 'pages';
  const activeId = isPageMode ? settings.activeModuleId : activeAnchorId;
  const TriggerIcon = isPageMode ? PanelLeft : Navigation;

  const handleNavigate = useCallback((moduleId: AppModuleId) => {
    if (isPageMode) {
      // 页面模式只切换全局 activeModuleId，模块本身仍常驻挂载，避免扫描结果和弹窗状态丢失。
      updateSettings({ activeModuleId: moduleId });
      return;
    }

    const container = scrollContainerRef.current;
    if (!container) return;

    const targetElement = container.querySelector(`[data-module-id="${moduleId}"]`);
    if (!targetElement) return;

    setActiveAnchorId(moduleId);
    if (clickLockRef.current?.timeout) {
      clearTimeout(clickLockRef.current.timeout);
    }
    clickLockRef.current = {
      id: moduleId,
      timeout: window.setTimeout(() => {
        clickLockRef.current = null;
      }, 600),
    };

    const containerRect = container.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();
    const scrollTop = container.scrollTop + targetRect.top - containerRect.top - 16;
    container.scrollTo({ top: scrollTop, behavior: 'smooth' });
  }, [isPageMode, scrollContainerRef, updateSettings]);

  useEffect(() => {
    if (isPageMode) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (clickLockRef.current) return;

      const containerRect = container.getBoundingClientRect();
      const containerTop = containerRect.top;
      let currentActiveId = APP_MODULE_META[0]?.id ?? settings.activeModuleId;
      let minDistance = Infinity;

      for (const moduleConfig of APP_MODULE_META) {
        const element = container.querySelector(`[data-module-id="${moduleConfig.id}"]`);
        if (!element) continue;

        const rect = element.getBoundingClientRect();
        const relativeTop = rect.top - containerTop;
        if (relativeTop <= containerRect.height * 0.5 && rect.bottom > containerTop) {
          const distance = Math.abs(relativeTop);
          if (relativeTop >= -50 && distance < minDistance) {
            minDistance = distance;
            currentActiveId = moduleConfig.id;
          } else if (relativeTop < -50 && !currentActiveId) {
            currentActiveId = moduleConfig.id;
          }
        }
      }

      setActiveAnchorId(currentActiveId);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => container.removeEventListener('scroll', handleScroll);
  }, [isPageMode, scrollContainerRef, settings.activeModuleId]);

  const handleMouseEnter = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    setIsHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    hoverTimeoutRef.current = window.setTimeout(() => {
      setIsHovered(false);
    }, 150);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
      if (clickLockRef.current?.timeout) {
        clearTimeout(clickLockRef.current.timeout);
      }
    };
  }, []);

  return (
    <div
      className="fixed left-3 top-1/2 -translate-y-1/2 z-50"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className={`
          flex items-center justify-center w-8 h-8 rounded-lg
          bg-[var(--bg-card)] border border-[var(--border-default)]
          shadow-lg cursor-pointer
          transition-all duration-300 ease-out
          hover:border-[var(--brand-green)] hover:shadow-[var(--brand-green)]/20
          ${isHovered ? 'opacity-0 scale-75 pointer-events-none' : 'opacity-100 scale-100'}
        `}
      >
        <TriggerIcon className="w-4 h-4 text-[var(--text-muted)]" />
      </div>

      <div
        className={`
          absolute left-0 top-1/2 -translate-y-1/2
          bg-[var(--bg-card)] border border-[var(--border-default)]
          rounded-xl shadow-xl overflow-hidden
          transition-all duration-300 ease-out
          ${isHovered
            ? 'opacity-100 scale-100 translate-x-0'
            : 'opacity-0 scale-95 -translate-x-2 pointer-events-none'
          }
        `}
      >
        <div className="py-1.5">
          {APP_MODULE_META.map((moduleConfig) => {
            const Icon = moduleConfig.icon;
            const isActive = activeId === moduleConfig.id;

            return (
              <button
                key={moduleConfig.id}
                onClick={() => handleNavigate(moduleConfig.id)}
                className={`
                  w-full flex items-center gap-2.5 px-3 py-2 text-left
                  transition-all duration-200
                  ${isActive
                    ? 'bg-[var(--brand-green)]/10 text-[var(--brand-green)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                  }
                `}
              >
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-[var(--brand-green)]' : ''}`} />
                <span className="text-xs font-medium whitespace-nowrap">{moduleConfig.label}</span>
                {isActive && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--brand-green)]" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
