// ============================================================================
// 系统瘦身模块组件
// 在仪表盘中展示系统瘦身功能
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { 
  Rocket, 
  Moon, 
  Package, 
  MemoryStick,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  ShieldAlert,
  ChevronRight,
  X
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { ModuleCard } from '../ModuleCard';
import { useToast } from '../Toast';
import { useDashboard } from '../../contexts/DashboardContext';
import { 
  getSystemSlimStatus, 
  disableHibernation, 
  cleanupWinsxs, 
  openVirtualMemorySettings,
  SlimItemStatus,
  SystemSlimStatus 
} from '../../api/commands';
import { formatSize } from '../../utils/format';

// ============================================================================
// 配置
// ============================================================================

const itemIcons: Record<string, typeof Moon> = {
  hibernation: Moon,
  winsxs: Package,
  pagefile: MemoryStick,
};

const itemColors: Record<string, { bg: string; text: string }> = {
  hibernation: { bg: 'bg-indigo-500/10', text: 'text-indigo-500' },
  winsxs: { bg: 'bg-amber-500/10', text: 'text-amber-500' },
  pagefile: { bg: 'bg-cyan-500/10', text: 'text-cyan-500' },
};

// ============================================================================
// 组件实现
// ============================================================================

export function SystemSlimModule() {
  const { modules, expandedModule, setExpandedModule, updateModuleState, triggerHealthRefresh, oneClickScanTrigger } = useDashboard();
  const moduleState = modules.system;
  const { showToast } = useToast();

  // 用于跟踪是否已处理过当前的一键扫描触发
  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [status, setStatus] = useState<SystemSlimStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showAdminWarning, setShowAdminWarning] = useState(true);

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

  // 监听 WinSxS 清理进度
  useEffect(() => {
    const unlisten = listen<{ status: string; message: string }>('winsxs-cleanup-progress', (event) => {
      if (event.payload.status === 'running') {
        showToast({ title: event.payload.message, type: 'info' });
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [showToast]);

  // 执行瘦身操作
  const handleAction = useCallback(async (item: SlimItemStatus) => {
    if (!status?.is_admin) {
      showToast({ title: '需要管理员权限', description: '请以管理员身份运行程序', type: 'error' });
      return;
    }

    setActionLoading(item.id);
    try {
      switch (item.id) {
        case 'hibernation':
          const hibResult = await disableHibernation();
          showToast({ title: '操作成功', description: hibResult, type: 'success' });
          break;
        case 'winsxs':
          showToast({ title: '正在清理', description: '系统组件存储清理中，这可能需要几分钟...', type: 'info' });
          const winsxsResult = await cleanupWinsxs();
          showToast({ title: '清理完成', description: winsxsResult, type: 'success' });
          break;
        case 'pagefile':
          await openVirtualMemorySettings();
          showToast({ title: '已打开设置', description: '请手动配置虚拟内存位置', type: 'info' });
          break;
      }
      
      await loadStatus();
      
      if (item.id === 'hibernation' || item.id === 'winsxs') {
        triggerHealthRefresh();
      }
    } catch (error) {
      showToast({ title: '操作失败', description: String(error), type: 'error' });
    } finally {
      setActionLoading(null);
    }
  }, [status, loadStatus, triggerHealthRefresh, showToast]);

  const isExpanded = expandedModule === 'system';

  return (
    <ModuleCard
      id="system"
      title="系统瘦身"
      description="通过调整系统配置，释放数 GB 的磁盘空间"
      icon={<Rocket className="w-6 h-6 text-emerald-600" />}
      iconBgClass="bg-emerald-600/15"
      status={moduleState.status}
      fileCount={moduleState.fileCount}
      totalSize={moduleState.totalSize}
      expanded={isExpanded}
      onToggleExpand={() => setExpandedModule(isExpanded ? null : 'system')}
      onScan={loadStatus}
      scanButtonText={loading ? '检测中...' : status ? '重新检测' : '检测状态'}
      error={moduleState.error}
      headerExtra={
        status && (
          <div className="flex items-center gap-2 text-xs">
            {status.is_admin ? (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600">
                <CheckCircle2 className="w-3 h-3" />
                管理员
              </span>
            ) : (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600">
                <ShieldAlert className="w-3 h-3" />
                需要权限
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
              <p className="text-xs font-medium text-amber-600">需要管理员权限</p>
              <p className="text-[11px] text-[var(--fg-muted)] mt-0.5">
                请关闭程序，右键点击程序图标选择"以管理员身份运行"。
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
            <p className="text-sm text-[var(--fg-muted)]">正在检测系统状态...</p>
          </div>
        )}

        {/* 空状态 */}
        {moduleState.status === 'idle' && !status && (
          <div className="py-8 flex flex-col items-center justify-center text-center">
            <div className="w-12 h-12 bg-[var(--bg-hover)] rounded-2xl flex items-center justify-center mb-2">
              <Rocket className="w-6 h-6 text-[var(--fg-faint)]" />
            </div>
            <p className="text-sm font-medium text-[var(--fg-secondary)]">等待检测</p>
            <p className="text-xs text-[var(--fg-muted)] mt-1">点击检测按钮查看可优化项</p>
          </div>
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
                          <h4 className="text-sm font-semibold text-[var(--fg-primary)]">{item.name}</h4>
                          {item.enabled && item.size > 0 && (
                            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-600">
                              {formatSize(item.size)}
                            </span>
                          )}
                          {!item.enabled && item.id === 'hibernation' && (
                            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-[var(--bg-hover)] text-[var(--fg-muted)]">
                              已关闭
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[var(--fg-secondary)] mt-0.5">{item.description}</p>

                        {/* 风险提示 */}
                        <div className="mt-2 flex items-start gap-1.5 bg-amber-500/5 rounded-lg px-2 py-1.5">
                          <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0 mt-0.5" />
                          <p className="text-[10px] text-amber-600 leading-relaxed">{item.warning}</p>
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
                              <span>执行中</span>
                            </>
                          ) : (
                            <>
                              <span>{item.action_text}</span>
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
            <strong className="text-[var(--fg-secondary)]">提示：</strong>
            系统瘦身操作会修改 Windows 系统配置，建议在执行前了解各项功能的作用。
          </div>
        )}
      </div>
    </ModuleCard>
  );
}

export default SystemSlimModule;
