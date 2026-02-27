// ============================================================================
// Tauri 命令调用封装
// 封装所有与Rust后端的通信接口
// ============================================================================

import { invoke } from '@tauri-apps/api/core';
import type {
  DiskInfo,
  ScanResult,
  CategoryScanResult,
  DeleteResult,
  CategoryInfo,
  ScanRequest,
  DeleteRequest,
  LargeFileEntry,
} from '../types';

/**
 * 获取C盘磁盘信息
 */
export async function getDiskInfo(): Promise<DiskInfo> {
  return invoke<DiskInfo>('get_disk_info');
}

/**
 * 执行垃圾文件扫描
 * @param request 扫描请求参数（可选）
 */
export async function scanJunkFiles(request?: ScanRequest): Promise<ScanResult> {
  return invoke<ScanResult>('scan_junk_files', { request });
}

/**
 * 扫描单个分类
 * @param categoryName 分类名称
 */
export async function scanCategory(categoryName: string): Promise<CategoryScanResult> {
  return invoke<CategoryScanResult>('scan_category', { categoryName });
}

/**
 * 删除指定文件
 * @param paths 要删除的文件路径列表
 */
export async function deleteFiles(paths: string[]): Promise<DeleteResult> {
  const request: DeleteRequest = { paths };
  return invoke<DeleteResult>('delete_files', { request });
}

/**
 * 获取所有可用的清理分类
 */
export async function getCategories(): Promise<CategoryInfo[]> {
  return invoke<CategoryInfo[]>('get_categories');
}

/**
 * 格式化文件大小（调用Rust端）
 * @param bytes 字节数
 */
export async function formatSizeFromRust(bytes: number): Promise<string> {
  return invoke<string>('format_size', { bytes });
}

/**
 * 打开Windows磁盘清理工具
 */
export async function openDiskCleanup(): Promise<void> {
  return invoke<void>('open_disk_cleanup');
}

/**
 * 扫描C盘大文件（前 50 项）
 */
export async function scanLargeFiles(): Promise<LargeFileEntry[]> {
  return invoke<LargeFileEntry[]>('scan_large_files');
}

/**
 * 取消大文件扫描
 */
export async function cancelLargeFileScan(): Promise<void> {
  return invoke<void>('cancel_large_file_scan');
}

/**
 * 扫描社交软件缓存
 */
export async function scanSocialCache(): Promise<SocialScanResult> {
  return invoke<SocialScanResult>('scan_social_cache');
}

/**
 * 在文件资源管理器中打开文件所在目录
 */
export async function openInFolder(path: string): Promise<void> {
  return invoke<void>('open_in_folder', { path });
}

/**
 * 直接打开文件（使用系统默认程序）
 */
export async function openFile(path: string): Promise<void> {
  return invoke<void>('open_file', { path });
}

// ============================================================================
// 系统瘦身相关
// ============================================================================

/** 系统瘦身项状态 */
export interface SlimItemStatus {
  id: string;
  name: string;
  description: string;
  warning: string;
  enabled: boolean;
  size: number;
  actionable: boolean;
  action_text: string;
}

/** 系统瘦身状态汇总 */
export interface SystemSlimStatus {
  is_admin: boolean;
  items: SlimItemStatus[];
  total_reclaimable: number;
}

/**
 * 检查是否以管理员权限运行
 */
export async function checkAdminPrivilege(): Promise<boolean> {
  return invoke<boolean>('check_admin_privilege');
}

/**
 * 获取系统瘦身状态
 */
export async function getSystemSlimStatus(): Promise<SystemSlimStatus> {
  return invoke<SystemSlimStatus>('get_system_slim_status');
}

/**
 * 关闭休眠功能
 */
export async function disableHibernation(): Promise<string> {
  return invoke<string>('disable_hibernation');
}

/**
 * 开启休眠功能
 */
export async function enableHibernation(): Promise<string> {
  return invoke<string>('enable_hibernation');
}

/**
 * 清理 WinSxS 组件存储
 */
export async function cleanupWinsxs(): Promise<string> {
  return invoke<string>('cleanup_winsxs');
}

/**
 * 打开系统虚拟内存设置
 */
export async function openVirtualMemorySettings(): Promise<void> {
  return invoke<void>('open_virtual_memory_settings');
}

// ============================================================================
// 健康评分相关
// ============================================================================

/** 系统健康评分结果 */
export interface HealthScoreResult {
  score: number;
  disk_score: number;
  hibernation_score: number;
  junk_score: number;
  disk_free_percent: number;
  has_hibernation: boolean;
  hibernation_size: number;
  junk_size: number;
}

/**
 * 获取系统健康评分
 */
export async function getHealthScore(): Promise<HealthScoreResult> {
  return invoke<HealthScoreResult>('get_health_score');
}

// 社交软件扫描结果类型
export interface SocialScanResult {
  categories: SocialCategory[];
  total_files: number;
  total_size: number;
}

export interface SocialCategory {
  id: string;
  name: string;
  description: string;
  file_count: number;
  total_size: number;
  files: SocialFile[];
}

export interface SocialFile {
  path: string;
  size: number;
  app_name: string;
}

// ============================================================================
// 卸载残留扫描相关
// ============================================================================

/** 卸载残留扫描结果 */
export interface LeftoverScanResult {
  /** 发现的残留文件夹列表 */
  leftovers: LeftoverEntry[];
  /** 总大小（字节） */
  total_size: number;
  /** 扫描耗时（毫秒） */
  scan_duration_ms: number;
}

/** 单个残留条目 */
export interface LeftoverEntry {
  /** 文件夹路径 */
  path: string;
  /** 文件夹大小（字节） */
  size: number;
  /** 可能的软件名称 */
  app_name: string;
  /** 来源类型 */
  source: 'LocalAppData' | 'RoamingAppData' | 'ProgramData';
  /** 最后修改时间（Unix时间戳） */
  last_modified: number;
  /** 包含的文件数量 */
  file_count: number;
}

/** 卸载残留删除结果 */
export interface LeftoverDeleteResult {
  /** 成功删除的文件夹数 */
  deleted_count: number;
  /** 释放的空间大小（字节） */
  deleted_size: number;
  /** 删除失败的路径 */
  failed_paths: string[];
  /** 错误信息列表 */
  errors: string[];
}

/**
 * 扫描卸载残留
 * 扫描 AppData 和 ProgramData 中已卸载软件遗留的孤立文件夹
 */
export async function scanUninstallLeftovers(): Promise<LeftoverScanResult> {
  return invoke<LeftoverScanResult>('scan_uninstall_leftovers');
}

/**
 * 删除卸载残留文件夹
 * @param paths 要删除的文件夹路径列表
 */
export async function deleteLeftoverFolders(paths: string[]): Promise<LeftoverDeleteResult> {
  return invoke<LeftoverDeleteResult>('delete_leftover_folders', { paths });
}

// ============================================================================
// 注册表冗余扫描相关
// ============================================================================

/** 注册表扫描结果 */
export interface RegistryScanResult {
  /** 发现的冗余注册表项 */
  entries: RegistryEntry[];
  /** 总条目数 */
  total_count: number;
  /** 扫描耗时（毫秒） */
  scan_duration_ms: number;
}

/** 单个注册表条目 */
export interface RegistryEntry {
  /** 注册表完整路径 */
  path: string;
  /** 键名或值名 */
  name: string;
  /** 条目类型 */
  entry_type: 'MuiCache' | 'SoftwareKey' | 'ApplicationAssociation' | 'FileTypeAssociation';
  /** 关联的文件路径（如果有） */
  associated_path: string | null;
  /** 问题描述 */
  issue: string;
  /** 风险等级 (1-5) */
  risk_level: number;
}

/** 注册表删除结果 */
export interface RegistryDeleteResult {
  /** 备份文件路径 */
  backup_path: string;
  /** 成功删除的条目数 */
  deleted_count: number;
  /** 删除失败的条目路径 */
  failed_entries: string[];
  /** 错误信息列表 */
  errors: string[];
}

/**
 * 扫描注册表冗余
 * 安全扫描 Windows 注册表中的孤立键值和无效引用
 */
export async function scanRegistryRedundancy(): Promise<RegistryScanResult> {
  return invoke<RegistryScanResult>('scan_registry_redundancy');
}

/**
 * 备份并删除注册表条目
 * @param entries 要删除的注册表条目列表
 */
export async function deleteRegistryEntries(entries: RegistryEntry[]): Promise<RegistryDeleteResult> {
  return invoke<RegistryDeleteResult>('delete_registry_entries', { entries });
}

/**
 * 打开注册表备份目录
 */
export async function openRegistryBackupDir(): Promise<void> {
  return invoke<void>('open_registry_backup_dir');
}
