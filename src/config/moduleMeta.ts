// ============================================================================
// 功能模块元信息
// 这里只放纯配置，避免设置状态依赖具体模块组件造成循环引用。
// ============================================================================

import {
  BrainCircuit,
  Cpu,
  Database,
  FileBox,
  Flame,
  HardDrive,
  Layers,
  MessageCircle,
  MousePointerClick,
  Package,
  Trash2,
} from 'lucide-react';
import type { ComponentType } from 'react';

export type LayoutMode = 'cards' | 'pages';

export type AppModuleId =
  | 'junk-clean'
  | 'big-files'
  | 'social-clean'
  | 'system-slim'
  | 'driver-cleanup'
  | 'leftovers'
  | 'registry'
  | 'context-menu'
  | 'hotspot'
  | 'disk-growth'
  | 'ai-models';

export interface AppModuleMeta {
  /** 模块在页面和导航里的稳定 ID，必须和 data-module-id 保持一致。 */
  id: AppModuleId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

export const APP_MODULE_META: AppModuleMeta[] = [
  { id: 'junk-clean', label: '垃圾清理', icon: Trash2 },
  { id: 'big-files', label: '大文件清理', icon: FileBox },
  { id: 'social-clean', label: '社交软件专清', icon: MessageCircle },
  { id: 'system-slim', label: '系统瘦身', icon: Layers },
  { id: 'driver-cleanup', label: '旧驱动清理', icon: Cpu },
  { id: 'leftovers', label: '卸载残留', icon: Package },
  { id: 'registry', label: '注册表冗余', icon: Database },
  { id: 'context-menu', label: '右键菜单清理', icon: MousePointerClick },
  { id: 'hotspot', label: '大目录分析', icon: Flame },
  { id: 'disk-growth', label: '磁盘变化分析', icon: HardDrive },
  // AI 模型空间覆盖模型、LoRA、Embedding 和缓存，用“空间”强调这是占用分析而不是自动清理。
  { id: 'ai-models', label: 'AI 模型空间', icon: BrainCircuit },
];

export const DEFAULT_ACTIVE_MODULE_ID: AppModuleId = 'junk-clean';
