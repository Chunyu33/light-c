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
