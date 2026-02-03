// ============================================================================
// 系统瘦身页面组件
// 通过修改系统配置释放大量磁盘空间
// ============================================================================

import { useEffect, useState } from 'react';
import { 
  Rocket, 
  Moon, 
  Package, 
  MemoryStick,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  ShieldAlert,
  RefreshCw,
  ChevronRight,
  X
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { 
  getSystemSlimStatus, 
  disableHibernation, 
  cleanupWinsxs, 
  openVirtualMemorySettings,
  SlimItemStatus,
  SystemSlimStatus 
} from '../api/commands';
import { BackButton, useToast } from '../components';
import { formatSize } from '../utils/format';

interface SystemSlimPageProps {
  onBack: () => void;
  onCleanupComplete?: () => void;
}

// 图标映射
const itemIcons: Record<string, typeof Moon> = {
  hibernation: Moon,
  winsxs: Package,
  pagefile: MemoryStick,
};

// 颜色映射
const itemColors: Record<string, { bg: string; text: string; border: string }> = {
  hibernation: { bg: 'bg-indigo-500/10', text: 'text-indigo-500', border: 'border-indigo-500/20' },
  winsxs: { bg: 'bg-amber-500/10', text: 'text-amber-500', border: 'border-amber-500/20' },
  pagefile: { bg: 'bg-cyan-500/10', text: 'text-cyan-500', border: 'border-cyan-500/20' },
};

export function SystemSlimPage({ onBack, onCleanupComplete }: SystemSlimPageProps) {
  const [status, setStatus] = useState<SystemSlimStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showAdminWarning, setShowAdminWarning] = useState(true);
  const { showToast } = useToast();

  // 加载系统瘦身状态
  const loadStatus = async () => {
    setLoading(true);
    try {
      const result = await getSystemSlimStatus();
      setStatus(result);
    } catch (error) {
      showToast({ title: `加载失败: ${error}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();

    // 监听 WinSxS 清理进度
    const unlisten = listen<{ status: string; message: string }>('winsxs-cleanup-progress', (event) => {
      if (event.payload.status === 'running') {
        showToast({ title: event.payload.message, type: 'info' });
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  // 执行瘦身操作
  const handleAction = async (item: SlimItemStatus) => {
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
      // 刷新状态
      await loadStatus();
      // 触发健康评分刷新（休眠和WinSxS操作会影响评分）
      if (item.id === 'hibernation' || item.id === 'winsxs') {
        onCleanupComplete?.();
      }
    } catch (error) {
      showToast({ title: '操作失败', description: `${error}`, type: 'error' });
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <>
      <BackButton onClick={onBack} />

      <div className="space-y-4">
        {/* 页面头部 */}
        <div className="bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl p-6 text-white">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-white/20 rounded-xl flex items-center justify-center">
              <Rocket className="w-7 h-7" />
            </div>
            <div className="flex-1">
              <h1 className="text-xl font-bold">系统瘦身</h1>
              <p className="text-sm text-white/80 mt-1">
                通过调整系统配置，释放数 GB 的磁盘空间
              </p>
            </div>
            <button
              onClick={loadStatus}
              disabled={loading}
              className="p-2 hover:bg-white/10 rounded-lg transition"
              title="刷新状态"
            >
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* 统计信息 */}
          {status && (
            <div className="mt-4 flex items-center gap-6">
              <div className="flex items-center gap-2">
                {status.is_admin ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-200" />
                    <span className="text-sm text-white/90">管理员权限</span>
                  </>
                ) : (
                  <>
                    <ShieldAlert className="w-4 h-4 text-amber-300" />
                    <span className="text-sm text-amber-200">需要管理员权限</span>
                  </>
                )}
              </div>
              <div className="text-sm text-white/80">
                预计可释放: <span className="font-semibold text-white">{formatSize(status.total_reclaimable)}</span>
              </div>
            </div>
          )}
        </div>

        {/* 管理员权限警告 */}
        {status && !status.is_admin && showAdminWarning && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 flex items-start gap-3 relative">
            <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-600">需要管理员权限</p>
              <p className="text-xs text-[var(--fg-muted)] mt-0.5">
                系统瘦身功能需要管理员权限才能执行。请关闭程序，右键点击程序图标选择"以管理员身份运行"。
              </p>
            </div>
            <button
              onClick={() => setShowAdminWarning(false)}
              className="text-amber-500 hover:text-amber-700 transition shrink-0"
              title="关闭提示"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* 加载状态 */}
        {loading && !status && (
          <div className="bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] p-12 flex flex-col items-center justify-center">
            <Loader2 className="w-8 h-8 text-emerald-500 animate-spin mb-3" />
            <p className="text-sm text-[var(--fg-muted)]">正在检测系统状态...</p>
          </div>
        )}

        {/* 瘦身项列表 */}
        {status && (
          <div className="space-y-3">
            {status.items.map((item) => {
              const Icon = itemIcons[item.id] || Package;
              const colors = itemColors[item.id] || itemColors.winsxs;
              const isLoading = actionLoading === item.id;

              return (
                <div
                  key={item.id}
                  className={`bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] overflow-hidden transition-all ${
                    item.actionable ? 'hover:border-emerald-500/30' : 'opacity-60'
                  }`}
                >
                  <div className="p-5">
                    <div className="flex items-start gap-4">
                      {/* 图标 */}
                      <div className={`w-12 h-12 rounded-xl ${colors.bg} flex items-center justify-center shrink-0`}>
                        <Icon className={`w-6 h-6 ${colors.text}`} />
                      </div>

                      {/* 内容 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-base font-semibold text-[var(--fg-primary)]">
                            {item.name}
                          </h3>
                          {item.enabled && item.size > 0 && (
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-600">
                              {formatSize(item.size)}
                            </span>
                          )}
                          {!item.enabled && item.id === 'hibernation' && (
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--bg-hover)] text-[var(--fg-muted)]">
                              已关闭
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-[var(--fg-secondary)] mt-1">
                          {item.description}
                        </p>

                        {/* 风险提示 */}
                        <div className="mt-3 flex items-start gap-2 bg-amber-500/5 rounded-lg px-3 py-2">
                          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                          <p className="text-xs text-amber-600 leading-relaxed">
                            {item.warning}
                          </p>
                        </div>
                      </div>

                      {/* 操作按钮 */}
                      <div className="shrink-0">
                        <button
                          onClick={() => handleAction(item)}
                          disabled={!item.actionable || isLoading || !status.is_admin}
                          className={`
                            px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2
                            ${item.actionable && status.is_admin
                              ? 'bg-emerald-500 text-white hover:bg-emerald-600 active:scale-95'
                              : 'bg-[var(--bg-hover)] text-[var(--fg-muted)] cursor-not-allowed'
                            }
                          `}
                        >
                          {isLoading ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span>执行中...</span>
                            </>
                          ) : (
                            <>
                              <span>{item.action_text}</span>
                              <ChevronRight className="w-4 h-4" />
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
        <div className="bg-[var(--bg-elevated)] rounded-xl px-4 py-3 text-xs text-[var(--fg-muted)] leading-relaxed">
          <p>
            <strong className="text-[var(--fg-secondary)]">提示：</strong>
            系统瘦身操作会修改 Windows 系统配置，建议在执行前了解各项功能的作用。
            如果不确定是否需要某项功能，建议保持默认设置。
          </p>
        </div>
      </div>
    </>
  );
}

export default SystemSlimPage;
