// ============================================================================
// 分类卡片组件 - 支持主题切换
// 使用虚拟列表优化大量文件的渲染性能
// ============================================================================

import { useState, useRef, useMemo, memo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ChevronDown,
  Folder,
  File,
  AlertTriangle,
} from 'lucide-react';
import type { CategoryScanResult, FileInfo } from '../types';
import { formatSize } from '../utils/format';

// 风险等级样式配置
const getRiskBadgeStyle = (level: number) => {
  switch (level) {
    case 1:
      return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30';
    case 2:
      return 'bg-teal-500/15 text-teal-600 dark:text-teal-400 border-teal-500/30';
    case 3:
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30';
    case 4:
      return 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30';
    default:
      return 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30';
  }
};

const getRiskText = (level: number) => {
  switch (level) {
    case 1: return '安全';
    case 2: return '低风险';
    case 3: return '中等';
    case 4: return '较高';
    default: return '高风险';
  }
};

interface CategoryCardProps {
  category: CategoryScanResult;
  selectedPaths: Set<string>;
  onToggleFile: (path: string) => void;
  onToggleCategory: (files: FileInfo[], selected: boolean) => void;
}

/**
 * 分类卡片组件 - 桌面应用风格
 */
export function CategoryCard({
  category,
  selectedPaths,
  onToggleFile,
  onToggleCategory,
}: CategoryCardProps) {
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
    onToggleCategory(category.files, !isAllSelected);
  }, [category.files, isAllSelected, onToggleCategory]);

  const handleExpand = useCallback(() => {
    setExpanded(prev => !prev);
  }, []);

  if (category.files.length === 0) return null;

  return (
    <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] overflow-hidden">
      {/* 分类头部 */}
      <div
        className="px-3 py-2.5 cursor-pointer hover:bg-[var(--bg-hover)] transition-colors select-none"
        onClick={handleExpand}
      >
        <div className="flex items-center gap-3">
          {/* 展开图标 */}
          <div className="text-[var(--fg-muted)] transition-transform duration-200" style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
            <ChevronDown className="w-4 h-4" />
          </div>

          {/* 复选框 */}
          <div onClick={(e) => { e.stopPropagation(); handleCategoryToggle(); }}>
            <div className={`w-4 h-4 rounded border-2 flex items-center justify-center cursor-pointer transition-colors
              ${isAllSelected ? 'bg-emerald-500 border-emerald-500' : isPartialSelected ? 'bg-emerald-500/50 border-emerald-500' : 'border-[var(--fg-faint)] hover:border-[var(--fg-muted)]'}`}>
              {(isAllSelected || isPartialSelected) && (
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  {isAllSelected ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /> : <path strokeLinecap="round" d="M5 12h14" />}
                </svg>
              )}
            </div>
          </div>

          {/* 分类图标 */}
          <div className="w-8 h-8 rounded-md bg-emerald-500/15 flex items-center justify-center text-emerald-500">
            <Folder className="w-4 h-4" />
          </div>

          {/* 分类信息 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--fg-primary)] truncate">
                {category.display_name}
              </span>
              <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded border ${getRiskBadgeStyle(category.risk_level)}`}>
                {getRiskText(category.risk_level)}
              </span>
            </div>
            <p className="text-xs text-[var(--fg-muted)] truncate mt-0.5">{category.description}</p>
          </div>

          {/* 统计信息 */}
          <div className="text-right">
            <p className="text-sm font-semibold text-[var(--fg-primary)]">
              {formatSize(category.total_size)}
            </p>
            <p className="text-xs text-[var(--fg-muted)]">
              {category.file_count.toLocaleString()} 个文件
              {selectedCount > 0 && (
                <span className="text-emerald-500 ml-1">
                  (已选 {selectedCount.toLocaleString()} 个, {formatSize(selectedSize)})
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* 文件列表 - 虚拟滚动 */}
      {expanded && (
        <div className="border-t border-[var(--border-default)]">
          {/* 风险提示 */}
          {category.risk_level >= 3 && (
            <div className="px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>此分类风险等级较高，请谨慎选择删除</span>
            </div>
          )}

          {/* 虚拟列表容器 */}
          <div ref={parentRef} className="h-60 overflow-auto bg-[var(--bg-base)]">
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
      )}
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
  style: React.CSSProperties;
}

const VirtualFileItem = memo(function VirtualFileItem({ file, selected, onToggle, style }: VirtualFileItemProps) {
  return (
    <div
      style={style}
      className={`px-3 flex items-center gap-3 cursor-pointer transition-colors
        ${selected ? 'bg-emerald-500/10' : 'hover:bg-[var(--bg-hover)]'}`}
      onClick={onToggle}
    >
      {/* 复选框 */}
      <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center
        ${selected ? 'bg-emerald-500 border-emerald-500' : 'border-[var(--fg-faint)]'}`}>
        {selected && (
          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      {/* 文件图标 */}
      <div className="text-[var(--fg-faint)]">
        {file.is_dir ? <Folder className="w-3.5 h-3.5" /> : <File className="w-3.5 h-3.5" />}
      </div>

      {/* 文件路径 */}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-[var(--fg-secondary)] truncate" title={file.path}>
          {file.path}
        </p>
      </div>

      {/* 文件大小 */}
      <div className="text-xs text-[var(--fg-muted)] tabular-nums">
        {formatSize(file.size)}
      </div>
    </div>
  );
});
