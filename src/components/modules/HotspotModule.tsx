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
import { EmptyState } from '../EmptyState';
import { useToast } from '../Toast';
import { useDashboard, useSettings } from '../../contexts';
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
  // MFT 引擎返回 Unix 秒，常规遍历返回毫秒；这里做兼容，避免秒级时间戳被解析到 1970 年。
  const normalizedTimestamp = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(normalizedTimestamp);
  if (Number.isNaN(date.getTime())) return '-';
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

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return '0.0s';
  return `${(ms / 1000).toFixed(1)}s`;
}

function getProgressStageLabel(stage?: string): string {
  switch (stage) {
    case 'mft':
      return '枚举 MFT';
    case 'index':
      return '建立索引';
    case 'metadata':
      return '读取大小';
    case 'aggregate':
      return '聚合目录';
    case 'result':
      return '生成结果';
    case 'walkdir':
      return '常规遍历';
    default:
      return '扫描中';
  }
}

// 诊断面板同时服务“扫描中”和“扫描完成”状态，避免两套指标重复展示。
function HotspotDiagnostics({
  logs,
  totalElapsedMs,
  currentProgress,
  compact = false,
}: {
  logs: HotspotScanProgress[];
  totalElapsedMs?: number;
  currentProgress?: HotspotScanProgress | null;
  compact?: boolean;
}) {
  if (logs.length === 0 && !totalElapsedMs && !currentProgress) return null;

  const latestLog = currentProgress || logs[logs.length - 1];
  // 相同阶段在监听器里已经合并，这里只负责过滤无效阶段，保持布局稳定。
  const visibleLogs = logs.filter((log) => log.stage && log.stage_elapsed_ms !== undefined);
  const processedCount = latestLog?.scanned_dirs || latestLog?.found_entries || 0;

  return (
    <div className={`rounded-xl bg-[var(--bg-main)] border border-[var(--border-color)] px-4 py-3 text-xs ${compact ? 'space-y-2' : 'space-y-3'}`}>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 md:gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0 px-2 py-0.5 rounded-md bg-[var(--brand-green)] text-white font-medium">
            {getProgressStageLabel(latestLog?.stage)}
          </span>
          <span className="truncate text-[var(--text-primary)]" title={latestLog?.message || '本次扫描阶段耗时'}>
            {latestLog?.message || '本次扫描阶段耗时'}
          </span>
        </div>
        <div className="flex items-center justify-start md:justify-end gap-4 text-[var(--text-muted)] tabular-nums">
          {processedCount > 0 && <span>已处理 {processedCount.toLocaleString()}</span>}
          {totalElapsedMs !== undefined && <span>总耗时 {formatDuration(totalElapsedMs)}</span>}
        </div>
      </div>
      {visibleLogs.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {visibleLogs.map((log, index) => (
            <div
              key={`${log.stage}-${index}`}
              className="min-w-0 rounded-lg bg-[var(--bg-card)] border border-[var(--border-color)] px-2.5 py-2"
            >
              <div className="truncate text-[var(--text-muted)]">{getProgressStageLabel(log.stage)}</div>
              <div className="mt-0.5 text-[var(--text-primary)] font-semibold tabular-nums">
                {formatDuration(log.stage_elapsed_ms)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
  const { settings } = useSettings();
  // 根据用户设置的展示深度动态控制树形展开层数：treeDepth 0 为顶级，settings.hotspotDepth 限制最多展示层数
  const maxTreeDepth = settings.hotspotDepth;
  // 计算占比条宽度
  const percentage = maxSize > 0 ? (entry.total_size / maxSize) * 100 : 0;
  
  // 【安全措施】深度扫描模式下，或者 is_safe_to_clean 为 false 时，禁用清理按钮
  const canCleanup = !isFullScan && entry.is_safe_to_clean && entry.is_cache && !entry.is_program && !entry.is_protected;
  
  // 生成路径简写：父目录 > 子目录
  const displayName = parentName ? `${parentName} > ${entry.name}` : entry.name;
  
  // 树形结构渐进缩进：每层递进 24px，随用户设置的深度动态调整上限
  const indentStyle = treeDepth > 0
    ? { paddingLeft: `${Math.min(treeDepth, maxTreeDepth) * 24}px`, borderLeft: '2px solid var(--border-color)' }
    : {};

  return (
    <div style={indentStyle}>
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
        {/* 文件夹徽标：用文件夹作为主视觉，序号作为角标，避免纯序号块和树线抢视觉焦点。 */}
        <div className="flex-shrink-0 relative w-10 h-9 flex items-center justify-center">
          <div className={`relative w-9 h-7 rounded-md shadow-sm ${
            entry.is_protected
              ? 'bg-red-400'
              : rank <= 3
                ? 'bg-amber-400'
                : 'bg-amber-300'
          }`}>
            <div className={`absolute -top-1 left-1.5 h-2.5 w-4 rounded-t-md ${
              entry.is_protected
                ? 'bg-red-300'
                : rank <= 3
                  ? 'bg-amber-300'
                  : 'bg-amber-200'
            }`} />
            <div className="absolute inset-x-0 bottom-0 h-5 rounded-md bg-gradient-to-b from-yellow-300 to-amber-500" />
          </div>
          <span className={`absolute -right-0.5 -bottom-0.5 min-w-5 h-5 px-1 rounded-full flex items-center justify-center text-[10px] font-bold shadow-sm ${
            entry.is_protected ? 'bg-red-500 text-white' : 'bg-[var(--brand-green)] text-white'
          }`}>
            {rank}
          </span>
        </div>
        
        {/* 文件夹信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-[var(--text-primary)] truncate">
              {isChild ? displayName : entry.name}
            </span>
            {/* 下钻深度指示器 */}
            {entry.depth > 0 && (
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
            {/* 下钻按钮 — 始终显示，已展示3个子节点时用户可能还想继续探索 */}
            {onDrillDown && (
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
      
      {/* 递归渲染子目录 — 最多展示 3 层树形结构 */}
      {treeDepth < maxTreeDepth - 1 && entry.children && entry.children.length > 0 && (
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

export function HotspotModule({ layoutMode = 'cards' }: { layoutMode?: 'cards' | 'pages' }) {
  const { modules, expandedModule, setExpandedModule, updateModuleState, oneClickScanTrigger, stopScanTrigger } = useDashboard();
  const moduleState = modules.hotspot;
  const { showToast } = useToast();
  const { settings } = useSettings();

  const lastScanTriggerRef = useRef(0);
  const scanningRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const scanRunIdRef = useRef(0);

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
  const [progressLogs, setProgressLogs] = useState<HotspotScanProgress[]>([]);
  const [scanElapsed, setScanElapsed] = useState(0);

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
        const progress = event.payload;
        setScanProgress(progress);
        setProgressLogs((prev) => {
          const last = prev[prev.length - 1];
          // 相同阶段只保留最新一条，避免 MFT 每 10k 条刷屏导致前端日志噪音过大。
          if (last?.stage === progress.stage) {
            return [...prev.slice(0, -1), progress].slice(-6);
          }
          return [...prev, progress].slice(-6);
        });
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

  // 扫描计时器（仅在全盘扫描时显示）
  useEffect(() => {
    if (moduleState.status !== 'scanning') { setScanElapsed(0); return; }
    const t0 = performance.now();
    const interval = setInterval(() => setScanElapsed(Math.floor((performance.now() - t0) / 1000)), 500);
    return () => clearInterval(interval);
  }, [moduleState.status]);

  // 执行扫描
  const handleScan = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    cancelRequestedRef.current = false;
    const scanRunId = ++scanRunIdRef.current;

    updateModuleState('hotspot', { status: 'scanning' });
    setError(null);
    setScanResult(null);
    setShowAll(false);
    setSelectedPath(null);
    setScanProgress(null);
    setProgressLogs([]);

    try {
      // 根据深度扫描开关决定扫描模式（全盘扫描条目更多）
      const topN = fullScanEnabled ? 80 : 50;
      const result = await scanHotspot(topN, fullScanEnabled, settings.hotspotDepth, settings.hotspotSizeThreshold, settings.hotspotIgnoreSystemDirs);
      if (cancelRequestedRef.current || scanRunId !== scanRunIdRef.current) {
        // 用户主动停止时不接收后端可能返回的半截结果，避免列表只剩一级目录造成误判。
        return;
      }
      setScanResult(result);

      // 卡片摘要：展示的目录数 + 扫描覆盖总大小（与内部统计行一致）
      updateModuleState('hotspot', {
        status: 'done',
        fileCount: result.entries.length,
        totalSize: result.scanned_total_size,
      });
    } catch (err) {
      if (cancelRequestedRef.current || scanRunId !== scanRunIdRef.current) {
        updateModuleState('hotspot', { status: 'idle', progress: 0 });
        return;
      }
      console.error('大目录分析扫描失败:', err);
      setError(String(err));
      updateModuleState('hotspot', { status: 'error' });
    } finally {
      if (scanRunId === scanRunIdRef.current) {
        scanningRef.current = false;
        setScanProgress(null);
      }
    }
  }, [updateModuleState, fullScanEnabled, settings]);

  // 取消扫描
  const handleStopScan = useCallback(async () => {
    cancelRequestedRef.current = true;
    scanRunIdRef.current += 1;
    scanningRef.current = false;
    updateModuleState('hotspot', { status: 'idle', progress: 0 });
    setScanProgress(null);
    try {
      await cancelHotspotScan();
      showToast({ type: 'info', title: '扫描已停止', description: '已取消本次扫描' });
    } catch (err) {
      console.error('停止扫描失败:', err);
    }
  }, [showToast, updateModuleState]);

  // 同步 handleScanRef 供模态框清理回调使用
  handleScanRef.current = handleScan;

  // 响应一键扫描
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  useEffect(() => {
    if (stopScanTrigger > 0 && scanningRef.current) {
      // 全局停止按钮已经通知后端取消，这里只负责阻止旧 Promise 回写半截结果。
      cancelRequestedRef.current = true;
      scanRunIdRef.current += 1;
      scanningRef.current = false;
      setScanProgress(null);
    }
  }, [stopScanTrigger]);

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
        variant={layoutMode === 'pages' ? 'page' : 'card'}
        forceExpanded={layoutMode === 'pages'}
      id="hotspot"
      title="大目录分析"
      description={fullScanEnabled ? "全盘深度扫描 C 盘，定位空间占用元凶" : "深度分析 AppData 目录，定位占用空间的元凶"}
      icon={<Flame className="w-5 h-5 text-[var(--brand-green)]" />}
      status={moduleState.status}
      fileCount={moduleState.fileCount}
      totalSize={moduleState.totalSize}
      countLabel="个大目录"
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
          <p className="text-sm flex items-center gap-2">
            {fullScanEnabled ? '正在全盘扫描 C 盘...' : '正在扫描 AppData 目录...'}
            {/* 扫描引擎模式标签 — MFT 直读 vs 常规遍历 */}
            {fullScanEnabled && scanProgress && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                scanProgress.backend === 'mft'
                  ? 'bg-[var(--brand-green-10)] text-[var(--brand-green)]'
                  : 'bg-[var(--bg-hover)] text-[var(--text-muted)]'
              }`}>
                {scanProgress.backend === 'mft' ? 'MFT 直读' : '常规遍历'}
              </span>
            )}
          </p>
          <p className="text-xs mt-1">
            {fullScanEnabled ? '深度扫描可能需要较长时间，请耐心等待' : '这可能需要几秒钟'}
          </p>
          {fullScanEnabled && !settings.hotspotIgnoreSystemDirs && (
            <p className="text-xs mt-1 text-amber-500">⚠ 已关闭系统目录过滤，扫描时间可能较长</p>
          )}

          {/* 深度扫描进度：展示关键阶段和耗时，用于判断瓶颈在枚举、读大小还是聚合。 */}
          {fullScanEnabled && scanProgress && (
            <div className="mt-3 w-full max-w-2xl">
              <HotspotDiagnostics
                logs={progressLogs}
                totalElapsedMs={scanProgress.elapsed_ms || scanElapsed * 1000}
                currentProgress={scanProgress}
              />
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
              <span>共 <strong className="text-[var(--text-primary)]">{scanResult.total_folders_scanned.toLocaleString()}</strong> 个文件夹</span>
              <span title="扫描遍历到的所有文件累计大小；系统保护目录（WinSxS 等）因性能原因跳过，实际磁盘占用更大">
                覆盖总大小{' '}
                <strong className="text-[var(--brand-green)]">{formatSize(scanResult.scanned_total_size)}</strong>
              </span>
            </div>
            <span>耗时 {(scanResult.scan_duration_ms / 1000).toFixed(1)}s</span>
          </div>

          {scanResult.is_full_scan && (
            <HotspotDiagnostics
              logs={progressLogs}
              totalElapsedMs={scanResult.scan_duration_ms}
              compact
            />
          )}

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
            <div className="p-4">
              <EmptyState
                icon={Flame}
                tone="success"
                title="未发现大型目录"
                description="当前阈值下没有需要特别关注的大目录。"
              />
            </div>
          )}
        </div>
      )}

      {/* 初始状态 */}
      {moduleState.status === 'idle' && !scanResult && (
        <div className="p-4">
          <EmptyState
            icon={Flame}
            title="尚未分析大目录"
            description="点击开始扫描，定位占用空间较大的目录。"
          />
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
