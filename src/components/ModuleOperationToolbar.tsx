import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ListChecks } from 'lucide-react';

export type ModuleOperationToolbarId = 'junk' | 'bigFiles' | 'social' | 'context';

interface ModuleOperationToolbarProps {
  moduleId: ModuleOperationToolbarId;
  /**
   * 忙碌态：用进度内容替换折叠入口与操作按钮。
   *
   * 工具栏是 position: fixed 的悬浮层，所以进度放在这里**完全不占文档流** ——
   * 删除期间列表不会被撑开、也不会有位移。这是"用户自己挑子集删除"的模块
   * （社交专清/大文件/右键菜单/注册表）需要保留列表参照、又不想要布局跳动时的做法。
   */
  busy?: boolean;
  /** 忙碌态要显示的内容（通常是一段进度）。忙碌时替换掉 children，调用方无需改动原有按钮。 */
  busyContent?: ReactNode;
  children: ReactNode;
}

// moduleId 用于标识操作区归属哪个模块（React 依赖调用位置区分实例），折叠状态不再依赖它做持久化。
export function ModuleOperationToolbar({ moduleId: _moduleId, busy = false, busyContent, children }: ModuleOperationToolbarProps) {
  const { t } = useTranslation('common');
  // 中文说明：折叠状态只属于当前会话，因此使用组件内部 state，不再写入 localStorage。
  // 垃圾清理、大文件清理、社交软件专清各自挂载一个实例，状态天然互相独立；
  // 每次启动或重新扫描后组件重新挂载，初始值固定为展开，避免上次收起的操作区在重启后仍然消失。
  const [isCollapsed, setIsCollapsed] = useState(false);

  // 忙碌时不提供折叠：进度必须一直可见，而且此刻也没有"收起操作"的语义。
  const collapsed = busy ? false : isCollapsed;
  const toggleLabel = isCollapsed ? t('expandToolbar') : t('collapseToolbar');

  return createPortal(
    <div className={`module-operation-toolbar${collapsed ? ' module-operation-toolbar--collapsed' : ''}${busy ? ' module-operation-toolbar--busy' : ''}`}>
      {!busy && (
        <button
          type="button"
          onClick={() => setIsCollapsed((previous) => !previous)}
          className="module-operation-toolbar__toggle"
          aria-label={toggleLabel}
          title={toggleLabel}
          aria-expanded={!isCollapsed}
        >
          {/* 展开态箭头必须指右：工具栏固定在视口右侧、展开时向左延伸，
              点击的动效是把操作区收回右边缘，所以方向是「→」而不是「←」。
              收起态用清单图标而非箭头 —— 它更能表达"操作区还在这里"。 */}
          {isCollapsed ? <ListChecks className="module-operation-toolbar__toggle-icon" /> : <ChevronRight className="module-operation-toolbar__toggle-icon" />}
        </button>
      )}
      {/* 折叠时直接卸载按钮，保证操作区不再占用结果区空间；展开为瞬时切换，不做过渡动画。 */}
      {!collapsed && (
        <div className="module-operation-toolbar__actions">
          {/* 忙碌态用调用方给的现成内容替换按钮。组件本身不认识"删除"这件事 ——
              它只负责把内容放进悬浮层，文案与业务都不在这里，避免主题无关的逻辑渗透进来。 */}
          {busy ? busyContent : children}
        </div>
      )}
    </div>,
    document.body,
  );
}
