// ============================================================================
// 类型定义 - 与Rust后端数据结构对应
// ============================================================================

/** 垃圾文件分类 */
export type JunkCategory =
  | 'WindowsTemp'
  | 'SystemCache'
  | 'BrowserCache'
  | 'RecycleBin'
  | 'WindowsUpdate'
  | 'ThumbnailCache'
  | 'LogFiles'
  | 'MemoryDump'
  | 'OldWindowsInstallation'
  | 'AppCache';

/** 单个文件信息 */
export interface FileInfo {
  /** 文件完整路径 */
  path: string;
  /** 文件名 */
  name: string;
  /** 文件大小（字节） */
  size: number;
  /** 最后修改时间（Unix时间戳） */
  modified_time: number;
  /** 是否为目录 */
  is_dir: boolean;
  /** 所属分类 */
  category: JunkCategory;
}

/** 分类扫描结果 */
export interface CategoryScanResult {
  /** 分类 */
  category: JunkCategory;
  /** 分类显示名称 */
  display_name: string;
  /** 分类描述 */
  description: string;
  /** 风险等级 */
  risk_level: number;
  /** 该分类下的所有文件 */
  files: FileInfo[];
  /** 总大小（字节） */
  total_size: number;
  /** 文件数量 */
  file_count: number;
}

/** 完整扫描结果 */
export interface ScanResult {
  /** 各分类的扫描结果 */
  categories: CategoryScanResult[];
  /** 总大小（字节） */
  total_size: number;
  /** 总文件数量 */
  total_file_count: number;
  /** 扫描耗时（毫秒） */
  scan_duration_ms: number;
  /** 扫描时间戳 */
  scan_timestamp: number;
}

/** 删除结果 */
export interface DeleteResult {
  /** 成功删除的文件数 */
  success_count: number;
  /** 删除失败的文件数 */
  failed_count: number;
  /** 释放的空间大小（字节） */
  freed_size: number;
  /** 失败的文件列表及原因 */
  failed_files: DeleteError[];
}

/** 删除错误信息 */
export interface DeleteError {
  /** 文件路径 */
  path: string;
  /** 错误原因 */
  reason: string;
}

/** 磁盘信息 */
export interface DiskInfo {
  /** 磁盘总容量（字节） */
  total_space: number;
  /** 已用空间（字节） */
  used_space: number;
  /** 可用空间（字节） */
  free_space: number;
  /** 使用百分比 */
  usage_percent: number;
  /** 磁盘盘符 */
  drive_letter: string;
}

/** 分类信息 */
export interface CategoryInfo {
  /** 分类名称 */
  name: string;
  /** 分类描述 */
  description: string;
  /** 风险等级 */
  risk_level: number;
}

/** 扫描请求参数 */
export interface ScanRequest {
  /** 要扫描的分类列表 */
  categories?: string[];
}

/** 删除请求参数 */
export interface DeleteRequest {
  /** 要删除的文件路径列表 */
  paths: string[];
}

/** 大文件扫描结果条目 */
export interface LargeFileEntry {
  /** 文件路径 */
  path: string;
  /** 文件大小（字节） */
  size: number;
  /** 最后修改时间（Unix时间戳，秒） */
  modified: number;
}

/** 应用状态 */
export type AppStatus = 'idle' | 'scanning' | 'deleting';
