// ============================================================================
// 大文件清理页面组件
// 扫描 C 盘体积最大的文件，支持选择删除
// ============================================================================

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { HardDrive, Search, Trash2, FileWarning, Loader2, FolderSearch, CheckCircle2, FolderOpen, ExternalLink, StopCircle } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { deleteFiles, scanLargeFiles, cancelLargeFileScan, openInFolder, openFile } from '../api/commands';
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
  /** 清理完成回调 */
  onCleanupComplete?: () => void;
}

/**
 * 大文件风险等级划分（基于文件路径和类型判断）
 * @param path 文件路径
 * @returns 风险等级 1-5 (1=安全可删, 5=高风险勿删)
 */
function getLargeFileRiskLevel(path: string): number {
  const lowerPath = path.toLowerCase();
  const fileName = lowerPath.split('\\').pop() || '';
  const ext = fileName.includes('.') ? fileName.split('.').pop() || '' : '';

  // ========== 高风险 (5) - 系统关键文件，删除可能导致系统无法启动 ==========
  // Windows 系统核心目录
  if (lowerPath.includes('\\windows\\system32\\') || 
      lowerPath.includes('\\windows\\syswow64\\') ||
      lowerPath.includes('\\windows\\winsxs\\')) {
    return 5;
  }
  // 系统关键文件
  if (['pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'ntoskrnl.exe', 'bootmgr'].includes(fileName)) {
    return 5;
  }
  // 驱动程序
  if (ext === 'sys' && lowerPath.includes('\\windows\\')) {
    return 5;
  }
  // 注册表文件
  if (['ntuser.dat', 'system', 'software', 'sam', 'security'].includes(fileName) && 
      (lowerPath.includes('\\config\\') || lowerPath.includes('\\users\\'))) {
    return 5;
  }

  // ========== 较高风险 (4) - 程序文件，删除可能导致软件无法运行 ==========
  // Program Files 目录下的可执行文件和库
  if ((lowerPath.includes('\\program files\\') || lowerPath.includes('\\program files (x86)\\')) &&
      ['exe', 'dll', 'ocx', 'msi'].includes(ext)) {
    return 4;
  }
  // Windows 目录下的其他文件
  if (lowerPath.includes('\\windows\\') && !lowerPath.includes('\\temp\\')) {
    return 4;
  }
  // 用户配置文件目录
  if (lowerPath.includes('\\appdata\\roaming\\') && ['exe', 'dll', 'dat'].includes(ext)) {
    return 4;
  }

  // ========== 中等风险 (3) - 可能有用的数据文件 ==========
  // 数据库文件
  if (['db', 'sqlite', 'mdf', 'ldf', 'accdb', 'mdb'].includes(ext)) {
    return 3;
  }
  // 虚拟机文件（用户可能需要）
  if (['vmdk', 'vdi', 'vhd', 'vhdx'].includes(ext)) {
    return 3;
  }
  // 文档文件
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf'].includes(ext)) {
    return 3;
  }
  // 压缩包（可能包含重要备份）
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext) && !lowerPath.includes('\\temp\\')) {
    return 3;
  }

  // ========== 低风险 (2) - 通常可以安全删除 ==========
  // 视频文件（通常是下载的媒体）
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'].includes(ext)) {
    return 2;
  }
  // 音频文件
  if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'wma', 'ogg'].includes(ext)) {
    return 2;
  }
  // 图片文件
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'raw'].includes(ext)) {
    return 2;
  }
  // 游戏和软件安装包
  if (lowerPath.includes('\\downloads\\') || lowerPath.includes('\\desktop\\')) {
    return 2;
  }

  // ========== 安全 (1) - 临时文件和缓存，可放心删除 ==========
  // 临时目录
  if (lowerPath.includes('\\temp\\') || lowerPath.includes('\\tmp\\') || 
      lowerPath.includes('\\cache\\') || lowerPath.includes('\\caches\\')) {
    return 1;
  }
  // 日志文件
  if (['log', 'tmp', 'bak', 'old', 'dmp'].includes(ext)) {
    return 1;
  }
  // 回收站
  if (lowerPath.includes('\\$recycle.bin\\')) {
    return 1;
  }
  // 浏览器缓存
  if (lowerPath.includes('\\cache\\') || lowerPath.includes('\\code cache\\')) {
    return 1;
  }

  // 默认中等风险（未知文件类型需谨慎）
  return 3;
}

export function BigFilesPage({ onBack, onCleanupComplete }: BigFilesPageProps) {
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

  // 停止扫描
  const handleStopScan = async () => {
    try {
      await cancelLargeFileScan();
      showToast({ type: 'info', title: '扫描已停止', description: '将显示已扫描到的大文件' });
    } catch (err) {
      console.error('停止扫描失败:', err);
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
        // 触发健康评分刷新
        onCleanupComplete?.();
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
      {/* 删除进度遮罩 - 使用 Portal 渲染到 body 确保覆盖全屏 */}
      {isDeleting && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-[var(--bg-card)] rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-4 max-w-sm mx-4">
            <div className="w-16 h-16 rounded-full bg-rose-500/10 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-rose-500 animate-spin" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-[var(--fg-primary)]">正在删除文件</h3>
              <p className="text-sm text-[var(--fg-muted)] mt-1">
                正在删除 {selectedFiles.size} 个文件，请稍候...
              </p>
            </div>
            <div className="w-full h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden">
              <div className="h-full bg-rose-500 rounded-full animate-pulse" style={{ width: '100%' }} />
            </div>
            <p className="text-xs text-[var(--fg-faint)]">请勿关闭窗口</p>
          </div>
        </div>,
        document.body
      )}

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
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <FolderSearch className="w-4 h-4 animate-pulse" />
                  <span className="text-sm font-medium">正在扫描文件系统...</span>
                </div>
                <button
                  onClick={handleStopScan}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white/20 hover:bg-white/30 rounded-lg text-xs font-medium transition-colors"
                >
                  <StopCircle className="w-3.5 h-3.5" />
                  停止扫描
                </button>
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
                  const riskLevel = getLargeFileRiskLevel(file.path);
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
