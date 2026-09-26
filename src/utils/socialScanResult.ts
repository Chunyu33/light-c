// ============================================================================
// 社交扫描结果的本地增量更新
//
// 删除成功后如果重跑一次全量扫描，代价是重新遍历所有软件的数据目录，
// 而且会把用户的勾选状态整块重置（handleScan 会默认全选所有可删除文件）。
// 这里在本地把已删除的文件从结果里摘掉并重算统计，让界面立即反映变化。
//
// 顶层总计按「各分类之和」重算 —— 后端 core.rs 就是这么汇总的
// （total_files / total_size / deletable_* 都是 categories 的求和），
// 所以本地重算与重新扫描的结果一致，不会引入语义差异。
// ============================================================================

import type { SocialCategoryStats, SocialScanResult } from '../api/commands';

/** 单个分类被移除的文件带来的统计变化 */
interface CategoryRemoval {
  count: number;
  size: number;
  deletableCount: number;
  deletableSize: number;
}

const EMPTY_REMOVAL: CategoryRemoval = { count: 0, size: 0, deletableCount: 0, deletableSize: 0 };

/**
 * 把已成功删除的路径从扫描结果中移除，并重算分类与顶层统计。
 *
 * 只能传入**后端确认已删除**的路径：被标记为「重启后删除」的文件仍在磁盘上，
 * 算进来会让界面显示成已删除。调用方需自行排除这类路径。
 *
 * 返回新对象，不修改入参。
 */
export function applyDeletedPaths(
  result: SocialScanResult,
  removedPaths: Set<string>,
): SocialScanResult {
  if (removedPaths.size === 0) {
    return result;
  }

  const categories: SocialCategoryStats[] = [];

  for (const category of result.categories) {
    const removal = countRemoval(category, removedPaths);

    if (removal.count === 0) {
      categories.push(category);
      continue;
    }

    categories.push({
      ...category,
      files: category.files.filter(file => !removedPaths.has(file.path)),
      file_count: Math.max(0, category.file_count - removal.count),
      total_size: Math.max(0, category.total_size - removal.size),
      deletable_count: Math.max(0, category.deletable_count - removal.deletableCount),
      deletable_size: Math.max(0, category.deletable_size - removal.deletableSize),
    });
  }

  return {
    ...result,
    categories,
    total_files: categories.reduce((sum, category) => sum + category.file_count, 0),
    total_size: categories.reduce((sum, category) => sum + category.total_size, 0),
    deletable_files: categories.reduce((sum, category) => sum + category.deletable_count, 0),
    deletable_size: categories.reduce((sum, category) => sum + category.deletable_size, 0),
  };
}

/** 统计某个分类里将被移除的文件数量与大小 */
function countRemoval(category: SocialCategoryStats, removedPaths: Set<string>): CategoryRemoval {
  let removal = EMPTY_REMOVAL;

  for (const file of category.files) {
    if (!removedPaths.has(file.path)) {
      continue;
    }
    removal = {
      count: removal.count + 1,
      size: removal.size + file.size,
      deletableCount: removal.deletableCount + (file.deletable ? 1 : 0),
      deletableSize: removal.deletableSize + (file.deletable ? file.size : 0),
    };
  }

  return removal;
}

/**
 * 从删除结果里挑出「后端确认已删除」的路径。
 *
 * 返回 null 表示无法安全地做本地更新，调用方应退回重新扫描：
 *   - 删除结果中存在「重启后删除」的文件：这类文件仍在磁盘上，且后端不返回它们的路径，
 *     无法把它们和已删除的区分开；
 *   - 成功 / 失败 / 待重启三项之和与请求数量对不上：说明有路径未被归类，
 *     此时本地更新可能漏删或多删。
 */
export function resolveDeletedPaths(
  requestedPaths: string[],
  deleteResult: {
    success_count: number;
    failed_count: number;
    reboot_pending_count: number;
    failed_files?: Array<{ path: string }> | null;
  },
): Set<string> | null {
  const accounted = deleteResult.success_count
    + deleteResult.failed_count
    + deleteResult.reboot_pending_count;

  if (deleteResult.reboot_pending_count > 0 || accounted !== requestedPaths.length) {
    return null;
  }

  const failedPaths = new Set((deleteResult.failed_files ?? []).map(item => item.path));
  return new Set(requestedPaths.filter(path => !failedPaths.has(path)));
}
