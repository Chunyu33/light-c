export interface ModuleRenderProps {
  /**
   * 只有当前模块渲染完整 DOM；非当前模块仍保持 React 实例和本地 state，
   * 但跳过大列表/图表渲染，降低菜单切换时的协调和布局成本。
   */
  isPageActive?: boolean;
}
