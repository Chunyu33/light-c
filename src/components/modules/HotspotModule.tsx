// ============================================================================
// C盘热点扫描模块
// 扫描 AppData 目录下占用空间最大的文件夹
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { Flame, Loader2, FolderOpen, Clock, HardDrive, ChevronDown } from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { useDashboard } from '../../contexts/DashboardContext';
import { scanHotspot, openInFolder, type HotspotScanResult, type HotspotEntry } from '../../api/commands';
import { formatSize } from '../../utils/format';

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
    default:
      return 'text-gray-500 bg-gray-50 dark:bg-gray-900/20';
  }
}

// ============================================================================
// 热点条目组件
// ============================================================================

interface HotspotItemProps {
  entry: HotspotEntry;
  rank: number;
  maxSize: number;
  onOpenFolder: (path: string) => void;
}

function HotspotItem({ entry, rank, maxSize, onOpenFolder }: HotspotItemProps) {
  // 计算占比条宽度
  const percentage = maxSize > 0 ? (entry.total_size / maxSize) * 100 : 0;
  
  return (
    <div className="group relative bg-[var(--bg-main)] rounded-xl p-3 hover:bg-[var(--bg-hover)] transition-colors">
      {/* 占比背景条 */}
      <div 
        className="absolute inset-0 bg-[var(--brand-green-10)] rounded-xl opacity-50 transition-all"
        style={{ width: `${percentage}%` }}
      />
      
      <div className="relative flex items-center gap-3">
        {/* 排名 */}
        <div className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold ${
          rank <= 3 
            ? 'bg-[var(--brand-green)] text-white' 
            : 'bg-[var(--bg-card)] text-[var(--text-secondary)] border border-[var(--border-color)]'
        }`}>
          {rank}
        </div>
        
        {/* 文件夹信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-[var(--text-primary)] truncate">
              {entry.name}
            </span>
            <span className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded ${getParentTypeColor(entry.parent_type)}`}>
              {entry.parent_type}
            </span>
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
          <div className="font-semibold text-[var(--brand-green)] min-w-[70px] text-right">
            {formatSize(entry.total_size)}
          </div>
          
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
  );
}

// ============================================================================
// 主组件
// ============================================================================

export function HotspotModule() {
  const { modules, expandedModule, setExpandedModule, updateModuleState, oneClickScanTrigger } = useDashboard();
  const moduleState = modules.hotspot;

  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [scanResult, setScanResult] = useState<HotspotScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // 是否展开
  const isExpanded = expandedModule === 'hotspot';

  // 执行扫描
  const handleScan = useCallback(async () => {
    updateModuleState('hotspot', { status: 'scanning' });
    setError(null);
    setScanResult(null);
    setShowAll(false);

    try {
      const result = await scanHotspot(20);
      setScanResult(result);
      
      // 计算 Top 10 的总大小作为模块显示
      const top10Size = result.entries.slice(0, 10).reduce((sum, e) => sum + e.total_size, 0);
      
      updateModuleState('hotspot', {
        status: 'done',
        fileCount: result.entries.length,
        totalSize: top10Size,
      });
    } catch (err) {
      console.error('热点扫描失败:', err);
      setError(String(err));
      updateModuleState('hotspot', { status: 'error' });
    }
  }, [updateModuleState]);

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

  // 显示的条目（默认显示 10 条，展开显示全部）
  const displayedEntries = showAll 
    ? scanResult?.entries || []
    : (scanResult?.entries || []).slice(0, 10);

  // 最大大小（用于计算占比条）
  const maxSize = scanResult?.entries[0]?.total_size || 0;

  return (
    <ModuleCard
      id="hotspot"
      title="C盘热点"
      description="扫描 AppData 中占用空间最大的文件夹"
      icon={<Flame className="w-5 h-5 text-[var(--brand-green)]" />}
      status={moduleState.status}
      fileCount={moduleState.fileCount}
      totalSize={moduleState.totalSize}
      expanded={isExpanded}
      onToggleExpand={() => setExpandedModule(isExpanded ? null : 'hotspot')}
      onScan={handleScan}
      scanButtonText="开始扫描"
      error={error}
    >
      {/* 扫描中状态 */}
      {moduleState.status === 'scanning' && (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--text-muted)]">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--brand-green)] mb-3" />
          <p className="text-sm">正在扫描 AppData 目录...</p>
          <p className="text-xs mt-1">这可能需要几秒钟</p>
        </div>
      )}

      {/* 扫描结果 */}
      {moduleState.status === 'done' && scanResult && (
        <div className="space-y-3">
          {/* 统计摘要 */}
          <div className="flex items-center justify-between px-1 text-xs text-[var(--text-muted)]">
            <div className="flex items-center gap-4">
              <span>共扫描 <strong className="text-[var(--text-primary)]">{scanResult.total_folders_scanned}</strong> 个文件夹</span>
              <span>AppData 总占用 <strong className="text-[var(--brand-green)]">{formatSize(scanResult.appdata_total_size)}</strong></span>
            </div>
            <span>耗时 {(scanResult.scan_duration_ms / 1000).toFixed(1)}s</span>
          </div>

          {/* 热点列表 */}
          <div className="space-y-2">
            {displayedEntries.map((entry, index) => (
              <HotspotItem
                key={entry.path}
                entry={entry}
                rank={index + 1}
                maxSize={maxSize}
                onOpenFolder={handleOpenFolder}
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
              <p className="text-sm">未发现热点文件夹</p>
            </div>
          )}
        </div>
      )}

      {/* 初始状态 */}
      {moduleState.status === 'idle' && !scanResult && (
        <div className="text-center py-8 text-[var(--text-muted)]">
          <Flame className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">点击"开始扫描"查看 AppData 空间占用热点</p>
        </div>
      )}
    </ModuleCard>
  );
}
