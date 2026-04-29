// ============================================================================
// 更新提示模态框组件
// 启动时自动检查更新，发现新版本时弹出精致的更新提示
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, RefreshCw, CheckCircle, AlertCircle, Sparkles, FileText, AlertTriangle } from 'lucide-react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { useToast } from './Toast';

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

function getErrorMessage(error: unknown): string {
  const errorStr = error instanceof Error ? error.message : String(error);
  
  // 网络相关错误
  if (errorStr.includes('network') || errorStr.includes('fetch') || errorStr.includes('connect')) {
    return '网络连接失败，请检查网络后重试';
  }
  
  // 签名验证错误
  if (errorStr.includes('signature') || errorStr.includes('pubkey') || errorStr.includes('verify')) {
    return '更新包签名验证失败，请从官方渠道下载';
  }
  
  // 超时错误
  if (errorStr.includes('timeout') || errorStr.includes('timed out')) {
    return '连接超时，请稍后重试';
  }
  
  // 404 错误
  if (errorStr.includes('404') || errorStr.includes('not found')) {
    return '未找到更新信息，请稍后重试';
  }
  
  // JSON 解析错误
  if (errorStr.includes('JSON') || errorStr.includes('parse')) {
    return '更新信息格式错误，请联系开发者';
  }
  
  // 权限错误
  if (errorStr.includes('permission') || errorStr.includes('access denied')) {
    return '没有写入权限，请以管理员身份运行';
  }
  
  // 磁盘空间错误
  if (errorStr.includes('disk') || errorStr.includes('space') || errorStr.includes('storage')) {
    return '磁盘空间不足，请清理后重试';
  }
  
  return errorStr || '未知错误';
}

// ============================================================================
// 更新模态框组件
// ============================================================================

export function UpdateModal({ autoCheck = true }: UpdateModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState<UpdateStatus>('checking');
  const [update, setUpdate] = useState<Update | null>(null);
  const [currentVersion, setCurrentVersion] = useState('');
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [isVisible, setIsVisible] = useState(false);
  const { showToast } = useToast();
  const sourceRef = useRef<'auto' | 'manual'>('auto');

  // 获取当前版本
  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => setCurrentVersion('未知'));
  }, []);

  // 检查更新（source: 'auto' 启动自动检查 / 'manual' 用户手动触发）
  const checkForUpdate = useCallback(async (source: 'auto' | 'manual' = 'auto') => {
    sourceRef.current = source;
    setStatus('checking');
    setErrorMessage('');

    // 手动触发时立即打开弹窗显示 loading，给用户即时反馈
    if (source === 'manual') {
      setIsOpen(true);
      requestAnimationFrame(() => setIsVisible(true));
    }

    try {
      const updateResult = await check();

      if (updateResult) {
        setUpdate(updateResult);
        setStatus('available');
        // auto 模式下需要打开弹窗；manual 模式弹窗已打开，仅切换状态
        if (source === 'auto') {
          setIsOpen(true);
          requestAnimationFrame(() => setIsVisible(true));
        }
      } else if (source === 'manual') {
        // 已是最新版本：关闭弹窗 + toast 提示
        setIsVisible(false);
        setTimeout(() => setIsOpen(false), 200);
        showToast({
          type: 'success',
          title: '已是最新版本',
          description: `当前版本 v${currentVersion} 已是最新`,
        });
      }
      // auto 模式无更新：静默（不弹窗）
    } catch (error) {
      console.error('检查更新失败:', error);
      setErrorMessage(getErrorMessage(error));
      setStatus('error');
      // manual 模式弹窗已打开，仅切换为错误状态；auto 模式需要打开弹窗
      if (source === 'auto') {
        setIsOpen(true);
        requestAnimationFrame(() => setIsVisible(true));
      }
    }
  }, [autoCheck, currentVersion, showToast]);

  // 启动时自动检查
  useEffect(() => {
    if (autoCheck) {
      const timer = setTimeout(() => checkForUpdate('auto'), 2000);
      return () => clearTimeout(timer);
    }
  }, [autoCheck, checkForUpdate]);

  // 监听手动触发事件（来自 SettingsModal 的"检查更新"按钮）
  useEffect(() => {
    const handler = () => checkForUpdate('manual');
    window.addEventListener('lightc:check-update', handler);
    return () => window.removeEventListener('lightc:check-update', handler);
  }, [checkForUpdate]);

  // 下载并安装更新
  const handleDownloadAndInstall = async () => {
    if (!update) return;
    
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
      setErrorMessage(getErrorMessage(error));
      setStatus('error');
    }
  };

  // 重启应用
  const handleRelaunch = async () => {
    try {
      await relaunch();
    } catch (error) {
      console.error('重启失败:', error);
      setErrorMessage('重启失败，请手动重启应用');
      setStatus('error');
    }
  };

  // 关闭模态框
  const handleClose = () => {
    setIsVisible(false);
    setTimeout(() => setIsOpen(false), 200);
  };

  // 重试（沿用上次的触发来源）
  const handleRetry = () => {
    checkForUpdate(sourceRef.current);
  };

  if (!isOpen) return null;

  return createPortal(
    <div className={`fixed inset-0 z-[10000] flex items-center justify-center transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}>
      {/* 遮罩 */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={status !== 'downloading' ? handleClose : undefined}
      />
      
      {/* 模态框内容 */}
      <div className={`relative w-[420px] bg-[var(--bg-card)] rounded-2xl shadow-2xl overflow-hidden transition-all duration-200 ${isVisible ? 'scale-100 opacity-100' : 'scale-95 opacity-0'}`}>
        {/* 顶部装饰条 */}
        <div className="h-1.5 bg-gradient-to-r from-[var(--brand-green)] via-emerald-400 to-teal-400" />
        
        {/* 关闭按钮 */}
        {status !== 'downloading' && (
          <button
            onClick={handleClose}
            className="absolute top-4 right-4 p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors z-10"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* 内容区域 */}
        <div className="p-6">
          {/* 有新版本可用 */}
          {status === 'available' && update && (
            <>
              {/* 标题 */}
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[var(--brand-green)] to-emerald-500 flex items-center justify-center shadow-lg">
                  <Sparkles className="w-6 h-6 text-white" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[var(--text-primary)]">发现新版本</h2>
                  <p className="text-sm text-[var(--text-muted)]">
                    v{currentVersion} → v{update.version}
                  </p>
                </div>
              </div>

              {/* 更新说明 */}
              <div className="mb-5">
                <div className="flex items-center gap-2 mb-2">
                  <FileText className="w-4 h-4 text-[var(--text-muted)]" />
                  <span className="text-sm font-medium text-[var(--text-primary)]">更新内容</span>
                </div>
                <div className="bg-[var(--bg-main)] rounded-xl p-4 max-h-48 overflow-auto">
                  <div className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
                    {update.body || '• 性能优化和问题修复'}
                  </div>
                </div>
              </div>

              {/* 操作按钮 */}
              <div className="flex gap-3">
                <button
                  onClick={handleClose}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] bg-[var(--bg-main)] rounded-xl hover:bg-[var(--bg-hover)] transition-colors"
                >
                  稍后提醒
                </button>
                <button
                  onClick={handleDownloadAndInstall}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-[var(--brand-green)] rounded-xl hover:bg-[var(--brand-green-hover)] transition-colors shadow-lg shadow-[var(--brand-green)]/20"
                >
                  <Download className="w-4 h-4" />
                  立即更新
                </button>
              </div>
            </>
          )}

          {/* 正在下载 */}
          {status === 'downloading' && (
            <div className="text-center py-4">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-[var(--brand-green)]/10 flex items-center justify-center">
                <RefreshCw className="w-8 h-8 text-[var(--brand-green)] animate-spin" />
              </div>
              <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">正在下载更新</h2>
              <p className="text-sm text-[var(--text-muted)] mb-4">请勿关闭应用...</p>
              
              {/* 进度条 */}
              <div className="w-full h-2 bg-[var(--bg-main)] rounded-full overflow-hidden mb-2">
                <div 
                  className="h-full bg-gradient-to-r from-[var(--brand-green)] to-emerald-400 transition-all duration-300"
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>
              <p className="text-sm font-medium text-[var(--brand-green)]">
                {downloadProgress.toFixed(0)}%
              </p>
            </div>
          )}

          {/* 下载完成，准备安装 */}
          {status === 'ready' && (
            <div className="text-center py-4">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-[var(--brand-green)]/10 flex items-center justify-center">
                <CheckCircle className="w-8 h-8 text-[var(--brand-green)]" />
              </div>
              <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">更新已就绪</h2>
              <p className="text-sm text-[var(--text-muted)] mb-5">重启应用以完成更新</p>
              
              <div className="flex gap-3">
                <button
                  onClick={handleClose}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] bg-[var(--bg-main)] rounded-xl hover:bg-[var(--bg-hover)] transition-colors"
                >
                  稍后重启
                </button>
                <button
                  onClick={handleRelaunch}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-[var(--brand-green)] rounded-xl hover:bg-[var(--brand-green-hover)] transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  立即重启
                </button>
              </div>
            </div>
          )}

          {/* 错误状态 */}
          {status === 'error' && (
            <div className="text-center py-4">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-[var(--color-danger)]/10 flex items-center justify-center">
                <AlertCircle className="w-8 h-8 text-[var(--color-danger)]" />
              </div>
              <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">更新失败</h2>
              <p className="text-sm text-[var(--color-danger)] mb-5 px-4">{errorMessage}</p>
              
              {/* 错误提示 */}
              <div className="bg-[var(--color-warning)]/10 rounded-xl p-3 mb-5 text-left">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-[var(--color-warning)] mt-0.5 shrink-0" />
                  <p className="text-xs text-[var(--text-muted)]">
                    如果问题持续存在，请访问 GitHub 或 作者分享的其他下载渠道手动下载最新版本
                  </p>
                </div>
              </div>
              
              <div className="flex gap-3">
                <button
                  onClick={handleClose}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] bg-[var(--bg-main)] rounded-xl hover:bg-[var(--bg-hover)] transition-colors"
                >
                  关闭
                </button>
                <button
                  onClick={handleRetry}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-[var(--brand-green)] rounded-xl hover:bg-[var(--brand-green-hover)] transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  重试
                </button>
              </div>
            </div>
          )}

          {/* 正在检查 */}
          {status === 'checking' && (
            <div className="text-center py-8">
              <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-[var(--brand-green)]/10 flex items-center justify-center">
                <RefreshCw className="w-6 h-6 text-[var(--brand-green)] animate-spin" />
              </div>
              <p className="text-sm text-[var(--text-muted)]">正在检查更新...</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
