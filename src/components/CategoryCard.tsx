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
  FolderOpen,
  ExternalLink,
} from 'lucide-react';
import { openInFolder, openFile } from '../api/commands';
import type { CategoryScanResult, FileInfo } from '../types';
import { formatSize } from '../utils/format';

// 微信风格风险等级样式配置
const getRiskBadgeStyle = (level: number) => {
  switch (level) {
    case 1:
      return 'bg-[#07C160]/10 text-[#07C160] border-[#07C160]/20';  // 微信绿 - 安全
    case 2:
      return 'bg-[#07C160]/10 text-[#07C160] border-[#07C160]/20';  // 微信绿 - 低风险
    case 3:
      return 'bg-[#FA9D3B]/10 text-[#FA9D3B] border-[#FA9D3B]/20';  // 柔和橙 - 中等
    case 4:
      return 'bg-[#FA9D3B]/10 text-[#FA9D3B] border-[#FA9D3B]/20';  // 柔和橙 - 较高
    default:
      return 'bg-[#FA5151]/10 text-[#FA5151] border-[#FA5151]/20';  // 柔和红 - 高风险
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
    <div className="bg-[var(--bg-card)] rounded-2xl overflow-hidden shadow-sm">
      {/* 分类头部 - 增加内边距 */}
      <div
        className="px-5 py-4 cursor-pointer hover:bg-[var(--bg-hover)] transition-colors select-none"
        onClick={handleExpand}
      >
        <div className="flex items-center gap-4">
          {/* 展开图标 */}
          <div className="text-[var(--fg-faint)] transition-transform duration-200" style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
            <ChevronDown className="w-5 h-5" />
          </div>

          {/* 复选框 - 微信绿 */}
          <div onClick={(e) => { e.stopPropagation(); handleCategoryToggle(); }}>
            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center cursor-pointer transition-colors
              ${isAllSelected ? 'bg-[#07C160] border-[#07C160]' : isPartialSelected ? 'bg-[#07C160]/50 border-[#07C160]' : 'border-[var(--fg-faint)] hover:border-[var(--fg-muted)]'}`}>
              {(isAllSelected || isPartialSelected) && (
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  {isAllSelected ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /> : <path strokeLinecap="round" d="M5 12h14" />}
                </svg>
              )}
            </div>
          </div>

          {/* 分类图标 - 微信绿 10% 透明度圆角容器 */}
          <div className="w-10 h-10 rounded-xl bg-[#07C160]/10 flex items-center justify-center text-[#07C160]">
            <Folder className="w-5 h-5" />
          </div>

          {/* 分类信息 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-bold text-[var(--fg-primary)] truncate">
                {category.display_name}
              </span>
              <span className={`px-2 py-0.5 text-[11px] font-medium rounded border ${getRiskBadgeStyle(category.risk_level)}`}>
                {getRiskText(category.risk_level)}
              </span>
            </div>
            <p className="text-[13px] text-[var(--fg-muted)] truncate mt-1">{category.description}</p>
          </div>

          {/* 统计信息 - tabular-nums 确保数字稳定 */}
          <div className="text-right">
            <p className="text-[15px] font-bold text-[var(--fg-primary)] tabular-nums">
              {formatSize(category.total_size)}
            </p>
            <p className="text-[13px] text-[var(--fg-muted)] tabular-nums">
              {category.file_count.toLocaleString()} 个文件
              {selectedCount > 0 && (
                <span className="text-[#07C160] ml-1">
                  (已选 {selectedCount.toLocaleString()} 个, {formatSize(selectedSize)})
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* 文件列表 - 虚拟滚动 */}
      {expanded && (
        <div className="border-t border-[var(--border-muted)]">
          {/* 风险提示 - 微信风格柔和橙 */}
          {category.risk_level >= 3 && (
            <div className="px-5 py-2.5 bg-[#FA9D3B]/10 border-b border-[#FA9D3B]/20 flex items-center gap-2 text-[13px] text-[#FA9D3B]">
              <AlertTriangle className="w-4 h-4" />
              <span>此分类风险等级较高，请谨慎选择删除</span>
            </div>
          )}

          {/* 虚拟列表容器 */}
          <div ref={parentRef} className="h-64 overflow-auto bg-[var(--bg-base)]">
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
      className={`px-5 flex items-center gap-4 cursor-pointer transition-colors
        ${selected ? 'bg-[#07C160]/10' : 'hover:bg-[var(--bg-hover)]'}`}
      onClick={onToggle}
    >
      {/* 复选框 - 微信绿 */}
      <div className={`w-4 h-4 rounded border flex items-center justify-center
        ${selected ? 'bg-[#07C160] border-[#07C160]' : 'border-[var(--fg-faint)]'}`}>
        {selected && (
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      {/* 文件图标 */}
      <div className="text-[var(--fg-faint)]">
        {file.is_dir ? <Folder className="w-4 h-4" /> : <File className="w-4 h-4" />}
      </div>

      {/* 文件路径 */}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-[var(--fg-secondary)] truncate" title={file.path}>
          {file.path}
        </p>
      </div>

      {/* 文件大小 */}
      <div className="text-[13px] text-[var(--fg-muted)] tabular-nums">
        {formatSize(file.size)}
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            openInFolder(file.path);
          }}
          className="p-1.5 hover:bg-[var(--bg-active)] rounded-lg transition text-[var(--fg-muted)] hover:text-[#07C160]"
          title="打开所在文件夹"
        >
          <FolderOpen className="w-4 h-4" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            openFile(file.path);
          }}
          className="p-1.5 hover:bg-[var(--bg-active)] rounded-lg transition text-[var(--fg-muted)] hover:text-[#07C160]"
          title="打开文件"
        >
          <ExternalLink className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
});
