// ============================================================================
// 锚点导航组件
// 悬浮在页面左侧，hover 显示功能模块菜单，点击平滑滚动到对应位置
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Trash2,
  FileBox,
  MessageCircle,
  Layers,
  Package,
  Database,
  MousePointerClick,
  Flame,
  HardDrive,
  Navigation,
} from 'lucide-react';

// 模块配置
const MODULE_ANCHORS = [
  { id: 'junk-clean', label: '垃圾清理', icon: Trash2 },
  { id: 'big-files', label: '大文件清理', icon: FileBox },
  { id: 'social-clean', label: '社交软件专清', icon: MessageCircle },
  { id: 'system-slim', label: '系统瘦身', icon: Layers },
  { id: 'leftovers', label: '卸载残留', icon: Package },
  { id: 'registry', label: '注册表冗余', icon: Database },
  { id: 'context-menu', label: '右键菜单清理', icon: MousePointerClick },
  { id: 'hotspot', label: '大目录分析', icon: Flame },
  { id: 'programdata', label: 'ProgramData 分析', icon: HardDrive },
];

interface AnchorNavProps {
  /** 滚动容器的 ref（用于监听滚动和执行滚动） */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
}

export function AnchorNav({ scrollContainerRef }: AnchorNavProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const hoverTimeoutRef = useRef<number | null>(null);
  // 点击锁定：点击锚点后临时锁定 activeId，避免滚动过程中误判
  const clickLockRef = useRef<{ id: string; timeout: number } | null>(null);

  // 点击锚点，平滑滚动到对应模块
  const handleAnchorClick = useCallback((moduleId: string) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const targetElement = container.querySelector(`[data-module-id="${moduleId}"]`);
    if (targetElement) {
      // 立即设置 activeId 并锁定
      setActiveId(moduleId);
      if (clickLockRef.current?.timeout) {
        clearTimeout(clickLockRef.current.timeout);
      }
      clickLockRef.current = {
        id: moduleId,
        timeout: window.setTimeout(() => {
          clickLockRef.current = null;
        }, 600), // 锁定 600ms，足够平滑滚动完成
      };

      const containerRect = container.getBoundingClientRect();
      const targetRect = targetElement.getBoundingClientRect();
      const scrollTop = container.scrollTop + targetRect.top - containerRect.top - 16; // 16px 顶部间距

      container.scrollTo({
        top: scrollTop,
        behavior: 'smooth',
      });
    }
  }, [scrollContainerRef]);

  // 监听滚动，更新当前激活的模块
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // 如果处于点击锁定状态，跳过判定
      if (clickLockRef.current) return;

      const containerRect = container.getBoundingClientRect();
      const containerTop = containerRect.top;

      // 找到顶部最接近容器顶部（但不超过太多）的模块
      let currentActiveId: string | null = null;
      let minDistance = Infinity;

      for (const anchor of MODULE_ANCHORS) {
        const element = container.querySelector(`[data-module-id="${anchor.id}"]`);
        if (element) {
          const rect = element.getBoundingClientRect();
          const relativeTop = rect.top - containerTop;

          // 模块顶部在容器顶部附近（-50px ~ 容器高度一半），且底部在视口内
          if (relativeTop <= containerRect.height * 0.5 && rect.bottom > containerTop) {
            // 优先选择顶部最接近容器顶部的（relativeTop 最接近 0 但不小于 -50）
            const distance = Math.abs(relativeTop);
            if (relativeTop >= -50 && distance < minDistance) {
              minDistance = distance;
              currentActiveId = anchor.id;
            } else if (relativeTop < -50 && currentActiveId === null) {
              // 如果模块已经滚过去了，也记录为当前项
              currentActiveId = anchor.id;
            }
          }
        }
      }

      setActiveId(currentActiveId);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll(); // 初始化

    return () => container.removeEventListener('scroll', handleScroll);
  }, [scrollContainerRef]);

  // 鼠标进入时延迟显示菜单
  const handleMouseEnter = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    setIsHovered(true);
  }, []);

  // 鼠标离开时延迟隐藏菜单
  const handleMouseLeave = useCallback(() => {
    hoverTimeoutRef.current = window.setTimeout(() => {
      setIsHovered(false);
    }, 150);
  }, []);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      className="fixed left-3 top-1/2 -translate-y-1/2 z-50"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* 收起状态：小图标 */}
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
        <Navigation className="w-4 h-4 text-[var(--text-muted)]" />
      </div>

      {/* 展开状态：菜单列表 */}
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
          {MODULE_ANCHORS.map((anchor) => {
            const Icon = anchor.icon;
            const isActive = activeId === anchor.id;

            return (
              <button
                key={anchor.id}
                onClick={() => handleAnchorClick(anchor.id)}
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
                <span className="text-xs font-medium whitespace-nowrap">{anchor.label}</span>
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
