// ============================================================================
// 空状态组件 - 支持主题切换
// ============================================================================

import { HardDrive, Sparkles, Shield, Zap } from 'lucide-react';

export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      {/* 主图标 */}
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center mb-6 shadow-lg shadow-emerald-500/20">
        <HardDrive className="w-10 h-10 text-white" />
      </div>

      {/* 标题 */}
      <h2 className="text-xl font-semibold text-[var(--fg-primary)] mb-2">
        C盘智能清理工具
      </h2>
      <p className="text-sm text-[var(--fg-muted)] mb-8 max-w-sm text-center">
        点击"开始扫描"按钮，智能分析您的C盘，找出可安全删除的垃圾文件
      </p>

      {/* 功能特点 */}
      <div className="grid grid-cols-3 gap-4 max-w-2xl">
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-4 text-center">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center mx-auto mb-3">
            <Sparkles className="w-5 h-5 text-emerald-500" />
          </div>
          <h3 className="text-sm font-medium text-[var(--fg-primary)] mb-1">智能分类</h3>
          <p className="text-xs text-[var(--fg-muted)]">自动识别10+种垃圾文件类型</p>
        </div>

        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-4 text-center">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center mx-auto mb-3">
            <Shield className="w-5 h-5 text-emerald-500" />
          </div>
          <h3 className="text-sm font-medium text-[var(--fg-primary)] mb-1">安全可靠</h3>
          <p className="text-xs text-[var(--fg-muted)]">风险等级标注，保护系统文件</p>
        </div>

        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-4 text-center">
          <div className="w-10 h-10 rounded-lg bg-teal-500/15 flex items-center justify-center mx-auto mb-3">
            <Zap className="w-5 h-5 text-teal-500" />
          </div>
          <h3 className="text-sm font-medium text-[var(--fg-primary)] mb-1">高效清理</h3>
          <p className="text-xs text-[var(--fg-muted)]">一键选择，快速释放空间</p>
        </div>
      </div>
    </div>
  );
}
