// ============================================================================
// 大文件清理模块组件
// 在仪表盘中展示大文件扫描和清理功能
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { HardDrive, Trash2, Loader2, FileWarning, FolderOpen, ExternalLink, StopCircle } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { ModuleCard } from '../ModuleCard';
import { ConfirmDialog } from '../ConfirmDialog';
import { useToast } from '../Toast';
import { useDashboard } from '../../contexts/DashboardContext';
import { scanLargeFiles, cancelLargeFileScan, deleteFiles, openInFolder, openFile } from '../../api/commands';
import { formatSize, formatDate, getRiskLevelColor, getRiskLevelBgColor, getRiskLevelText } from '../../utils/format';
import type { LargeFileEntry } from '../../types';

// ============================================================================
// 风险等级计算函数
// ============================================================================

function getLargeFileRiskLevel(path: string): number {
  const lowerPath = path.toLowerCase();
  const fileName = lowerPath.split('\\').pop() || '';
  const ext = fileName.includes('.') ? fileName.split('.').pop() || '' : '';

  // 高风险 (5) - 系统关键文件
  if (lowerPath.includes('\\windows\\system32\\') || 
      lowerPath.includes('\\windows\\syswow64\\') ||
      lowerPath.includes('\\windows\\winsxs\\')) {
    return 5;
  }
  if (['pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'ntoskrnl.exe', 'bootmgr'].includes(fileName)) {
    return 5;
  }
  if (ext === 'sys' && lowerPath.includes('\\windows\\')) {
    return 5;
  }

  // 较高风险 (4) - 程序文件
  if ((lowerPath.includes('\\program files\\') || lowerPath.includes('\\program files (x86)\\')) &&
      ['exe', 'dll', 'ocx', 'msi'].includes(ext)) {
    return 4;
  }
  if (lowerPath.includes('\\windows\\') && !lowerPath.includes('\\temp\\')) {
    return 4;
  }

  // 中等风险 (3) - 数据文件
  if (['db', 'sqlite', 'mdf', 'ldf', 'accdb', 'mdb', 'vmdk', 'vdi', 'vhd', 'vhdx'].includes(ext)) {
    return 3;
  }
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf'].includes(ext)) {
    return 3;
  }

  // 低风险 (2) - 媒体文件
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mp3', 'wav', 'flac'].includes(ext)) {
    return 2;
  }
  if (lowerPath.includes('\\downloads\\') || lowerPath.includes('\\desktop\\')) {
    return 2;
  }

  // 安全 (1) - 临时文件
  if (lowerPath.includes('\\temp\\') || lowerPath.includes('\\tmp\\') || lowerPath.includes('\\cache\\')) {
    return 1;
  }
  if (['log', 'tmp', 'bak', 'old', 'dmp'].includes(ext)) {
    return 1;
  }

  return 3;
}

// ============================================================================
// 组件实现
// ============================================================================

export function BigFilesModule() {
  const { modules, expandedModule, setExpandedModule, updateModuleState, triggerHealthRefresh, oneClickScanTrigger } = useDashboard();
  const moduleState = modules.bigFiles;
  const { showToast } = useToast();

  // 用于跟踪是否已处理过当前的一键扫描触发
  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [files, setFiles] = useState<LargeFileEntry[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [currentPath, setCurrentPath] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

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
  const handleScan = useCallback(async () => {
    updateModuleState('bigFiles', { status: 'scanning', error: null });
    setFiles([]);
    setCurrentPath('');
    setSelectedFiles(new Set());

    try {
      const results = await scanLargeFiles();
      setFiles(results);
      
      const totalSize = results.reduce((sum, f) => sum + f.size, 0);
      updateModuleState('bigFiles', {
        status: 'done',
        fileCount: results.length,
        totalSize,
      });

      // 自动展开模块
      setExpandedModule('bigFiles');
    } catch (err) {
      console.error('扫描大文件失败:', err);
      updateModuleState('bigFiles', { status: 'error', error: String(err) });
    }
  }, [updateModuleState, setExpandedModule]);

  // 监听一键扫描触发器
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  // 停止扫描
  const handleStopScan = useCallback(async () => {
    try {
      await cancelLargeFileScan();
      showToast({ type: 'info', title: '扫描已停止', description: '将显示已扫描到的大文件' });
    } catch (err) {
      console.error('停止扫描失败:', err);
    }
  }, [showToast]);

  // 切换文件选中状态
  const toggleFileSelection = useCallback((path: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // 全选/取消全选
  const toggleSelectAll = useCallback(() => {
    if (selectedFiles.size === files.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(files.map((f) => f.path)));
    }
  }, [selectedFiles.size, files]);

  // 执行删除
  const handleDelete = useCallback(async () => {
    const paths = Array.from(selectedFiles);
    if (paths.length === 0) return;

    setIsDeleting(true);

    try {
      const result = await deleteFiles(paths);

      if (result.failed_count === 0) {
        showToast({
          type: 'success',
          title: `成功删除 ${result.success_count} 个文件`,
          description: `已释放 ${formatSize(result.freed_size)} 空间`,
        });
      } else if (result.success_count === 0) {
        showToast({
          type: 'error',
          title: '删除失败',
          description: `${result.failed_count} 个文件无法删除`,
        });
      } else {
        showToast({
          type: 'warning',
          title: '部分成功',
          description: `${result.success_count} 个已删除，${result.failed_count} 个失败`,
        });
      }

      // 从列表中移除成功删除的文件
      if (result.success_count > 0) {
        const failedPaths = new Set(result.failed_files?.map((f) => f.path) || []);
        const newFiles = files.filter((file) => !selectedFiles.has(file.path) || failedPaths.has(file.path));
        setFiles(newFiles);
        
        const newTotalSize = newFiles.reduce((sum, f) => sum + f.size, 0);
        updateModuleState('bigFiles', {
          fileCount: newFiles.length,
          totalSize: newTotalSize,
        });

        setSelectedFiles((prev) => {
          const next = new Set(prev);
          for (const path of prev) {
            if (!failedPaths.has(path)) {
              next.delete(path);
            }
          }
          return next;
        });

        triggerHealthRefresh();
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
  }, [selectedFiles, files, updateModuleState, triggerHealthRefresh, showToast]);

  // 计算选中文件的总大小
  const selectedSize = files
    .filter((f) => selectedFiles.has(f.path))
    .reduce((sum, f) => sum + f.size, 0);

  const isExpanded = expandedModule === 'bigFiles';
  const isScanning = moduleState.status === 'scanning';

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
          </div>
        </div>,
        document.body
      )}

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title="确认删除大文件"
        description={`您即将删除 ${selectedFiles.size.toLocaleString()} 个大文件，共 ${formatSize(selectedSize)}。此操作不可撤销。`}
        warning="免责声明：大文件删除可能影响系统或软件正常运行，请确认文件用途后再执行。"
        confirmText="确认删除"
        cancelText="取消"
        onConfirm={() => {
          setShowDeleteConfirm(false);
          handleDelete();
        }}
        onCancel={() => setShowDeleteConfirm(false)}
        isDanger
      />

      <ModuleCard
        id="bigFiles"
        title="大文件清理"
        description="扫描 C 盘体积最大的文件，快速释放存储空间"
        icon={<HardDrive className="w-6 h-6 text-emerald-500" />}
        iconBgClass="bg-emerald-500/15"
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={moduleState.totalSize}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'bigFiles')}
        onScan={handleScan}
        error={moduleState.error}
        headerExtra={
          <>
            {isScanning && (
              <button
                onClick={handleStopScan}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg text-xs font-medium text-amber-600 transition"
              >
                <StopCircle className="w-3.5 h-3.5" />
                停止
              </button>
            )}
            {files.length > 0 && !isScanning && (
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleSelectAll}
                  className="text-xs text-[var(--fg-muted)] hover:text-emerald-600 transition"
                >
                  {selectedFiles.size === files.length ? '取消全选' : '全选'}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={selectedFiles.size === 0}
                  className={`
                    flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                    ${selectedFiles.size === 0
                      ? 'bg-[var(--bg-hover)] text-[var(--fg-faint)] cursor-not-allowed'
                      : 'bg-rose-500 text-white hover:bg-rose-600'
                    }
                  `}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  删除 ({selectedFiles.size})
                </button>
              </div>
            )}
          </>
        }
      >
        {/* 展开内容 */}
        <div className="max-h-[400px] overflow-auto">
          {/* 扫描进度提示 */}
          {isScanning && currentPath && (
            <div className="px-4 py-2 bg-emerald-500/5 border-b border-[var(--border-default)] text-xs text-[var(--fg-muted)] truncate">
              正在扫描: {currentPath}
            </div>
          )}

          {/* 空状态 */}
          {moduleState.status === 'idle' && files.length === 0 && (
            <div className="py-12 flex flex-col items-center justify-center text-center">
              <div className="w-14 h-14 bg-[var(--bg-hover)] rounded-2xl flex items-center justify-center mb-3">
                <HardDrive className="w-7 h-7 text-[var(--fg-faint)]" />
              </div>
              <p className="text-sm font-medium text-[var(--fg-secondary)]">等待扫描</p>
              <p className="text-xs text-[var(--fg-muted)] mt-1">点击扫描按钮开始查找大文件</p>
            </div>
          )}

          {/* 扫描中状态 */}
          {isScanning && files.length === 0 && (
            <div className="py-12 flex flex-col items-center justify-center text-center">
              <div className="w-14 h-14 bg-emerald-500/10 rounded-2xl flex items-center justify-center mb-3">
                <Loader2 className="w-7 h-7 text-emerald-500 animate-spin" />
              </div>
              <p className="text-sm font-medium text-[var(--fg-secondary)]">正在扫描中...</p>
              <p className="text-xs text-[var(--fg-muted)] mt-1">正在遍历 C 盘文件，请稍候</p>
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
                      px-4 py-3 flex items-center gap-3 cursor-pointer transition-all
                      ${isSelected ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : 'hover:bg-[var(--bg-hover)]'}
                    `}
                  >
                    {/* 序号 + 复选框 */}
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="w-5 text-center text-xs font-medium text-[var(--fg-faint)]">
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
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${getRiskLevelBgColor(riskLevel)}`}>
                      <FileWarning className={`w-4 h-4 ${getRiskLevelColor(riskLevel)}`} />
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
                      <p className="text-sm font-bold text-emerald-600">{formatSize(file.size)}</p>
                      <div className="flex items-center justify-end gap-2 mt-0.5">
                        <span className="text-[10px] text-[var(--fg-muted)]">{formatDate(file.modified)}</span>
                        <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold ${getRiskLevelColor(riskLevel)} ${getRiskLevelBgColor(riskLevel)}`}>
                          {getRiskLevelText(riskLevel)}
                        </span>
                      </div>
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openInFolder(file.path);
                        }}
                        className="p-1.5 hover:bg-[var(--bg-hover)] rounded-lg transition text-[var(--fg-muted)] hover:text-emerald-600"
                        title="打开所在文件夹"
                      >
                        <FolderOpen className="w-4 h-4" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openFile(file.path);
                        }}
                        className="p-1.5 hover:bg-[var(--bg-hover)] rounded-lg transition text-[var(--fg-muted)] hover:text-emerald-600"
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
      </ModuleCard>
    </>
  );
}

export default BigFilesModule;
