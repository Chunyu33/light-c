// ============================================================================
// 系统瘦身模块组件
// 在仪表盘中展示系统瘦身功能
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
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
import { ModuleScanProgress } from '../ModuleScanProgress';
import { EmptyState } from '../EmptyState';
import { ConfirmDialog } from '../ConfirmDialog';
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
  SlimOperationProgress,
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

/**
 * 组装组件清理的结果提示。
 *
 * 中文说明：DISM 完成后组件存储体积会变化，重新检测一次并和操作前的体积比较，
 * 就能告诉用户"这次实际释放了多少"，而不是只重复操作前的估算值。
 * 检测失败不影响清理结果本身，因此这里吞掉异常并退化为不带数字的说明。
 */
async function buildCleanupResultMessage(
  item: SlimItemStatus,
  sizeBefore: number,
  translate: (key: string, options?: Record<string, unknown>) => string,
): Promise<string> {
  const conclusion = item.id === 'winsxs_resetbase'
    ? translate('systemSlim.resetBaseCompleted')
    : translate('systemSlim.componentCleanupCompleted');

  let actualReclaim = '';
  try {
    const latest = await getSystemSlimStatus();
    const sizeAfter = latest.items.find((current) => current.id === 'winsxs')?.size ?? 0;
    // 只有确实变小才算"实际释放"，否则宁可不说，避免出现负数或 0 的误导。
    if (sizeBefore > 0 && sizeAfter < sizeBefore) {
      actualReclaim = translate('systemSlim.actualReclaim', { size: formatSize(sizeBefore - sizeAfter) });
    }
  } catch (error) {
    console.warn('清理后重新检测体积失败:', error);
  }

  const estimate = item.size > 0 ? translate('systemSlim.estimatedReclaim', { size: formatSize(item.size) }) : '';
  return `${conclusion} ${actualReclaim} ${estimate}`.trim();
}

/**
 * 取按钮文案。
 *
 * 中文说明：按钮文案必须反映真实状态，而不是固定文案：
 *   - 休眠项：开启时"关闭休眠"，已关闭时"开启休眠"；
 *   - 后端 action_text 是中文（无需清理 / 深度清理 / 执行清理 / 重新检测），
 *     在其它语言下需要通过它反查对应的多语言键，避免英文/日文界面出现中文按钮。
 */
function getActionLabel(
  item: SlimItemStatus,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (item.id === 'hibernation') {
    return translate(item.enabled ? 'systemSlim.items.hibernation.disable' : 'systemSlim.items.hibernation.enable');
  }

  // action_text 与多语言键的对应关系；键顺序与后端文案一一对应。
  const actionTextToKey: Record<string, string> = {
    无需清理: 'noCleanup',
    开始清理: 'startCleanup',
    深度清理: 'deepCleanup',
    执行清理: 'runCleanup',
    重新检测: 'rescan',
    打开设置: 'openSettings',
  };
  const matchedKey = actionTextToKey[item.action_text];
  if (matchedKey) {
    return translate(`systemSlim.actions.${matchedKey}`);
  }

  // 后端新增文案而前端还没补多语言键时，至少不要退回静态旧文案（会造成状态不一致）。
  return item.action_text || translate(`systemSlim.items.${item.id}.action`);
}

/**
 * 格式化已用时间。
 *
 * 中文说明：DISM 清理的进度百分比长时间不动时，用户唯一能判断"还在跑"的依据就是已用时间，
 * 因此统一按「秒」或「分秒」显示，避免只显示毫秒造成困惑。
 */
function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
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
  // 正在执行的瘦身操作进度：DISM 清理可能持续数分钟，必须有阶段与百分比反馈。
  const [operationProgress, setOperationProgress] = useState<SlimOperationProgress | null>(null);
  const [showAdminWarning, setShowAdminWarning] = useState(true);
  // 基线压缩不可撤销，点击后先二次确认再执行。
  const [pendingConfirmItem, setPendingConfirmItem] = useState<SlimItemStatus | null>(null);
  // 确认弹窗回调需要拿到最新的处理函数，用 ref 避免为了它重建所有按钮回调。
  const handleActionRef = useRef<(item: SlimItemStatus) => void>(() => {});

  // 订阅后端进度事件；操作结束后保留最终状态，由操作流程负责清理。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    listen<SlimOperationProgress>('system-slim:progress', (event) => {
      if (!disposed) setOperationProgress(event.payload);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((error) => {
        // 订阅失败只影响进度展示，操作本身仍可执行，因此仅记录日志。
        console.error('订阅系统瘦身进度失败:', error);
      });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

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

  /**
   * 操作结束后立即重新读取后端状态。
   *
   * 中文说明：状态必须以后端为准。此前操作完成只做本地"标记需重新检测"，导致按钮文案和
   * 体积停留在操作前的快照（关掉休眠后仍显示"关闭休眠"、清理完仍显示旧的估算体积）。
   * 这里不复用 loadStatus，因为它带有"忙碌时拦截"的保护，而本函数正是在操作收尾阶段调用。
   */
  const refreshStatusAfterAction = useCallback(async () => {
    try {
      const result = await getSystemSlimStatus();
      setStatus(result);
      updateModuleState('system', {
        status: 'done',
        fileCount: result.items.filter((current) => current.actionable).length,
        totalSize: result.total_reclaimable,
      });
    } catch (error) {
      // 刷新失败不影响操作结果本身，退化为提示用户手动重新检测。
      console.warn('操作后刷新系统瘦身状态失败:', error);
      markItemsNeedRescan(['hibernation', 'winsxs', 'winsxs_resetbase']);
    }
  }, [markItemsNeedRescan, updateModuleState]);

  // 加载系统瘦身状态
  const loadStatus = useCallback(async () => {
    // 系统操作执行期间禁止重新检测：DISM 分析与清理并发会互相干扰，也会让状态显示错乱。
    if (actionLoading) {
      showToast({ title: moduleT('systemSlim.busyTitle'), description: moduleT('systemSlim.busyDesc'), type: 'info' });
      return;
    }

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
  }, [actionLoading, moduleT, showToast, updateModuleState, setExpandedModule]);

  // 监听一键扫描触发器
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      loadStatus();
    }
  }, [oneClickScanTrigger, loadStatus]);

  // 执行瘦身操作
  const runAction = useCallback(async (item: SlimItemStatus) => {
    if (!status?.is_admin) {
      showToast({ title: moduleT('systemSlim.adminRequired'), description: moduleT('systemSlim.adminHint'), type: 'error' });
      return;
    }

    // 同一时间只允许一个系统级操作：DISM 与 powercfg 并发会互相干扰且更难排查。
    if (actionLoading) {
      showToast({ title: moduleT('systemSlim.busyTitle'), description: moduleT('systemSlim.busyDesc'), type: 'info' });
      return;
    }

    setActionLoading(item.id);
    // 记录操作前的体积，操作完成后用真实差值告诉用户"实际释放了多少"，而不是只报估算值。
    const sizeBefore = status?.items.find((current) => current.id === item.id)?.size ?? 0;
    // 先用本地状态兜底，避免后端首条进度到达前出现"点了没反应"的空窗。
    setOperationProgress({
      item_id: item.id,
      phase: 'preparing',
      message: moduleT('systemSlim.progressPreparing'),
      percent: 0,
      status: 'running',
      elapsed_ms: 0,
    });

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
          break;
        case 'winsxs':
          await cleanupWinsxs();
          showToast({ title: moduleT('systemSlim.componentCleanup'), description: await buildCleanupResultMessage(item, sizeBefore, moduleT), type: 'success' });
          break;
        case 'winsxs_resetbase':
          await cleanupWinsxsResetbase();
          showToast({ title: moduleT('systemSlim.resetBaseCompletedTitle'), description: await buildCleanupResultMessage(item, sizeBefore, moduleT), type: 'success' });
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

      // 操作完成后重新读取真实状态：休眠是否关闭、组件是否还有可回收内容都必须以后端为准，
      // 否则按钮文案会停留在操作前的状态（例如关掉休眠后仍显示"关闭休眠"）。
      if (item.id !== 'pagefile' && item.id !== 'search_index') {
        await refreshStatusAfterAction();
      }

      if (item.id === 'hibernation' || item.id === 'winsxs' || item.id === 'winsxs_resetbase') {
        triggerHealthRefresh();
      }
    } catch (error) {
      showToast({ title: moduleT('systemSlim.operationFailed'), description: String(error), type: 'error' });
    } finally {
      setActionLoading(null);
      // 操作结束即撤下进度视图：成功由 toast 反馈，失败由错误 toast 反馈。
      setOperationProgress(null);
    }
  }, [actionLoading, moduleT, refreshStatusAfterAction, showToast, status, triggerHealthRefresh, markItemsNeedRescan]);

  // 让确认弹窗始终调用到最新的处理函数。
  useEffect(() => {
    handleActionRef.current = runAction;
  }, [runAction]);

  /**
   * 按钮入口：基线压缩会移除更新回滚基线、不可撤销，因此先弹二次确认；
   * 其余操作可逆，直接执行。
   */
  const handleAction = useCallback((item: SlimItemStatus) => {
    if (item.id === 'winsxs_resetbase') {
      setPendingConfirmItem(item);
      return;
    }
    void runAction(item);
  }, [runAction]);

  const isExpanded = expandedModule === 'system';
  // 任一系统操作执行中即视为忙碌：所有操作入口（按钮、重新检测）统一用它拦截。
  const isActionBusy = actionLoading !== null;

  if (shouldSkipInactivePageRender(layoutMode, isPageActive) && !actionLoading) {
    return null;
  }

  return (
    <>
      {/* 基线压缩不可撤销，必须二次确认后才执行 */}
      <ConfirmDialog
        isOpen={pendingConfirmItem !== null}
        title={moduleT('systemSlim.confirmResetBaseTitle')}
        description={moduleT('systemSlim.confirmResetBaseDesc')}
        warning={moduleT('systemSlim.items.winsxs_resetbase.warning')}
        confirmText={moduleT('systemSlim.confirmResetBaseConfirm')}
        cancelText={t('cancel')}
        onConfirm={() => {
          const item = pendingConfirmItem;
          setPendingConfirmItem(null);
          if (item) void handleActionRef.current(item);
        }}
        onCancel={() => setPendingConfirmItem(null)}
        isDanger
      />

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
      // 系统操作执行期间禁用重新检测，避免与 DISM 分析/清理并发。
      scanDisabled={isActionBusy}
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
          <ModuleScanProgress
            title={`${moduleT('systemSlim.checking')}...`}
            icon={<Loader2 className="h-7 w-7 animate-spin text-[var(--brand-green)]" />}
          />
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
              // 禁用条件与按钮样式共用同一个判定，避免"看着能点、点了没反应"。
              const isItemButtonDisabled = !item.actionable || !status.is_admin || isActionBusy;

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

                        {/* 执行进度：让用户看到阶段、百分比和已用时间 */}
                        {isLoading && operationProgress && operationProgress.item_id === item.id && (
                          <div className="mt-2 rounded-lg bg-emerald-500/10 px-3 py-2">
                            <div className="flex items-center justify-between gap-2 text-[11px] text-emerald-700 dark:text-emerald-400">
                              <span className="truncate">{operationProgress.message}</span>
                              <span className="shrink-0 tabular-nums">
                                {operationProgress.percent > 0 ? `${operationProgress.percent}%` : formatElapsed(operationProgress.elapsed_ms)}
                              </span>
                            </div>
                            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                              <div
                                className={`h-full rounded-full bg-emerald-500 transition-all duration-300 ${operationProgress.percent > 0 ? '' : 'w-1/3 animate-pulse'}`}
                                style={operationProgress.percent > 0 ? { width: `${operationProgress.percent}%` } : undefined}
                              />
                            </div>
                            <p className="mt-1.5 flex items-center gap-1 text-[10px] text-[var(--fg-muted)]">
                              <ShieldAlert className="h-3 w-3 shrink-0 text-amber-500" />
                              {moduleT('systemSlim.progressElapsed', { time: formatElapsed(operationProgress.elapsed_ms) })} · {moduleT('systemSlim.progressDoNotClose')}
                            </p>
                          </div>
                        )}
                      </div>

                      {/* 操作按钮 */}
                      <div className="shrink-0">
                        <button
                          onClick={() => handleAction(item)}
                          /*
                            只要有任何操作在跑就禁用全部按钮：DISM 与 powercfg 并发会互相干扰。
                            禁用条件必须和下方样式使用同一个判定，否则会出现"看得出能点、点了没反应"。
                          */
                          disabled={isItemButtonDisabled}
                          title={isActionBusy ? moduleT('systemSlim.waitForCurrent') : undefined}
                          className={`
                            px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5
                            ${isItemButtonDisabled
                              ? 'cursor-not-allowed bg-[var(--bg-hover)] text-[var(--fg-muted)]'
                              : 'bg-emerald-500 text-white hover:bg-emerald-600 active:scale-95'
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
                                {/*
                                  按钮文案必须随真实状态变化，因此按状态取多语言文案：
                                  休眠开启时显示"关闭休眠"，已关闭时显示"开启休眠"（此前一直静态显示"关闭休眠"）。
                                  其余按后端 action_text 反查对应多语言键，查不到才退化为后端原文。
                                */}
                                {getActionLabel(item, moduleT)}
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
    </>
  );
}

export default SystemSlimModule;
