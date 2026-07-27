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
  HardDriveDownload,
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
  | 'ai-models'
  | 'shell-icons';

export interface AppModuleMeta {
  /** 模块在页面和导航里的稳定 ID，必须和 data-module-id 保持一致。 */
  id: AppModuleId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

export const APP_MODULE_META: AppModuleMeta[] = [
  { id: 'junk-clean', label: 'junkClean', icon: Trash2 },
  { id: 'big-files', label: 'bigFiles', icon: FileBox },
  { id: 'social-clean', label: 'socialClean', icon: MessageCircle },
  { id: 'system-slim', label: 'systemSlim', icon: Layers },
  { id: 'driver-cleanup', label: 'driverCleanup', icon: Cpu },
  { id: 'leftovers', label: 'leftovers', icon: Package },
  { id: 'registry', label: 'registry', icon: Database },
  { id: 'context-menu', label: 'contextMenu', icon: MousePointerClick },
  { id: 'hotspot', label: 'hotspot', icon: Flame },
  { id: 'disk-growth', label: 'diskGrowth', icon: HardDrive },
  { id: 'shell-icons', label: 'shellIcons', icon: HardDriveDownload },
  // AI 模型空间覆盖模型、LoRA、Embedding 和缓存，用“空间”强调这是占用分析而不是自动清理。
  { id: 'ai-models', label: 'aiModels', icon: BrainCircuit },
];

export const DEFAULT_ACTIVE_MODULE_ID: AppModuleId = 'junk-clean';
