// ============================================================================
// 系统瘦身模块组件
// 在仪表盘中展示系统瘦身功能
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  Rocket, 
  Moon, 
  Package, 
  MemoryStick,
  Search,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  ShieldAlert,
  ChevronRight,
  X
} from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { EmptyState } from '../EmptyState';
import { useToast } from '../Toast';
import { useModuleDashboard } from '../../contexts/DashboardContext';
import {
  getSystemSlimStatus,
  disableHibernation,
  enableHibernation,
  cleanupWinsxs,
  cleanupWinsxsResetbase,
  openVirtualMemorySettings,
  rebuildSearchIndex,
  SlimItemStatus,
  SystemSlimStatus
} from '../../api/commands';
import { formatSize } from '../../utils/format';
import { shouldSkipInactivePageRender, type ModuleRenderProps } from './moduleProps';

// ============================================================================
// 配置
// ============================================================================

const itemIcons: Record<string, typeof Moon> = {
  hibernation: Moon,
  winsxs: Package,
  winsxs_resetbase: Package,
  pagefile: MemoryStick,
  search_index: Search,
};

const itemColors: Record<string, { bg: string; text: string }> = {
  hibernation: { bg: 'bg-indigo-500/10', text: 'text-indigo-500' },
  winsxs: { bg: 'bg-amber-500/10', text: 'text-amber-500' },
  winsxs_resetbase: { bg: 'bg-orange-500/10', text: 'text-orange-500' },
  pagefile: { bg: 'bg-cyan-500/10', text: 'text-cyan-500' },
  search_index: { bg: 'bg-blue-500/10', text: 'text-blue-500' },
};

function buildWinsxsResultMessage(item: SlimItemStatus, translate: (key: string, options?: Record<string, unknown>) => string): string {
  const estimate = item.size > 0 ? translate('systemSlim.estimatedReclaim', { size: formatSize(item.size) }) : '';
  if (item.id === 'winsxs_resetbase') {
    return `${translate('systemSlim.resetBaseCompleted')} ${estimate}`.trim();
  }
  return `${translate('systemSlim.componentCleanupCompleted')} ${estimate}`.trim();
}

// ============================================================================
// 组件实现
// ============================================================================

export function SystemSlimModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
  const { t: navT } = useTranslation('nav');
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  const { moduleState, expandedModule, setExpandedModule, updateModuleState, triggerHealthRefresh, oneClickScanTrigger } = useModuleDashboard('system');
  const { showToast } = useToast();

  // 用于跟踪是否已处理过当前的一键扫描触发
  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [status, setStatus] = useState<SystemSlimStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showAdminWarning, setShowAdminWarning] = useState(true);

  const markItemsNeedRescan = useCallback((itemIds: string[]) => {
    setStatus((current) => {
      if (!current) return current;
      const idSet = new Set(itemIds);
      const items = current.items.map((item) => {
        if (!idSet.has(item.id)) return item;
        return {
          ...item,
          enabled: false,
          size: 0,
          actionable: false,
          action_text: moduleT('systemSlim.rescan'),
          status_text: moduleT('systemSlim.done'),
        };
      });
      updateModuleState('system', {
        fileCount: items.filter((item) => item.actionable).length,
        totalSize: items.filter((item) => item.enabled).reduce((sum, item) => sum + item.size, 0),
      });
      return { ...current, items, total_reclaimable: items.filter((item) => item.enabled).reduce((sum, item) => sum + item.size, 0) };
    });
  }, [updateModuleState]);

  // 加载系统瘦身状态
  const loadStatus = useCallback(async () => {
    setLoading(true);
    updateModuleState('system', { status: 'scanning' });
    
    try {
      const result = await getSystemSlimStatus();
      setStatus(result);
      
      updateModuleState('system', {
        status: 'done',
        fileCount: result.items.filter(i => i.actionable).length,
        totalSize: result.total_reclaimable,
      });

      setExpandedModule('system');
    } catch (error) {
      console.error('加载系统瘦身状态失败:', error);
      updateModuleState('system', { status: 'error', error: String(error) });
    } finally {
      setLoading(false);
    }
  }, [updateModuleState, setExpandedModule]);

  // 监听一键扫描触发器
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      loadStatus();
    }
  }, [oneClickScanTrigger, loadStatus]);

  // 执行瘦身操作
  const handleAction = useCallback(async (item: SlimItemStatus) => {
    if (!status?.is_admin) {
      showToast({ title: moduleT('systemSlim.adminRequired'), description: moduleT('systemSlim.adminHint'), type: 'error' });
      return;
    }

    setActionLoading(item.id);
    try {
      switch (item.id) {
        case 'hibernation':
          if (item.enabled) {
            await disableHibernation();
            showToast({ title: moduleT('systemSlim.operationCompleted'), description: moduleT('systemSlim.operationCompletedDesc'), type: 'success' });
          } else {
            await enableHibernation();
            showToast({ title: moduleT('systemSlim.operationCompleted'), description: moduleT('systemSlim.operationCompletedDesc'), type: 'success' });
          }
          markItemsNeedRescan(['hibernation']);
          break;
        case 'winsxs':
          await cleanupWinsxs();
          showToast({ title: moduleT('systemSlim.componentCleanup'), description: buildWinsxsResultMessage(item, moduleT), type: 'success' });
          markItemsNeedRescan(['winsxs', 'winsxs_resetbase']);
          break;
        case 'winsxs_resetbase':
          await cleanupWinsxsResetbase();
          showToast({ title: moduleT('systemSlim.resetBaseCompletedTitle'), description: buildWinsxsResultMessage(item, moduleT), type: 'success' });
          markItemsNeedRescan(['winsxs', 'winsxs_resetbase']);
          break;
        case 'pagefile':
          await openVirtualMemorySettings();
          showToast({ title: moduleT('systemSlim.settingsOpened'), description: moduleT('systemSlim.pagefileOpened'), type: 'info' });
          break;
        case 'search_index':
          await rebuildSearchIndex();
          showToast({ title: moduleT('systemSlim.searchIndexRebuildStartedTitle'), description: moduleT('systemSlim.searchIndexRebuildStarted'), type: 'success' });
          break;
      }

      if (item.id === 'hibernation' || item.id === 'winsxs' || item.id === 'winsxs_resetbase') {
        triggerHealthRefresh();
      }
    } catch (error) {
      showToast({ title: moduleT('systemSlim.operationFailed'), description: String(error), type: 'error' });
    } finally {
      setActionLoading(null);
    }
  }, [status, triggerHealthRefresh, showToast, markItemsNeedRescan]);

  const isExpanded = expandedModule === 'system';

  if (shouldSkipInactivePageRender(layoutMode, isPageActive) && !actionLoading) {
    return null;
  }

  return (
    <ModuleCard
        variant={layoutMode === 'pages' ? 'page' : 'card'}
        forceExpanded={layoutMode === 'pages'}
      id="system"
        title={navT('systemSlim')}
        description={navT('systemSlimDesc')}
      icon={<Rocket className="w-6 h-6 text-[var(--brand-green)]" />}
      status={moduleState.status}
      fileCount={moduleState.fileCount}
      totalSize={moduleState.totalSize}
      expanded={isExpanded}
      onToggleExpand={() => setExpandedModule(isExpanded ? null : 'system')}
      onScan={loadStatus}
      scanButtonText={loading ? moduleT('systemSlim.checking') : status ? moduleT('systemSlim.rescan') : moduleT('systemSlim.check')}
      error={moduleState.error}
      headerExtra={
        status && (
          <div className="flex items-center gap-2 text-xs">
            {status.is_admin ? (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600">
                <CheckCircle2 className="w-3 h-3" />
                {moduleT('systemSlim.administrator')}
              </span>
            ) : (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600">
                <ShieldAlert className="w-3 h-3" />
                {moduleT('systemSlim.permissionRequired')}
              </span>
            )}
          </div>
        )
      }
    >
      {/* 展开内容 */}
      <div className="p-4 space-y-3">
        {/* 管理员权限警告 */}
        {status && !status.is_admin && showAdminWarning && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2 flex items-start gap-2 relative">
            <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs font-medium text-amber-600">{moduleT('systemSlim.adminRequired')}</p>
              <p className="text-[11px] text-[var(--fg-muted)] mt-0.5">
                {moduleT('systemSlim.adminHint')}
              </p>
            </div>
            <button onClick={() => setShowAdminWarning(false)} className="text-amber-500 hover:text-amber-700 transition shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* 加载状态 */}
        {loading && !status && (
          <div className="py-8 flex flex-col items-center justify-center">
            <Loader2 className="w-7 h-7 text-emerald-500 animate-spin mb-2" />
            <p className="text-sm text-[var(--fg-muted)]">{moduleT('systemSlim.checking')}...</p>
          </div>
        )}

        {/* 空状态 */}
        {moduleState.status === 'idle' && !status && (
          <EmptyState
            icon={Rocket}
              title={t('notScannedSystemState')}
            description={moduleT('systemSlim.emptyDesc')}
          />
        )}

        {/* 瘦身项列表 */}
        {status && (
          <div className="space-y-2">
            {status.items.map((item) => {
              const Icon = itemIcons[item.id] || Package;
              const colors = itemColors[item.id] || itemColors.winsxs;
              const isLoading = actionLoading === item.id;

              return (
                <div
                  key={item.id}
                  className={`bg-[var(--bg-base)] rounded-xl border border-[var(--border-default)] overflow-hidden transition-all ${
                    item.actionable ? 'hover:border-emerald-500/30' : 'opacity-60'
                  }`}
                >
                  <div className="p-4">
                    <div className="flex items-start gap-3">
                      {/* 图标 */}
                      <div className={`w-10 h-10 rounded-lg ${colors.bg} flex items-center justify-center shrink-0`}>
                        <Icon className={`w-5 h-5 ${colors.text}`} />
                      </div>

                      {/* 内容 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-semibold text-[var(--fg-primary)]">
                            {moduleT(`systemSlim.items.${item.id}.name`, { defaultValue: item.name })}
                            {/* 搜索索引重建依赖本机 SearchAPI.dll，尚未在真实环境充分验证，临时标注 Beta */}
                            {item.id === 'search_index' && <span className="ml-1">（Beta）</span>}
                          </h4>
                          {item.enabled && item.size > 0 && (
                            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-600">
                              {formatSize(item.size)}
                            </span>
                          )}
                          {!item.enabled && item.id === 'hibernation' && (
                            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-[var(--bg-hover)] text-[var(--fg-muted)]">
                              {moduleT('systemSlim.disabled')}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[var(--fg-secondary)] mt-0.5">{moduleT(`systemSlim.items.${item.id}.description`, { defaultValue: item.description })}</p>
                        {item.status_text && (
                          <p className="text-[11px] text-[var(--fg-muted)] mt-1">
                            {item.id === 'search_index' ? (
                              // 搜索索引的 itemStatus 键是固定文案；可操作时展示动态状态（服务 + 数据库大小），
                              // 不可操作时直接展示后端细分的置灰原因（服务停止/已禁用/未安装）
                              item.actionable ? (
                                <>
                                  {moduleT('systemSlim.searchIndexServiceRunning')}
                                  {item.size > 0 && (
                                    <> · {moduleT('systemSlim.searchIndexDbSize', { size: formatSize(item.size) })}</>
                                  )}
                                </>
                              ) : (
                                item.status_text
                              )
                            ) : (
                              moduleT('systemSlim.itemStatus', { defaultValue: item.status_text })
                            )}
                          </p>
                        )}

                        {/* 风险提示 */}
                        <div className="mt-2 flex items-start gap-1.5 bg-amber-500/5 rounded-lg px-2 py-1.5">
                          <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0 mt-0.5" />
                          <p className="text-[10px] text-amber-600 leading-relaxed">{moduleT(`systemSlim.items.${item.id}.warning`, { defaultValue: item.warning })}</p>
                        </div>
                      </div>

                      {/* 操作按钮 */}
                      <div className="shrink-0">
                        <button
                          onClick={() => handleAction(item)}
                          disabled={!item.actionable || isLoading || !status.is_admin}
                          className={`
                            px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5
                            ${item.actionable && status.is_admin
                              ? 'bg-emerald-500 text-white hover:bg-emerald-600 active:scale-95'
                              : 'bg-[var(--bg-hover)] text-[var(--fg-muted)] cursor-not-allowed'
                            }
                          `}
                        >
                          {isLoading ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin" />
                              <span>{moduleT('systemSlim.executing')}</span>
                            </>
                          ) : (
                            <>
                              <span>
                                {/* 搜索索引置灰时按钮直接显示后端细分原因（服务停止/已禁用/未安装），避免误导为可重建 */}
                                {item.id === 'search_index' && !item.actionable
                                  ? item.action_text
                                  : moduleT(`systemSlim.items.${item.id}.action`, { defaultValue: item.action_text })}
                              </span>
                              <ChevronRight className="w-3 h-3" />
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 底部说明 */}
        {status && (
          <div className="bg-[var(--bg-elevated)] rounded-lg px-3 py-2 text-[10px] text-[var(--fg-muted)] leading-relaxed">
            <strong className="text-[var(--fg-secondary)]">{moduleT('systemSlim.tip')}</strong>
            {moduleT('systemSlim.tipDesc')}
          </div>
        )}
      </div>
    </ModuleCard>
  );
}

export default SystemSlimModule;
