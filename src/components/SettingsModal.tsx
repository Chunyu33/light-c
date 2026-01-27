// ============================================================================
// 设置弹窗组件 - 仿微信设置布局
// ============================================================================

import { useState, useEffect } from 'react';
import { X, Settings, MessageSquare, Info, Sun, Moon, Monitor, ExternalLink, RefreshCw, Download, CheckCircle, AlertCircle } from 'lucide-react';
import { useTheme, type ThemeMode } from '../contexts';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';

type SettingsTab = 'general' | 'feedback' | 'about';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const tabs: { id: SettingsTab; label: string; icon: typeof Settings }[] = [
  { id: 'general', label: '通用', icon: Settings },
  { id: 'feedback', label: '意见反馈', icon: MessageSquare },
  { id: 'about', label: '关于', icon: Info },
];

const themeOptions: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'light', label: '浅色模式', icon: Sun },
  { mode: 'dark', label: '深色模式', icon: Moon },
  { mode: 'system', label: '跟随系统', icon: Monitor },
];

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const { mode, setMode } = useTheme();
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsAnimating(true);
      // 延迟一帧以触发动画
      requestAnimationFrame(() => {
        setIsVisible(true);
      });
    } else {
      setIsVisible(false);
      // 等待动画结束后再隐藏
      const timer = setTimeout(() => {
        setIsAnimating(false);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!isOpen && !isAnimating) return null;

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}>
      {/* 遮罩 */}
      <div 
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* 弹窗内容 */}
      <div className={`relative w-[600px] h-[450px] bg-[var(--bg-elevated)] rounded-xl shadow-2xl border border-[var(--border-default)] flex overflow-hidden transition-all duration-200 ${isVisible ? 'scale-100 opacity-100' : 'scale-95 opacity-0'}`}>
        {/* 左侧导航 */}
        <div className="w-[160px] bg-[var(--bg-base)] border-r border-[var(--border-default)] py-4">
          <div className="px-4 mb-4">
            <h2 className="text-sm font-semibold text-[var(--fg-primary)]">设置</h2>
          </div>
          <nav className="space-y-1 px-2">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  activeTab === id
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium'
                    : 'text-[var(--fg-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* 右侧内容 */}
        <div className="flex-1 flex flex-col">
          {/* 标题栏 */}
          <div className="h-12 flex items-center justify-between px-4 border-b border-[var(--border-default)]">
            <h3 className="text-sm font-medium text-[var(--fg-primary)]">
              {tabs.find(t => t.id === activeTab)?.label}
            </h3>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-[var(--fg-muted)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 内容区 */}
          <div className="flex-1 overflow-auto p-4">
            {activeTab === 'general' && (
              <GeneralSettings mode={mode} setMode={setMode} />
            )}
            {activeTab === 'feedback' && <FeedbackSettings />}
            {activeTab === 'about' && <AboutSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

// 通用设置
function GeneralSettings({ mode, setMode }: { mode: ThemeMode; setMode: (mode: ThemeMode) => void }) {
  return (
    <div className="space-y-6">
      {/* 外观设置 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--fg-muted)] uppercase tracking-wider">外观</h4>
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--fg-primary)]">主题模式</p>
              <p className="text-xs text-[var(--fg-muted)] mt-0.5">选择应用的外观主题</p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-[var(--bg-base)] rounded-lg border border-[var(--border-default)]">
              {themeOptions.map(({ mode: m, label, icon: Icon }) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  title={label}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    mode === m
                      ? 'bg-emerald-500 text-white shadow-sm'
                      : 'text-[var(--fg-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// 意见反馈
function FeedbackSettings() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--fg-muted)] uppercase tracking-wider">联系我</h4>
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-4 space-y-4">
          <div>
            <p className="text-sm font-medium text-[var(--fg-primary)]">问题反馈</p>
            <p className="text-xs text-[var(--fg-muted)] mt-1">
              如果您在使用过程中遇到任何问题或有改进建议，欢迎通过以下方式联系我：
            </p>
          </div>
          
          <div className="space-y-2">
            <a
              href="https://github.com/Chunyu33/light-c/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-base)] hover:bg-[var(--bg-hover)] transition-colors group"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-gray-800 flex items-center justify-center">
                  <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-[var(--fg-primary)]">GitHub Issues</p>
                  <p className="text-xs text-[var(--fg-muted)]">在 GitHub 上提交问题</p>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-[var(--fg-faint)] group-hover:text-[var(--fg-muted)]" />
            </a>

            <a
              href="mailto:liucygm33@gmail.com"
              className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-base)] hover:bg-[var(--bg-hover)] transition-colors group"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center">
                  <MessageSquare className="w-4 h-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-medium text-[var(--fg-primary)]">邮件反馈</p>
                  <p className="text-xs text-[var(--fg-muted)]">liucygm33@gmail.com</p>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-[var(--fg-faint)] group-hover:text-[var(--fg-muted)]" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'latest' | 'error';

// 关于
function AboutSettings() {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updateInfo, setUpdateInfo] = useState<{ version: string; notes: string } | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [appVersion, setAppVersion] = useState('');

  // 获取应用版本号
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion('未知'));
  }, []);

  const checkForUpdates = async () => {
    setUpdateStatus('checking');
    setErrorMessage('');
    
    try {
      const update = await check();
      
      if (update) {
        setUpdateInfo({
          version: update.version,
          notes: update.body || '无更新说明',
        });
        setUpdateStatus('available');
      } else {
        setUpdateStatus('latest');
      }
    } catch (error) {
      console.error('检查更新失败:', error);
      setErrorMessage(error instanceof Error ? error.message : '检查更新失败');
      setUpdateStatus('error');
    }
  };

  const downloadAndInstall = async () => {
    setUpdateStatus('downloading');
    setDownloadProgress(0);
    
    try {
      const update = await check();
      
      if (update) {
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
        
        setUpdateStatus('ready');
      }
    } catch (error) {
      console.error('下载更新失败:', error);
      setErrorMessage(error instanceof Error ? error.message : '下载更新失败');
      setUpdateStatus('error');
    }
  };

  const handleRelaunch = async () => {
    await relaunch();
  };

  return (
    <div className="space-y-6">
      {/* 检查更新 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--fg-muted)] uppercase tracking-wider">检查更新</h4>
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {updateStatus === 'checking' && (
                <RefreshCw className="w-5 h-5 text-emerald-500 animate-spin" />
              )}
              {updateStatus === 'idle' && (
                <Download className="w-5 h-5 text-[var(--fg-muted)]" />
              )}
              {updateStatus === 'latest' && (
                <CheckCircle className="w-5 h-5 text-emerald-500" />
              )}
              {updateStatus === 'available' && (
                <Download className="w-5 h-5 text-amber-500" />
              )}
              {updateStatus === 'downloading' && (
                <RefreshCw className="w-5 h-5 text-emerald-500 animate-spin" />
              )}
              {updateStatus === 'ready' && (
                <CheckCircle className="w-5 h-5 text-emerald-500" />
              )}
              {updateStatus === 'error' && (
                <AlertCircle className="w-5 h-5 text-red-500" />
              )}
              <div>
                <p className="text-sm font-medium text-[var(--fg-primary)]">
                  {updateStatus === 'idle' && '检查更新'}
                  {updateStatus === 'checking' && '正在检查...'}
                  {updateStatus === 'latest' && '已是最新版本'}
                  {updateStatus === 'available' && `发现新版本: v${updateInfo?.version}`}
                  {updateStatus === 'downloading' && `正在下载... ${downloadProgress.toFixed(0)}%`}
                  {updateStatus === 'ready' && '更新已就绪'}
                  {updateStatus === 'error' && '检查失败'}
                </p>
                <p className="text-xs text-[var(--fg-muted)]">
                  {updateStatus === 'idle' && '点击检查是否有新版本可用'}
                  {updateStatus === 'checking' && '正在连接更新服务器...'}
                  {updateStatus === 'latest' && '您的应用已是最新版本'}
                  {updateStatus === 'available' && '点击下载并安装更新'}
                  {updateStatus === 'downloading' && '请勿关闭应用...'}
                  {updateStatus === 'ready' && '点击重启应用以完成更新'}
                  {updateStatus === 'error' && errorMessage}
                </p>
              </div>
            </div>
            <div>
              {(updateStatus === 'idle' || updateStatus === 'latest' || updateStatus === 'error') && (
                <button
                  onClick={checkForUpdates}
                  className="px-3 py-1.5 text-xs font-medium bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors"
                >
                  检查更新
                </button>
              )}
              {updateStatus === 'available' && (
                <button
                  onClick={downloadAndInstall}
                  className="px-3 py-1.5 text-xs font-medium bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors"
                >
                  下载更新
                </button>
              )}
              {updateStatus === 'ready' && (
                <button
                  onClick={handleRelaunch}
                  className="px-3 py-1.5 text-xs font-medium bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors"
                >
                  重启应用
                </button>
              )}
            </div>
          </div>
          {updateStatus === 'downloading' && (
            <div className="mt-3">
              <div className="h-1.5 bg-[var(--bg-base)] rounded-full overflow-hidden">
                <div 
                  className="h-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--fg-muted)] uppercase tracking-wider">应用信息</h4>
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-4">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg">
              <span className="text-2xl font-bold text-white">C:</span>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-[var(--fg-primary)]">LightC</h3>
              <p className="text-sm text-[var(--fg-muted)]">Windows C盘智能清理工具</p>
              <p className="text-xs text-[var(--fg-faint)] mt-1">版本 {appVersion || '...'}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--fg-muted)] uppercase tracking-wider">为什么叫LightC</h4>
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-4">
          <p className="text-sm text-[var(--fg-secondary)] leading-relaxed">
            <span className="font-medium text-emerald-500">Light</span> 代表轻量、轻快，寓意让您的C盘变得轻盈；
            <span className="font-medium text-emerald-500">C</span> 即C盘，Windows系统的核心磁盘。
            LightC 致力于帮助您安全、高效地清理C盘垃圾文件，释放宝贵的磁盘空间，让系统运行更加流畅。
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--fg-muted)] uppercase tracking-wider">开发者</h4>
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--fg-secondary)]">作者</span>
            <span className="text-sm font-medium text-[var(--fg-primary)]">Evan Lau</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--fg-secondary)]">网站</span>
            <a 
              href="https://evanspace.icu" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-sm font-medium text-emerald-500 hover:text-emerald-600 flex items-center gap-1"
            >
              evanspace.icu
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--fg-secondary)]">开源地址</span>
            <a 
              href="https://github.com/Chunyu33/light-c" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-sm font-medium text-emerald-500 hover:text-emerald-600 flex items-center gap-1"
            >
              GitHub
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>

      <div className="text-center pt-4">
        <p className="text-xs text-[var(--fg-faint)]">
          Copyright © 2025 Chunyu. All rights reserved.
        </p>
      </div>
    </div>
  );
}
