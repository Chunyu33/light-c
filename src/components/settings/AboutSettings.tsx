// ============================================================================
// 关于页面
// ============================================================================

import { useEffect, useState } from 'react';
import { Code2, Cpu, Download, ExternalLink, HardDrive, HelpCircle, Info, Monitor as MonitorIcon, RefreshCw, Rocket, User, Clock, ClipboardList } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { getDistributionChannel, getSystemInfo, type DistributionChannel, type SystemInfo } from '../../api/commands';
import { formatSize } from '../../utils/format';
import binlockxIcon from '../../assets/binlockx.svg';
import viapIcon from '../../assets/viap.svg';

export function AboutSettings() {
  const [appVersion, setAppVersion] = useState('');
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loadingSystemInfo, setLoadingSystemInfo] = useState(true);
  const [distributionChannel, setDistributionChannel] = useState<DistributionChannel>('installer');

  // 获取应用版本号和系统信息
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion('未知'));

    // 获取系统信息
    getSystemInfo()
      .then(setSystemInfo)
      .catch(err => console.error('获取系统信息失败:', err))
      .finally(() => setLoadingSystemInfo(false));

    // 便携版使用 zip 覆盖更新，关于页需要把入口文案改成作者渠道下载，避免误导用户走安装器更新。
    getDistributionChannel()
      .then(setDistributionChannel)
      .catch(err => console.error('获取发行渠道失败:', err));
  }, []);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Info className="w-3.5 h-3.5" />
          应用信息
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-[var(--brand-green)] flex items-center justify-center">
              <span className="text-2xl font-bold text-white">C:</span>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">LightC</h3>
              <p className="text-sm text-[var(--text-muted)]">Windows C盘智能清理工具</p>
              <p className="text-xs text-[var(--text-faint)] mt-1">
                版本 {appVersion || '...'} · {distributionChannel === 'portable' ? '便携版' : '安装版'}
              </p>
            </div>
          </div>
          {/* 检查更新按钮 */}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('lightc:check-update'))}
            className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-[var(--brand-green)] bg-[var(--brand-green)]/10 rounded-xl hover:bg-[var(--brand-green)]/20 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            {distributionChannel === 'portable' ? '作者渠道下载' : '检查更新'}
          </button>
          <p className="text-xs text-[var(--text-faint)] mt-3">
            {distributionChannel === 'portable'
              ? '便携版不会自动安装更新，推荐从作者网盘下载新版 zip 后覆盖当前目录，GitHub Releases 作为官方备用渠道。'
              : '温馨提示：更新源为GitHub，国内可能会出现间歇性DNS污染，如果失败可以稍后重试。'}
          </p>
        </div>
      </div>

      {/* 系统信息 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <MonitorIcon className="w-3.5 h-3.5" />
          系统信息
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5">
          {loadingSystemInfo ? (
            <div className="flex items-center justify-center py-4">
              <RefreshCw className="w-5 h-5 text-[var(--brand-green)] animate-spin" />
              <span className="ml-2 text-sm text-[var(--text-muted)]">正在获取系统信息...</span>
            </div>
          ) : systemInfo ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MonitorIcon className="w-4 h-4 text-[var(--text-muted)]" />
                  <span className="text-sm text-[var(--text-secondary)]">操作系统</span>
                </div>
                <span className="text-sm font-medium text-[var(--text-primary)] text-right max-w-[280px] truncate" title={systemInfo.os_version}>
                  {systemInfo.os_version}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-[var(--text-muted)]" />
                  <span className="text-sm text-[var(--text-secondary)]">系统架构</span>
                </div>
                <span className="text-sm font-medium text-[var(--text-primary)]">{systemInfo.os_arch}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-[var(--text-muted)]" />
                  <span className="text-sm text-[var(--text-secondary)]">处理器</span>
                </div>
                <span className="text-sm font-medium text-[var(--text-primary)] text-right max-w-[280px] truncate" title={systemInfo.cpu_info}>
                  {systemInfo.cpu_info}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-[var(--text-muted)]" />
                  <span className="text-sm text-[var(--text-secondary)]">CPU 核心数</span>
                </div>
                <span className="text-sm font-medium text-[var(--text-primary)]">{systemInfo.cpu_cores} 核</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-[var(--text-muted)]" />
                  <span className="text-sm text-[var(--text-secondary)]">内存</span>
                </div>
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  {formatSize(systemInfo.available_memory)} 可用 / {formatSize(systemInfo.total_memory)} 总计
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-[var(--text-muted)]" />
                  <span className="text-sm text-[var(--text-secondary)]">计算机名</span>
                </div>
                <span className="text-sm font-medium text-[var(--text-primary)]">{systemInfo.computer_name}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-[var(--text-muted)]" />
                  <span className="text-sm text-[var(--text-secondary)]">当前用户</span>
                </div>
                <span className="text-sm font-medium text-[var(--text-primary)]">{systemInfo.user_name}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-[var(--text-muted)]" />
                  <span className="text-sm text-[var(--text-secondary)]">系统运行时间</span>
                </div>
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  {Math.floor(systemInfo.uptime_seconds / 86400)} 天 {Math.floor((systemInfo.uptime_seconds % 86400) / 3600)} 小时 {Math.floor((systemInfo.uptime_seconds % 3600) / 60)} 分钟
                </span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[var(--text-muted)] text-center py-4">无法获取系统信息</p>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <HelpCircle className="w-3.5 h-3.5" />
          为什么叫LightC
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5">
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            <span className="font-medium text-[var(--brand-green)]">Light</span> 代表轻量、轻快，寓意让您的C盘变得轻盈；
            <span className="font-medium text-[var(--brand-green)]">C</span> 即C盘，Windows系统的核心磁盘。
            LightC 致力于帮助您安全、高效地清理C盘垃圾文件，释放宝贵的磁盘空间，让系统运行更加流畅。
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Code2 className="w-3.5 h-3.5" />
          开发者
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--text-secondary)]">作者</span>
            <span className="text-sm font-medium text-[var(--text-primary)]">Evan Lau</span>
          </div>
          {/* <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--text-secondary)]">官方网站</span>
            <a
              href="https://evanspace.icu/lightc"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-[var(--brand-green)] hover:opacity-80 flex items-center gap-1"
            >
              LightC
              <ExternalLink className="w-3 h-3" />
            </a>
          </div> */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--text-secondary)]">源码地址</span>
            <a
              href="https://github.com/Chunyu33/light-c"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-[var(--brand-green)] hover:opacity-80 flex items-center gap-1"
            >
              GitHub
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--text-secondary)]">源码许可证</span>
            <a
              href="https://github.com/Chunyu33/light-c/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-[var(--brand-green)] hover:opacity-80 flex items-center gap-1"
            >
              Source Available
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>

      {/* 更新日志 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <ClipboardList className="w-3.5 h-3.5" />
          更新日志
        </h4>
        <a
          href="https://github.com/Chunyu33/light-c/blob/main/CHANGELOG.md"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between p-4 rounded-2xl bg-[var(--bg-main)] hover:bg-[var(--bg-hover)] transition-colors group"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--brand-green)]/10 flex items-center justify-center">
              <Clock className="w-4 h-4 text-[var(--brand-green)]" />
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">更新日志</p>
              <p className="text-xs text-[var(--text-muted)]">查看版本更新历史</p>
            </div>
          </div>
          <ExternalLink className="w-4 h-4 text-[var(--text-faint)] group-hover:text-[var(--text-muted)]" />
        </a>
      </div>

      <MoreToolsSection />

      <div className="text-center pt-4">
        <p className="text-xs text-[var(--text-faint)]">
          Copyright &copy; {new Date().getFullYear()} LightC. All rights reserved.
        </p>
      </div>
    </div>
  );
}

// 更多工具推荐放在关于页底部，用轻量入口承接同作者的其他实用工具，不打断主设置流程。
function MoreToolsSection() {
  const tools = [
    {
      name: 'Viap',
      icon: viapIcon,
      description:
        'Windows 应用存储重定向工具。通过目录/符号链接将 C 盘应用迁移到其他磁盘，支持批量迁移。常见场景如桌面/文档/微信/QQ 等数据迁移。',
      downloadUrl: 'https://pan.quark.cn/s/4761ee4ba698',
    },
    {
      name: 'BinlockX',
      icon: binlockxIcon,
      description:
        '本地隐私保护工具。支持 AES-256-GCM 文件加密、隐私空间、隐私便签和隐私体检，数据全程保留在本机。',
      downloadUrl: 'https://pan.quark.cn/s/4243a5142b29',
    },
  ];

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
        <Rocket className="w-3.5 h-3.5" />
        更多实用工具
      </h4>
      <div className="space-y-3">
        {tools.map(({ name, icon, description, downloadUrl }) => (
          <div
            key={name}
            className="rounded-2xl bg-[var(--bg-main)] border border-[var(--border-color)] p-4"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 rounded-lg bg-[var(--brand-green)]/10 flex items-center justify-center">
                {/* 使用项目原始图标，避免推荐卡片和 LightC 自身功能图标混淆。 */}
                <img src={icon} alt={`${name} 图标`} className="w-5 h-5 object-contain" />
              </div>
              <h5 className="text-sm font-semibold text-[var(--text-primary)]">{name}</h5>
            </div>
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{description}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href={downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--brand-green)] hover:border-[var(--brand-green)]/40 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                下载
              </a>
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-[var(--text-faint)] text-center">以上同为我维护的工具，欢迎试用</p>
    </div>
  );
}
