// ============================================================================
// 上下文导出
// ============================================================================

export { ThemeProvider, useTheme } from './ThemeContext';
export type { ThemeMode, AppliedTheme } from './ThemeContext';
export {
  DashboardProvider,
  useDashboard,
  useDashboardActions,
  useDashboardModuleState,
  useDashboardSignals,
  useDashboardSummary,
  useModuleDashboard,
} from './DashboardContext';
export type { ModuleStatus, ModuleState, ModulesState, DashboardContextValue } from './DashboardContext';
export {
  FontSizeProvider,
  useFontSize,
  FONT_SIZE_CONFIGS,
  CUSTOM_FONT_SIZE_MIN,
  CUSTOM_FONT_SIZE_MAX,
  DEFAULT_CUSTOM_FONT_SIZE,
} from './FontSizeContext';
export type { FontSizeLevel } from './FontSizeContext';
export { SettingsProvider, useSettings } from './SettingsContext';
