import type { ComponentType } from 'react';
import {
  BigFilesModule,
  ContextMenuModule,
  DiskGrowthModule,
  HotspotModule,
  JunkCleanModule,
  LeftoversModule,
  RegistryModule,
  SocialCleanModule,
  SystemSlimModule,
} from '../components/modules';
import { APP_MODULE_META, type AppModuleId, type LayoutMode } from './moduleMeta';

export interface AppModuleConfig {
  id: AppModuleId;
  label: string;
  component: ComponentType<{ layoutMode?: LayoutMode }>;
}

const moduleComponents: Record<AppModuleId, ComponentType<{ layoutMode?: LayoutMode }>> = {
  'junk-clean': JunkCleanModule,
  'big-files': BigFilesModule,
  'social-clean': SocialCleanModule,
  'system-slim': SystemSlimModule,
  leftovers: LeftoversModule,
  registry: RegistryModule,
  'context-menu': ContextMenuModule,
  hotspot: HotspotModule,
  'disk-growth': DiskGrowthModule,
};

export const APP_MODULES: AppModuleConfig[] = APP_MODULE_META.map(moduleMeta => ({
  id: moduleMeta.id,
  label: moduleMeta.label,
  component: moduleComponents[moduleMeta.id],
}));

export type { AppModuleId, LayoutMode };
