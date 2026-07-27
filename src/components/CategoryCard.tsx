// ============================================================================
// 分类卡片组件 - 支持主题切换
// 使用虚拟列表优化大量文件的渲染性能
// ============================================================================

import { useState, useRef, useMemo, memo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronDown,
  Folder,
  File,
  AlertTriangle,
  FolderOpen,
  ExternalLink,
  Search,
} from 'lucide-react';
import { openInFolder, openFile, openRecycleBin } from '../api/commands';
import { stripWindowsDevicePrefix } from '../utils/searchEngine';
import type { CategoryScanResult, FileInfo } from '../types';
import { formatSize } from '../utils/format';
import { useTranslation } from 'react-i18next';

// 微信风格风险等级样式配置
const getRiskBadgeStyle = (level: number) => {
  switch (level) {
    case 1:
      return 'bg-[var(--brand-green-10)] text-[var(--brand-green)] border-[var(--brand-green-20)]';  // 微信绿 - 安全
    case 2:
      return 'bg-[var(--brand-green-10)] text-[var(--brand-green)] border-[var(--brand-green-20)]';  // 微信绿 - 低风险
    case 3:
      return 'bg-[var(--color-warning)]/10 text-[var(--color-warning)] border-[var(--color-warning)]/20';  // 柔和橙 - 中等
    case 4:
      return 'bg-[var(--color-warning)]/10 text-[var(--color-warning)] border-[var(--color-warning)]/20';  // 柔和橙 - 较高
    default:
      return 'bg-[var(--color-danger)]/10 text-[var(--color-danger)] border-[var(--color-danger)]/20';  // 柔和红 - 高风险
  }
};

const getRiskText = (level: number) => {
  switch (level) {
    case 1: return 'safe';
    case 2: return 'lowRisk';
    case 3: return 'mediumRisk';
    case 4: return 'highRisk';
    default: return 'criticalRisk';
  }
};

interface CategoryCardProps {
  category: CategoryScanResult;
  selectedPaths: Set<string>;
  onToggleFile: (path: string) => void;
  onToggleCategory: (categoryName: string, files: FileInfo[], selected: boolean) => void;
  onSearchFile: (file: FileInfo) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
}

/**
 * 分类卡片组件 - 桌面应用风格
 */
export function CategoryCard({
  category,
  selectedPaths,
  onToggleFile,
  onToggleCategory,
  onSearchFile,
  hasMore = false,
  onLoadMore,
  isLoadingMore = false,
}: CategoryCardProps) {
  const { t: commonT } = useTranslation('common');
  const { t } = useTranslation('junkClean');
  const categoryName = t(`categories.${category.category}.name`, { defaultValue: category.display_name });
  const categoryDescription = t(`categories.${category.category}.description`, { defaultValue: category.description });
  const [expanded, setExpanded] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

  // 使用useMemo缓存计算结果，避免重复计算
  const { selectedCount, selectedSize, isAllSelected, isPartialSelected } = useMemo(() => {
    let count = 0;
    let size = 0;
    for (const f of category.files) {
      if (selectedPaths.has(f.path)) {
        count++;
        size += f.size;
      }
    }
    return {
      selectedCount: count,
      selectedSize: size,
      isAllSelected: count === category.files.length && category.files.length > 0,
      isPartialSelected: count > 0 && count < category.files.length,
    };
  }, [category.files, selectedPaths]);

  // 虚拟列表配置
  const virtualizer = useVirtualizer({
    count: category.files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44, // 每行高度
    overscan: 10, // 预渲染数量
  });

  const handleCategoryToggle = useCallback(() => {
    onToggleCategory(category.display_name, category.files, !isAllSelected);
  }, [category.display_name, category.files, isAllSelected, onToggleCategory]);

  const handleExpand = useCallback(() => {
    setExpanded(prev => !prev);
  }, []);

  if (category.files.length === 0) return null;

  return (
    <div className="bg-[var(--bg-card)] rounded-2xl overflow-hidden shadow-sm">
      {/* 分类头部 - 增加内边距 */}
      <div
        className="px-5 py-4 cursor-pointer hover:bg-[var(--bg-hover)] transition-colors select-none"
        onClick={handleExpand}
      >
        {/* 多语言分类名称长度不同，允许窄窗口换行，避免风险标签和统计信息互相挤压。 */}
        <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap sm:gap-4">
          {/* 展开图标 */}
          <div className="text-[var(--text-faint)] transition-transform duration-200" style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
            <ChevronDown className="w-5 h-5" />
          </div>

          {/* 复选框 - 微信绿 */}
          <div onClick={(e) => { e.stopPropagation(); handleCategoryToggle(); }}>
            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center cursor-pointer transition-colors
              ${isAllSelected ? 'bg-[var(--brand-green)] border-[var(--brand-green)]' : isPartialSelected ? 'bg-[var(--brand-green)]/50 border-[var(--brand-green)]' : 'border-[var(--text-faint)] hover:border-[var(--text-muted)]'}`}>
              {(isAllSelected || isPartialSelected) && (
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  {isAllSelected ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /> : <path strokeLinecap="round" d="M5 12h14" />}
                </svg>
              )}
            </div>
          </div>

          {/* 分类图标 - 微信绿 10% 透明度圆角容器 */}
          <div className="w-10 h-10 rounded-xl bg-[var(--brand-green-10)] flex items-center justify-center text-[var(--brand-green)]">
            <Folder className="w-5 h-5" />
          </div>

          {/* 分类信息 */}
          <div className="min-w-[140px] flex-1 sm:min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-[14px] font-bold text-[var(--text-primary)] truncate">
                {categoryName}
              </span>
              <span className={`shrink-0 whitespace-nowrap px-2 py-0.5 text-[11px] font-medium rounded border ${getRiskBadgeStyle(category.risk_level)}`}>
                {commonT(getRiskText(category.risk_level))}
              </span>
            </div>
            <p className="text-[13px] text-[var(--text-muted)] truncate mt-1">{categoryDescription}</p>
          </div>

          {/* 统计信息 - tabular-nums 确保数字稳定 */}
          <div className="ml-auto shrink-0 text-right">
            <p className="text-[15px] font-bold text-[var(--text-primary)] tabular-nums">
              {formatSize(category.total_size)}
            </p>
            <p className="text-[13px] text-[var(--text-muted)] tabular-nums">
              {commonT('fileCount', { count: category.file_count.toLocaleString() })}
              {selectedCount > 0 && (
                <span className="text-[var(--brand-green)] ml-1">
                  {/* 深度分类分页时提示完整删除口径，避免把当前页大小误认为分类总量。 */}
                  {hasMore && selectedCount === category.files.length
                    ? commonT('selectedPage', { count: selectedCount.toLocaleString() })
                    : commonT('selectedFiles', { count: selectedCount.toLocaleString(), size: formatSize(selectedSize) })}
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* 文件列表 - 虚拟滚动。用高度动画包住列表，展开/折叠时不会再硬切。 */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="overflow-hidden border-t border-[var(--border-color)]"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* 风险提示 - 微信风格柔和橙 */}
            {category.risk_level >= 3 && (
              <div className="px-5 py-2.5 bg-[var(--color-warning)]/10 border-b border-[var(--color-warning)]/20 flex items-center gap-2 text-[13px] text-[var(--color-warning)]">
                <AlertTriangle className="w-4 h-4" />
                <span>{commonT('highRiskWarning')}</span>
              </div>
            )}

            {/* 虚拟列表容器 */}
            <div ref={parentRef} className="h-64 overflow-auto bg-[var(--bg-main)]">
              <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const file = category.files[virtualRow.index];
                  const isSelected = selectedPaths.has(file.path);
                  return (
                      <VirtualFileItem
                        key={file.path}
                        file={file}
                        selected={isSelected}
                        onToggle={() => onToggleFile(file.path)}
                        onSearch={() => onSearchFile(file)}
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
            {hasMore && onLoadMore && (
              <div className="px-5 py-2.5 border-t border-[var(--border-color)] flex justify-center">
                <button
                  onClick={onLoadMore}
                  disabled={isLoadingMore}
                  className="text-xs text-[var(--brand-green)] hover:text-[var(--brand-green-hover)] disabled:text-[var(--text-faint)] transition"
                >
                  {isLoadingMore ? commonT('loading') : commonT('loadMore', { shown: category.files.length.toLocaleString(), total: category.file_count.toLocaleString() })}
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ============================================================================
// 虚拟文件项组件 - 使用memo优化
// ============================================================================
interface VirtualFileItemProps {
  file: FileInfo;
  selected: boolean;
  onToggle: () => void;
  onSearch: () => void;
  style: React.CSSProperties;
}

const VirtualFileItem = memo(function VirtualFileItem({ file, selected, onToggle, onSearch, style }: VirtualFileItemProps) {
  const { t } = useTranslation('common');
  // 回收站的真实删除路径是隐藏的 $R 文件，界面展示元数据中的原始文件名，避免与 Explorer 看到的内容脱节。
  const displayPath = file.category === 'RecycleBin'
    ? file.name
    : stripWindowsDevicePrefix(file.path);
  const displayTitle = file.category === 'RecycleBin' && file.original_path
    ? t('originalLocation', { path: stripWindowsDevicePrefix(file.original_path) })
    : displayPath;

  return (
    <div
      style={style}
      className={`px-5 flex items-center gap-4 cursor-pointer transition-colors
        ${selected ? 'bg-[var(--brand-green-10)]' : 'hover:bg-[var(--bg-hover)]'}`}
      onClick={onToggle}
    >
      {/* 复选框 - 微信绿 */}
      <div className={`w-4 h-4 rounded border flex items-center justify-center
        ${selected ? 'bg-[var(--brand-green)] border-[var(--brand-green)]' : 'border-[var(--text-faint)]'}`}>
        {selected && (
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      {/* 文件图标 */}
      <div className="text-[var(--text-faint)]">
        {file.is_dir ? <Folder className="w-4 h-4" /> : <File className="w-4 h-4" />}
      </div>

      {/* 文件路径 */}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-[var(--text-secondary)] truncate" title={displayTitle}>
          {displayPath}
        </p>
      </div>

      {/* 文件大小 */}
      <div className="text-[13px] text-[var(--text-muted)] tabular-nums">
        {formatSize(file.size)}
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSearch();
          }}
          className="p-1.5 hover:bg-[var(--bg-active)] rounded-lg transition text-[var(--text-muted)] hover:text-[var(--brand-green)]"
          title={t('searchDeletionAdvice')}
        >
          <Search className="w-4 h-4" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (file.category === 'RecycleBin') {
              openRecycleBin();
            } else {
              openInFolder(file.path);
            }
          }}
          className="p-1.5 hover:bg-[var(--bg-active)] rounded-lg transition text-[var(--text-muted)] hover:text-[var(--brand-green)]"
          title={file.category === 'RecycleBin' ? t('openRecycleBin') : t('openInFolder')}
        >
          <FolderOpen className="w-4 h-4" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (file.category === 'RecycleBin') {
              openRecycleBin();
            } else {
              openFile(file.path);
            }
          }}
          className="p-1.5 hover:bg-[var(--bg-active)] rounded-lg transition text-[var(--text-muted)] hover:text-[var(--brand-green)]"
          title={file.category === 'RecycleBin' ? t('openRecycleBin') : t('openFile')}
        >
          <ExternalLink className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
});
