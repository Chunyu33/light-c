// ============================================================================
// 设置页面共享配置
// ============================================================================

import { BookOpen, HardDrive, Info, LayoutGrid, MessageSquare, Monitor, Moon, PanelLeft, Settings, ShieldCheck, SlidersHorizontal, Sun, type LucideIcon } from 'lucide-react';
import { FONT_SIZE_CONFIGS, type FontSizeLevel, type ThemeMode } from '../../contexts';
import type { SettingsTabDefinition } from './types';

export const SETTINGS_TABS: SettingsTabDefinition[] = [
  { id: 'general', label: '通用', icon: Settings },
  { id: 'features', label: '功能设置', icon: SlidersHorizontal },
  { id: 'disk-info', label: '磁盘信息', icon: HardDrive },
  { id: 'guide', label: '使用说明', icon: BookOpen },
  { id: 'security', label: '安全与校验', icon: ShieldCheck },
  { id: 'feedback', label: '意见反馈', icon: MessageSquare },
  { id: 'about', label: '关于', icon: Info },
];

export const THEME_OPTIONS: { mode: ThemeMode; label: string; icon: LucideIcon }[] = [
  { mode: 'light', label: '浅色模式', icon: Sun },
  { mode: 'dark', label: '深色模式', icon: Moon },
  { mode: 'system', label: '跟随系统', icon: Monitor },
];

export const FONT_SIZE_OPTIONS: { level: FontSizeLevel; label: string }[] = [
  { level: 'standard', label: '标准' },
  { level: 'medium', label: '适中' },
  { level: 'large', label: '较大' },
  { level: 'custom', label: '自定义' },
];

export const LAYOUT_MODE_OPTIONS = [
  { mode: 'cards' as const, label: '卡片模式', icon: LayoutGrid, description: '所有功能集中在同一页，适合快速总览' },
  { mode: 'pages' as const, label: '页面模式', icon: PanelLeft, description: '左侧菜单切换单功能页，更接近传统 PC 软件' },
];

// 保留统一导出，页面组件只从一个配置入口读取字号提示所需配置。
export { FONT_SIZE_CONFIGS };
