import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ListChecks } from 'lucide-react';

export type ModuleOperationToolbarId = 'junk' | 'bigFiles' | 'social';

interface ModuleOperationToolbarProps {
  moduleId: ModuleOperationToolbarId;
  children: ReactNode;
}

const STORAGE_KEY_PREFIX = 'lightc.moduleOperationToolbar.';

function getStorageKey(moduleId: ModuleOperationToolbarId) {
  return `${STORAGE_KEY_PREFIX}${moduleId}`;
}

function readCollapsedState(moduleId: ModuleOperationToolbarId) {
  try {
    return window.localStorage.getItem(getStorageKey(moduleId)) === 'collapsed';
  } catch (error) {
    // 本地存储不可用时保持默认展开，避免操作区因为浏览器权限问题消失。
    console.warn('读取操作区折叠状态失败:', error);
    return false;
  }
}

function writeCollapsedState(moduleId: ModuleOperationToolbarId, isCollapsed: boolean) {
  try {
    window.localStorage.setItem(getStorageKey(moduleId), isCollapsed ? 'collapsed' : 'expanded');
  } catch (error) {
    // 写入失败不影响当前会话的折叠操作，但需要保留日志方便定位环境问题。
    console.warn('保存操作区折叠状态失败:', error);
  }
}

export function ModuleOperationToolbar({ moduleId, children }: ModuleOperationToolbarProps) {
  const { t } = useTranslation('common');
  const [isCollapsed, setIsCollapsed] = useState(() => readCollapsedState(moduleId));

  useEffect(() => {
    writeCollapsedState(moduleId, isCollapsed);
  }, [isCollapsed, moduleId]);

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
      {!isCollapsed && (
        <div className="module-operation-toolbar__actions">
          {children}
        </div>
      )}
    </div>,
    document.body,
  );
}
