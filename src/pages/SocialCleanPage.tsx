// ============================================================================
// 社交软件专清页面组件
// 扫描微信、QQ、钉钉、飞书等社交软件的缓存文件
// ============================================================================

import { useState, useRef, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { 
  MessageCircle, 
  Search, 
  Trash2, 
  Loader2, 
  Image, 
  FileText, 
  Share2,
  ChevronRight,
  CheckCircle2,
  FolderOpen,
  X,
  File,
  ExternalLink
} from 'lucide-react';
import { deleteFiles, scanSocialCache, openInFolder, openFile, SocialScanResult, SocialFile } from '../api/commands';
import { ConfirmDialog, BackButton, useToast } from '../components';
import { formatSize } from '../utils/format';

interface SocialCleanPageProps {
  onBack: () => void;
  onCleanupComplete?: () => void;
}

// 分类图标映射
const categoryIcons: Record<string, typeof Image> = {
  images_videos: Image,
  file_transfer: FileText,
  moments_cache: Share2,
};

// 分类颜色映射 - 使用绿色系
const categoryColors: Record<string, { bg: string; text: string; border: string }> = {
  images_videos: { bg: 'bg-emerald-500/10', text: 'text-emerald-600', border: 'border-emerald-500/20' },
  file_transfer: { bg: 'bg-teal-500/10', text: 'text-teal-600', border: 'border-teal-500/20' },
  moments_cache: { bg: 'bg-cyan-500/10', text: 'text-cyan-600', border: 'border-cyan-500/20' },
};

export function SocialCleanPage({ onBack, onCleanupComplete }: SocialCleanPageProps) {
  const [status, setStatus] = useState<'idle' | 'scanning' | 'done'>('idle');
  const [scanResult, setScanResult] = useState<SocialScanResult | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // 文件详情弹窗
  const [fileModalData, setFileModalData] = useState<{ name: string; files: SocialFile[] } | null>(null);
  // 说明提示是否显示
  const [showTip, setShowTip] = useState(true);
  const { showToast } = useToast();

  // 开始扫描
  const handleScan = async () => {
    setStatus('scanning');
    setScanResult(null);
    setSelectedPaths(new Set());
    setExpandedCategory(null);

    try {
      const result = await scanSocialCache();
      console.log('社交软件扫描结果:', result);
      setScanResult(result);
      setStatus('done');
      // 默认全选所有文件
      const allPaths = result.categories.flatMap(c => c.files.map(f => f.path));
      setSelectedPaths(new Set(allPaths));
    } catch (err) {
      console.error('扫描社交软件缓存失败:', err);
      showToast({ type: 'error', title: '扫描失败', description: String(err) });
      setStatus('idle');
    }
  };

  // 切换单个文件选中
  const toggleFile = (path: string) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // 切换分类选中（选中/取消该分类下所有文件）
  const toggleCategory = (category: { files: SocialFile[] }) => {
    const categoryPaths = category.files.map(f => f.path);
    const allSelected = categoryPaths.every(p => selectedPaths.has(p));
    
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (allSelected) {
        categoryPaths.forEach(p => next.delete(p));
      } else {
        categoryPaths.forEach(p => next.add(p));
      }
      return next;
    });
  };

  // 全选/取消全选
  const toggleSelectAll = () => {
    if (!scanResult) return;
    const allPaths = scanResult.categories.flatMap(c => c.files.map(f => f.path));
    if (selectedPaths.size === allPaths.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(allPaths));
    }
  };

  // 执行删除
  const handleDelete = async () => {
    if (!scanResult) return;
    
    // 收集所有选中的文件路径
    const paths = Array.from(selectedPaths);

    if (paths.length === 0) return;

    setIsDeleting(true);
    try {
      const result = await deleteFiles(paths);
      
      if (result.failed_count === 0) {
        showToast({
          type: 'success',
          title: `成功清理 ${result.success_count} 个文件`,
          description: `已释放 ${formatSize(result.freed_size)} 空间`,
        });
      } else if (result.success_count === 0) {
        showToast({
          type: 'error',
          title: '清理失败',
          description: `${result.failed_count} 个文件无法删除`,
        });
      } else {
        showToast({
          type: 'warning',
          title: '部分成功',
          description: `${result.success_count} 个已删除，${result.failed_count} 个失败`,
        });
      }

      // 重新扫描以更新列表
      if (result.success_count > 0) {
        handleScan();
        // 触发健康评分刷新
        onCleanupComplete?.();
      }
    } catch (err) {
      console.error('删除失败:', err);
      showToast({ type: 'error', title: '删除失败', description: String(err) });
    } finally {
      setIsDeleting(false);
    }
  };

  // 计算选中的文件数和大小
  const selectedStats = scanResult?.categories
    .flatMap(c => c.files)
    .filter(f => selectedPaths.has(f.path))
    .reduce((acc, f) => ({
      files: acc.files + 1,
      size: acc.size + f.size,
    }), { files: 0, size: 0 }) || { files: 0, size: 0 };

  return (
    <>
      {/* 删除确认弹窗 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title="确认清理社交软件缓存"
        description={`您即将清理 ${selectedStats.files.toLocaleString()} 个文件，共 ${formatSize(selectedStats.size)}。此操作不可撤销。`}
        warning="注意：清理后可能需要重新下载聊天中的图片和文件。建议先备份重要数据。"
        confirmText={isDeleting ? '清理中...' : '确认清理'}
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
                <MessageCircle className="w-7 h-7" />
              </div>
              <div>
                <h1 className="text-xl font-bold">社交软件专清</h1>
                <p className="text-sm text-white/80 mt-0.5">清理微信、QQ、钉钉、飞书、企业微信等软件的缓存文件</p>
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
                  {status === 'done' ? '重新扫描' : '开始扫描'}
                </>
              )}
            </button>
          </div>

          {/* 扫描完成统计 */}
          {status === 'done' && scanResult && scanResult.total_files > 0 && (
            <div className="mt-5 pt-5 border-t border-white/20 grid grid-cols-4 gap-4">
              <div className="text-center">
                <p className="text-2xl font-bold">{scanResult.total_files.toLocaleString()}</p>
                <p className="text-xs text-white/70 mt-1">发现文件</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold">{formatSize(scanResult.total_size)}</p>
                <p className="text-xs text-white/70 mt-1">可清理</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold">{selectedStats.files.toLocaleString()}</p>
                <p className="text-xs text-white/70 mt-1">已选中</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold">{formatSize(selectedStats.size)}</p>
                <p className="text-xs text-white/70 mt-1">选中大小</p>
              </div>
            </div>
          )}
        </div>

        {/* 说明提示 */}
        {showTip && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 flex items-start gap-3 relative">
            <div className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-amber-600 text-xs font-bold">!</span>
            </div>
            <div className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed flex-1">
              <p className="font-medium">关于扫描范围</p>
              <p className="mt-1 text-amber-600/80 dark:text-amber-400/80">
                本工具会自动检测您系统中"文档"文件夹的实际位置进行扫描，即使您已将文档目录迁移到其他磁盘（如 D 盘）也能正确识别。
                虽然本项目主要面向 C 盘优化，但社交软件缓存往往是磁盘空间的"大头"，帮您一并清理也是好事。
              </p>
            </div>
            <button
              onClick={() => setShowTip(false)}
              className="text-amber-500 hover:text-amber-700 transition shrink-0"
              title="关闭提示"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* 操作栏 */}
        {status === 'done' && scanResult && scanResult.total_files > 0 && (
          <div className="bg-[var(--bg-card)] rounded-xl border border-[var(--border-default)] p-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={toggleSelectAll}
                className="flex items-center gap-2 text-sm text-[var(--fg-secondary)] hover:text-emerald-600 transition"
              >
                <input
                  type="checkbox"
                  checked={selectedPaths.size === scanResult.categories.flatMap(c => c.files).length && selectedPaths.size > 0}
                  onChange={toggleSelectAll}
                  className="h-4 w-4 rounded border-[var(--border-default)] text-emerald-500 focus:ring-emerald-500"
                />
                全选
              </button>
              <button
                onClick={() => setSelectedPaths(new Set())}
                className="text-sm text-[var(--fg-muted)] hover:text-[var(--fg-secondary)] transition"
              >
                取消全选
              </button>
            </div>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={selectedPaths.size === 0 || isDeleting}
              className={`
                flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all
                ${selectedPaths.size === 0 || isDeleting
                  ? 'bg-[var(--bg-hover)] text-[var(--fg-faint)] cursor-not-allowed'
                  : 'bg-rose-500 text-white hover:bg-rose-600 shadow-sm hover:shadow'
                }
              `}
            >
              <Trash2 className="w-4 h-4" />
              清理选中 ({selectedStats.files.toLocaleString()})
            </button>
          </div>
        )}

        {/* 分类列表 */}
        <div className="bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] overflow-hidden">
          <div className="px-5 py-3 bg-[var(--bg-elevated)] border-b border-[var(--border-default)]">
            <h3 className="text-sm font-semibold text-[var(--fg-primary)]">垃圾文件分类</h3>
          </div>

          <div className="divide-y divide-[var(--border-default)]">
            {/* 空状态 */}
            {status === 'idle' && (
              <div className="py-16 flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 bg-[var(--bg-hover)] rounded-2xl flex items-center justify-center mb-4">
                  <Search className="w-8 h-8 text-[var(--fg-faint)]" />
                </div>
                <p className="text-sm font-medium text-[var(--fg-secondary)]">等待扫描</p>
                <p className="text-xs text-[var(--fg-muted)] mt-1">点击上方按钮开始扫描社交软件缓存</p>
              </div>
            )}

            {/* 扫描中状态 */}
            {status === 'scanning' && (
              <div className="py-16 flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mb-4">
                  <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
                </div>
                <p className="text-sm font-medium text-[var(--fg-secondary)]">正在扫描中...</p>
                <p className="text-xs text-[var(--fg-muted)] mt-1">正在检索社交软件缓存目录，请稍候</p>
              </div>
            )}

            {/* 无结果状态 */}
            {status === 'done' && scanResult && scanResult.total_files === 0 && (
              <div className="py-16 flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mb-4">
                  <CheckCircle2 className="w-8 h-8 text-emerald-500" />
                </div>
                <p className="text-sm font-medium text-[var(--fg-secondary)]">太棒了！</p>
                <p className="text-xs text-[var(--fg-muted)] mt-1">没有发现需要清理的社交软件缓存</p>
              </div>
            )}

            {/* 分类列表 */}
            {status === 'done' && scanResult && scanResult.categories.map((category) => {
              const Icon = categoryIcons[category.id] || FolderOpen;
              const colors = categoryColors[category.id] || categoryColors.images_videos;
              const isExpanded = expandedCategory === category.id;
              const hasFiles = category.file_count > 0;
              // 计算该分类的选中状态
              const categoryPaths = category.files.map(f => f.path);
              const selectedInCategory = categoryPaths.filter(p => selectedPaths.has(p)).length;
              const isAllSelected = selectedInCategory === categoryPaths.length && categoryPaths.length > 0;
              const isPartialSelected = selectedInCategory > 0 && selectedInCategory < categoryPaths.length;

              return (
                <div key={category.id}>
                  {/* 分类行 */}
                  <div
                    className={`
                      px-5 py-4 flex items-center gap-4 transition-all
                      ${hasFiles ? 'cursor-pointer hover:bg-[var(--bg-hover)]' : 'opacity-50'}
                      ${isAllSelected || isPartialSelected ? 'bg-emerald-500/5' : ''}
                    `}
                    onClick={() => hasFiles && setExpandedCategory(isExpanded ? null : category.id)}
                  >
                    {/* 展开图标 */}
                    <div className={`text-[var(--fg-muted)] transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
                      <ChevronRight className="w-4 h-4" />
                    </div>

                    {/* 复选框 */}
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        if (hasFiles) toggleCategory(category);
                      }}
                      className={`w-5 h-5 rounded border-2 flex items-center justify-center cursor-pointer transition-colors
                        ${isAllSelected ? 'bg-emerald-500 border-emerald-500' : isPartialSelected ? 'bg-emerald-500/50 border-emerald-500' : 'border-[var(--fg-faint)] hover:border-[var(--fg-muted)]'}`}
                    >
                      {(isAllSelected || isPartialSelected) && (
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>

                    {/* 图标 */}
                    <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${colors.bg}`}>
                      <Icon className={`w-5 h-5 ${colors.text}`} />
                    </div>

                    {/* 分类信息 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-[var(--fg-primary)]">{category.name}</p>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${colors.bg} ${colors.text}`}>
                          {hasFiles ? '可清理' : '无文件'}
                        </span>
                      </div>
                      <p className="text-xs text-[var(--fg-muted)] mt-0.5">{category.description}</p>
                    </div>

                    {/* 右侧统计 */}
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-emerald-600">
                        {formatSize(category.total_size)}
                      </p>
                      <p className="text-xs text-[var(--fg-muted)] mt-0.5">
                        {category.file_count.toLocaleString()} 个文件
                      </p>
                    </div>
                  </div>

                  {/* 展开的文件列表 */}
                  {isExpanded && hasFiles && (
                    <div className="bg-[var(--bg-base)] border-t border-[var(--border-default)]">
                      {/* 预览前 20 个文件 */}
                      <div className="max-h-64 overflow-auto">
                        {category.files.slice(0, 20).map((file, index) => {
                          const isFileSelected = selectedPaths.has(file.path);
                          return (
                            <div
                              key={file.path}
                              className={`px-5 py-2.5 flex items-center gap-3 text-xs border-b border-[var(--border-default)] last:border-b-0 hover:bg-[var(--bg-hover)] cursor-pointer ${isFileSelected ? 'bg-emerald-500/5' : ''}`}
                              onClick={() => toggleFile(file.path)}
                            >
                              {/* 文件复选框 */}
                              <div
                                className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors
                                  ${isFileSelected ? 'bg-emerald-500 border-emerald-500' : 'border-[var(--fg-faint)]'}`}
                              >
                                {isFileSelected && (
                                  <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </div>
                              <span className="w-6 text-center text-[var(--fg-faint)]">{index + 1}</span>
                              <span className="px-2 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--fg-muted)] shrink-0">
                                {file.app_name}
                              </span>
                              <span className="flex-1 truncate text-[var(--fg-secondary)]" title={file.path}>
                                {file.path}
                              </span>
                              <span className="text-emerald-600 font-medium shrink-0">{formatSize(file.size)}</span>
                              {/* 操作按钮 */}
                              <div className="flex items-center gap-0.5 shrink-0">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openInFolder(file.path);
                                  }}
                                  className="p-1.5 hover:bg-[var(--bg-elevated)] rounded transition text-[var(--fg-muted)] hover:text-emerald-600"
                                  title="打开所在文件夹"
                                >
                                  <FolderOpen className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openFile(file.path);
                                  }}
                                  className="p-1.5 hover:bg-[var(--bg-elevated)] rounded transition text-[var(--fg-muted)] hover:text-emerald-600"
                                  title="打开文件"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {/* 查看全部按钮 */}
                      {category.files.length > 20 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setFileModalData({ name: category.name, files: category.files });
                          }}
                          className="w-full px-5 py-3 text-center text-xs text-emerald-600 hover:bg-emerald-500/5 border-t border-[var(--border-default)] transition"
                        >
                          查看全部 {category.files.length.toLocaleString()} 个文件 →
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 文件详情弹窗 */}
      {fileModalData && (
        <FileListModal
          title={fileModalData.name}
          files={fileModalData.files}
          onClose={() => setFileModalData(null)}
        />
      )}
    </>
  );
}

// ============================================================================
// 文件列表弹窗组件 - 使用虚拟列表优化性能
// ============================================================================

interface FileListModalProps {
  title: string;
  files: SocialFile[];
  onClose: () => void;
}

function FileListModal({ title, files, onClose }: FileListModalProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 20,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* 遮罩 */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* 弹窗内容 */}
      <div className="relative bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="px-6 py-4 border-b border-[var(--border-default)] flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-[var(--fg-primary)]">{title}</h3>
            <p className="text-xs text-[var(--fg-muted)] mt-0.5">
              共 {files.length.toLocaleString()} 个文件，
              总计 {formatSize(files.reduce((sum, f) => sum + f.size, 0))}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-[var(--bg-hover)] rounded-lg transition"
          >
            <X className="w-5 h-5 text-[var(--fg-muted)]" />
          </button>
        </div>

        {/* 表头 */}
        <div className="px-6 py-2 bg-[var(--bg-elevated)] border-b border-[var(--border-default)] flex items-center gap-4 text-xs font-medium text-[var(--fg-muted)] shrink-0">
          <span className="w-12 text-center">#</span>
          <span className="w-16">来源</span>
          <span className="flex-1">文件路径</span>
          <span className="w-20 text-right">大小</span>
        </div>

        {/* 虚拟列表 */}
        <div ref={parentRef} className="flex-1 overflow-auto">
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const file = files[virtualRow.index];
              return (
                <VirtualFileRow
                  key={file.path}
                  index={virtualRow.index}
                  file={file}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 虚拟文件行组件
// ============================================================================

interface VirtualFileRowProps {
  index: number;
  file: SocialFile;
  style: React.CSSProperties;
}

const VirtualFileRow = memo(function VirtualFileRow({ index, file, style }: VirtualFileRowProps) {
  return (
    <div
      style={style}
      className="px-6 flex items-center gap-4 text-xs border-b border-[var(--border-default)] hover:bg-[var(--bg-hover)] transition-colors"
    >
      <span className="w-12 text-center text-[var(--fg-faint)]">{index + 1}</span>
      <span className="w-16 px-2 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--fg-muted)] text-center truncate">
        {file.app_name}
      </span>
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <File className="w-3.5 h-3.5 text-[var(--fg-faint)] shrink-0" />
        <span className="truncate text-[var(--fg-secondary)]" title={file.path}>
          {file.path}
        </span>
      </div>
      <span className="w-20 text-right text-emerald-600 font-medium tabular-nums">
        {formatSize(file.size)}
      </span>
      {/* 操作按钮 */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          onClick={() => openInFolder(file.path)}
          className="p-1.5 hover:bg-[var(--bg-elevated)] rounded transition text-[var(--fg-muted)] hover:text-emerald-600"
          title="打开所在文件夹"
        >
          <FolderOpen className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => openFile(file.path)}
          className="p-1.5 hover:bg-[var(--bg-elevated)] rounded transition text-[var(--fg-muted)] hover:text-emerald-600"
          title="打开文件"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
});

export default SocialCleanPage;
