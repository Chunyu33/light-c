// ============================================================================
// 大文件清理页面组件
// 扫描 C 盘体积最大的文件，支持选择删除
// ============================================================================

import { useEffect, useState } from 'react';
import { HardDrive, Search, Trash2, FileWarning, Loader2, FolderSearch, CheckCircle2, FolderOpen, ExternalLink } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { deleteFiles, scanLargeFiles, openInFolder, openFile } from '../api/commands';
import { ConfirmDialog, BackButton, useToast } from '../components';
import {
  formatDate,
  formatSize,
  getRiskLevelBgColor,
  getRiskLevelColor,
  getRiskLevelText,
} from '../utils/format';
import type { LargeFileEntry } from '../types';

interface BigFilesPageProps {
  /** 返回首页回调 */
  onBack: () => void;
}

/**
 * 大文件风险等级划分（按体积）
 * @param size 文件大小（字节）
 * @returns 风险等级 1-5
 */
function getLargeFileRiskLevel(size: number): number {
  const GB = 1024 * 1024 * 1024;
  if (size >= 10 * GB) return 5;
  if (size >= 5 * GB) return 4;
  if (size >= 2 * GB) return 3;
  if (size >= 1 * GB) return 2;
  return 1;
}

export function BigFilesPage({ onBack }: BigFilesPageProps) {
  // 扫描状态
  const [status, setStatus] = useState<'idle' | 'scanning' | 'done'>('idle');
  // 当前扫描路径（实时显示）
  const [currentPath, setCurrentPath] = useState('');
  // 扫描结果
  const [files, setFiles] = useState<LargeFileEntry[]>([]);
  // 选中的文件路径
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  // 删除确认弹窗
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // 删除中状态
  const [isDeleting, setIsDeleting] = useState(false);
  // Toast 提示
  const { showToast } = useToast();

  // 监听扫描进度事件
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      unlisten = await listen<string>('large-file-scan:progress', (event) => {
        setCurrentPath(event.payload);
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  // 开始扫描
  const handleScan = async () => {
    setStatus('scanning');
    setFiles([]);
    setCurrentPath('');
    setSelectedFiles(new Set());

    try {
      const results = await scanLargeFiles();
      setFiles(results);
      setStatus('done');
    } catch (err) {
      console.error('扫描大文件失败:', err);
      setStatus('idle');
    }
  };

  // 切换文件选中状态
  const toggleFileSelection = (path: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // 全选/取消全选
  const toggleSelectAll = () => {
    if (selectedFiles.size === files.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(files.map((f) => f.path)));
    }
  };

  // 执行删除
  const handleDelete = async () => {
    const paths = Array.from(selectedFiles);
    if (paths.length === 0) return;

    setIsDeleting(true);

    try {
      const result = await deleteFiles(paths);
      console.log('删除结果:', result);

      // 显示 Toast 提示
      if (result.failed_count === 0) {
        showToast({
          type: 'success',
          title: `成功删除 ${result.success_count} 个文件`,
          description: `已释放 ${formatSize(result.freed_size)} 空间`,
        });
      } else if (result.success_count === 0) {
        showToast({
          type: 'error',
          title: `删除失败`,
          description: `${result.failed_count} 个文件无法删除`,
        });
      } else {
        showToast({
          type: 'warning',
          title: `部分成功`,
          description: `${result.success_count} 个已删除，${result.failed_count} 个失败`,
        });
      }

      // 从列表中移除成功删除的文件
      if (result.success_count > 0) {
        const failedPaths = new Set(result.failed_files?.map((f) => f.path) || []);
        setFiles((prev) => prev.filter((file) => !selectedFiles.has(file.path) || failedPaths.has(file.path)));
        setSelectedFiles((prev) => {
          const next = new Set(prev);
          for (const path of prev) {
            if (!failedPaths.has(path)) {
              next.delete(path);
            }
          }
          return next;
        });
      }
    } catch (err) {
      console.error('删除大文件失败:', err);
      showToast({
        type: 'error',
        title: '删除失败',
        description: String(err),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // 计算选中文件的总大小
  const selectedSize = files
    .filter((f) => selectedFiles.has(f.path))
    .reduce((sum, f) => sum + f.size, 0);

  // 计算总大小
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  return (
    <>
      {/* 删除确认弹窗 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title="确认删除大文件"
        description={`您即将删除 ${selectedFiles.size.toLocaleString()} 个大文件，共 ${formatSize(selectedSize)}。此操作不可撤销，请确认这些文件不再需要。`}
        warning="免责声明：大文件删除可能影响系统或软件正常运行，请确认文件用途后再执行。建议先备份重要数据。"
        confirmText={isDeleting ? '删除中...' : '确认删除'}
        cancelText="取消"
        onConfirm={() => {
          setShowDeleteConfirm(false);
          handleDelete();
        }}
        onCancel={() => setShowDeleteConfirm(false)}
        isDanger
      />

      {/* 返回按钮 */}
      <BackButton onClick={onBack} />

      <div className="max-w-5xl mx-auto space-y-4">
        {/* 页面头部卡片 */}
        <div className="bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl p-6 text-white shadow-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-white/20 backdrop-blur-sm rounded-xl flex items-center justify-center">
                <HardDrive className="w-7 h-7" />
              </div>
              <div>
                <h1 className="text-xl font-bold">大文件清理</h1>
                <p className="text-sm text-white/80 mt-0.5">扫描 C 盘体积最大的文件，快速释放存储空间</p>
              </div>
            </div>
            <button
              onClick={handleScan}
              disabled={status === 'scanning'}
              className={`
                flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all
                ${status === 'scanning'
                  ? 'bg-white/20 cursor-not-allowed'
                  : 'bg-white text-emerald-600 hover:bg-white/90 shadow-md hover:shadow-lg'
                }
              `}
            >
              {status === 'scanning' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  扫描中...
                </>
              ) : (
                <>
                  <Search className="w-4 h-4" />
                  开始扫描
                </>
              )}
            </button>
          </div>

          {/* 扫描进度区 */}
          {status === 'scanning' && (
            <div className="mt-5 pt-5 border-t border-white/20">
              <div className="flex items-center gap-3 mb-3">
                <FolderSearch className="w-4 h-4 animate-pulse" />
                <span className="text-sm font-medium">正在扫描文件系统...</span>
              </div>
              <p className="text-xs text-white/70 truncate mb-3">
                {currentPath || '准备中...'}
              </p>
              <div className="h-1.5 bg-white/20 rounded-full overflow-hidden">
                <div className="h-full w-full bg-white/60 rounded-full animate-pulse" 
                  style={{ 
                    animation: 'shimmer 2s ease-in-out infinite',
                    background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.8), transparent)',
                    backgroundSize: '200% 100%'
                  }} 
                />
              </div>
            </div>
          )}

          {/* 扫描完成统计 */}
          {status === 'done' && files.length > 0 && (
            <div className="mt-5 pt-5 border-t border-white/20 flex items-center gap-6">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" />
                <span className="text-sm">扫描完成</span>
              </div>
              <div className="flex items-center gap-4 text-sm">
                <span>共 <strong>{files.length}</strong> 个大文件</span>
                <span>总计 <strong>{formatSize(totalSize)}</strong></span>
              </div>
            </div>
          )}
        </div>

        {/* 操作栏 */}
        {status === 'done' && files.length > 0 && (
          <div className="bg-[var(--bg-card)] rounded-xl border border-[var(--border-default)] p-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={toggleSelectAll}
                className="flex items-center gap-2 text-sm text-[var(--fg-secondary)] hover:text-emerald-600 transition"
              >
                <input
                  type="checkbox"
                  checked={selectedFiles.size === files.length && files.length > 0}
                  onChange={toggleSelectAll}
                  className="h-4 w-4 rounded border-[var(--border-default)] text-emerald-500 focus:ring-emerald-500"
                />
                {selectedFiles.size === files.length ? '取消全选' : '全选'}
              </button>
              {selectedFiles.size > 0 && (
                <span className="text-sm text-[var(--fg-muted)]">
                  已选 <strong className="text-emerald-600">{selectedFiles.size}</strong> 项，
                  共 <strong className="text-emerald-600">{formatSize(selectedSize)}</strong>
                </span>
              )}
            </div>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={selectedFiles.size === 0 || isDeleting}
              className={`
                flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all
                ${selectedFiles.size === 0 || isDeleting
                  ? 'bg-[var(--bg-hover)] text-[var(--fg-faint)] cursor-not-allowed'
                  : 'bg-rose-500 text-white hover:bg-rose-600 shadow-sm hover:shadow'
                }
              `}
            >
              <Trash2 className="w-4 h-4" />
              删除选中
            </button>
          </div>
        )}

        {/* 文件列表 */}
        <div className="bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] overflow-hidden">
          {/* 列表头部 */}
          <div className="px-5 py-3 bg-[var(--bg-elevated)] border-b border-[var(--border-default)] flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--fg-primary)]">
              Top 50 大文件
            </h3>
            <span className="text-xs text-[var(--fg-muted)]">
              {files.length} 项
            </span>
          </div>

          {/* 列表内容 */}
          <div className="max-h-[400px] overflow-auto">
            {/* 空状态 */}
            {status === 'idle' && files.length === 0 && (
              <div className="py-16 flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 bg-[var(--bg-hover)] rounded-2xl flex items-center justify-center mb-4">
                  <Search className="w-8 h-8 text-[var(--fg-faint)]" />
                </div>
                <p className="text-sm font-medium text-[var(--fg-secondary)]">等待扫描</p>
                <p className="text-xs text-[var(--fg-muted)] mt-1">点击上方按钮开始扫描大文件</p>
              </div>
            )}

            {/* 扫描中状态 */}
            {status === 'scanning' && (
              <div className="py-16 flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mb-4">
                  <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
                </div>
                <p className="text-sm font-medium text-[var(--fg-secondary)]">正在扫描中...</p>
                <p className="text-xs text-[var(--fg-muted)] mt-1">正在遍历 C 盘文件，请稍候</p>
              </div>
            )}

            {/* 无结果状态 */}
            {status === 'done' && files.length === 0 && (
              <div className="py-16 flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mb-4">
                  <CheckCircle2 className="w-8 h-8 text-emerald-500" />
                </div>
                <p className="text-sm font-medium text-[var(--fg-secondary)]">太棒了！</p>
                <p className="text-xs text-[var(--fg-muted)] mt-1">没有发现需要清理的大文件</p>
              </div>
            )}

            {/* 文件列表 */}
            {files.length > 0 && (
              <div className="divide-y divide-[var(--border-default)]">
                {files.map((file, index) => {
                  const riskLevel = getLargeFileRiskLevel(file.size);
                  const isSelected = selectedFiles.has(file.path);
                  return (
                    <div
                      key={file.path}
                      onClick={() => toggleFileSelection(file.path)}
                      className={`
                        px-5 py-4 flex items-center gap-4 cursor-pointer transition-all
                        ${isSelected 
                          ? 'bg-emerald-500/5 hover:bg-emerald-500/10' 
                          : 'hover:bg-[var(--bg-hover)]'
                        }
                      `}
                    >
                      {/* 序号 + 复选框 */}
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="w-6 text-center text-xs font-medium text-[var(--fg-faint)]">
                          {index + 1}
                        </span>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          className="h-4 w-4 rounded border-[var(--border-default)] text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                        />
                      </div>

                      {/* 文件图标 */}
                      <div className={`
                        w-10 h-10 rounded-xl flex items-center justify-center shrink-0
                        ${getRiskLevelBgColor(riskLevel)}
                      `}>
                        <FileWarning className={`w-5 h-5 ${getRiskLevelColor(riskLevel)}`} />
                      </div>

                      {/* 文件信息 */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-[var(--fg-primary)] truncate font-medium" title={file.path}>
                          {file.path.split('\\').pop() || file.path}
                        </p>
                        <p className="text-xs text-[var(--fg-muted)] truncate mt-0.5" title={file.path}>
                          {file.path}
                        </p>
                      </div>

                      {/* 右侧信息 */}
                      <div className="text-right shrink-0">
                        <p className="text-sm font-bold text-emerald-600">
                          {formatSize(file.size)}
                        </p>
                        <div className="flex items-center justify-end gap-2 mt-1">
                          <span className="text-[11px] text-[var(--fg-muted)]">
                            {formatDate(file.modified)}
                          </span>
                          <span className={`
                            px-2 py-0.5 rounded-full text-[10px] font-semibold
                            ${getRiskLevelColor(riskLevel)} ${getRiskLevelBgColor(riskLevel)}
                          `}>
                            {getRiskLevelText(riskLevel)}
                          </span>
                        </div>
                      </div>

                      {/* 操作按钮 */}
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openInFolder(file.path);
                          }}
                          className="p-2 hover:bg-[var(--bg-hover)] rounded-lg transition text-[var(--fg-muted)] hover:text-emerald-600"
                          title="打开所在文件夹"
                        >
                          <FolderOpen className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openFile(file.path);
                          }}
                          className="p-2 hover:bg-[var(--bg-hover)] rounded-lg transition text-[var(--fg-muted)] hover:text-emerald-600"
                          title="打开文件"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
