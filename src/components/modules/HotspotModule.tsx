// ============================================================================
// 大目录分析模块
// 深度分析 AppData 目录，定位占用空间的元凶
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Flame, Loader2, FolderOpen, Clock, HardDrive, ChevronDown, ChevronRight, Search, ShieldAlert, Shield, Eye, Trash2, XCircle } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { listen } from '@tauri-apps/api/event';
import { ModuleCard } from '../ModuleCard';
import { ConfirmDialog } from '../ConfirmDialog';
import { useToast } from '../Toast';
import { useDashboard } from '../../contexts/DashboardContext';
import { scanHotspot, cancelHotspotScan, openInFolder, cleanupDirectoryContents, type HotspotScanResult, type HotspotEntry, type HotspotScanProgress } from '../../api/commands';
import { formatSize } from '../../utils/format';
import { DrillDownModal } from './DrillDownModal';

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 格式化时间戳为 YYYY-MM-DD HH:mm
 */
function formatDateTime(timestamp: number): string {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * 中间省略长路径
 * 例如: C:\Users\xxx\AppData\Local\VeryLongFolderName -> C:\Users\...\VeryLongFolderName
 */
function middleEllipsis(path: string, maxLength: number = 45): string {
  if (path.length <= maxLength) return path;
  
  const parts = path.split('\\');
  if (parts.length <= 3) {
    // 路径太短，直接截断
    return path.slice(0, maxLength - 3) + '...';
  }
  
  // 保留前两部分和最后一部分
  const start = parts.slice(0, 2).join('\\');
  const end = parts[parts.length - 1];
  
  // 如果结尾部分太长，也需要截断
  const availableForEnd = maxLength - start.length - 5; // 5 = "\\...\\".length
  const truncatedEnd = end.length > availableForEnd 
    ? end.slice(0, availableForEnd - 3) + '...'
    : end;
  
  return `${start}\\...\\${truncatedEnd}`;
}

/**
 * 获取父目录类型的显示颜色
 */
function getParentTypeColor(type: string): string {
  switch (type) {
    case 'Local':
      return 'text-blue-500 bg-blue-50 dark:bg-blue-900/20';
    case 'Roaming':
      return 'text-purple-500 bg-purple-50 dark:bg-purple-900/20';
    case 'LocalLow':
      return 'text-orange-500 bg-orange-50 dark:bg-orange-900/20';
    case 'Windows':
      return 'text-red-500 bg-red-50 dark:bg-red-900/20';
    case 'Program Files':
    case 'Program Files (x86)':
      return 'text-amber-500 bg-amber-50 dark:bg-amber-900/20';
    case 'Users':
      return 'text-cyan-500 bg-cyan-50 dark:bg-cyan-900/20';
    case 'System':
      return 'text-rose-500 bg-rose-50 dark:bg-rose-900/20';
    default:
      return 'text-gray-500 bg-gray-50 dark:bg-gray-900/20';
  }
}

// ============================================================================
// 大目录分析条目组件
// ============================================================================

interface HotspotItemProps {
  entry: HotspotEntry;
  rank: number;
  maxSize: number;
  isFullScan: boolean; // 是否为深度扫描模式
  onOpenFolder: (path: string) => void;
  onCleanup: (entry: HotspotEntry) => void;
  onSearch: (path: string) => void;
  /** 父目录名称（用于路径简写展示） */
  parentName?: string;
  /** 是否为子目录（下钻结果） */
  isChild?: boolean;
  /** 当前在树中的绝对深度（0=顶级） */
  treeDepth?: number;
  /** 下钻回调：点击后进入 drilldown 模式 */
  onDrillDown?: (path: string) => void;
}

function HotspotItem({ entry, rank, maxSize, isFullScan, onOpenFolder, onCleanup, onSearch, parentName, isChild, treeDepth = 0, onDrillDown }: HotspotItemProps) {
  // 计算占比条宽度
  const percentage = maxSize > 0 ? (entry.total_size / maxSize) * 100 : 0;
  
  // 【安全措施】深度扫描模式下，或者 is_safe_to_clean 为 false 时，禁用清理按钮
  const canCleanup = !isFullScan && entry.is_safe_to_clean && entry.is_cache && !entry.is_program && !entry.is_protected;
  
  // 生成路径简写：父目录 > 子目录
  const displayName = parentName ? `${parentName} > ${entry.name}` : entry.name;
  
  // 子目录缩进样式
  const indentClass = isChild ? 'ml-6 border-l-2 border-[var(--border-color)] pl-3' : '';
  
  return (
    <div className={`${indentClass}`}>
      <div className={`group relative bg-[var(--bg-main)] rounded-xl p-3 hover:bg-[var(--bg-hover)] transition-colors ${
        entry.is_protected ? 'border border-red-200 dark:border-red-800/30' : ''
      } ${isChild ? 'bg-opacity-50' : ''}`}>
      {/* 占比背景条 */}
      <div 
        className={`absolute inset-0 rounded-xl opacity-50 transition-all ${
          entry.is_protected ? 'bg-red-100 dark:bg-red-900/10' : 'bg-[var(--brand-green-10)]'
        }`}
        style={{ width: `${percentage}%` }}
      />
      
      <div className="relative flex items-center gap-3">
        {/* 排名 */}
        <div className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold ${
          entry.is_protected
            ? 'bg-red-500 text-white'
            : rank <= 3 
              ? 'bg-[var(--brand-green)] text-white' 
              : 'bg-[var(--bg-card)] text-[var(--text-secondary)] border border-[var(--border-color)]'
        }`}>
          {rank}
        </div>
        
        {/* 文件夹信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-[var(--text-primary)] truncate">
              {isChild ? displayName : entry.name}
            </span>
            {/* 下钻深度指示器 */}
            {entry.depth > 0 && !isChild && (
              <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded text-purple-500 bg-purple-50 dark:bg-purple-900/20">
                L{entry.depth}
              </span>
            )}
            <span className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded ${getParentTypeColor(entry.parent_type)}`}>
              {entry.parent_type}
            </span>
            {/* 系统保护目录标签 - 深度扫描时显示 */}
            {entry.is_protected && (
              <span className="flex-shrink-0 flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded text-red-500 bg-red-50 dark:bg-red-900/20">
                <Shield className="w-3 h-3" />
                系统保护
              </span>
            )}
            {/* 程序目录标签 - 红色警告，禁止删除 */}
            {entry.is_program && !entry.is_protected && (
              <span className="flex-shrink-0 flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded text-red-500 bg-red-50 dark:bg-red-900/20">
                <ShieldAlert className="w-3 h-3" />
                系统/程序
              </span>
            )}
            {/* 缓存目录标签 - 建议清理（仅非深度扫描模式显示） */}
            {entry.is_cache && !entry.is_program && !entry.is_protected && !isFullScan && (
              <span className="flex-shrink-0 flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded text-orange-500 bg-orange-50 dark:bg-orange-900/20">
                <Trash2 className="w-3 h-3" />
                临时缓存
              </span>
            )}
            {/* 深度扫描只读提示 */}
            {isFullScan && !entry.is_protected && (
              <span className="flex-shrink-0 flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded text-blue-500 bg-blue-50 dark:bg-blue-900/20">
                <Eye className="w-3 h-3" />
                仅查看
              </span>
            )}
          </div>
          <div 
            className="text-xs text-[var(--text-muted)] mt-0.5 truncate cursor-help"
            title={entry.path}
          >
            {middleEllipsis(entry.path)}
          </div>
        </div>
        
        {/* 统计信息 */}
        <div className="flex-shrink-0 flex items-center gap-4 text-xs">
          {/* 文件数 */}
          <div className="hidden sm:flex items-center gap-1 text-[var(--text-muted)]">
            <HardDrive className="w-3 h-3" />
            <span>{entry.file_count.toLocaleString()} 个</span>
          </div>
          
          {/* 最后修改时间 */}
          <div className="hidden md:flex items-center gap-1 text-[var(--text-muted)]">
            <Clock className="w-3 h-3" />
            <span>{formatDateTime(entry.last_modified)}</span>
          </div>
          
          {/* 大小 */}
          <div className={`font-semibold min-w-[70px] text-right ${
            entry.is_protected ? 'text-red-500' : 'text-[var(--brand-green)]'
          }`}>
            {formatSize(entry.total_size)}
          </div>
          
          {/* 操作按钮组 */}
          <div className="flex items-center gap-1">
            {/* 下钻按钮 - 在最末层子目录（无 children 且有 onDrillDown）时显示 */}
            {onDrillDown && (!entry.children || entry.children.length === 0) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDrillDown(entry.path);
                }}
                className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-[var(--brand-green-10)] text-[var(--brand-green)] transition-all"
                title="展开下级目录"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            )}

            {/* 清理按钮 - 仅在非深度扫描模式且可清理时显示 */}
            {canCleanup && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCleanup(entry);
                }}
                className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-orange-100 dark:hover:bg-orange-900/30 text-orange-500 transition-all"
                title="清理缓存文件"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            
            {/* 搜索按钮 - 搜索该文件夹是否可以删除 全路径用.path，文件夹名称用.name */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSearch(entry.path);
              }}
              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-blue-500 transition-all"
              title="搜索该文件夹是否可以删除"
            >
              <Search className="w-4 h-4" />
            </button>
            
            {/* 打开文件夹按钮 */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenFolder(entry.path);
              }}
              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all"
              title="在文件资源管理器中打开"
            >
              <FolderOpen className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
      </div>
      
      {/* 递归渲染子目录（智能下钻结果） - 仅在 tree 模式前三级展示 */}
      {entry.children && entry.children.length > 0 && (
        <div className="mt-1 space-y-1">
          {entry.children.map((child, idx) => (
            <HotspotItem
              key={child.path}
              entry={child}
              rank={idx + 1}
              maxSize={entry.total_size}
              isFullScan={isFullScan}
              onOpenFolder={onOpenFolder}
              onCleanup={onCleanup}
              onSearch={onSearch}
              parentName={entry.name}
              isChild={true}
              treeDepth={treeDepth + 1}
              onDrillDown={onDrillDown}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 主组件
// ============================================================================

export function HotspotModule() {
  const { modules, expandedModule, setExpandedModule, updateModuleState, oneClickScanTrigger } = useDashboard();
  const moduleState = modules.hotspot;
  const { showToast } = useToast();

  const lastScanTriggerRef = useRef(0);
  const scanningRef = useRef(false);

  // 本地状态
  const [scanResult, setScanResult] = useState<HotspotScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // 深度扫描开关状态
  const [fullScanEnabled, setFullScanEnabled] = useState(false);
  // 清理确认对话框状态
  const [cleanupTarget, setCleanupTarget] = useState<HotspotEntry | null>(null);
  const [isCleaning, setIsCleaning] = useState(false);

  // ====== 扫描进度状态（仅深度扫描时有效） ======
  const [scanProgress, setScanProgress] = useState<HotspotScanProgress | null>(null);

  // ====== 下钻模态框状态 ======
  /** 选中的路径：非空时弹出 DrillDownModal */
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // 是否展开
  const isExpanded = expandedModule === 'hotspot';

  /** 点击下钻按钮 → 打开模态框 */
  const handleDrillDown = useCallback((targetPath: string) => {
    setSelectedPath(targetPath);
  }, []);

  /** 模态框内发生清理后的同步回调 → 重新扫描主列表 */
  const handleModalCleanupDone = useCallback(() => {
    // 延迟触发重新扫描，避免与模态框关闭动画冲突
    setTimeout(() => {
      handleScanRef.current?.();
    }, 100);
  }, []);

  // 使用 ref 打破 handleScan ↔ handleModalCleanupDone 的循环依赖
  const handleScanRef = useRef<(() => void) | null>(null);

  // ====== 监听扫描进度事件 ======
  useEffect(() => {
    let unlistenProgress: (() => void) | null = null;
    let unlistenCancelled: (() => void) | null = null;

    const setupListeners = async () => {
      unlistenProgress = await listen<HotspotScanProgress>('hotspot-scan:progress', (event) => {
        setScanProgress(event.payload);
      });
      unlistenCancelled = await listen('hotspot-scan:cancelled', () => {
        // 扫描被取消，UI 由 handleScan 的 catch/finally 处理
      });
    };

    setupListeners();

    return () => {
      if (unlistenProgress) unlistenProgress();
      if (unlistenCancelled) unlistenCancelled();
    };
  }, []);

  // 执行扫描
  const handleScan = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;

    updateModuleState('hotspot', { status: 'scanning' });
    setError(null);
    setScanResult(null);
    setShowAll(false);
    setSelectedPath(null);
    setScanProgress(null);

    try {
      // 根据深度扫描开关决定扫描模式
      const result = await scanHotspot(30, fullScanEnabled);
      setScanResult(result);

      // 计算 Top 10 的总大小作为模块显示
      const top10Size = result.entries.slice(0, 10).reduce((sum, e) => sum + e.total_size, 0);

      updateModuleState('hotspot', {
        status: 'done',
        fileCount: result.entries.length,
        totalSize: top10Size,
      });
    } catch (err) {
      console.error('大目录分析扫描失败:', err);
      setError(String(err));
      updateModuleState('hotspot', { status: 'error' });
    } finally {
      scanningRef.current = false;
      setScanProgress(null);
    }
  }, [updateModuleState, fullScanEnabled]);

  // 取消扫描
  const handleStopScan = useCallback(async () => {
    try {
      await cancelHotspotScan();
      showToast({ type: 'info', title: '扫描已停止', description: '将显示已扫描到的目录' });
    } catch (err) {
      console.error('停止扫描失败:', err);
    }
  }, [showToast]);

  // 同步 handleScanRef 供模态框清理回调使用
  handleScanRef.current = handleScan;

  // 响应一键扫描
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  // 打开文件夹
  const handleOpenFolder = useCallback(async (path: string) => {
    try {
      await openInFolder(path);
    } catch (err) {
      console.error('打开文件夹失败:', err);
    }
  }, []);

  // 触发清理确认对话框
  const handleCleanupClick = useCallback((entry: HotspotEntry) => {
    setCleanupTarget(entry);
  }, []);

  // 执行清理操作
  const handleCleanupConfirm = useCallback(async () => {
    if (!cleanupTarget) return;
    
    setIsCleaning(true);
    try {
      const result = await cleanupDirectoryContents(cleanupTarget.path);
      
      if (result.deleted_count > 0) {
        showToast({
          type: 'success',
          title: `清理完成`,
          description: `已删除 ${result.deleted_count} 项，释放 ${formatSize(result.freed_size)}`,
        });
        // 清理完成后重新扫描以更新数据
        handleScan();
      } else if (result.failed_count > 0) {
        showToast({
          type: 'warning',
          title: '清理受阻',
          description: `${result.failed_count} 个文件被占用无法删除`,
        });
      } else {
        showToast({
          type: 'info',
          title: '目录已为空',
          description: '没有需要清理的文件',
        });
      }
    } catch (err) {
      console.error('清理失败:', err);
      showToast({
        type: 'error',
        title: '清理失败',
        description: String(err),
      });
    } finally {
      setIsCleaning(false);
      setCleanupTarget(null);
    }
  }, [cleanupTarget, handleScan, showToast]);

  // 搜索文件夹是否可以删除 - 使用 Tauri opener 插件打开浏览器
  const handleSearch = useCallback(async (path: string) => {
    try {
      const query = encodeURIComponent(`Windows 文件夹 ${path} 可以删除吗`);
      const url = `https://www.bing.com/search?q=${query}`;
      await openUrl(url);
    } catch (err) {
      console.error('打开搜索链接失败:', err);
    }
  }, []);

  // 显示的条目（默认显示 10 条，展开显示全部）
  const displayedEntries = showAll 
    ? scanResult?.entries || []
    : (scanResult?.entries || []).slice(0, 10);

  // 最大大小（用于计算占比条）
  const maxSize = scanResult?.entries[0]?.total_size || 0;

  return (
    <ModuleCard
      id="hotspot"
      title="大目录分析"
      description={fullScanEnabled ? "全盘深度扫描 C 盘，定位空间占用元凶" : "深度分析 AppData 目录，定位占用空间的元凶"}
      icon={<Flame className="w-5 h-5 text-[var(--brand-green)]" />}
      status={moduleState.status}
      fileCount={moduleState.fileCount}
      totalSize={moduleState.totalSize}
      expanded={isExpanded}
      onToggleExpand={() => setExpandedModule(isExpanded ? null : 'hotspot')}
      onScan={handleScan}
      scanButtonText="开始扫描"
      error={error}
      headerExtra={
        // 深度扫描开关 - 参考卸载残留模块样式
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFullScanEnabled(!fullScanEnabled)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
              fullScanEnabled
                ? 'bg-[var(--brand-green)] text-white'
                : 'bg-[var(--bg-main)] text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-[var(--border-color)]'
            }`}
            title={fullScanEnabled ? '当前：全盘深度扫描' : '当前：仅扫描 AppData'}
          >
            <Eye className="w-3.5 h-3.5" />
            深度扫描
          </button>
        </div>
      }
    >
      {/* 扫描中状态 */}
      {moduleState.status === 'scanning' && (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--text-muted)]">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--brand-green)] mb-3" />
          <p className="text-sm">
            {fullScanEnabled ? '正在全盘扫描 C 盘...' : '正在扫描 AppData 目录...'}
          </p>
          <p className="text-xs mt-1">
            {fullScanEnabled ? '深度扫描可能需要较长时间，请耐心等待' : '这可能需要几秒钟'}
          </p>

          {/* 深度扫描进度条 */}
          {fullScanEnabled && scanProgress && (
            <div className="mt-4 w-full max-w-xs space-y-2">
              {/* 进度百分比 */}
              <div className="flex items-center justify-between text-xs">
                <span className="truncate max-w-[200px]" title={scanProgress.current_dir}>
                  {scanProgress.current_dir}
                </span>
                <span className="shrink-0">
                  {scanProgress.total_first_level_dirs > 0
                    ? `${Math.round((scanProgress.scanned_dirs / scanProgress.total_first_level_dirs) * 100)}%`
                    : ''}
                </span>
              </div>
              {/* 进度条 */}
              <div className="w-full h-1.5 bg-[var(--bg-card)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--brand-green)] rounded-full transition-all duration-300"
                  style={{
                    width: `${scanProgress.total_first_level_dirs > 0
                      ? (scanProgress.scanned_dirs / scanProgress.total_first_level_dirs) * 100
                      : 0}%`
                  }}
                />
              </div>
              {/* 统计信息 */}
              <div className="flex justify-center gap-3 text-[10px] text-[var(--text-faint)]">
                <span>已扫描 {scanProgress.scanned_dirs} 个目录</span>
                <span>发现 {scanProgress.found_entries} 个大目录</span>
              </div>
            </div>
          )}

          {/* 取消按钮（仅深度扫描时显示） */}
          {fullScanEnabled && (
            <button
              onClick={handleStopScan}
              className="mt-4 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                bg-red-50 dark:bg-red-900/20 text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30
                border border-red-200 dark:border-red-800/30 transition-colors"
            >
              <XCircle className="w-3.5 h-3.5" />
              停止扫描
            </button>
          )}
        </div>
      )}

      {/* 扫描结果 */}
      {moduleState.status === 'done' && scanResult && (
        <div className="space-y-3">
          {/* 深度扫描安全提示 */}
          {scanResult.is_full_scan && (
            <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-xs text-blue-600 dark:text-blue-400">
              <Eye className="w-4 h-4 flex-shrink-0" />
              <span>深度扫描模式：仅供查看分析，清理功能已禁用以保护系统安全</span>
            </div>
          )}

          {/* 统计摘要 */}
          <div className="flex items-center justify-between px-1 text-xs text-[var(--text-muted)]">
            <div className="flex items-center gap-4 mt-4">
              <span>共扫描 <strong className="text-[var(--text-primary)]">{scanResult.total_folders_scanned}</strong> 个文件夹</span>
              <span>
                {scanResult.is_full_scan ? 'C 盘' : 'AppData'} 总占用{' '}
                <strong className="text-[var(--brand-green)]">{formatSize(scanResult.appdata_total_size)}</strong>
              </span>
            </div>
            <span>耗时 {(scanResult.scan_duration_ms / 1000).toFixed(1)}s</span>
          </div>

          {/* 目录列表 */}
          <div className="space-y-2">
            {displayedEntries.map((entry, index) => (
              <HotspotItem
                key={entry.path}
                entry={entry}
                rank={index + 1}
                maxSize={maxSize}
                isFullScan={scanResult.is_full_scan}
                onOpenFolder={handleOpenFolder}
                onCleanup={handleCleanupClick}
                onSearch={handleSearch}
                treeDepth={0}
                onDrillDown={handleDrillDown}
              />
            ))}
          </div>

          {/* 展开/收起按钮 */}
          {scanResult.entries.length > 10 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="w-full flex items-center justify-center gap-1 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <span>{showAll ? '收起' : `显示全部 ${scanResult.entries.length} 项`}</span>
              <ChevronDown className={`w-4 h-4 transition-transform ${showAll ? 'rotate-180' : ''}`} />
            </button>
          )}

          {/* 空状态 */}
          {scanResult.entries.length === 0 && (
            <div className="text-center py-8 text-[var(--text-muted)]">
              <p className="text-sm">未发现大型目录</p>
            </div>
          )}
        </div>
      )}

      {/* 初始状态 */}
      {moduleState.status === 'idle' && !scanResult && (
        <div className="text-center py-8 text-[var(--text-muted)]">
          <Flame className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">点击"开始扫描"分析 AppData 目录空间占用</p>
        </div>
      )}

      {/* 清理确认对话框 */}
      {cleanupTarget && createPortal(
        <ConfirmDialog
          isOpen={!!cleanupTarget}
          title="确认清理"
          description={`确定清理 "${cleanupTarget.name}" 的临时文件吗？此操作将删除该目录下的所有文件，但保留目录本身。`}
          warning="被占用的文件将被跳过，不会影响正在运行的程序。"
          confirmText={isCleaning ? '清理中...' : '确认清理'}
          cancelText="取消"
          onConfirm={handleCleanupConfirm}
          onCancel={() => setCleanupTarget(null)}
          isDanger={false}
        />,
        document.body
      )}

      {/* 下钻模态框 - Portal 渲染到 body */}
      {selectedPath && (
        <DrillDownModal
          initialPath={selectedPath}
          onClose={() => setSelectedPath(null)}
          onCleanupDone={handleModalCleanupDone}
        />
      )}
    </ModuleCard>
  );
}
