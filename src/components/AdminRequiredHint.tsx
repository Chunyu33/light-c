// ============================================================================
// 管理员权限提示条
//
// 需要管理员权限的模块共用这一条：已经提权时自己消失，没提权时给一个「重新启动」按钮，走系统 UAC。
// 目前接入 5 个 —— 磁盘变化分析 / 旧驱动清理 / 系统瘦身（没权限就做不了），
// 垃圾清理深度发现 / AI 模型空间深度发现（没权限只是退回慢路径，用 variant="performance"）。
//
// 为什么不做成浮层：它是状态提示，不是常驻操作 —— 用户看一眼、要么点按钮、要么滚过去。
// 做成 fixed 会一直压在内容上（底部操作条那边已经踩过一次，还要给每个模块补 padding），
// 而且各模块原来的位置本来就不同，固定到一处反而更别扭。放文档流里、压成一行薄条，
// 对布局的影响最小。
//
// 接入方式：模块里写一行 <AdminRequiredHint />，不需要传任何状态 ——
// 权限自己查，查询结果在模块级缓存，多个模块同时挂载也只走一次 IPC。
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, X } from 'lucide-react';
import { checkAdminPrivilege, relaunchAsAdmin } from '../api/commands';

interface AdminRequiredHintProps {
  /**
   * 语气，决定标题：
   * - `permission`（默认）：不提权就做不了这件事（磁盘变化分析 / 删驱动包 / 改系统配置）
   * - `performance`：不提权也能用，只是慢很多（MFT 直读降级成遍历，几十秒 vs 几秒）
   *
   * 两者不能混：对降级场景说"需要管理员权限"，用户会以为功能坏了。
   */
  variant?: 'permission' | 'performance';
  /**
   * 该功能为什么需要管理员（一句话）。不传就只显示通用说明。
   * 各模块的用途差别很大（读 MFT / 删驱动包 / 改系统配置），说清楚比一句"需要权限"有用。
   */
  description?: string;
  /** 允许用户手动关掉这条提示。系统瘦身是这种用法，默认不可关 */
  dismissible?: boolean;
  /** 用户点关闭时通知调用方（由调用方决定要不要记住这次操作） */
  onDismiss?: () => void;
  /** 外层间距，默认无（由调用方的容器控制） */
  className?: string;
}

/**
 * 权限查询只做一次：三个模块可能同时挂载，没必要各发一次 IPC。
 * 提权重启后是新进程，缓存自然失效。
 */
let adminProbe: Promise<boolean> | null = null;

function probeAdminOnce(): Promise<boolean> {
  adminProbe ??= checkAdminPrivilege().catch(() => false);
  return adminProbe;
}

export function AdminRequiredHint({
  variant = 'permission',
  description,
  dismissible = false,
  onDismiss,
  className = '',
}: AdminRequiredHintProps) {
  const { t } = useTranslation('common');
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  /** 已发出提权请求、正在等 UAC。成功时窗口会被关掉，所以不解除忙碌态 */
  const [relaunching, setRelaunching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void probeAdminOnce().then((result) => {
      if (!cancelled) setIsAdmin(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRelaunch = useCallback(async () => {
    setRelaunching(true);
    try {
      const started = await relaunchAsAdmin();
      // false = 用户在 UAC 里取消了（或本来就是管理员）。取消是正常操作，恢复按钮即可
      if (!started) {
        setRelaunching(false);
      }
    } catch (error) {
      setRelaunching(false);
      console.error('请求管理员权限失败:', error);
    }
  }, []);

  // 查询中（null）和已有权限（true）都不渲染，避免先闪一条再消失
  if (isAdmin !== false) return null;

  return (
    <div
      // 配色全部走主题变量（soft-warning 用的是 --color-warning）。原来写的是
      // `text-amber-700 dark:text-amber-400` —— 本项目的 `dark:` 绑的是系统深浅色，
      // 不是应用自己的 `.dark` 类，应用切深色时文字仍是深棕，在暖色底上几乎看不清。
      className={`soft-warning flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${className}`}
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 leading-snug text-[var(--fg-secondary)]">
        <span className="font-medium text-[var(--color-warning)]">
          {variant === 'performance' ? t('adminPerformanceTitle') : t('adminRequiredTitle')}
        </span>
        {description && <span className="opacity-90"> — {description}</span>}
      </div>
      {/* 直接给按钮：让用户自己退出程序、再右键找 exe 选「以管理员身份运行」，这一步最容易劝退 */}
      <button
        type="button"
        onClick={handleRelaunch}
        disabled={relaunching}
        className="shrink-0 rounded-lg bg-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] px-2 py-0.5 font-medium text-[var(--color-warning)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-warning)_30%,transparent)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {relaunching ? t('adminRequesting') : t('adminRelaunch')}
      </button>
      {dismissible && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('close')}
          className="shrink-0 rounded p-0.5 text-[var(--color-warning)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-warning)_20%,transparent)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
