// ============================================================================
// 更新提示模态框组件
// 启动时自动检查更新，发现新版本时弹出更新提示。
//
// 视觉与尺寸都跟随全局设置：
// - 颜色用主题变量，深色模式自动适配；
// - 所有尺寸用 em，继承 :root 的 font-size（= --base-font-size + --font-size-offset），
//   因此用户调整字号时，弹窗的宽高与文字会和主界面同比例放大缩小。
// - 进出场沿用项目统一的 modal-overlay-* / modal-content-* 动画类（见 App.css），
//   与 ConfirmDialog / SettingsModal 保持一致。
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, RefreshCw, CheckCircle, AlertCircle, Sparkles, FileText, AlertTriangle } from 'lucide-react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import { useToast } from './Toast';
import { PortableUpdateDialog } from './settings/PortableUpdateDialog';
import { registerPortableUpdateDebugTrigger } from '../utils/portableUpdateDebug';
import { getDistributionChannel, type DistributionChannel } from '../api/commands';
import { getOfficialDownloadConfig } from '../utils/downloadConfig';
import { LIGHTC_DEFAULT_DOWNLOAD_CONFIG, LIGHTC_OFFICIAL_WEBSITE_URL } from '../config/officialLinks';
import { useTranslation } from 'react-i18next';

// ============================================================================
// 类型定义
// ============================================================================

type UpdateStatus = 
  | 'checking'      // 正在检查
  | 'available'     // 有新版本
  | 'downloading'   // 正在下载
  | 'ready'         // 下载完成，准备安装
  | 'error';        // 错误

interface UpdateModalProps {
  /** 是否在启动时自动检查 */
  autoCheck?: boolean;
}

// ============================================================================
// 错误信息映射
// ============================================================================

function getErrorMessage(error: unknown, translate: (key: string) => string): string {
  const errorStr = error instanceof Error ? error.message : String(error);
  
  // 网络相关错误
  if (errorStr.includes('network') || errorStr.includes('fetch') || errorStr.includes('connect')) {
    return translate('updateErrorNetwork');
  }
  
  // 签名验证错误
  if (errorStr.includes('signature') || errorStr.includes('pubkey') || errorStr.includes('verify')) {
    return translate('updateErrorSignature');
  }
  
  // 超时错误
  if (errorStr.includes('timeout') || errorStr.includes('timed out')) {
    return translate('updateErrorTimeout');
  }
  
  // 404 错误
  if (errorStr.includes('404') || errorStr.includes('not found')) {
    return translate('updateErrorNotFound');
  }
  
  // JSON 解析错误
  if (errorStr.includes('JSON') || errorStr.includes('parse')) {
    return translate('updateErrorFormat');
  }
  
  // 权限错误
  if (errorStr.includes('permission') || errorStr.includes('access denied')) {
    return translate('updateErrorPermission');
  }
  
  // 磁盘空间错误
  if (errorStr.includes('disk') || errorStr.includes('space') || errorStr.includes('storage')) {
    return translate('updateErrorDisk');
  }
  
  return errorStr || translate('unknown');
}

// ============================================================================
// 更新模态框组件
// ============================================================================

export function UpdateModal({ autoCheck = true }: UpdateModalProps) {
  const { t } = useTranslation('common');
  const { t: uiT } = useTranslation('ui');
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState<UpdateStatus>('checking');
  const [update, setUpdate] = useState<Update | null>(null);
  const [currentVersion, setCurrentVersion] = useState('');
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [isVisible, setIsVisible] = useState(false);
  // 退场动画期间需要继续保留 DOM，否则 animate-out 会来不及播就被卸载。
  const [isAnimating, setIsAnimating] = useState(false);
  const enteredRef = useRef(false);
  if (isVisible) enteredRef.current = true;
  const [distributionChannel, setDistributionChannel] = useState<DistributionChannel | null>(null);
  // 便携版更新提示：只引导下载，不安装；latestVersion 为 null 表示未查到或已是最新。
  const [portableDialogOpen, setPortableDialogOpen] = useState(false);
  const [portableLatestVersion, setPortableLatestVersion] = useState<string | null>(null);
  const [isCheckingPortableVersion, setIsCheckingPortableVersion] = useState(false);
  const [portableCheckFailed, setPortableCheckFailed] = useState(false);
  const [downloadConfig, setDownloadConfig] = useState({ netDiskUrl: LIGHTC_DEFAULT_DOWNLOAD_CONFIG.netDiskUrl });
  const { showToast } = useToast();
  const sourceRef = useRef<'auto' | 'manual'>('auto');

  // 获取当前版本
  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => setCurrentVersion(t('unknown')));
  }, []);

  // 便携版不能走安装器式自动更新，否则会误导用户下载并安装 NSIS 包。
  useEffect(() => {
    getDistributionChannel()
      .then(setDistributionChannel)
      .catch((error) => {
        console.error('获取发行渠道失败:', error);
        setDistributionChannel('installer');
      });
  }, []);

  /**
   * 便携版更新引导：先立即弹出二次确认窗口，再后台查询远端版本用于补充提示。
   *
   * 中文说明：便携版替换文件即可升级，绝不能调用 downloadAndInstall（那会静默安装 NSIS 包）。
   * 这里把"需要手动替换"讲清楚，并给出官网与网盘两个官方入口。
   */
  const openPortableUpdateDialog = useCallback(async () => {
    setPortableLatestVersion(null);
    setPortableCheckFailed(false);
    setPortableDialogOpen(true);
    setIsCheckingPortableVersion(true);

    // 渠道地址来自官方 download.json，失败时沿用内置网盘地址，保证按钮永远可用。
    try {
      const config = await getOfficialDownloadConfig();
      setDownloadConfig({ netDiskUrl: config.netDiskUrl });
    } catch (error) {
      console.error('读取官方下载配置失败，沿用内置网盘地址:', error);
    }

    try {
      // 只查询版本用于提示，不下载也不安装。
      const updateResult = await check();
      setPortableLatestVersion(updateResult?.version ?? null);
      setPortableCheckFailed(false);
    } catch (error) {
      // 查询失败不影响引导流程，弹窗降级为纯渠道入口，并如实说明没查到版本。
      console.error('查询便携版最新版本失败:', error);
      setPortableLatestVersion(null);
      setPortableCheckFailed(true);
    } finally {
      setIsCheckingPortableVersion(false);
    }
  }, []);

  // 开发环境提供控制台入口，便于直接预览便携版弹窗样式。
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    registerPortableUpdateDebugTrigger((overrides = {}) => {
      setPortableLatestVersion(overrides.latestVersion ?? null);
      setIsCheckingPortableVersion(overrides.isChecking ?? false);
      setPortableDialogOpen(true);
    });
  }, []);

  /** 打开官方渠道；网盘地址保持使用官方配置里的作者网盘。 */
  const handleOpenPortableChannel = useCallback(async (url: string, channel: 'website' | 'netDisk') => {
    try {
      await openUrl(url);
      showToast({
        type: 'info',
        title: channel === 'website' ? uiT('websiteOpened') : uiT('netDiskOpened'),
        description: uiT('portableUpdateHint'),
      });
    } catch (error) {
      console.error('打开便携版下载渠道失败:', error);
      showToast({
        type: 'error',
        title: uiT('downloadOpenFailed'),
        description: uiT('downloadOpenFailedDesc'),
      });
    }
  }, [showToast, uiT]);

  // 检查更新（source: 'auto' 启动自动检查 / 'manual' 用户手动触发）
  const checkForUpdate = useCallback(async (source: 'auto' | 'manual' = 'auto') => {
    sourceRef.current = source;
    let currentDistributionChannel = distributionChannel;

    if (!currentDistributionChannel) {
      try {
        // 手动检查可能早于初始化完成，按需补取一次渠道，避免按钮点击后没有反馈。
        currentDistributionChannel = await getDistributionChannel();
        setDistributionChannel(currentDistributionChannel);
      } catch (error) {
        // 渠道未知时绝不能假定为安装版：那会让便携版去调用安装器式自动更新。
        // 这里留空，下面的判断会按"非安装版"处理，改为打开官方下载页。
        console.error('获取发行渠道失败，将按便携版方式提示手动下载:', error);
        currentDistributionChannel = null;
        setDistributionChannel(null);
      }
    }

    // 只有明确是安装版才允许走 Tauri 自动更新；便携版和渠道未知都只做下载引导。
    if (currentDistributionChannel !== 'installer') {
      if (source === 'manual') {
        await openPortableUpdateDialog();
      }
      return;
    }

    setStatus('checking');
    setErrorMessage('');

    // 手动触发时立即打开弹窗显示 loading，给用户即时反馈
    if (source === 'manual') {
      openModal();
    }

    try {
      const updateResult = await check();

      if (updateResult) {
        setUpdate(updateResult);
        setStatus('available');
        // auto 模式下需要打开弹窗；manual 模式弹窗已打开，仅切换状态
        if (source === 'auto') {
          openModal();
        }
      } else if (source === 'manual') {
        // 已是最新版本：关闭弹窗 + toast 提示
        closeModal();
        showToast({
          type: 'success',
          title: uiT('upToDate'),
          description: uiT('upToDateDesc', { version: currentVersion }),
        });
      }
      // auto 模式无更新：静默（不弹窗）
    } catch (error) {
      console.error('检查更新失败:', error);
      // auto 模式：静默失败，不弹窗打扰用户
      // manual 模式：弹窗已打开，切换为错误状态展示
      if (source === 'manual') {
        setErrorMessage(getErrorMessage(error, uiT));
        setStatus('error');
      }
    }
  }, [currentVersion, distributionChannel, openPortableUpdateDialog, showToast, t, uiT]);

  // 启动时自动检查
  useEffect(() => {
    if (autoCheck && distributionChannel === 'installer') {
      const timer = setTimeout(() => checkForUpdate('auto'), 2000);
      return () => clearTimeout(timer);
    }
  }, [autoCheck, checkForUpdate, distributionChannel]);

  // 监听手动触发事件（来自 SettingsModal 的"检查更新"按钮）
  useEffect(() => {
    const handler = () => checkForUpdate('manual');
    window.addEventListener('lightc:check-update', handler);
    return () => window.removeEventListener('lightc:check-update', handler);
  }, [checkForUpdate]);

  // 下载并安装更新：只允许安装版执行，便携版永远不会调用安装器。
  const handleDownloadAndInstall = async () => {
    if (!update) return;
    if (distributionChannel !== 'installer') {
      // 双保险：即便弹窗状态被意外推进到 available，也不让便携版拉起 NSIS 安装包。
      closeModal();
      showToast({
        type: 'warning',
        title: uiT('downloadOpenFailed'),
        description: uiT('portableUpdateBlocked'),
      });
      return;
    }
    
    setStatus('downloading');
    setDownloadProgress(0);
    
    try {
      let downloaded = 0;
      let contentLength = 0;
      
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          contentLength = event.data.contentLength || 0;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            setDownloadProgress((downloaded / contentLength) * 100);
          }
        }
      });
      
      setStatus('ready');
    } catch (error) {
      console.error('下载更新失败:', error);
      setErrorMessage(getErrorMessage(error, uiT));
      setStatus('error');
    }
  };

  // 重启应用
  const handleRelaunch = async () => {
    try {
      await relaunch();
    } catch (error) {
      console.error('重启失败:', error);
      setErrorMessage(uiT('relaunchFailed'));
      setStatus('error');
    }
  };

  /**
   * 打开弹窗。
   * 中文说明：先挂载再在下一帧置为可见，让 CSS 动画从初始态正常起播；
   * 同时把 isAnimating 打开，保证关闭时的退场动画有 DOM 可播。
   */
  const openModal = () => {
    setIsAnimating(true);
    setIsOpen(true);
    requestAnimationFrame(() => setIsVisible(true));
  };

  /** 关闭弹窗：先播放退场动画，动画结束（与 modal-content-out 时长对齐）后再卸载。 */
  const closeModal = () => {
    setIsVisible(false);
    // 280ms 是入场动画时长，退场固定 185ms；这里取 200ms 与既有的 ConfirmDialog 一致。
    setTimeout(() => {
      setIsAnimating(false);
      setIsOpen(false);
    }, 200);
  };

  // 关闭模态框（供按钮与遮罩复用）
  const handleClose = closeModal;

  // 重试（沿用上次的触发来源）
  const handleRetry = () => {
    checkForUpdate(sourceRef.current);
  };

  if (!isOpen && !portableDialogOpen && !isAnimating) return null;

  return (
    <>
      {isOpen && createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      {/* 遮罩 */}
      <div
        className={`absolute inset-0 bg-black/50 backdrop-blur-sm ${isVisible ? 'modal-overlay-in' : enteredRef.current ? 'modal-overlay-out' : 'opacity-0'}`}
        onClick={status !== 'downloading' ? handleClose : undefined}
      />

      {/* 弹窗主体：宽高与圆角都随全局字号缩放，1.86em ≈ 26px */}
      <div className={`relative mx-[1em] w-[28.5em] max-w-[calc(100vw-2em)] overflow-hidden rounded-[0.86em] border border-[var(--border-default)] bg-[var(--bg-card)] shadow-2xl ${isVisible ? 'modal-content-in' : enteredRef.current ? 'modal-content-out' : 'opacity-0'}`}>
        {/* 关闭按钮：下载中不允许中断，故不渲染 */}
        {status !== 'downloading' && (
          <button
            type="button"
            onClick={handleClose}
            aria-label={t('close')}
            className="absolute right-[1em] top-[1em] z-10 flex h-[2em] w-[2em] items-center justify-center rounded-[0.57em] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-[1.14em] w-[1.14em]" />
          </button>
        )}

        {/* 内容区域 */}
        <div className="p-[1.43em]">
          {/* 有新版本可用 */}
          {status === 'available' && update && (
            <>
              {/* 版本标题：浅绿底图标 + 版本号，与主界面模块卡片同一语汇 */}
              <div className="flex items-start gap-[0.86em]">
                <div className="flex h-[2.57em] w-[2.57em] shrink-0 items-center justify-center rounded-[0.71em] bg-[var(--brand-green-10)]">
                  <Sparkles className="h-[1.29em] w-[1.29em] text-[var(--brand-green)]" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[1em] font-semibold text-[var(--text-primary)]">
                    {t('updateAvailable')}
                  </h2>
                  <p className="mt-[0.14em] text-[0.86em] text-[var(--text-muted)]">
                    v{currentVersion} → v{update.version}
                  </p>
                </div>
              </div>

              {/* 更新说明 */}
              <div className="mt-[1.14em]">
                <div className="flex items-center gap-[0.43em]">
                  <FileText className="h-[0.86em] w-[0.86em] text-[var(--text-muted)]" />
                  <span className="text-[0.86em] font-medium text-[var(--text-secondary)]">{t('updateNotes')}</span>
                </div>
                <div className="mt-[0.57em] max-h-[14em] overflow-auto rounded-[0.71em] border border-[var(--border-color)] bg-[var(--bg-main)] p-[1em]">
                  <div className="whitespace-pre-wrap text-[0.86em] leading-relaxed text-[var(--text-secondary)]">
                    {update.body || t('updateNotes')}
                  </div>
                </div>
              </div>

              {/* 操作按钮 */}
              <div className="mt-[1.43em] flex gap-[0.71em]">
                <button
                  onClick={handleClose}
                  className="flex-1 rounded-[0.71em] border border-[var(--border-default)] bg-[var(--bg-card)] px-[1em] py-[0.64em] text-[0.86em] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
                >
                  {t('cancel')}
                </button>
                <button
                  onClick={handleDownloadAndInstall}
                  className="flex flex-1 items-center justify-center gap-[0.43em] rounded-[0.71em] bg-[var(--brand-green)] px-[1em] py-[0.64em] text-[0.86em] font-semibold text-white transition-colors hover:bg-[var(--brand-green-hover)]"
                >
                  <Download className="h-[0.86em] w-[0.86em]" />
                  {t('confirm')}
                </button>
              </div>
            </>
          )}

          {/* 正在下载 */}
          {status === 'downloading' && (
            <div className="py-[1em]">
              <div className="flex items-start gap-[0.86em]">
                <div className="flex h-[2.57em] w-[2.57em] shrink-0 items-center justify-center rounded-[0.71em] bg-[var(--brand-green-10)]">
                  <RefreshCw className="h-[1.29em] w-[1.29em] animate-spin text-[var(--brand-green)]" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[1em] font-semibold text-[var(--text-primary)]">{t('downloadingUpdate')}</h2>
                  <p className="mt-[0.14em] text-[0.86em] text-[var(--text-muted)]">{t('doNotCloseApp')}</p>
                </div>
              </div>

              {/* 进度条：纯色填充，不用渐变装饰 */}
              <div className="mt-[1.14em] h-[0.43em] w-full overflow-hidden rounded-full bg-[var(--bg-main)]">
                <div
                  className="h-full rounded-full bg-[var(--brand-green)] transition-all duration-300"
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>
              <p className="mt-[0.57em] text-right text-[0.86em] font-medium text-[var(--brand-green)]">
                {downloadProgress.toFixed(0)}%
              </p>
            </div>
          )}

          {/* 下载完成，准备安装 */}
          {status === 'ready' && (
            <>
              <div className="flex items-start gap-[0.86em]">
                <div className="flex h-[2.57em] w-[2.57em] shrink-0 items-center justify-center rounded-[0.71em] bg-[var(--brand-green-10)]">
                  <CheckCircle className="h-[1.29em] w-[1.29em] text-[var(--brand-green)]" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[1em] font-semibold text-[var(--text-primary)]">{t('updateReady')}</h2>
                  <p className="mt-[0.14em] text-[0.86em] leading-relaxed text-[var(--text-muted)]">{t('restartToUpdate')}</p>
                </div>
              </div>

              <div className="mt-[1.43em] flex gap-[0.71em]">
                <button
                  onClick={handleClose}
                  className="flex-1 rounded-[0.71em] border border-[var(--border-default)] bg-[var(--bg-card)] px-[1em] py-[0.64em] text-[0.86em] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
                >
                  {t('cancel')}
                </button>
                <button
                  onClick={handleRelaunch}
                  className="flex flex-1 items-center justify-center gap-[0.43em] rounded-[0.71em] bg-[var(--brand-green)] px-[1em] py-[0.64em] text-[0.86em] font-semibold text-white transition-colors hover:bg-[var(--brand-green-hover)]"
                >
                  <RefreshCw className="h-[0.86em] w-[0.86em]" />
                  {t('confirm')}
                </button>
              </div>
            </>
          )}

          {/* 错误状态 */}
          {status === 'error' && (
            <>
              <div className="flex items-start gap-[0.86em]">
                <div className="flex h-[2.57em] w-[2.57em] shrink-0 items-center justify-center rounded-[0.71em] bg-[var(--color-danger)]/10">
                  <AlertCircle className="h-[1.29em] w-[1.29em] text-[var(--color-danger)]" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[1em] font-semibold text-[var(--text-primary)]">{t('updateFailed')}</h2>
                  <p className="mt-[0.14em] break-words text-[0.86em] leading-relaxed text-[var(--color-danger)]">
                    {errorMessage}
                  </p>
                </div>
              </div>

              {/* 提示条：浅色底 + 1px 边框，去掉原来的大块警示底色 */}
              <div className="mt-[1.14em] flex items-start gap-[0.57em] rounded-[0.71em] border border-[var(--border-color)] bg-[var(--bg-main)] px-[0.86em] py-[0.64em]">
                <AlertTriangle className="mt-[0.14em] h-[0.86em] w-[0.86em] shrink-0 text-[var(--color-warning)]" />
                <p className="text-[0.79em] leading-relaxed text-[var(--text-muted)]">
                  {t('updateFailed')}
                </p>
              </div>

              <div className="mt-[1.43em] flex gap-[0.71em]">
                <button
                  onClick={handleClose}
                  className="flex-1 rounded-[0.71em] border border-[var(--border-default)] bg-[var(--bg-card)] px-[1em] py-[0.64em] text-[0.86em] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
                >
                  {t('close')}
                </button>
                <button
                  onClick={handleRetry}
                  className="flex flex-1 items-center justify-center gap-[0.43em] rounded-[0.71em] bg-[var(--brand-green)] px-[1em] py-[0.64em] text-[0.86em] font-semibold text-white transition-colors hover:bg-[var(--brand-green-hover)]"
                >
                  <RefreshCw className="h-[0.86em] w-[0.86em]" />
                  {t('retry')}
                </button>
              </div>
            </>
          )}

          {/* 正在检查 */}
          {status === 'checking' && (
            <div className="flex items-center gap-[0.86em] py-[1.43em]">
              <div className="flex h-[2.29em] w-[2.29em] shrink-0 items-center justify-center rounded-[0.71em] bg-[var(--brand-green-10)]">
                <RefreshCw className="h-[1.14em] w-[1.14em] animate-spin text-[var(--brand-green)]" />
              </div>
              <p className="text-[0.86em] text-[var(--text-muted)]">{t('checkingUpdates')}</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
      )}

      <PortableUpdateDialog
        isOpen={portableDialogOpen}
        latestVersion={portableLatestVersion}
        currentVersion={currentVersion || '...'}
        isChecking={isCheckingPortableVersion}
        checkFailed={portableCheckFailed}
        netDiskUrl={downloadConfig.netDiskUrl}
        officialWebsiteUrl={LIGHTC_OFFICIAL_WEBSITE_URL}
        onOpenChannel={handleOpenPortableChannel}
        onClose={() => setPortableDialogOpen(false)}
      />
    </>
  );
}
