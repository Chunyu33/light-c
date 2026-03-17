// ============================================================================
// 社交软件专清模块组件 V2 - 带风险分级
// 支持智能路径溯源和文件类型深度分类
// ============================================================================

import { useState, useCallback, useRef, memo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { 
  MessageCircle, 
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
  ExternalLink,
  Database,
  AlertTriangle,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Clock
} from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ConfirmDialog } from '../ConfirmDialog';
import { useToast } from '../Toast';
import { useDashboard } from '../../contexts/DashboardContext';
import { 
  scanSocialCacheV2, 
  deleteFiles, 
  openInFolder, 
  openFile, 
  recordCleanupAction, 
  type SocialScanResultV2, 
  type SocialFileEntryV2,
  type SocialCategoryStatsV2,
  type RiskLevel,
  type CleanupLogEntryInput,
  getRiskLevelDescription,
  getRiskLevelTooltip
} from '../../api/commands';
import { formatSize } from '../../utils/format';

// ============================================================================
// 分类配置
// ============================================================================

const categoryIcons: Record<string, typeof Image> = {
  chatdatabase: Database,
  imagevideo: Image,
  filetransfer: FileText,
  tempcache: Clock,
  momentscache: Share2,
};

const categoryColors: Record<string, { bg: string; text: string }> = {
  chatdatabase: { bg: 'bg-red-500/10', text: 'text-red-600' },
  imagevideo: { bg: 'bg-emerald-500/10', text: 'text-emerald-600' },
  filetransfer: { bg: 'bg-amber-500/10', text: 'text-amber-600' },
  tempcache: { bg: 'bg-teal-500/10', text: 'text-teal-600' },
  momentscache: { bg: 'bg-cyan-500/10', text: 'text-cyan-600' },
};

// 风险等级配置
const riskLevelConfig: Record<RiskLevel, { 
  icon: typeof Shield; 
  color: string; 
  bgColor: string;
  borderColor: string;
}> = {
  critical: { 
    icon: ShieldAlert, 
    color: 'text-red-600', 
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/30'
  },
  medium: { 
    icon: AlertTriangle, 
    color: 'text-amber-600', 
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/30'
  },
  low: { 
    icon: Shield, 
    color: 'text-emerald-600', 
    bgColor: 'bg-emerald-500/10',
    borderColor: 'border-emerald-500/30'
  },
  none: { 
    icon: ShieldCheck, 
    color: 'text-teal-600', 
    bgColor: 'bg-teal-500/10',
    borderColor: 'border-teal-500/30'
  },
};

// ============================================================================
// 组件实现
// ============================================================================

export function SocialCleanModuleV2() {
  const { modules, expandedModule, setExpandedModule, updateModuleState, triggerHealthRefresh, oneClickScanTrigger } = useDashboard();
  const moduleState = modules.social;
  const { showToast } = useToast();

  // 用于跟踪是否已处理过当前的一键扫描触发
  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [scanResult, setScanResult] = useState<SocialScanResultV2 | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [fileModalData, setFileModalData] = useState<{ name: string; files: SocialFileEntryV2[] } | null>(null);
  const [showTip, setShowTip] = useState(true);

  // 开始扫描
  const handleScan = useCallback(async () => {
    updateModuleState('social', { status: 'scanning', error: null });
    setScanResult(null);
    setSelectedPaths(new Set());
    setExpandedCategory(null);

    try {
      const result = await scanSocialCacheV2();
      setScanResult(result);
      
      // 默认只选中可删除的文件（排除 Critical 级别）
      const deletablePaths = result.categories
        .flatMap(c => c.files)
        .filter(f => f.deletable)
        .map(f => f.path);
      setSelectedPaths(new Set(deletablePaths));

      updateModuleState('social', {
        status: 'done',
        fileCount: result.total_files,
        totalSize: result.total_size,
      });

      setExpandedModule('social');
    } catch (err) {
      console.error('扫描社交软件缓存失败:', err);
      updateModuleState('social', { status: 'error', error: String(err) });
    }
  }, [updateModuleState, setExpandedModule]);

  // 监听一键扫描触发器
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  // 切换单个文件选中（只允许可删除的文件）
  const toggleFile = useCallback((file: SocialFileEntryV2) => {
    if (!file.deletable) return; // Critical 级别不允许选中
    
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(file.path)) {
        next.delete(file.path);
      } else {
        next.add(file.path);
      }
      return next;
    });
  }, []);

  // 切换分类选中（只选中可删除的文件）
  const toggleCategory = useCallback((category: SocialCategoryStatsV2) => {
    const deletableFiles = category.files.filter(f => f.deletable);
    const categoryPaths = deletableFiles.map(f => f.path);
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
  }, [selectedPaths]);

  // 全选/取消全选（只选中可删除的文件）
  const toggleSelectAll = useCallback(() => {
    if (!scanResult) return;
    const deletablePaths = scanResult.categories
      .flatMap(c => c.files)
      .filter(f => f.deletable)
      .map(f => f.path);
    
    const allSelected = deletablePaths.every(p => selectedPaths.has(p));
    if (allSelected) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(deletablePaths));
    }
  }, [scanResult, selectedPaths]);

  // 执行删除
  const handleDelete = useCallback(async () => {
    const paths = Array.from(selectedPaths);
    if (paths.length === 0) return;

    setIsDeleting(true);
    try {
      const result = await deleteFiles(paths);

      // 记录清理日志
      const failedPathSet = new Set(result.failed_files?.map((f) => f.path) || []);
      const allFiles = scanResult?.categories.flatMap(c => c.files) || [];
      const logEntries: CleanupLogEntryInput[] = paths.map((path) => {
        const file = allFiles.find((f) => f.path === path);
        const failedFile = result.failed_files?.find((f) => f.path === path);
        return {
          category: '社交软件专清',
          path,
          size: file?.size || 0,
          success: !failedPathSet.has(path),
          error_message: failedFile?.reason,
        };
      });
      recordCleanupAction(logEntries).catch((err) => {
        console.warn('记录清理日志失败:', err);
      });
      
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

      if (result.success_count > 0) {
        handleScan();
        triggerHealthRefresh();
      }
    } catch (err) {
      console.error('删除失败:', err);
      showToast({ type: 'error', title: '删除失败', description: String(err) });
    } finally {
      setIsDeleting(false);
    }
  }, [selectedPaths, scanResult, handleScan, triggerHealthRefresh, showToast]);

  // 计算选中的文件数和大小
  const selectedStats = scanResult?.categories
    .flatMap(c => c.files)
    .filter(f => selectedPaths.has(f.path))
    .reduce((acc, f) => ({
      files: acc.files + 1,
      size: acc.size + f.size,
    }), { files: 0, size: 0 }) || { files: 0, size: 0 };

  const isExpanded = expandedModule === 'social';

  return (
    <>
      {/* 删除进度遮罩 */}
      {isDeleting && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-[var(--bg-card)] rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-4 max-w-sm mx-4">
            <div className="w-16 h-16 rounded-full bg-rose-500/10 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-rose-500 animate-spin" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-[var(--fg-primary)]">正在清理缓存</h3>
              <p className="text-sm text-[var(--fg-muted)] mt-1">
                正在清理 {selectedStats.files} 个文件，请稍候...
              </p>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title="确认清理社交软件缓存"
        description={`您即将清理 ${selectedStats.files.toLocaleString()} 个文件，共 ${formatSize(selectedStats.size)}。此操作不可撤销。`}
        warning="注意：清理后可能需要重新下载聊天中的图片和文件。建议先备份重要数据。"
        confirmText="确认清理"
        cancelText="取消"
        onConfirm={() => {
          setShowDeleteConfirm(false);
          handleDelete();
        }}
        onCancel={() => setShowDeleteConfirm(false)}
        isDanger
      />

      <ModuleCard
        id="social"
        title="社交软件专清"
        description="清理微信、QQ、钉钉、飞书等软件的缓存文件"
        icon={<MessageCircle className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={moduleState.totalSize}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'social')}
        onScan={handleScan}
        error={moduleState.error}
        headerExtra={
          scanResult && scanResult.total_files > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={toggleSelectAll}
                className="text-xs text-[var(--fg-muted)] hover:text-emerald-600 transition"
              >
                {selectedPaths.size === scanResult.deletable_files ? '取消全选' : '全选'}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                disabled={selectedPaths.size === 0}
                className={`
                  flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                  ${selectedPaths.size === 0
                    ? 'bg-[var(--bg-hover)] text-[var(--fg-faint)] cursor-not-allowed'
                    : 'bg-rose-500 text-white hover:bg-rose-600'
                  }
                `}
              >
                <Trash2 className="w-3.5 h-3.5" />
                清理 ({selectedStats.files})
              </button>
            </div>
          )
        }
      >
        {/* 展开内容 */}
        <div className="max-h-[500px] overflow-auto">
          {/* 说明提示 */}
          {showTip && (
            <div className="mx-4 mt-4 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2 flex items-start gap-2 relative">
              <div className="w-4 h-4 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-amber-600 text-[10px] font-bold">!</span>
              </div>
              <p className="text-[11px] text-amber-600/80 leading-relaxed flex-1">
                <span className="font-medium">智能风险分级：</span>
                <span className="text-red-600">红色</span>为聊天记录（禁止删除），
                <span className="text-amber-600">橙色</span>为传输文件（谨慎清理），
                <span className="text-emerald-600">绿色</span>为图片视频（建议清理），
                <span className="text-teal-600">青色</span>为临时缓存（安全清理）。
              </p>
              <button onClick={() => setShowTip(false)} className="text-amber-500 hover:text-amber-700 transition shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* 空状态 */}
          {moduleState.status === 'idle' && (
            <div className="py-12 flex flex-col items-center justify-center text-center">
              <div className="w-14 h-14 bg-[var(--bg-hover)] rounded-2xl flex items-center justify-center mb-3">
                <MessageCircle className="w-7 h-7 text-[var(--fg-faint)]" />
              </div>
              <p className="text-sm font-medium text-[var(--fg-secondary)]">等待扫描</p>
              <p className="text-xs text-[var(--fg-muted)] mt-1">点击扫描按钮开始检测社交软件缓存</p>
            </div>
          )}

          {/* 扫描中状态 */}
          {moduleState.status === 'scanning' && (
            <div className="py-12 flex flex-col items-center justify-center text-center">
              <div className="w-14 h-14 bg-emerald-500/10 rounded-2xl flex items-center justify-center mb-3">
                <Loader2 className="w-7 h-7 text-emerald-500 animate-spin" />
              </div>
              <p className="text-sm font-medium text-[var(--fg-secondary)]">正在扫描中...</p>
              <p className="text-xs text-[var(--fg-muted)] mt-1">正在智能检索社交软件缓存目录</p>
            </div>
          )}

          {/* 无结果状态 */}
          {moduleState.status === 'done' && scanResult && scanResult.total_files === 0 && (
            <div className="py-12 flex flex-col items-center justify-center text-center">
              <div className="w-14 h-14 bg-emerald-500/10 rounded-2xl flex items-center justify-center mb-3">
                <CheckCircle2 className="w-7 h-7 text-emerald-500" />
              </div>
              <p className="text-sm font-medium text-[var(--fg-secondary)]">太棒了！</p>
              <p className="text-xs text-[var(--fg-muted)] mt-1">没有发现需要清理的社交软件缓存</p>
            </div>
          )}

          {/* 分类列表 */}
          {moduleState.status === 'done' && scanResult && scanResult.categories.map((category) => {
            const Icon = categoryIcons[category.id] || FolderOpen;
            const colors = categoryColors[category.id] || categoryColors.imagevideo;
            const isCategoryExpanded = expandedCategory === category.id;
            const hasFiles = category.file_count > 0;
            const deletableFiles = category.files.filter(f => f.deletable);
            const categoryPaths = deletableFiles.map(f => f.path);
            const selectedInCategory = categoryPaths.filter(p => selectedPaths.has(p)).length;
            const isAllSelected = selectedInCategory === categoryPaths.length && categoryPaths.length > 0;
            const isPartialSelected = selectedInCategory > 0 && selectedInCategory < categoryPaths.length;
            
            // 判断是否为危险分类（聊天记录）
            const isCriticalCategory = category.id === 'chatdatabase';

            return (
              <div key={category.id} className={`border-b border-[var(--border-default)] last:border-b-0 ${isCriticalCategory ? 'bg-red-500/5' : ''}`}>
                {/* 分类行 */}
                <div
                  className={`px-4 py-3 flex items-center gap-3 transition-all ${hasFiles ? 'cursor-pointer hover:bg-[var(--bg-hover)]' : 'opacity-50'}`}
                  onClick={() => hasFiles && setExpandedCategory(isCategoryExpanded ? null : category.id)}
                >
                  <div className={`text-[var(--fg-muted)] transition-transform duration-200 ${isCategoryExpanded ? 'rotate-90' : ''}`}>
                    <ChevronRight className="w-4 h-4" />
                  </div>

                  {/* 复选框 - 危险分类禁用 */}
                  <div
                    onClick={(e) => { 
                      e.stopPropagation(); 
                      if (hasFiles && !isCriticalCategory) toggleCategory(category); 
                    }}
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors
                      ${isCriticalCategory 
                        ? 'border-red-300 bg-red-100 cursor-not-allowed' 
                        : isAllSelected 
                          ? 'bg-emerald-500 border-emerald-500 cursor-pointer' 
                          : isPartialSelected 
                            ? 'bg-emerald-500/50 border-emerald-500 cursor-pointer' 
                            : 'border-[var(--fg-faint)] cursor-pointer'
                      }`}
                    title={isCriticalCategory ? '聊天记录不可删除' : undefined}
                  >
                    {isCriticalCategory ? (
                      <X className="w-2.5 h-2.5 text-red-500" />
                    ) : (isAllSelected || isPartialSelected) && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>

                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${colors.bg}`}>
                    <Icon className={`w-4 h-4 ${colors.text}`} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-[var(--fg-primary)]">{category.name}</p>
                      {isCriticalCategory ? (
                        <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-red-500/10 text-red-600 flex items-center gap-0.5">
                          <ShieldAlert className="w-2.5 h-2.5" />
                          禁止删除
                        </span>
                      ) : (
                        <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-medium ${colors.bg} ${colors.text}`}>
                          {hasFiles ? `可清理 ${category.deletable_count}` : '无文件'}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-[var(--fg-muted)] mt-0.5 truncate">{category.description}</p>
                  </div>

                  <div className="text-right shrink-0">
                    <p className={`text-sm font-bold ${isCriticalCategory ? 'text-red-600' : 'text-emerald-600'}`}>
                      {formatSize(category.total_size)}
                    </p>
                    <p className="text-[11px] text-[var(--fg-muted)]">{category.file_count.toLocaleString()} 个文件</p>
                  </div>
                </div>

                {/* 展开的文件列表 */}
                {isCategoryExpanded && hasFiles && (
                  <div className="bg-[var(--bg-base)] border-t border-[var(--border-default)]">
                    <div className="max-h-48 overflow-auto">
                      {category.files.slice(0, 20).map((file, index) => (
                        <FileRow
                          key={file.path}
                          index={index}
                          file={file}
                          isSelected={selectedPaths.has(file.path)}
                          onToggle={() => toggleFile(file)}
                        />
                      ))}
                    </div>
                    {category.files.length > 20 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setFileModalData({ name: category.name, files: category.files }); }}
                        className="w-full px-4 py-2 text-center text-xs text-emerald-600 hover:bg-emerald-500/5 border-t border-[var(--border-default)] transition"
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
      </ModuleCard>

      {/* 文件详情弹窗 */}
      <FileListModalV2
        isOpen={fileModalData !== null}
        title={fileModalData?.name || ''}
        files={fileModalData?.files || []}
        selectedPaths={selectedPaths}
        onToggleFile={toggleFile}
        onClose={() => setFileModalData(null)}
      />
    </>
  );
}

// ============================================================================
// 文件行组件
// ============================================================================

interface FileRowProps {
  index: number;
  file: SocialFileEntryV2;
  isSelected: boolean;
  onToggle: () => void;
}

function FileRow({ index, file, isSelected, onToggle }: FileRowProps) {
  const riskConfig = riskLevelConfig[file.risk_level];
  const RiskIcon = riskConfig.icon;
  const isCritical = file.risk_level === 'critical';
  
  return (
    <div
      className={`px-4 py-2 flex items-center gap-2 text-xs border-b border-[var(--border-default)] last:border-b-0 hover:bg-[var(--bg-hover)] transition-colors
        ${isCritical ? 'bg-red-500/5 cursor-not-allowed' : 'cursor-pointer'}
        ${isSelected && !isCritical ? 'bg-emerald-500/5' : ''}`}
      onClick={() => !isCritical && onToggle()}
    >
      {/* 复选框 */}
      <div 
        className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center shrink-0 transition-colors
          ${isCritical 
            ? 'border-red-300 bg-red-100' 
            : isSelected 
              ? 'bg-emerald-500 border-emerald-500' 
              : 'border-[var(--fg-faint)]'
          }`}
        title={isCritical ? getRiskLevelTooltip(file.risk_level) : undefined}
      >
        {isCritical ? (
          <X className="w-2 h-2 text-red-500" />
        ) : isSelected && (
          <svg className="w-2 h-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>
      
      {/* 序号 */}
      <span className="w-5 text-center text-[var(--fg-faint)]">{index + 1}</span>
      
      {/* 风险等级图标 */}
      <div 
        className={`p-0.5 rounded ${riskConfig.bgColor}`}
        title={getRiskLevelTooltip(file.risk_level)}
      >
        <RiskIcon className={`w-3 h-3 ${riskConfig.color}`} />
      </div>
      
      {/* 应用名称 */}
      <span className="px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--fg-muted)] shrink-0 text-[10px]">
        {file.app_name}
      </span>
      
      {/* 文件路径 */}
      <span className="flex-1 truncate text-[var(--fg-secondary)]" title={file.path}>
        {file.path}
      </span>
      
      {/* 风险标签 */}
      <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${riskConfig.bgColor} ${riskConfig.color}`}>
        {getRiskLevelDescription(file.risk_level)}
      </span>
      
      {/* 文件大小 */}
      <span className={`font-medium shrink-0 ${isCritical ? 'text-red-600' : 'text-emerald-600'}`}>
        {formatSize(file.size)}
      </span>
      
      {/* 操作按钮 */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button 
          onClick={(e) => { e.stopPropagation(); openInFolder(file.path); }} 
          className="p-1 hover:bg-[var(--bg-elevated)] rounded transition text-[var(--fg-muted)] hover:text-emerald-600" 
          title="打开所在文件夹"
        >
          <FolderOpen className="w-3 h-3" />
        </button>
        <button 
          onClick={(e) => { e.stopPropagation(); openFile(file.path); }} 
          className="p-1 hover:bg-[var(--bg-elevated)] rounded transition text-[var(--fg-muted)] hover:text-emerald-600" 
          title="打开文件"
        >
          <ExternalLink className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// 文件列表弹窗组件 V2
// ============================================================================

interface FileListModalV2Props {
  title: string;
  files: SocialFileEntryV2[];
  selectedPaths: Set<string>;
  onToggleFile: (file: SocialFileEntryV2) => void;
  isOpen: boolean;
  onClose: () => void;
}

function FileListModalV2({ title, files, selectedPaths, onToggleFile, isOpen, onClose }: FileListModalV2Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);

  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 20,
  });

  useEffect(() => {
    if (isOpen) {
      setIsAnimating(true);
      requestAnimationFrame(() => setIsVisible(true));
    } else {
      setIsVisible(false);
      const timer = setTimeout(() => setIsAnimating(false), 200);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!isOpen && !isAnimating) return null;

  return createPortal(
    <div className={`fixed inset-0 z-[9999] flex items-center justify-center p-4 transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] shadow-2xl w-full max-w-5xl max-h-[80vh] flex flex-col overflow-hidden transition-all duration-200 ${isVisible ? 'scale-100' : 'scale-95'}`}>
        <div className="px-6 py-4 border-b border-[var(--border-default)] flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-[var(--fg-primary)]">{title}</h3>
            <p className="text-xs text-[var(--fg-muted)] mt-0.5">
              共 {files.length.toLocaleString()} 个文件，总计 {formatSize(files.reduce((sum, f) => sum + f.size, 0))}
              <span className="mx-2">|</span>
              可删除 {files.filter(f => f.deletable).length} 个
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-[var(--bg-hover)] rounded-lg transition">
            <X className="w-5 h-5 text-[var(--fg-muted)]" />
          </button>
        </div>
        <div className="px-6 py-2 bg-[var(--bg-elevated)] border-b border-[var(--border-default)] flex items-center gap-4 text-xs font-medium text-[var(--fg-muted)] shrink-0">
          <span className="w-8"></span>
          <span className="w-8 text-center">#</span>
          <span className="w-6"></span>
          <span className="w-16">来源</span>
          <span className="flex-1">文件路径</span>
          <span className="w-20">风险</span>
          <span className="w-20 text-right">大小</span>
          <span className="w-16"></span>
        </div>
        <div ref={parentRef} className="flex-1 overflow-auto">
          <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const file = files[virtualRow.index];
              return (
                <VirtualFileRowV2
                  key={file.path}
                  index={virtualRow.index}
                  file={file}
                  isSelected={selectedPaths.has(file.path)}
                  onToggle={() => onToggleFile(file)}
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
    </div>,
    document.body
  );
}

// ============================================================================
// 虚拟文件行组件 V2
// ============================================================================

interface VirtualFileRowV2Props {
  index: number;
  file: SocialFileEntryV2;
  isSelected: boolean;
  onToggle: () => void;
  style: React.CSSProperties;
}

const VirtualFileRowV2 = memo(function VirtualFileRowV2({ index, file, isSelected, onToggle, style }: VirtualFileRowV2Props) {
  const riskConfig = riskLevelConfig[file.risk_level];
  const RiskIcon = riskConfig.icon;
  const isCritical = file.risk_level === 'critical';
  
  return (
    <div 
      style={style} 
      className={`px-6 flex items-center gap-4 text-xs border-b border-[var(--border-default)] hover:bg-[var(--bg-hover)] transition-colors
        ${isCritical ? 'bg-red-500/5' : ''}`}
    >
      {/* 复选框 */}
      <div 
        onClick={() => !isCritical && onToggle()}
        className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors
          ${isCritical 
            ? 'border-red-300 bg-red-100 cursor-not-allowed' 
            : isSelected 
              ? 'bg-emerald-500 border-emerald-500 cursor-pointer' 
              : 'border-[var(--fg-faint)] cursor-pointer'
          }`}
        title={isCritical ? getRiskLevelTooltip(file.risk_level) : undefined}
      >
        {isCritical ? (
          <X className="w-2.5 h-2.5 text-red-500" />
        ) : isSelected && (
          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>
      
      <span className="w-8 text-center text-[var(--fg-faint)]">{index + 1}</span>
      
      {/* 风险图标 */}
      <div 
        className={`p-1 rounded ${riskConfig.bgColor}`}
        title={getRiskLevelTooltip(file.risk_level)}
      >
        <RiskIcon className={`w-3.5 h-3.5 ${riskConfig.color}`} />
      </div>
      
      <span className="w-16 px-2 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--fg-muted)] text-center truncate">
        {file.app_name}
      </span>
      
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <File className="w-3.5 h-3.5 text-[var(--fg-faint)] shrink-0" />
        <span className="truncate text-[var(--fg-secondary)]" title={file.path}>{file.path}</span>
      </div>
      
      {/* 风险标签 */}
      <span className={`w-20 px-1.5 py-0.5 rounded text-[9px] font-medium text-center ${riskConfig.bgColor} ${riskConfig.color}`}>
        {getRiskLevelDescription(file.risk_level)}
      </span>
      
      <span className={`w-20 text-right font-medium tabular-nums ${isCritical ? 'text-red-600' : 'text-emerald-600'}`}>
        {formatSize(file.size)}
      </span>
      
      <div className="w-16 flex items-center justify-end gap-0.5 shrink-0">
        <button onClick={() => openInFolder(file.path)} className="p-1.5 hover:bg-[var(--bg-elevated)] rounded transition text-[var(--fg-muted)] hover:text-emerald-600" title="打开所在文件夹">
          <FolderOpen className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => openFile(file.path)} className="p-1.5 hover:bg-[var(--bg-elevated)] rounded transition text-[var(--fg-muted)] hover:text-emerald-600" title="打开文件">
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
});

export default SocialCleanModuleV2;
