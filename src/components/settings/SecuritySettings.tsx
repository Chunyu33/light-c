// ============================================================================
// 安全与校验页面
// ============================================================================

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Download, ExternalLink, Info, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { useToast } from '../Toast';
import { getOfficialDownloadConfig, type OfficialDownloadConfig } from '../../utils/downloadConfig';
import { LIGHTC_DEFAULT_DOWNLOAD_CONFIG } from '../../config/officialLinks';
import { verifyIntegrity, type VerifyIntegrityResult } from '../../api/commands';

export function SecuritySettings() {
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
        showToast({ type: 'success', title: '校验通过', description: result.message });
      } else if (result.status === 'network_error') {
        showToast({ type: 'info', title: '无法连接 GitHub', description: '请检查网络后重试。' });
      } else if (result.status === 'release_unavailable') {
        showToast({ type: 'info', title: '签名资产未发布', description: '当前版本需要等 Release 完成后才能校验。' });
      } else if (result.status === 'signature_error') {
        showToast({ type: 'error', title: '签名资产异常', description: '官方签名文件格式异常，请等待作者修复发布资产。' });
      } else {
        showToast({ type: 'error', title: '校验未通过', description: '当前文件未匹配到对应版本的官方 exe 签名。' });
      }
    } catch (error) {
      setVerifyResult({
        verified: false,
        status: 'network_error',
        version: '',
        channel: '',
        message: `无法连接到 GitHub，请检查网络：${String(error)}`,
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
          官方原版校验
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">校验文件完整性</p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed mt-1">
              使用官方公钥读取签名来验证当前运行的 LightC.exe。
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
            {isVerifying ? '正在校验...' : '校验文件完整性'}
          </button>

          {verifyResult && <VerifyIntegrityResultCard result={verifyResult} />}
        </div>
      </div>

      {/* 先给出官方渠道，再说明第三方风险，避免用户只看到警告却不知道应该去哪里下载。 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Download className="w-3.5 h-3.5" />
          官方下载渠道
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-3">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            LightC 的官方文件仅通过以下渠道发布，其他来源均为第三方转载。
          </p>

          <a
            href={downloadConfig?.githubReleasesUrl ?? LIGHTC_DEFAULT_DOWNLOAD_CONFIG.githubReleasesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between rounded-xl bg-[var(--bg-card)] px-3 py-3 transition-colors hover:bg-[var(--bg-hover)] group"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--text-primary)]">GitHub Releases</p>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">唯一的原始发布地址，所有版本均可在此获取</p>
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
              <p className="text-sm font-medium text-[var(--text-primary)]">网盘下载</p>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">作者本人分享的、安全的网盘渠道。</p>
            </div>
            <ExternalLink className="h-4 w-4 shrink-0 text-[var(--text-faint)] group-hover:text-[var(--brand-green)]" />
          </a>

          <div className="rounded-xl bg-[var(--bg-card)] px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">作者本人社交平台</p>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">B站 / 抖音同名账号「Evan的像素空间」发布的网盘链接</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <a
                  href={downloadConfig?.bilibiliUrl ?? LIGHTC_DEFAULT_DOWNLOAD_CONFIG.bilibiliUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[var(--brand-green)] hover:bg-[var(--brand-green)]/10"
                  title="打开 B站 @Evan的像素空间"
                >
                  B站
                  <ExternalLink className="h-3 w-3" />
                </a>
                <a
                  href={downloadConfig?.douyinUrl ?? LIGHTC_DEFAULT_DOWNLOAD_CONFIG.douyinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[var(--brand-green)] hover:bg-[var(--brand-green)]/10"
                  title="在抖音搜索 Evan的像素空间"
                >
                  抖音
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
            <p className="text-sm font-medium text-[var(--text-primary)]">第三方渠道的风险</p>
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
              公众号、论坛、网盘分享等第三方渠道发布的 LightC 文件，可能存在版本滞后、二次打包、捆绑推广软件或广告程序等问题。
            </p>
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
              部分网盘链接需要积分或关注，属于借助本软件的商业引流行为。以上风险与作者无关，作者对第三方渠道分发的文件内容不承担任何责任。
            </p>
            <p className="text-xs font-medium leading-relaxed text-[var(--color-warning)]">
              建议使用上方“校验文件完整性”功能，验证当前运行的文件是否为官方原版。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function VerifyIntegrityResultCard({ result }: { result: VerifyIntegrityResult }) {
  if (result.status === 'verified') {
    return (
      <div className="rounded-xl border border-[var(--brand-green)]/20 bg-[var(--brand-green)]/10 p-3">
        <div className="flex items-start gap-3">
          <CheckCircle className="w-4 h-4 text-[var(--brand-green)] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--brand-green)]">当前为官方原版 v{result.version}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">{result.channel} · 签名验证通过</p>
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
            <p className="text-sm font-medium text-[var(--text-primary)]">无法连接到 GitHub</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">请检查网络后重试，或稍后再进行完整性校验。</p>
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
            <p className="text-sm font-medium text-[var(--text-primary)]">当前版本暂未发布官方签名资产</p>
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
            <p className="text-sm font-medium text-[var(--text-primary)]">官方签名资产格式异常</p>
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
          <p className="text-sm font-medium text-[var(--color-danger)]">签名与当前文件不匹配</p>
          <p className="text-xs text-[var(--text-muted)] mt-1 break-all">{result.message}</p>
          <p className="text-xs text-[var(--text-muted)] mt-2">
            可能原因包括：文件来源不一致、文件被修改，或当前 Release 的 exe 签名资产需要作者重新上传。
          </p>
          <a
            href={result.official_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--brand-green)] hover:opacity-80"
          >
            官方 GitHub Releases
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
    </div>
  );
}
