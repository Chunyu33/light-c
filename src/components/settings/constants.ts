// ============================================================================
// 设置页面共享配置
// ============================================================================

import { BookOpen, HardDrive, Info, LayoutGrid, MessageSquare, Monitor, Moon, PanelLeft, Settings, ShieldCheck, SlidersHorizontal, Sun, type LucideIcon } from 'lucide-react';
import { FONT_SIZE_CONFIGS, type FontSizeLevel, type ThemeMode } from '../../contexts';
import type { SettingsTabDefinition } from './types';

export const SETTINGS_TABS: SettingsTabDefinition[] = [
  { id: 'general', label: 'tabs.general', icon: Settings },
  { id: 'features', label: 'tabs.features', icon: SlidersHorizontal },
  { id: 'disk-info', label: 'tabs.diskInfo', icon: HardDrive },
  { id: 'guide', label: 'tabs.guide', icon: BookOpen },
  { id: 'security', label: 'tabs.security', icon: ShieldCheck },
  { id: 'feedback', label: 'tabs.feedback', icon: MessageSquare },
  { id: 'about', label: 'tabs.about', icon: Info },
];

export const THEME_OPTIONS: { mode: ThemeMode; label: string; icon: LucideIcon }[] = [
  { mode: 'light', label: 'theme.light', icon: Sun },
  { mode: 'dark', label: 'theme.dark', icon: Moon },
  { mode: 'system', label: 'theme.system', icon: Monitor },
];

export const FONT_SIZE_OPTIONS: { level: FontSizeLevel; label: string }[] = [
  { level: 'standard', label: 'fontSize.standard' },
  { level: 'medium', label: 'fontSize.medium' },
  { level: 'large', label: 'fontSize.large' },
  { level: 'custom', label: 'fontSize.custom' },
];

export const LAYOUT_MODE_OPTIONS = [
  { mode: 'cards' as const, label: 'layout.cards', icon: LayoutGrid, description: 'layout.cardsDesc' },
  { mode: 'pages' as const, label: 'layout.pages', icon: PanelLeft, description: 'layout.pagesDesc' },
];

// 保留统一导出，页面组件只从一个配置入口读取字号提示所需配置。
export { FONT_SIZE_CONFIGS };
