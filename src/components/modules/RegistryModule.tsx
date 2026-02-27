// ============================================================================
// 注册表冗余扫描模块
// 安全扫描 Windows 注册表中的孤立键值和无效引用
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Database, Loader2, Trash2, CheckCircle2, Shield } from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ConfirmDialog } from '../ConfirmDialog';
import { useDashboard } from '../../contexts/DashboardContext';
import { 
  scanRegistryRedundancy, 
  deleteRegistryEntries,
  openRegistryBackupDir,
  type RegistryScanResult,
  type RegistryEntry,
} from '../../api/commands';

// ============================================================================
// 组件实现
// ============================================================================

export function RegistryModule() {
  const { modules, expandedModule, setExpandedModule, updateModuleState, triggerHealthRefresh, oneClickScanTrigger } = useDashboard();
  const moduleState = modules.registry;

  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [scanResult, setScanResult] = useState<RegistryScanResult | null>(null);
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<string[]>([]); // 详细错误列表
  const [showErrorDetails, setShowErrorDetails] = useState(false); // 是否显示错误详情
  const [backupPath, setBackupPath] = useState<string | null>(null);

  // 计算选中数量
  const selectedCount = selectedEntries.size;

  // 开始扫描
  const handleScan = useCallback(async () => {
    updateModuleState('registry', { status: 'scanning', error: null });
    setScanResult(null);
    setSelectedEntries(new Set());
    setDeleteError(null);
    setDeleteErrors([]);
    setShowErrorDetails(false);
    setBackupPath(null);

    try {
      const result = await scanRegistryRedundancy();
      setScanResult(result);
      
      // 默认只选中低风险项（MUI缓存）
      const defaultSelected = new Set(
        result.entries
          .filter(e => e.risk_level <= 2)
          .map(e => e.path + '|' + e.name)
      );
      setSelectedEntries(defaultSelected);

      updateModuleState('registry', {
        status: 'done',
        fileCount: result.total_count,
        totalSize: 0, // 注册表项没有大小
      });

      setExpandedModule('registry');
    } catch (err) {
      console.error('注册表扫描失败:', err);
      updateModuleState('registry', { status: 'error', error: String(err) });
    }
  }, [updateModuleState, setExpandedModule]);

  // 监听一键扫描触发器
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  // 执行删除
  const handleDelete = useCallback(async () => {
    if (selectedEntries.size === 0 || !scanResult) return;

    setIsDeleting(true);
    setDeleteError(null);
    setDeleteErrors([]);
    setShowErrorDetails(false);
    
    try {
      // 获取选中的条目
      const entriesToDelete = scanResult.entries.filter(
        e => selectedEntries.has(e.path + '|' + e.name)
      );

      const result = await deleteRegistryEntries(entriesToDelete);
      setBackupPath(result.backup_path);

      if (result.errors.length > 0) {
        setDeleteError(`${result.errors.length} 个条目删除失败`);
        setDeleteErrors(result.errors); // 保存详细错误列表
      }

      // 从结果中移除已删除的项
      const failedSet = new Set(result.failed_entries);
      const remainingEntries = scanResult.entries.filter(
        e => !selectedEntries.has(e.path + '|' + e.name) || failedSet.has(e.path)
      );
      
      setScanResult({
        ...scanResult,
        entries: remainingEntries,
        total_count: remainingEntries.length,
      });

      // 更新选中状态
      const newSelected = new Set(
        Array.from(selectedEntries).filter(key => {
          const path = key.split('|')[0];
          return failedSet.has(path);
        })
      );
      setSelectedEntries(newSelected);

      updateModuleState('registry', {
        fileCount: remainingEntries.length,
      });

      triggerHealthRefresh();
    } catch (err) {
      console.error('删除失败:', err);
      setDeleteError(String(err));
      setDeleteErrors([String(err)]);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [selectedEntries, scanResult, updateModuleState, triggerHealthRefresh]);

  // 切换选择
  const toggleSelect = useCallback((entry: RegistryEntry) => {
    const key = entry.path + '|' + entry.name;
    setSelectedEntries(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // 全选/取消全选
  const toggleSelectAll = useCallback(() => {
    if (!scanResult) return;
    if (selectedEntries.size === scanResult.entries.length) {
      setSelectedEntries(new Set());
    } else {
      setSelectedEntries(new Set(scanResult.entries.map(e => e.path + '|' + e.name)));
    }
  }, [scanResult, selectedEntries]);

  // 获取条目类型显示名称
  const getTypeName = (type: RegistryEntry['entry_type']) => {
    switch (type) {
      case 'MuiCache': return 'MUI缓存';
      case 'SoftwareKey': return '软件配置';
      case 'ApplicationAssociation': return '应用关联';
      case 'FileTypeAssociation': return '文件类型';
      default: return type;
    }
  };

  // 获取风险等级样式
  const getRiskStyle = (level: number) => {
    if (level <= 1) return 'bg-[var(--brand-green-10)] text-[var(--brand-green)]';
    if (level <= 2) return 'bg-[var(--brand-green-10)] text-[var(--brand-green)]';
    if (level <= 3) return 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]';
    return 'bg-[var(--color-danger)]/10 text-[var(--color-danger)]';
  };

  const getRiskText = (level: number) => {
    if (level <= 1) return '安全';
    if (level <= 2) return '低风险';
    if (level <= 3) return '中风险';
    return '高风险';
  };

  const isExpanded = expandedModule === 'registry';

  return (
    <>
      {/* 删除进度遮罩 - 使用 Portal 渲染到 body 确保覆盖全屏 */}
      {isDeleting && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-[var(--bg-card)] rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-4 max-w-sm mx-4">
            <div className="w-16 h-16 rounded-full bg-[var(--color-warning)]/10 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-[var(--color-warning)] animate-spin" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">正在清理注册表</h3>
              <p className="text-sm text-[var(--text-muted)] mt-1">
                正在删除 {selectedCount} 个注册表条目，请稍候...
              </p>
            </div>
            <div className="w-full h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden">
              <div className="h-full bg-[var(--color-warning)] rounded-full animate-pulse" style={{ width: '100%' }} />
            </div>
            <p className="text-xs text-[var(--text-faint)]">请勿关闭窗口</p>
          </div>
        </div>,
        document.body
      )}

      <ModuleCard
        id="registry"
        title="注册表冗余"
        description="扫描已卸载软件的孤立注册表键值"
        icon={<Database className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={0}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'registry')}
        onScan={handleScan}
        error={moduleState.error}
        headerExtra={
          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--color-warning)]/10 text-[var(--color-warning)] border border-[var(--color-warning)]/20">
            中风险
          </span>
        }
      >
        {/* 扫描结果内容 */}
        {scanResult && scanResult.entries.length > 0 && (
          <div className="p-5 space-y-4">
            {/* 安全提示 */}
            <div className="flex items-start gap-3 p-4 bg-[var(--brand-green-10)] rounded-xl border border-[var(--brand-green-20)]">
              <Shield className="w-5 h-5 text-[var(--brand-green)] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">安全机制已启用</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  删除前会自动创建 .reg 备份文件，您可以随时通过双击备份文件恢复。
                </p>
              </div>
            </div>

            {/* 备份路径提示 */}
            {backupPath && (
              <div className="flex items-center justify-between p-3 bg-[var(--bg-main)] rounded-xl">
                <span className="text-xs text-[var(--text-muted)]">
                  备份已保存到: {backupPath}
                </span>
                <button
                  onClick={() => openRegistryBackupDir()}
                  className="text-xs text-[var(--brand-green)] hover:underline"
                >
                  打开备份目录
                </button>
              </div>
            )}

            {/* 操作栏 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleSelectAll}
                  className="text-sm text-[var(--brand-green)] hover:underline"
                >
                  {selectedEntries.size === scanResult.entries.length ? '取消全选' : '全选'}
                </button>
                <span className="text-sm text-[var(--text-muted)]">
                  已选 {selectedCount} 项
                </span>
              </div>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                disabled={selectedCount === 0 || isDeleting}
                className={`
                  flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors
                  ${selectedCount === 0 || isDeleting
                    ? 'bg-[var(--bg-hover)] text-[var(--text-faint)] cursor-not-allowed'
                    : 'bg-[var(--color-danger)] text-white hover:opacity-90'
                  }
                `}
              >
                {isDeleting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
                删除选中
              </button>
            </div>

            {/* 错误提示 */}
            {deleteError && (
              <div className="p-3 bg-[var(--color-danger)]/10 rounded-xl border border-[var(--color-danger)]/20">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--color-danger)]">{deleteError}</span>
                  {deleteErrors.length > 0 && (
                    <button
                      onClick={() => setShowErrorDetails(!showErrorDetails)}
                      className="text-xs text-[var(--color-danger)] hover:underline"
                    >
                      {showErrorDetails ? '收起详情' : '查看详情'}
                    </button>
                  )}
                </div>
                {showErrorDetails && deleteErrors.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-[var(--color-danger)]/20 space-y-1 max-h-32 overflow-auto">
                    {deleteErrors.map((err, idx) => (
                      <p key={idx} className="text-xs text-[var(--color-danger)]/80 break-all">
                        • {err}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 条目列表 */}
            <div className="space-y-2 max-h-80 overflow-auto">
              {scanResult.entries.map((entry) => {
                const key = entry.path + '|' + entry.name;
                const isSelected = selectedEntries.has(key);
                
                return (
                  <div
                    key={key}
                    className={`
                      flex items-center gap-4 p-4 rounded-xl cursor-pointer transition-colors
                      ${isSelected
                        ? 'bg-[var(--brand-green-10)]'
                        : 'bg-[var(--bg-main)] hover:bg-[var(--bg-hover)]'
                      }
                    `}
                    onClick={() => toggleSelect(entry)}
                  >
                    {/* 复选框 */}
                    <div className={`
                      w-5 h-5 rounded border-2 flex items-center justify-center shrink-0
                      ${isSelected
                        ? 'bg-[var(--brand-green)] border-[var(--brand-green)]'
                        : 'border-[var(--text-faint)]'
                      }
                    `}>
                      {isSelected && (
                        <CheckCircle2 className="w-3 h-3 text-white" />
                      )}
                    </div>

                    {/* 图标 */}
                    <div className="w-10 h-10 rounded-xl bg-[var(--brand-green-10)] flex items-center justify-center shrink-0">
                      <Database className="w-5 h-5 text-[var(--brand-green)]" />
                    </div>

                    {/* 信息 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                          {entry.name}
                        </p>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getRiskStyle(entry.risk_level)}`}>
                          {getRiskText(entry.risk_level)}
                        </span>
                      </div>
                      <p className="text-xs text-[var(--text-muted)] truncate mt-0.5" title={entry.path}>
                        {entry.path}
                      </p>
                      <p className="text-xs text-[var(--text-faint)] mt-1">
                        {entry.issue}
                      </p>
                    </div>

                    {/* 类型标签 */}
                    <div className="shrink-0">
                      <span className="px-2 py-1 rounded-lg text-xs bg-[var(--bg-hover)] text-[var(--text-muted)]">
                        {getTypeName(entry.entry_type)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 空状态 */}
        {scanResult && scanResult.entries.length === 0 && (
          <div className="p-8 text-center">
            <CheckCircle2 className="w-12 h-12 text-[var(--brand-green)] mx-auto mb-3" />
            <p className="text-sm font-medium text-[var(--text-primary)]">没有发现注册表冗余</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">您的注册表很干净！</p>
          </div>
        )}
      </ModuleCard>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="确认删除注册表条目"
        description={`确定要删除选中的 ${selectedCount} 个注册表条目吗？`}
        warning="删除前会自动创建备份文件，您可以通过双击 .reg 文件恢复。"
        confirmText="删除"
        cancelText="取消"
        isDanger={true}
      />
    </>
  );
}

export default RegistryModule;
