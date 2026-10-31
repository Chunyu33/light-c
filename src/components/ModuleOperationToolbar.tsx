import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type ModuleOperationToolbarId = 'junk' | 'bigFiles' | 'social' | 'context' | 'aiTools';

interface ModuleOperationToolbarProps {
  moduleId: ModuleOperationToolbarId;
  /**
   * 忙碌态：用进度内容替换操作按钮。
   *
   * 操作条是 position: fixed 的悬浮层，所以进度放在这里**完全不占文档流** ——
   * 删除期间列表不会被撑开、也不会有位移。这是"用户自己挑子集删除"的模块
   * （社交专清/大文件/右键菜单/注册表）需要保留列表参照、又不想要布局跳动时的做法。
   */
  busy?: boolean;
  /** 忙碌态要显示的内容（通常是一段进度）。忙碌时替换掉 children，调用方无需改动原有按钮。 */
  busyContent?: ReactNode;
  children: ReactNode;
}

/**
 * 批量操作条：固定在视口底部居中。
 *
 * 为什么在底部而不是右侧悬浮：右侧会压住列表里的数字和行内图标，
 * 用户要先把它折叠起来才能看清内容；底部横排是「对选中项批量做事」的常规位置，
 * 而且横向排布不占用任何数据列。
 *
 * 为什么不做折叠：折叠态只剩一个图标，多数用户认不出那里是操作区 ——
 * 这比「挡住内容」更糟。收起/展开的代价会被转嫁到每一次使用上。
 *
 * moduleId 只用于标记操作区归属（React 靠调用位置区分实例），不参与渲染。
 */
export function ModuleOperationToolbar({ moduleId: _moduleId, busy = false, busyContent, children }: ModuleOperationToolbarProps) {
  return createPortal(
    <div className={`module-operation-toolbar${busy ? ' module-operation-toolbar--busy' : ''}`}>
      {/* 忙碌态用调用方给的现成内容替换按钮。组件本身不认识"删除"这件事 ——
          它只负责把内容放进悬浮层，文案与业务都不在这里，避免主题无关的逻辑渗透进来。 */}
      <div className="module-operation-toolbar__actions">
        {busy ? busyContent : children}
      </div>
    </div>,
    document.body,
  );
}
