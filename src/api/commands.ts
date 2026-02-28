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

// ============================================================================
// 增强删除 API - 支持锁定文件处理和物理大小计算
// ============================================================================

/** 删除失败原因 */
export type DeleteFailureReason = 
  | 'NotFound'           // 文件不存在
  | 'PermissionDenied'   // 权限不足
  | 'FileLocked'         // 文件被锁定
  | 'SystemProtected'    // 系统保护文件
  | 'OutOfScope'         // 不在清理范围
  | 'MarkedForReboot'    // 已标记重启删除
  | { Other: string };   // 其他错误

/** 单个文件删除结果 */
export interface FileDeleteResult {
  /** 文件路径 */
  path: string;
  /** 是否成功删除 */
  success: boolean;
  /** 逻辑大小（文件内容大小） */
  logical_size: number;
  /** 物理大小（实际磁盘占用） */
  physical_size: number;
  /** 失败原因 */
  failure_reason: DeleteFailureReason | null;
  /** 是否标记为重启删除 */
  marked_for_reboot: boolean;
}

/** 增强删除结果 */
export interface EnhancedDeleteResult {
  /** 成功删除的文件数 */
  success_count: number;
  /** 失败的文件数 */
  failed_count: number;
  /** 标记为重启删除的文件数 */
  reboot_pending_count: number;
  /** 实际释放的物理空间（字节） */
  freed_physical_size: number;
  /** 逻辑大小总计 */
  freed_logical_size: number;
  /** 跳过的文件大小 */
  skipped_size: number;
  /** 详细的文件删除结果 */
  file_results: FileDeleteResult[];
  /** 是否需要重启完成清理 */
  needs_reboot: boolean;
  /** 汇总消息（WeChat 风格） */
  summary_message: string;
}

/**
 * 增强删除文件
 * 支持物理大小计算、锁定文件处理、详细失败原因反馈
 * @param paths 要删除的文件路径列表
 */
export async function enhancedDeleteFiles(paths: string[]): Promise<EnhancedDeleteResult> {
  return invoke<EnhancedDeleteResult>('enhanced_delete_files', { paths });
}

/**
 * 获取文件的物理大小（按簇对齐）
 * @param logicalSize 逻辑大小（字节）
 */
export async function getPhysicalSize(logicalSize: number): Promise<number> {
  return invoke<number>('get_physical_size', { logicalSize });
}

/**
 * 检查路径是否需要管理员权限
 * @param path 文件路径
 */
export async function checkAdminForPath(path: string): Promise<boolean> {
  return invoke<boolean>('check_admin_for_path', { path });
}

/**
 * 获取失败原因的用户友好描述
 */
export function getFailureReasonMessage(reason: DeleteFailureReason | null): string {
  if (!reason) return '';
  if (reason === 'NotFound') return '文件不存在';
  if (reason === 'PermissionDenied') return '权限不足';
  if (reason === 'FileLocked') return '文件被系统占用';
  if (reason === 'SystemProtected') return '系统保护文件';
  if (reason === 'OutOfScope') return '不在清理范围内';
  if (reason === 'MarkedForReboot') return '已标记重启后删除';
  if (typeof reason === 'object' && 'Other' in reason) return reason.Other;
  return '删除失败';
}

/**
 * 获取失败原因的详细提示（用于 tooltip）
 */
export function getFailureReasonTooltip(reason: DeleteFailureReason | null): string {
  if (!reason) return '';
  if (reason === 'NotFound') return '该文件可能已被其他程序删除';
  if (reason === 'PermissionDenied') return '需要管理员权限才能删除此文件';
  if (reason === 'FileLocked') return '该文件正被系统或其他程序使用，将在重启后删除';
  if (reason === 'SystemProtected') return '这是系统关键文件，删除可能导致系统不稳定';
  if (reason === 'OutOfScope') return '该文件不在安全清理范围内';
  if (reason === 'MarkedForReboot') return '文件已标记，将在下次重启时自动删除';
  if (typeof reason === 'object' && 'Other' in reason) return reason.Other;
  return '未知错误';
}

// ============================================================================
// 永久删除 API - 卸载残留深度清理
// ============================================================================

/** 安全检查结果类型 */
export type SafetyCheckResult = 
  | 'Safe'  // 通过所有检查，可以安全删除
  | { FoundInRegistry: { matched_field: string; matched_value: string } }  // 在注册表中找到匹配
  | { ContainsExecutables: { files: string[] } }  // 发现可执行文件
  | { InProtectedPath: { reason: string } };  // 路径在系统保护目录内

/** 单个残留的永久删除结果 */
export interface LeftoverPermanentDeleteDetail {
  /** 文件夹路径 */
  path: string;
  /** 是否成功删除 */
  success: boolean;
  /** 删除的文件数量 */
  deleted_files: number;
  /** 释放的空间（字节） */
  freed_size: number;
  /** 失败原因 */
  failure_reason: string | null;
  /** 是否标记为重启删除 */
  marked_for_reboot: boolean;
  /** 是否需要人工审核 */
  needs_manual_review: boolean;
  /** 安全检查结果 */
  safety_check: SafetyCheckResult;
}

/** 永久删除的总体结果 */
export interface PermanentDeleteResult {
  /** 成功删除的文件夹数 */
  success_count: number;
  /** 失败的文件夹数 */
  failed_count: number;
  /** 需要人工审核的数量 */
  manual_review_count: number;
  /** 标记为重启删除的数量 */
  reboot_pending_count: number;
  /** 实际释放的空间（字节） */
  freed_size: number;
  /** 各文件夹的详细结果 */
  details: LeftoverPermanentDeleteDetail[];
  /** 删除耗时（毫秒） */
  duration_ms: number;
}

/**
 * 永久删除卸载残留（深度清理）
 * 
 * ⚠️ 警告：此操作将直接从磁盘永久删除文件，不可恢复！
 * 
 * 执行删除前会进行三重安全检查：
 * 1. 注册表检查 - 确认目录不在任何已安装程序中
 * 2. 可执行文件检查 - 扫描 .exe/.dll/.sys 文件，发现则跳过
 * 3. 核心白名单检查 - 确保路径不在系统关键目录内
 * 
 * @param paths 要永久删除的文件夹路径列表
 */
export async function deleteLeftoversPermanent(paths: string[]): Promise<PermanentDeleteResult> {
  return invoke<PermanentDeleteResult>('delete_leftovers_permanent', { paths });
}

/**
 * 执行单个路径的安全检查
 * 在用户确认删除前，可以先调用此接口检查路径是否安全
 * @param path 要检查的文件夹路径
 */
export async function checkLeftoverSafety(path: string): Promise<SafetyCheckResult> {
  return invoke<SafetyCheckResult>('check_leftover_safety', { path });
}

/**
 * 获取安全检查结果的用户友好描述
 */
export function getSafetyCheckMessage(result: SafetyCheckResult): string {
  if (result === 'Safe') return '安全';
  if (typeof result === 'object') {
    if ('FoundInRegistry' in result) {
      return `注册表中存在匹配: ${result.FoundInRegistry.matched_field} = ${result.FoundInRegistry.matched_value}`;
    }
    if ('ContainsExecutables' in result) {
      const files = result.ContainsExecutables.files;
      const count = files.length;
      const preview = files.slice(0, 3).join(', ');
      return count > 3 
        ? `包含 ${count} 个可执行文件: ${preview} 等`
        : `包含可执行文件: ${preview}`;
    }
    if ('InProtectedPath' in result) {
      return `系统保护路径: ${result.InProtectedPath.reason}`;
    }
  }
  return '未知状态';
}

/**
 * 检查安全检查结果是否安全
 */
export function isSafetyCheckPassed(result: SafetyCheckResult): boolean {
  return result === 'Safe';
}

// ============================================================================
// 系统信息 API
// ============================================================================

/** 系统信息 */
export interface SystemInfo {
  /** 操作系统名称 */
  os_name: string;
  /** 操作系统版本 */
  os_version: string;
  /** 系统架构 */
  os_arch: string;
  /** 计算机名称 */
  computer_name: string;
  /** 用户名 */
  user_name: string;
  /** CPU 信息 */
  cpu_info: string;
  /** CPU 核心数 */
  cpu_cores: number;
  /** 总内存（字节） */
  total_memory: number;
  /** 可用内存（字节） */
  available_memory: number;
  /** 系统启动时间（秒） */
  uptime_seconds: number;
}

/**
 * 获取系统信息
 */
export async function getSystemInfo(): Promise<SystemInfo> {
  return invoke<SystemInfo>('get_system_info');
}
