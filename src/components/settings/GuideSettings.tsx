// 使用说明页面

import { BookOpen, Cpu, Database, FileBox, HardDrive, Layers, MessageCircle, MousePointerClick, Package, Shield, ShieldCheck, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const GUIDE_ITEMS = [
  { key: 'scan', icon: Zap },
  { key: 'bigFiles', icon: FileBox },
  { key: 'diskInfo', icon: HardDrive },
  { key: 'social', icon: MessageCircle },
  { key: 'systemSlim', icon: Layers },
  { key: 'drivers', icon: Cpu },
  { key: 'leftovers', icon: Package },
  { key: 'registry', icon: Database },
  { key: 'contextMenu', icon: MousePointerClick },
  { key: 'hotspot', icon: HardDrive },
  { key: 'diskGrowth', icon: HardDrive },
  { key: 'shellIcons', icon: HardDrive },
  { key: 'aiModels', icon: Cpu },
] as const;

const RISK_LEVELS = [
  { key: 'safe', className: 'bg-[var(--brand-green)] text-white' },
  { key: 'low', className: 'bg-[var(--brand-green)] text-white' },
  { key: 'medium', className: 'bg-[var(--color-warning)] text-white' },
  { key: 'high', className: 'bg-[var(--color-warning)] text-white' },
  { key: 'critical', className: 'bg-[var(--color-danger)] text-white' },
] as const;

export function GuideSettings() {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h4 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          <BookOpen className="h-3.5 w-3.5" />
          {t('guide.title')}
        </h4>
        <div className="space-y-4 rounded-2xl bg-[var(--bg-main)] p-5">
          {GUIDE_ITEMS.map(({ key, icon: Icon }) => (
            <div key={key}>
              <p className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                <Icon className="h-4 w-4 text-[var(--brand-green)]" />
                {t(`guide.items.${key}.title`)}
              </p>
              <p className="pl-6 text-xs leading-relaxed text-[var(--text-muted)]">
                {t(`guide.items.${key}.desc`)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          <ShieldCheck className="h-3.5 w-3.5" />
          {t('guide.permissionsTitle')}
        </h4>
        <div className="space-y-3 rounded-2xl bg-[var(--bg-main)] p-5">
          <p className="text-sm font-medium text-[var(--text-primary)]">{t('guide.permissionsHeading')}</p>
          <p className="text-xs leading-relaxed text-[var(--text-muted)]">{t('guide.permissionsDesc')}</p>
          <p className="text-sm font-medium text-[var(--text-primary)]">{t('guide.securityTitle')}</p>
          <p className="text-xs leading-relaxed text-[var(--text-muted)]">{t('guide.securityDesc')}</p>
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          <Shield className="h-3.5 w-3.5" />
          {t('guide.riskTitle')}
        </h4>
        <div className="space-y-3 rounded-2xl bg-[var(--bg-main)] p-5">
          {RISK_LEVELS.map(({ key, className }) => (
            <div key={key} className="flex items-start gap-3">
              <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-medium ${className}`}>
                {t(`guide.risk.${key}`)}
              </span>
              <p className="text-xs text-[var(--text-muted)]">{t(`guide.risk.${key}Desc`)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          <Shield className="h-3.5 w-3.5" />
          {t('guide.notesTitle')}
        </h4>
        <div className="space-y-1 rounded-2xl bg-[var(--bg-main)] p-5 text-xs leading-relaxed text-[var(--text-muted)]">
          {(t('guide.notes', { returnObjects: true }) as string[]).map((note) => (
            <p key={note}>• {note}</p>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          <ShieldCheck className="h-3.5 w-3.5" />
          {t('guide.disclaimerTitle')}
        </h4>
        <p className="rounded-2xl bg-[var(--bg-main)] p-5 text-xs leading-relaxed text-[var(--text-muted)]">
          {t('guide.disclaimer')}
        </p>
      </section>
    </div>
  );
}
