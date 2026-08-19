import { FolderOpen, ShieldCheck, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { LeftoverWhitelistEntry } from '../../api/commands';

interface LeftoverWhitelistModalProps {
  entries: LeftoverWhitelistEntry[];
  error: string | null;
  isUpdating: boolean;
  onClose: () => void;
  onOpen: (path: string) => Promise<void>;
  onRemove: (path: string) => Promise<void>;
  t: TFunction<'modules'>;
  commonT: TFunction<'common'>;
}

export function LeftoverWhitelistModal({
  entries,
  error,
  isUpdating,
  onClose,
  onOpen,
  onRemove,
  t,
  commonT,
}: LeftoverWhitelistModalProps) {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex w-full max-w-2xl max-h-[80vh] flex-col overflow-hidden rounded-xl bg-[var(--bg-card)] shadow-2xl">
        <div className="flex items-center gap-3 border-b border-[var(--border-color)] p-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--brand-green-10)]">
            <ShieldCheck className="h-5 w-5 text-[var(--brand-green)]" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-[var(--text-primary)]">{t('leftovers.whitelistManage')}</h3>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">{t('leftovers.whitelistDesc')}</p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && <p className="mb-3 rounded-lg bg-[var(--color-danger)]/10 p-3 text-xs text-[var(--color-danger)] break-all">{error}</p>}
          {entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--text-muted)]">{t('leftovers.whitelistEmpty')}</p>
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => (
                <div key={entry.path} className="flex items-center gap-3 rounded-lg bg-[var(--bg-main)] p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-[var(--text-primary)]" title={entry.path}>{entry.path}</p>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">{t('leftovers.whitelistAddedAt', { time: formatAddedTime(entry.addedAt) })}</p>
                  </div>
                  <button
                    onClick={() => void onOpen(entry.path)}
                    className="shrink-0 rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--brand-green)]"
                    title={commonT('openInFolder')}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => void onRemove(entry.path)}
                    disabled={isUpdating}
                    className="shrink-0 rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--color-danger)]/10 hover:text-[var(--color-danger)] disabled:cursor-not-allowed disabled:opacity-50"
                    title={t('leftovers.removeFromWhitelist')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-[var(--border-color)] p-4">
          <button onClick={onClose} className="w-full rounded-lg bg-[var(--bg-hover)] px-4 py-2.5 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-main)]">
            {commonT('close')}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatAddedTime(addedAt: string): string {
  const date = new Date(addedAt);
  // 历史文件可能缺少时间字段，保留原值比显示无效日期更便于排查。
  return Number.isNaN(date.getTime()) ? addedAt : date.toLocaleString();
}
