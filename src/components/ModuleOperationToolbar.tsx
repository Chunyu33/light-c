import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ListChecks } from 'lucide-react';

export type ModuleOperationToolbarId = 'junk' | 'bigFiles' | 'social';

interface ModuleOperationToolbarProps {
  moduleId: ModuleOperationToolbarId;
  children: ReactNode;
}

// moduleId 用于标识操作区归属哪个模块（React 依赖调用位置区分实例），折叠状态不再依赖它做持久化。
export function ModuleOperationToolbar({ moduleId: _moduleId, children }: ModuleOperationToolbarProps) {
  const { t } = useTranslation('common');
  // 中文说明：折叠状态只属于当前会话，因此使用组件内部 state，不再写入 localStorage。
  // 垃圾清理、大文件清理、社交软件专清各自挂载一个实例，状态天然互相独立；
  // 每次启动或重新扫描后组件重新挂载，初始值固定为展开，避免上次收起的操作区在重启后仍然消失。
  const [isCollapsed, setIsCollapsed] = useState(false);

  const toggleLabel = isCollapsed ? t('expandToolbar') : t('collapseToolbar');

  return createPortal(
    <div className={`module-operation-toolbar${isCollapsed ? ' module-operation-toolbar--collapsed' : ''}`}>
      <button
        type="button"
        onClick={() => setIsCollapsed((previous) => !previous)}
        className="module-operation-toolbar__toggle"
        aria-label={toggleLabel}
        title={toggleLabel}
        aria-expanded={!isCollapsed}
      >
        {isCollapsed ? <ListChecks className="module-operation-toolbar__toggle-icon" /> : <ChevronLeft className="module-operation-toolbar__toggle-icon" />}
      </button>
      {/* 折叠时直接卸载按钮，保证操作区不再占用结果区空间；展开为瞬时切换，不做过渡动画。 */}
      {!isCollapsed && (
        <div className="module-operation-toolbar__actions">
          {children}
        </div>
      )}
    </div>,
    document.body,
  );
}
