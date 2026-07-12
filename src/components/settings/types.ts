// ============================================================================
// 设置页面共享类型
// ============================================================================

import type { LucideIcon } from 'lucide-react';

export type SettingsTab = 'general' | 'features' | 'guide' | 'security' | 'feedback' | 'about';

export interface SettingsTabDefinition {
  id: SettingsTab;
  label: string;
  icon: LucideIcon;
}
