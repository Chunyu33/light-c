// ============================================================================
// 便携版更新弹窗的调试入口（仅开发环境注册）
//
// 便携版弹窗正常情况下只在"点检查更新时真的查到新版本"才出现，本地开发很难复现。
// 这里在 dev 构建下挂一个 window 方法，方便在开发者控制台直接把弹窗调出来看样式：
//
//   window.__lightcDebugPortableUpdate()
//   window.__lightcDebugPortableUpdate({ latestVersion: '2.16.9', currentVersion: '2.16.8' })
//   window.__lightcDebugPortableUpdate({ latestVersion: null })   // 只展示渠道引导
//   window.__lightcDebugPortableUpdate({ isChecking: true })      // 查询中状态
//
// 生产构建不会注册该全局方法，避免把调试入口带到正式包。
// ============================================================================

declare global {
  interface Window {
    __lightcDebugPortableUpdate?: (overrides?: {
      latestVersion?: string | null;
      currentVersion?: string;
      isChecking?: boolean;
    }) => void;
  }
}

/** 注册调试入口；同一会话内重复调用会覆盖上一次的实现。 */
export function registerPortableUpdateDebugTrigger(
  open: (overrides?: {
    latestVersion?: string | null;
    currentVersion?: string;
    isChecking?: boolean;
  }) => void,
): void {
  window.__lightcDebugPortableUpdate = open;
}
