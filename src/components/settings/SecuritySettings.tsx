// ============================================================================
// 安全与校验页面
// ============================================================================

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Download, ExternalLink, Info, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { useToast } from '../Toast';
import { getOfficialDownloadConfig, type OfficialDownloadConfig } from '../../utils/downloadConfig';
import { LIGHTC_DEFAULT_DOWNLOAD_CONFIG, LIGHTC_OFFICIAL_WEBSITE_URL } from '../../config/officialLinks';
import { verifyIntegrity, type VerifyIntegrityResult } from '../../api/commands';
import { useTranslation } from 'react-i18next';

export function SecuritySettings() {
  const { t } = useTranslation('settings');
  const [verifyResult, setVerifyResult] = useState<VerifyIntegrityResult | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [downloadConfig, setDownloadConfig] = useState<OfficialDownloadConfig | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    // 渠道链接放在 Release 的 download.json，设置页只展示通过 https 校验后的官方入口。
    getOfficialDownloadConfig()
      .then(setDownloadConfig)
      .catch((error) => {
        console.warn('读取官方下载配置失败:', error);
      });
  }, []);

  const handleVerifyIntegrity = async () => {
    try {
      setIsVerifying(true);
      const result = await verifyIntegrity();
      setVerifyResult(result);

      if (result.status === 'verified') {
        showToast({ type: 'success', title: t('security.verifyPassed'), description: result.message });
      } else if (result.status === 'network_error') {
        showToast({ type: 'info', title: t('security.networkTitle'), description: t('security.networkDesc') });
      } else if (result.status === 'release_unavailable') {
        showToast({ type: 'info', title: t('security.releaseTitle'), description: t('security.releaseDesc') });
      } else if (result.status === 'signature_error') {
        showToast({ type: 'error', title: t('security.signatureTitle'), description: t('security.signatureDesc') });
      } else {
        showToast({ type: 'error', title: t('security.verifyFailed'), description: t('security.verifyFailedDesc') });
      }
    } catch (error) {
      setVerifyResult({
        verified: false,
        status: 'network_error',
        version: '',
        channel: '',
        message: `${t('security.networkDesc')}: ${String(error)}`,
        official_url: 'https://github.com/Chunyu33/light-c/releases',
      });
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <ShieldCheck className="w-3.5 h-3.5" />
          {t('security.title')}
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">{t('security.verifyTitle')}</p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed mt-1">
              {t('security.verifyDesc')}
            </p>
          </div>

          <button
            onClick={handleVerifyIntegrity}
            disabled={isVerifying}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-[var(--brand-green)] rounded-xl hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {isVerifying ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <ShieldCheck className="w-4 h-4" />
            )}
            {isVerifying ? t('security.verifying') : t('security.verifyTitle')}
          </button>

          {verifyResult && <VerifyIntegrityResultCard result={verifyResult} />}
        </div>
      </div>

      {/* 先给出官方渠道，再说明第三方风险，避免用户只看到警告却不知道应该去哪里下载。 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Download className="w-3.5 h-3.5" />
          {t('security.downloadTitle')}
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-3">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            {t('security.downloadDesc')}
          </p>

          {/* 安全页同时展示官网，帮助用户从可信入口了解项目和下载来源。 */}
          <a
            href={LIGHTC_OFFICIAL_WEBSITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between rounded-xl bg-[var(--bg-card)] px-3 py-3 transition-colors hover:bg-[var(--bg-hover)] group"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--text-primary)]">{t('security.officialWebsite')}</p>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">{t('security.officialWebsiteDesc')}</p>
            </div>
            <ExternalLink className="h-4 w-4 shrink-0 text-[var(--text-faint)] group-hover:text-[var(--brand-green)]" />
          </a>

          <a
            href={downloadConfig?.githubReleasesUrl ?? LIGHTC_DEFAULT_DOWNLOAD_CONFIG.githubReleasesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between rounded-xl bg-[var(--bg-card)] px-3 py-3 transition-colors hover:bg-[var(--bg-hover)] group"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--text-primary)]">GitHub Releases</p>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">{t('security.githubDesc')}</p>
            </div>
            <ExternalLink className="h-4 w-4 shrink-0 text-[var(--text-faint)] group-hover:text-[var(--brand-green)]" />
          </a>

          <a
            href={downloadConfig?.netDiskUrl ?? LIGHTC_DEFAULT_DOWNLOAD_CONFIG.netDiskUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between rounded-xl bg-[var(--bg-card)] px-3 py-3 transition-colors hover:bg-[var(--bg-hover)] group"
          >
            <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)]">{t('security.netDisk')}</p>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">{t('security.netDiskDesc')}</p>
            </div>
            <ExternalLink className="h-4 w-4 shrink-0 text-[var(--text-faint)] group-hover:text-[var(--brand-green)]" />
          </a>

          <div className="rounded-xl bg-[var(--bg-card)] px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">{t('security.socialTitle')}</p>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">{t('security.socialDesc')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <a
                  href={downloadConfig?.bilibiliUrl ?? LIGHTC_DEFAULT_DOWNLOAD_CONFIG.bilibiliUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[var(--brand-green)] hover:bg-[var(--brand-green)]/10"
                  title={t('security.openBilibili')}
                >
                  Bilibili
                  <ExternalLink className="h-3 w-3" />
                </a>
                <a
                  href={downloadConfig?.douyinUrl ?? LIGHTC_DEFAULT_DOWNLOAD_CONFIG.douyinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[var(--brand-green)] hover:bg-[var(--brand-green)]/10"
                  title={t('security.openDouyin')}
                >
                  Douyin
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--color-warning)]/20 bg-[var(--color-warning)]/10 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-[var(--color-warning)] mt-0.5 shrink-0" />
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-medium text-[var(--text-primary)]">{t('security.thirdPartyTitle')}</p>
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
              {t('security.thirdPartyDesc')}
            </p>
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
              {t('security.thirdPartyDesc2')}
            </p>
            <p className="text-xs font-medium leading-relaxed text-[var(--color-warning)]">
              {t('security.recommendVerify')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function VerifyIntegrityResultCard({ result }: { result: VerifyIntegrityResult }) {
  const { t } = useTranslation('settings');
  if (result.status === 'verified') {
    return (
      <div className="rounded-xl border border-[var(--brand-green)]/20 bg-[var(--brand-green)]/10 p-3">
        <div className="flex items-start gap-3">
          <CheckCircle className="w-4 h-4 text-[var(--brand-green)] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--brand-green)]">{t('security.officialVersion', { version: result.version })}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">{result.channel} · {t('security.signaturePassed')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (result.status === 'network_error') {
    return (
      <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-3">
        <div className="flex items-start gap-3">
          <Info className="w-4 h-4 text-[var(--text-muted)] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)]">{t('security.networkTitle')}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">{t('security.networkRetry')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (result.status === 'release_unavailable') {
    return (
      <div className="rounded-xl border border-[var(--color-warning)]/20 bg-[var(--color-warning)]/10 p-3">
        <div className="flex items-start gap-3">
          <Info className="w-4 h-4 text-[var(--color-warning)] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)]">{t('security.releaseCardTitle')}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1 break-all">{result.message}</p>
          </div>
        </div>
      </div>
    );
  }

  if (result.status === 'signature_error') {
    return (
      <div className="rounded-xl border border-[var(--color-warning)]/20 bg-[var(--color-warning)]/10 p-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-[var(--color-warning)] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)]">{t('security.signatureCardTitle')}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1 break-all">{result.message}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/10 p-3">
      <div className="flex items-start gap-3">
        <XCircle className="w-4 h-4 text-[var(--color-danger)] mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--color-danger)]">{t('security.mismatchTitle')}</p>
          <p className="text-xs text-[var(--text-muted)] mt-1 break-all">{result.message}</p>
          <p className="text-xs text-[var(--text-muted)] mt-2">
            {t('security.mismatchDesc')}
          </p>
          <a
            href={result.official_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--brand-green)] hover:opacity-80"
          >
            {t('security.githubReleases')}
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
    </div>
  );
}
