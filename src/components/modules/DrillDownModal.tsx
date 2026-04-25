// ============================================================================
// 目录下钻模态框组件
// 以沉浸式弹窗模式展示指定路径的无限下钻内容
// 支持面包屑导航、ESC 关闭、Portal 渲染、清理同步回调
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Loader2, FolderOpen, Clock, HardDrive, ChevronRight,
  CornerLeftUp, Search, Shield, Trash2,
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ConfirmDialog } from '../ConfirmDialog';
import { useToast } from '../Toast';
import {
  scanPathDirect, openInFolder, cleanupDirectoryContents,
  type HotspotScanResult, type HotspotEntry,
} from '../../api/commands';
import { formatSize } from '../../utils/format';

// ============================================================================
// 工具函数（与 HotspotModule 共享逻辑）
// ============================================================================

function formatDateTime(timestamp: number): string {
  if (!timestamp) return '-';
  const d = new Date(timestamp);
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}`;
}

function getParentTypeColor(type: string): string {
  switch (type) {
    case 'Local':      return 'text-blue-500 bg-blue-50 dark:bg-blue-900/20';
    case 'Roaming':    return 'text-purple-500 bg-purple-50 dark:bg-purple-900/20';
    case 'LocalLow':   return 'text-orange-500 bg-orange-50 dark:bg-orange-900/20';
    case 'Windows':    return 'text-red-500 bg-red-50 dark:bg-red-900/20';
    case 'Program Files':
    case 'Program Files (x86)':
      return 'text-amber-500 bg-amber-50 dark:bg-amber-900/20';
    case 'Users':      return 'text-cyan-500 bg-cyan-50 dark:bg-cyan-900/20';
    case 'System':     return 'text-rose-500 bg-rose-50 dark:bg-rose-900/20';
    default:           return 'text-gray-500 bg-gray-50 dark:bg-gray-900/20';
  }
}

// ============================================================================
// 面包屑导航
// 路径过长时截断中间部分，保留最后两级
// ============================================================================

interface BreadcrumbSegment {
  name: string;
  path: string;
}

/** 将 Windows 绝对路径拆分为面包屑段 */
function buildBreadcrumbs(fullPath: string): BreadcrumbSegment[] {
  const parts = fullPath.replace(/\//g, '\\').split('\\').filter(Boolean);
  const segments: BreadcrumbSegment[] = [];
  let accumulated = '';
  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}\\${part}` : part;
    // 第一段是盘符如 "C:"，补上反斜杠
    const path = segments.length === 0 ? `${accumulated}\\` : accumulated;
    segments.push({ name: part, path });
  }
  return segments;
}

function ModalBreadcrumbs({
  segments,
  initialDepth,
  onNavigate,
}: {
  segments: BreadcrumbSegment[];
  /** 初始路径的层级数，前 initialDepth 级不可点击 */
  initialDepth: number;
  onNavigate: (path: string) => void;
}) {
  // 如果段数 > 5，截断中间保留 前2 + "..." + 后2
  const MAX_VISIBLE = 5;
  // 记录原始索引以判断是否可点击
  type VisibleItem = { seg: BreadcrumbSegment; originalIndex: number } | null;
  let visible: VisibleItem[] = segments.map((seg, i) => ({ seg, originalIndex: i }));
  if (segments.length > MAX_VISIBLE) {
    visible = [
      { seg: segments[0], originalIndex: 0 },
      { seg: segments[1], originalIndex: 1 },
      null, // 省略号占位
      { seg: segments[segments.length - 2], originalIndex: segments.length - 2 },
      { seg: segments[segments.length - 1], originalIndex: segments.length - 1 },
    ];
  }

  return (
    <div className="flex items-center gap-1 text-xs overflow-x-auto scrollbar-thin py-1 min-w-0">
      {visible.map((item, idx) => {
        if (item === null) {
          return (
            <span key="ellipsis" className="flex items-center gap-1 shrink-0 text-[var(--text-faint)]">
              <ChevronRight className="w-3 h-3" />
              <span>···</span>
            </span>
          );
        }
        const { seg, originalIndex } = item;
        const isLast = idx === visible.length - 1;
        // initialPath 的父级目录不可点击（已在父模块扫描过），initialPath 本身及之后可点击
        // initialDepth 是 initialPath 的层级数，所以 index < initialDepth - 1 的不可点击
        const isClickable = originalIndex >= initialDepth - 1 && !isLast;
        return (
          <span key={seg.path} className="flex items-center gap-1 shrink-0">
            {idx > 0 && <ChevronRight className="w-3 h-3 text-[var(--text-faint)]" />}
            {isLast ? (
              <span
                className="font-semibold text-[var(--text-primary)] max-w-[180px] truncate"
                title={seg.path}
              >
                {seg.name}
              </span>
            ) : isClickable ? (
              <button
                onClick={() => onNavigate(seg.path)}
                className="text-[var(--text-muted)] hover:text-[var(--brand-green)] hover:underline transition-colors max-w-[120px] truncate"
                title={seg.path}
              >
                {seg.name}
              </button>
            ) : (
              <span
                className="text-[var(--text-faint)] max-w-[120px] truncate cursor-default"
                title={seg.path}
              >
                {seg.name}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ============================================================================
// 下钻列表条目（沉浸式 - 全宽、无缩进）
// ============================================================================

interface ModalEntryItemProps {
  entry: HotspotEntry;
  rank: number;
  maxSize: number;
  onDrillDown: (path: string) => void;
  onOpenFolder: (path: string) => void;
  onCleanup: (entry: HotspotEntry) => void;
  onSearch: (path: string) => void;
}

function ModalEntryItem({
  entry, rank, maxSize, onDrillDown, onOpenFolder, onCleanup, onSearch,
}: ModalEntryItemProps) {
  const percentage = maxSize > 0 ? (entry.total_size / maxSize) * 100 : 0;
  const canCleanup = entry.is_safe_to_clean && entry.is_cache && !entry.is_program && !entry.is_protected;

  return (
    <div
      className={`group relative rounded-xl p-3 hover:bg-[var(--bg-hover)] transition-colors cursor-default ${
        entry.is_protected ? 'border border-red-200 dark:border-red-800/30' : ''
      }`}
    >
      {/* 占比背景条 */}
      <div
        className={`absolute inset-0 rounded-xl opacity-40 transition-all ${
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

        {/* 左侧：图标 + 名称 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <FolderOpen className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
            <span className="font-medium text-sm text-[var(--text-primary)]">{entry.name}</span>
            <span className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded ${getParentTypeColor(entry.parent_type)}`}>
              {entry.parent_type}
            </span>
            {entry.is_protected && (
              <span className="flex-shrink-0 flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded text-red-500 bg-red-50 dark:bg-red-900/20">
                <Shield className="w-3 h-3" />
                系统保护
              </span>
            )}
            {entry.is_cache && !entry.is_program && !entry.is_protected && (
              <span className="flex-shrink-0 flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded text-orange-500 bg-orange-50 dark:bg-orange-900/20">
                <Trash2 className="w-3 h-3" />
                临时缓存
              </span>
            )}
          </div>
        </div>

        {/* 右侧：大小 + 修改日期 + 操作按钮 */}
        <div className="flex-shrink-0 flex items-center gap-4 text-xs">
          <div className="hidden sm:flex items-center gap-1 text-[var(--text-muted)]">
            <HardDrive className="w-3 h-3" />
            <span>{entry.file_count.toLocaleString()} 个</span>
          </div>
          <div className="hidden md:flex items-center gap-1 text-[var(--text-muted)]">
            <Clock className="w-3 h-3" />
            <span>{formatDateTime(entry.last_modified)}</span>
          </div>
          <div className={`font-semibold min-w-[70px] text-right ${
            entry.is_protected ? 'text-red-500' : 'text-[var(--brand-green)]'
          }`}>
            {formatSize(entry.total_size)}
          </div>

          {/* 操作按钮组 */}
          <div className="flex items-center gap-1">
            {/* 下钻 */}
            <button
              onClick={(e) => { e.stopPropagation(); onDrillDown(entry.path); }}
              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-[var(--brand-green-10)] text-[var(--brand-green)] transition-all"
              title="展开下级目录"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            {/* 清理 */}
            {canCleanup && (
              <button
                onClick={(e) => { e.stopPropagation(); onCleanup(entry); }}
                className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-orange-100 dark:hover:bg-orange-900/30 text-orange-500 transition-all"
                title="清理缓存文件"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            {/* 搜索 全路径用.path，文件夹名称用.name */}
            <button
              onClick={(e) => { e.stopPropagation(); onSearch(entry.path); }}
              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-blue-500 transition-all"
              title="搜索该文件夹是否可以删除"
            >
              <Search className="w-4 h-4" />
            </button>
            {/* 打开文件夹 */}
            <button
              onClick={(e) => { e.stopPropagation(); onOpenFolder(entry.path); }}
              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all"
              title="在文件资源管理器中打开"
            >
              <FolderOpen className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// DrillDownModal 主组件
// ============================================================================

interface DrillDownModalProps {
  /** 初始路径（点击下钻时传入的路径） */
  initialPath: string;
  /** 关闭回调 */
  onClose: () => void;
  /** 清理发生后的同步回调（通知主界面刷新） */
  onCleanupDone?: () => void;
}

export function DrillDownModal({ initialPath, onClose, onCleanupDone }: DrillDownModalProps) {
  const { showToast } = useToast();

  // ====== 动画状态 ======
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(true);
  const enteredRef = useRef(false);
  if (isVisible) enteredRef.current = true;

  // ====== 数据状态 ======
  /** 路径栈：从初始路径开始，每次下钻 push，回退 pop */
  const [pathStack, setPathStack] = useState<string[]>([initialPath]);
  const [scanResult, setScanResult] = useState<HotspotScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  /** 记录本次模态框内是否发生过清理（用于关闭时同步） */
  const didCleanupRef = useRef(false);

  // ====== 清理确认对话框 ======
  const [cleanupTarget, setCleanupTarget] = useState<HotspotEntry | null>(null);
  const [isCleaning, setIsCleaning] = useState(false);

  // 当前路径（栈顶）
  const currentPath = pathStack[pathStack.length - 1];

  // ====== 入场动画 ======
  useEffect(() => {
    // 延迟一帧触发动画
    const raf = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // ====== ESC 键关闭 ======
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ====== 数据加载 ======
  const fetchData = useCallback(async (targetPath: string) => {
    setLoading(true);
    try {
      const result = await scanPathDirect(targetPath);
      setScanResult(result);
    } catch (err) {
      console.error('下钻扫描失败:', err);
      showToast({ type: 'error', title: '下钻扫描失败', description: String(err) });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  // 初始加载 + 路径变化时重新加载
  useEffect(() => {
    fetchData(currentPath);
  }, [currentPath, fetchData]);

  // ====== 关闭（带退出动画） ======
  const handleClose = useCallback(() => {
    setIsVisible(false);
    setTimeout(() => {
      setIsAnimating(false);
      if (didCleanupRef.current) {
        onCleanupDone?.();
      }
      onClose();
    }, 190);
  }, [onClose, onCleanupDone]);

  // ====== 下钻 ======
  const handleDrillDown = useCallback((path: string) => {
    setPathStack(prev => [...prev, path]);
  }, []);

  // ====== 返回上级 ======
  const handleGoBack = useCallback(() => {
    if (pathStack.length <= 1) {
      handleClose();
      return;
    }
    setPathStack(prev => prev.slice(0, -1));
  }, [pathStack.length, handleClose]);

  // ====== 面包屑跳转 ======
  const handleBreadcrumbNavigate = useCallback((targetPath: string) => {
    // 找到 pathStack 中对应的位置，截断到那里
    // 如果目标不在栈中（面包屑是完整路径拆分），直接替换栈
    const idx = pathStack.findIndex(p => p === targetPath);
    if (idx >= 0) {
      setPathStack(prev => prev.slice(0, idx + 1));
    } else {
      setPathStack([targetPath]);
    }
  }, [pathStack]);

  // ====== 打开文件夹 ======
  const handleOpenFolder = useCallback(async (path: string) => {
    try {
      await openInFolder(path);
    } catch (err) {
      console.error('打开文件夹失败:', err);
    }
  }, []);

  // ====== 搜索 ======
  const handleSearch = useCallback(async (path: string) => {
    try {
      const query = encodeURIComponent(`Windows 文件夹 ${path} 可以删除吗`);
      await openUrl(`https://www.bing.com/search?q=${query}`);
    } catch (err) {
      console.error('打开搜索链接失败:', err);
    }
  }, []);

  // ====== 清理 ======
  const handleCleanupConfirm = useCallback(async () => {
    if (!cleanupTarget) return;
    setIsCleaning(true);
    try {
      const result = await cleanupDirectoryContents(cleanupTarget.path);
      if (result.deleted_count > 0) {
        showToast({
          type: 'success',
          title: '清理完成',
          description: `已删除 ${result.deleted_count} 项，释放 ${formatSize(result.freed_size)}`,
        });
        didCleanupRef.current = true;
        // 重新加载当前层
        fetchData(currentPath);
      } else if (result.failed_count > 0) {
        showToast({ type: 'warning', title: '清理受阻', description: `${result.failed_count} 个文件被占用无法删除` });
      } else {
        showToast({ type: 'info', title: '目录已为空', description: '没有需要清理的文件' });
      }
    } catch (err) {
      console.error('清理失败:', err);
      showToast({ type: 'error', title: '清理失败', description: String(err) });
    } finally {
      setIsCleaning(false);
      setCleanupTarget(null);
    }
  }, [cleanupTarget, currentPath, fetchData, showToast]);

  // 面包屑段
  const breadcrumbSegments = buildBreadcrumbs(currentPath);
  // 初始路径的层级数（前 initialDepth 级不可点击，因为父模块已扫描过）
  const initialDepth = buildBreadcrumbs(initialPath).length;
  const maxSize = scanResult?.entries[0]?.total_size || 0;

  if (!isAnimating) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
      {/* 遮罩层 - 半透明磨砂 */}
      <div
        className={`absolute inset-0 bg-black/40 backdrop-blur-md ${
          isVisible ? 'modal-overlay-in' : enteredRef.current ? 'modal-overlay-out' : 'opacity-0'
        }`}
        onClick={handleClose}
      />

      {/* 模态框主体 */}
      <div
        className={`relative flex flex-col bg-[var(--bg-elevated)] rounded-2xl shadow-2xl border border-[var(--border-default)]
          w-[720px] max-w-[92vw] max-h-[80vh] overflow-hidden ${
          isVisible ? 'modal-content-in' : enteredRef.current ? 'modal-content-out' : 'opacity-0'
        }`}
      >
        {/* ====== 头部：面包屑 + 关闭按钮 ====== */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-default)] bg-[var(--bg-card)]/80 backdrop-blur-sm">
          <div className="flex-1 min-w-0 mr-3">
            <ModalBreadcrumbs segments={breadcrumbSegments} initialDepth={initialDepth} onNavigate={handleBreadcrumbNavigate} />
          </div>
          <button
            onClick={handleClose}
            className="flex-shrink-0 p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            title="关闭 (ESC)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ====== 内容区：可滚动列表 ====== */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 min-h-[200px]">
          {/* 加载中 */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--brand-green)] mr-2" />
              <span className="text-sm text-[var(--text-muted)]">正在扫描子目录...</span>
            </div>
          )}

          {/* 列表内容 */}
          {!loading && scanResult && (
            <>
              {/* 返回上级 */}
              <button
                onClick={handleGoBack}
                className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-[var(--bg-hover)] transition-colors text-left"
              >
                <div className="w-7 h-7 rounded-lg bg-[var(--bg-card)] border border-[var(--border-color)] flex items-center justify-center">
                  <CornerLeftUp className="w-4 h-4 text-[var(--text-muted)]" />
                </div>
                <span className="text-sm text-[var(--text-muted)]">
                  {pathStack.length <= 1 ? '关闭' : '返回上级目录'}
                </span>
              </button>

              {/* 目录条目 */}
              {scanResult.entries.map((entry, index) => (
                <ModalEntryItem
                  key={entry.path}
                  entry={entry}
                  rank={index + 1}
                  maxSize={maxSize}
                  onDrillDown={handleDrillDown}
                  onOpenFolder={handleOpenFolder}
                  onCleanup={setCleanupTarget}
                  onSearch={handleSearch}
                />
              ))}

              {/* 空状态 */}
              {scanResult.entries.length === 0 && (
                <div className="text-center py-10 text-[var(--text-muted)]">
                  <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">该目录下没有子文件夹</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* ====== 底栏：统计信息 ====== */}
        {!loading && scanResult && scanResult.entries.length > 0 && (
          <div className="flex items-center justify-between px-5 py-2.5 border-t border-[var(--border-default)] text-xs text-[var(--text-muted)] bg-[var(--bg-card)]/80 backdrop-blur-sm">
            <span>
              共 <strong className="text-[var(--text-primary)]">{scanResult.entries.length}</strong> 个子目录，
              总计 <strong className="text-[var(--brand-green)]">{formatSize(scanResult.appdata_total_size)}</strong>
            </span>
            <span>耗时 {(scanResult.scan_duration_ms / 1000).toFixed(1)}s</span>
          </div>
        )}
      </div>

      {/* 清理确认对话框（嵌套 Portal，z-index 更高） */}
      {cleanupTarget && (
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
        />
      )}
    </div>,
    document.body
  );
}
