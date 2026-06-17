// ============================================================================
// 设置弹窗组件
// ============================================================================

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Settings, MessageSquare, Info, Sun, Moon, Monitor, ExternalLink, RefreshCw, CheckCircle, BookOpen, Shield, AlertTriangle, Cpu, HardDrive, Monitor as MonitorIcon, User, Clock, Zap, FileBox, MessageCircle, Layers, Package, Database, Code2, FolderOpen, History, ChevronRight, MonitorCog, Coffee, Copy, MousePointerClick, ShieldCheck, Rocket, HelpCircle, ClipboardList, ShieldAlert, Navigation, Trash2, SlidersHorizontal, Download } from 'lucide-react';
import { Select, type SelectOption } from './ui/Select';

// 赞赏码图片
import wechatQr from '../assets/r_wechat_qr.jpg';
import alipayQr from '../assets/r_alipay_qr.jpg';
import binlockxIcon from '../assets/binlockx.svg';
import viapIcon from '../assets/viap.svg';
import { useTheme, type ThemeMode, useFontSize, FONT_SIZE_CONFIGS, type FontSizeLevel, useSettings } from '../contexts';
import { useToast } from './Toast';
import { Type } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { getSystemInfo, type SystemInfo, openLogsFolder, openStartupManager, openStorageSettings, getDataDirectory, setDataDirectory, clearLocalData, pickFolderDialog, openInFolder } from '../api/commands';
import { formatSize } from '../utils/format';

type SettingsTab = 'general' | 'features' | 'guide' | 'feedback' | 'about';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const tabs: { id: SettingsTab; label: string; icon: typeof Settings }[] = [
  { id: 'general', label: '通用', icon: Settings },
  { id: 'features', label: '功能设置', icon: SlidersHorizontal },
  { id: 'guide', label: '使用说明', icon: BookOpen },
  { id: 'feedback', label: '意见反馈', icon: MessageSquare },
  { id: 'about', label: '关于', icon: Info },
];

const themeOptions: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'light', label: '浅色模式', icon: Sun },
  { mode: 'dark', label: '深色模式', icon: Moon },
  { mode: 'system', label: '跟随系统', icon: Monitor },
];

const fontSizeOptions: { level: FontSizeLevel; label: string }[] = [
  { level: 'standard', label: '标准' },
  { level: 'medium', label: '适中' },
  { level: 'large', label: '较大' },
];

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const { mode, setMode } = useTheme();
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  // 记录是否曾经进入「可见」状态，用于区分「初次挂载预隐藏」和「正在关闭」
  const enteredRef = useRef(false);
  if (isVisible) enteredRef.current = true;

  useEffect(() => {
    if (isOpen) {
      setIsAnimating(true);
      setIsVisible(true);
    } else {
      setIsVisible(false);
      // 等待弹出动画结束（185ms）后卸载 DOM
      const timer = setTimeout(() => {
        setIsAnimating(false);
      }, 190);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!isOpen && !isAnimating) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* 遮罩 */}
      <div
        className={`absolute inset-0 bg-black/40 backdrop-blur-sm ${isVisible ? 'modal-overlay-in' : enteredRef.current ? 'modal-overlay-out' : 'opacity-0'}`}
        onClick={onClose}
      />

      {/* 弹窗内容 - 微信风格卡片布局 */}
      <div className={`relative w-[600px] min-h-[450px] max-h-[80vh] bg-[var(--bg-card)] rounded-2xl shadow-2xl flex overflow-hidden ${isVisible ? 'modal-content-in' : enteredRef.current ? 'modal-content-out' : 'opacity-0'}`}>
        {/* 左侧导航 - 使用主背景色 */}
        {/* === 🐛 核心修复点：添加 shrink-0，禁止菜单缩小以适应右侧的长代码块 === */}
        <div className="w-[160px] shrink-0 bg-[var(--bg-main)] border-r border-[var(--border-color)] py-4">
          <div className="px-4 mb-4">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">设置</h2>
          </div>
          <nav className="space-y-1 px-2">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${activeTab === id
                    ? 'bg-[var(--brand-green-10)] text-[var(--brand-green)] font-medium'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="whitespace-nowrap">{label}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* 右侧内容 - 卡片背景 */}
        <div className="flex-1 flex flex-col bg-[var(--bg-card)]">
          {/* 标题栏 */}
          <div className="min-h-12 flex items-center justify-between px-5 border-b border-[var(--border-color)]">
            <h3 className="text-sm font-medium text-[var(--text-primary)]">
              {tabs.find(t => t.id === activeTab)?.label}
            </h3>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 内容区 - 增加内边距 */}
          <div className="flex-1 overflow-auto p-5">
            {activeTab === 'general' && (
              <GeneralSettings mode={mode} setMode={setMode} />
            )}
            {activeTab === 'features' && <FeatureSettings />}
            {activeTab === 'guide' && <GuideSettings />}
            {activeTab === 'feedback' && <FeedbackSettings />}
            {activeTab === 'about' && <AboutSettings />}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// 通用设置 - 微信风格主题切换器
function GeneralSettings({ mode, setMode }: { mode: ThemeMode; setMode: (mode: ThemeMode) => void }) {
  const { level: fontSizeLevel, setLevel: setFontSizeLevel } = useFontSize();
  const { settings, updateSettings } = useSettings();
  const { showToast } = useToast();
  const [dataDir, setDataDir] = useState('');
  const [isChangingDir, setIsChangingDir] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  // 加载当前数据目录
  useEffect(() => {
    getDataDirectory().then(setDataDir).catch(() => setDataDir('未知'));
  }, []);

  const handleOpenLogsFolder = async () => {
    try {
      await openLogsFolder();
    } catch (error) {
      console.error('打开日志文件夹失败:', error);
    }
  };

  // 更改数据目录
  const handleChangeDataDir = async () => {
    try {
      setIsChangingDir(true);
      const folder = await pickFolderDialog();
      if (!folder) { setIsChangingDir(false); return; }
      const msg = await setDataDirectory(folder);
      setDataDir(folder);
      console.log(msg);
    } catch (error) {
      console.error('更改数据目录失败:', error);
    } finally {
      setIsChangingDir(false);
    }
  };

  // 清空本地数据
  const handleClearData = async () => {
    if (!window.confirm('确定要清空所有本地数据吗？\n\n这将删除：\n• 安装历史缓存\n• 所有清理日志记录\n\n此操作不可撤销。')) return;
    try {
      setIsClearing(true);
      const [fileCount, freedBytes] = await clearLocalData();
      showToast({
        type: 'success',
        title: '数据已清空',
        description: `已删除 ${fileCount} 个文件，释放 ${formatSize(freedBytes)}`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '清空失败',
        description: String(error),
      });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 常规设置 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <MonitorCog className="w-3.5 h-3.5" />
          常规设置
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-5">
          {/* 主题模式 */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">主题模式</p>
              <p className="text-xs text-[var(--text-muted)] mt-1">选择应用的外观主题</p>
            </div>
            {/* 分段控制器 - 仅显示图标 */}
            <div className="flex items-center gap-1 p-1 bg-[var(--bg-card)] rounded-xl border border-[var(--border-color)]">
              {themeOptions.map(({ mode: m, label, icon: Icon }) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  title={label}
                  className={`flex items-center justify-center p-2 rounded-lg transition-all duration-200 ${mode === m
                      ? 'bg-[var(--brand-green)] text-white'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                    }`}
                >
                  <Icon className="w-4 h-4" />
                </button>
              ))}
            </div>
          </div>

          {/* 字体大小 */}
          <div className="flex items-center justify-between pt-4 border-t border-[var(--border-color)]">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                <Type className="w-4 h-4 text-[var(--text-muted)]" />
                字体大小
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-1">调整应用内文字大小</p>
            </div>
            {/* 字号分段控制器 */}
            <div className="flex items-center gap-1 p-1 bg-[var(--bg-card)] rounded-xl border border-[var(--border-color)]">
              {fontSizeOptions.map(({ level, label }) => (
                <button
                  key={level}
                  onClick={() => setFontSizeLevel(level)}
                  title={`${label} (+${FONT_SIZE_CONFIGS[level].offset}px)`}
                  className={`px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200 ${fontSizeLevel === level
                      ? 'bg-[var(--brand-green)] text-white'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                    }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 锚点导航开关 */}
          <div className="flex items-center justify-between pt-4 border-t border-[var(--border-color)]">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                <Navigation className="w-4 h-4 text-[var(--text-muted)]" />
                锚点导航
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-1">在页面左侧显示悬浮导航，快速定位功能模块</p>
            </div>
            {/* Switch 开关 */}
            <button
              onClick={() => updateSettings({ showAnchorNav: !settings.showAnchorNav })}
              className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                settings.showAnchorNav ? 'bg-[var(--brand-green)]' : 'bg-[var(--bg-switch)]'
              }`}
            >
              <span
                className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-300 ${
                  settings.showAnchorNav ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* 数据管理 */}
      <div className="space-y-3 pt-2 border-t border-[var(--border-color)]">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <History className="w-3.5 h-3.5" />
          数据管理
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl divide-y divide-[var(--border-color)]">
          {/* 当前数据目录 */}
          <div className="p-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-[var(--text-muted)]">存储位置</span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-[var(--text-faint)] max-w-[250px] truncate" title={dataDir}>
                  {dataDir || '加载中...'}
                </span>
                <button
                  onClick={() => openInFolder(dataDir).catch(console.error)}
                  className="text-[10px] text-[var(--brand-green)] hover:opacity-80 transition shrink-0"
                >
                  前往
                </button>
              </div>
            </div>
          </div>
          {/* 更改数据目录 */}
          <button
            onClick={handleChangeDataDir}
            disabled={isChangingDir}
            className="w-full flex items-center justify-between p-4 hover:bg-[var(--bg-hover)] transition-colors group disabled:opacity-50"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[var(--brand-green-10)] flex items-center justify-center">
                {isChangingDir ? (
                  <RefreshCw className="w-4.5 h-4.5 text-[var(--brand-green)] animate-spin" />
                ) : (
                  <FolderOpen className="w-4.5 h-4.5 text-[var(--brand-green)]" />
                )}
              </div>
              <div className="text-left">
                <p className="text-sm font-medium text-[var(--text-primary)]">更改数据目录</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">选择存储清理日志和缓存数据的位置，已有数据将自动迁移</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors" />
          </button>
          {/* 打开日志文件夹 */}
          <button
            onClick={handleOpenLogsFolder}
            className="w-full flex items-center justify-between p-4 hover:bg-[var(--bg-hover)] transition-colors group"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[var(--brand-green-10)] flex items-center justify-center">
                <History className="w-4.5 h-4.5 text-[var(--brand-green)]" />
              </div>
              <div className="text-left">
                <p className="text-sm font-medium text-[var(--text-primary)]">查看清理日志</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">查看历史清理记录与详细文件清单</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors" />
          </button>
          {/* 清空本地数据 */}
          <button
            onClick={handleClearData}
            disabled={isClearing}
            className="w-full flex items-center justify-between p-4 hover:bg-[var(--bg-hover)] rounded-b-2xl transition-colors group disabled:opacity-50"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[var(--color-danger)]/10 flex items-center justify-center">
                {isClearing ? (
                  <RefreshCw className="w-4.5 h-4.5 text-[var(--color-danger)] animate-spin" />
                ) : (
                  <Trash2 className="w-4.5 h-4.5 text-[var(--color-danger)]" />
                )}
              </div>
              <div className="text-left">
                <p className="text-sm font-medium text-[var(--text-primary)]">清空本地数据</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">删除安装历史缓存与所有清理日志记录</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors" />
          </button>
        </div>
      </div>

      {/* 系统快捷工具 */}
      <div className="space-y-3 pt-2 border-t border-[var(--border-color)]">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Rocket className="w-3.5 h-3.5" />
          系统快捷工具
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl divide-y divide-[var(--border-color)]">
          {/* 开机启动管理 */}
          <button
            onClick={() => openStartupManager().catch(console.error)}
            className="w-full flex items-center justify-between p-4 hover:bg-[var(--bg-hover)] first:rounded-t-2xl transition-colors group"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[var(--brand-green-10)] flex items-center justify-center">
                <Rocket className="w-4.5 h-4.5 text-[var(--brand-green)]" />
              </div>
              <div className="text-left">
                <p className="text-sm font-medium text-[var(--text-primary)]">开机启动管理</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">打开任务管理器，禁用不必要的自启动软件</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors" />
          </button>
          {/* 存储感知 */}
          <button
            onClick={() => openStorageSettings().catch(console.error)}
            className="w-full flex items-center justify-between p-4 hover:bg-[var(--bg-hover)] last:rounded-b-2xl transition-colors group"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[var(--brand-green-10)] flex items-center justify-center">
                <HardDrive className="w-4.5 h-4.5 text-[var(--brand-green)]" />
              </div>
              <div className="text-left">
                <p className="text-sm font-medium text-[var(--text-primary)]">存储感知</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">调用 Windows 原生的磁盘清理与空间管理</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 功能设置 - 扫描参数配置（独立一级菜单）
// ============================================================================

const DEPTH_OPTIONS: SelectOption<string>[] = [
  { value: '2', label: '2 层' },
  { value: '3', label: '3 层' },
  { value: '4', label: '4 层' },
];

const HOTSPOT_SIZE_OPTIONS = [10, 50, 100, 200, 500];
const DISK_GROWTH_MAX_ENTRY_OPTIONS = [50, 100, 200, 300, 500, 1000];

function FeatureSettings() {
  const { settings, updateSettings } = useSettings();

  return (
    <div className="flex flex-col w-0 min-w-full space-y-4 pb-2">
      {/* 大目录分析 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <HardDrive className="w-3.5 h-3.5" />
          大目录分析
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-6">
          {/* 展示深度 — 下拉选择，最大 4 层（实际扫描固定 6 层） */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">展示深度</p>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                结果列表中展示的目录层数
              </p>
            </div>
            <Select
              value={String(settings.hotspotDepth)}
              options={DEPTH_OPTIONS}
              onChange={(v) => updateSettings({ hotspotDepth: Number(v) })}
              widthClass="w-24"
            />
          </div>

          {/* 大小阈值 */}
          <div className="pt-4 border-t border-[var(--border-color)]">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">最低展示大小</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  低于此大小的目录不参与扫描（减少噪音）
                </p>
              </div>
              <span className="text-sm font-semibold text-[var(--brand-green)] min-w-[3rem] text-right">
                {settings.hotspotSizeThreshold} MB
              </span>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {HOTSPOT_SIZE_OPTIONS.map((n) => (
                <button
                  key={n}
                  onClick={() => updateSettings({ hotspotSizeThreshold: n })}
                  className={`h-8 rounded-lg text-xs font-medium border transition-colors ${
                    settings.hotspotSizeThreshold === n
                      ? 'bg-[var(--brand-green)] text-white border-[var(--brand-green)]'
                      : 'bg-[var(--bg-card)] text-[var(--text-muted)] border-[var(--border-color)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  {n}MB
                </button>
              ))}
            </div>
          </div>

          {/* 深度扫描忽略系统目录 */}
          <div className="pt-4 border-t border-[var(--border-color)]">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">深度扫描忽略系统目录</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  关闭后可发现藏在系统保护目录下的异常大文件（如日志爆满），但扫描时间将增加数倍
                </p>
              </div>
              <button
                onClick={() => updateSettings({ hotspotIgnoreSystemDirs: !settings.hotspotIgnoreSystemDirs })}
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ml-3 ${
                  settings.hotspotIgnoreSystemDirs ? 'bg-[var(--brand-green)]' : 'bg-[var(--bg-switch)]'
                }`}
              >
                <span
                  className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-300 ${
                    settings.hotspotIgnoreSystemDirs ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* 自动忽略的目录说明 */}
          <div className="pt-4 border-t border-[var(--border-color)]">
            <p className="text-sm font-medium text-[var(--text-primary)] mb-3 flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5" />
              自动忽略的目录
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed mb-2">
              以下目录扫描时自动跳过或标记为保护，不会出现在清理候选列表中：
            </p>
            <div className="space-y-1 text-[11px] text-[var(--text-muted)]">
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                C:\Windows — 系统核心目录，删除会导致系统崩溃
              </p>
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                Program Files / Program Files (x86) — 软件安装目录，仅查看不清理
              </p>
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                WinSxS / System32 / SysWOW64 — Windows 组件存储，由系统管理
              </p>
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />
                $Recycle.Bin / System Volume Information — 系统保留目录
              </p>
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />
                DriverStore / WindowsApps / assembly — 驱动和应用商店缓存
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* C 盘全盘分析 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <HardDrive className="w-3.5 h-3.5" />
          C 盘全盘分析
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">最多展示变化目录</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                限制与上次快照对比后返回的变化目录数量。数值越大，前端渲染和排序压力越高，建议保持 300 以内。
              </p>
            </div>
            <span className="text-sm font-semibold text-[var(--brand-green)] shrink-0">
              {settings.diskGrowthMaxEntries} 项
            </span>
          </div>
          <div className="grid grid-cols-6 gap-2">
            {DISK_GROWTH_MAX_ENTRY_OPTIONS.map((n) => (
              <button
                key={n}
                onClick={() => updateSettings({ diskGrowthMaxEntries: n })}
                className={`h-8 rounded-lg text-xs font-medium border transition-colors ${
                  settings.diskGrowthMaxEntries === n
                    ? 'bg-[var(--brand-green)] text-white border-[var(--brand-green)]'
                    : 'bg-[var(--bg-card)] text-[var(--text-muted)] border-[var(--border-color)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-[var(--text-faint)]">
            边界范围：50 - 1000 项。首次扫描或无变化时仍显示占用基线列表，不受此项影响。
          </p>
          <div className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-color)] p-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">变化明细</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                点击变化量可打开明细弹窗，左侧展示当前目录的下一级变化目录，右侧展示当前目录内变化文件。明细通过后端接口按需分页加载，每次最多 200 条，并使用虚拟列表渲染，避免大目录一次性渲染造成卡顿。
              </p>
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">颜色指标</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 mt-2 text-xs text-[var(--text-muted)]">
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                  蓝色：新增，上次快照不存在、本次出现
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                  红色：显著增长，增加 1GB 及以上
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
                  橙色：快速增长，增加 300MB 及以上
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                  黄色：轻微增长，增加 1B 及以上
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                  绿色：相比上次快照减少
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-gray-400 shrink-0" />
                  灰色：基本稳定，无明显变化
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// 使用说明 - 微信风格卡片
function GuideSettings() {
  return (
    <div className="space-y-6">
      {/* 功能说明 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <BookOpen className="w-3.5 h-3.5" />
          功能说明
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Zap className="w-4 h-4 text-[var(--brand-green)]" />
              一键扫描
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              扫描系统临时文件、浏览器缓存、Windows更新缓存等常见垃圾文件。扫描过程不会删除任何文件，您可以在扫描结果中选择需要清理的项目。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <FileBox className="w-4 h-4 text-[var(--brand-green)]" />
              大文件清理
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              扫描C盘中体积最大的50个文件。请仔细查看文件路径和类型，避免删除系统文件或重要数据。建议只删除您确认不再需要的文件。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-[var(--brand-green)]" />
              社交软件专清
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              支持<span className="font-medium">微信、QQ/NTQQ、钉钉、飞书、企业微信、Telegram</span>等主流社交软件。
              系统会<span className="text-[var(--brand-green)] font-medium">智能读取注册表</span>获取自定义存储路径，即使数据迁移到其他磁盘也能正确识别。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-1">
              <span className="text-[var(--brand-green)] font-medium">智能风险分级：</span>
              <span className="text-[var(--color-danger)]">聊天记录数据库</span>会被自动锁定禁止删除，
              <span className="text-[var(--color-warning)]">传输文件</span>需谨慎清理，
              <span className="text-[var(--brand-green)]">图片视频缓存</span>可安全清理。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Layers className="w-4 h-4 text-[var(--brand-green)]" />
              系统瘦身
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              管理休眠文件、Windows组件存储等系统级功能。<span className="text-[var(--color-warning)] font-medium">此功能需要管理员权限</span>，操作前请确保了解各项功能的作用。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Package className="w-4 h-4 text-[var(--brand-green)]" />
              卸载残留
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              基于<span className="text-[var(--brand-green)] font-medium">置信度评分引擎</span>（7项正向信号 + 7项负向信号），智能识别 AppData 和 ProgramData 中已卸载软件的残留文件夹。
              系统会自动读取注册表构建已安装应用映射，结合<span className="text-[var(--brand-green)] font-medium">安装历史缓存</span>检测"曾经安装现已卸载"的残留。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-1">
              <span className="text-[var(--brand-green)] font-medium">双重删除模式：</span>
              普通删除含可执行文件预检查（含 .exe/.dll/.sys 的文件夹自动跳过），
              深度清理执行完整的<span className="text-[var(--color-warning)] font-medium">安全检查协议</span>（白名单 + 可执行文件扫描），发现风险项标记为人工审核。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-1">
              <span className="text-[var(--color-danger)] font-medium">模拟器残留：</span>
              自动检测雷电、蓝叠、夜神、MuMu、MEmu 等7款安卓模拟器的卸载残留和虚拟磁盘文件（.vmdk/.vdi/.vhd）。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Database className="w-4 h-4 text-[var(--brand-green)]" />
              注册表冗余
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              扫描 Windows 注册表中的孤立键值和无效引用，包括 MUI 缓存、软件残留键等。
              <span className="text-[var(--color-warning)] font-medium">删除前会自动备份</span>，备份文件保存在用户文档目录下的 LightC_Backups 文件夹中。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <MousePointerClick className="w-4 h-4 text-[var(--brand-green)]" />
              右键菜单清理
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              扫描 Windows 注册表中注册的右键菜单项（覆盖"任意文件""文件夹""桌面背景""磁盘驱动器"等场景），
              找出那些指向<span className="text-[var(--color-danger)] font-medium">已不存在可执行文件</span>的失效条目。
              失效菜单项虽不影响系统稳定性，但会让右键菜单显得杂乱，影响使用体验。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-1">
              <span className="text-[var(--color-warning)] font-medium">⚠ 权限提示：</span>
              注册表条目分为用户级（HKCU）和系统级（HKLM）两类。
              删除<span className="font-medium"> HKCU </span>条目无需特殊权限；
              删除<span className="font-medium"> HKLM </span>条目需要以<span className="text-[var(--color-warning)] font-medium">管理员身份运行</span>程序，否则会提示删除失败。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-[var(--brand-green)]" />
              大目录分析
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              双模式扫描引擎：<span className="text-[var(--brand-green)] font-medium">默认模式</span>深度分析 AppData 目录（快速定位用户数据热点），
              <span className="text-[var(--brand-green)] font-medium">深度扫描模式</span>覆盖 C 盘全部一级目录（全盘摸排）。
              扫描自动标记<span className="text-[var(--color-warning)] font-medium">临时缓存</span>和<span className="text-[var(--color-danger)] font-medium">系统保护</span>目录，辅助安全决策。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-2">
              <span className="text-[var(--brand-green)] font-medium">MFT 直读引擎（v2.5 新特性）：</span>
              以管理员身份运行时，深度扫描自动启用<span className="text-[var(--brand-green)] font-medium"> NTFS MFT 直读</span>技术，
              绕开文件系统 API 直接读取主文件表，实现类似 WizTree 的<span className="text-[var(--brand-green)] font-medium">秒级全盘扫描</span>。
              非管理员或非 NTFS 文件系统时自动降级为常规遍历，无需用户干预。
              扫描中前端会显示当前使用的引擎类型（MFT 直读 / 常规遍历）。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-2">
              <span className="text-[var(--brand-green)] font-medium">树形层级展示：</span>结果以递归父子树呈现，渐进缩进 + L&#123;n&#125; 深度标签直观展示目录层级关系。
              每层最多展开前 <span className="font-medium">3</span> 个最大子目录。展示深度可在<span className="text-[var(--brand-green)] font-medium">功能设置</span>中调节（2-4 层），
              实际扫描深度固定为 6 层以确保覆盖率。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-2">
              <span className="text-[var(--brand-green)] font-medium">热点展开：</span>全盘扫描中，容器级大目录（
              <span className="font-medium">&gt;20GB</span> 或系统保护目录）自动展开为子目录参与排名竞争，
              避免 Windows、Program Files 等"不可操作"目录霸占排行榜。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-2">
              <span className="text-[var(--brand-green)] font-medium">无限下钻弹窗：</span>点击目录右侧 <span className="font-medium">▶</span> 按钮进入沉浸式模态框，
              支持任意层级深入探索子目录结构。顶部完整路径面包屑导航可快速回溯，按 <span className="font-medium">ESC</span> 快速关闭。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-2">
              <span className="text-[var(--brand-green)] font-medium">大小阈值：</span>可在<span className="text-[var(--brand-green)] font-medium">功能设置</span>中调节最低展示大小（10-500MB），
              低于阈值的目录不显示，有效减少结果噪音。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-[var(--brand-green)]" />
              C 盘全盘分析
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              使用<span className="text-[var(--brand-green)] font-medium">NTFS MFT</span> 枚举 C 盘文件记录，重建目录树并聚合目录大小。
              该能力需要管理员权限；首次扫描会建立基准快照，第二次扫描开始展示新增、减少和明显变化的目录。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-2">
              <span className="text-[var(--brand-green)] font-medium">变化定位：</span>
              每次扫描会与上次快照对比，计算 C 盘净新增/净减少空间，并按变化量列出对应目录、当前大小、变化级别和原因提示。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-2">
              <span className="text-[var(--brand-green)] font-medium">只做分析：</span>
              全盘变化不等同于可删除项，因此结果页只提供打开目录继续排查，不提供一键清理，避免误删系统或应用数据。
            </p>
          </div>
        </div>
      </div>

      {/* 置信度评分说明 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <ShieldCheck className="w-3.5 h-3.5" />
          评分与安全保障
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[var(--brand-green)]" />
              置信度评分引擎
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              卸载残留模块采用加权评分模型（0.0~1.0），综合<span className="font-medium">7项正向信号</span>（如文件夹名匹配已知应用、含卸载程序残留）
              和<span className="font-medium">7项负向信号</span>（如通用目录名、已安装应用映射、共享厂商目录）。
              <span className="text-[var(--brand-green)] font-medium">≥0.65 高置信度</span>的条目默认勾选，
              <span className="text-[var(--color-warning)] font-medium">0.40~0.65 可疑项</span>供手动判断，&lt;0.40 的条目不输出。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Shield className="w-4 h-4 text-[var(--brand-green)]" />
              删除安全机制
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              <span className="font-medium">普通删除：</span>路径范围校验 + 浅层可执行文件扫描（exe/dll/sys），含可执行文件的目录自动跳过并引导使用深度清理。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-1">
              <span className="text-[var(--color-warning)] font-medium">深度清理：</span>白名单校验（19项系统保护路径）+ 可执行文件扫描（7种扩展名）+ 重启删除回退，
              检测到风险项标记为"需人工审核"，确保不会误删正在使用的软件。
            </p>
          </div>
        </div>
      </div>

      {/* 风险等级说明 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Shield className="w-3.5 h-3.5" />
          文件风险等级
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-3">
          <div className="flex items-start gap-3">
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--brand-green)] text-white shrink-0">安全</span>
            <p className="text-xs text-[var(--text-muted)]">临时文件、缓存文件、日志文件等，删除后不影响系统和软件运行</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--brand-green)] text-white shrink-0">低风险</span>
            <p className="text-xs text-[var(--text-muted)]">媒体文件、下载内容等用户数据，删除前请确认不再需要</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--color-warning)] text-white shrink-0">中等</span>
            <p className="text-xs text-[var(--text-muted)]">数据库文件、文档、压缩包等，可能包含重要数据，请谨慎删除</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--color-warning)] text-white shrink-0">较高</span>
            <p className="text-xs text-[var(--text-muted)]">程序文件、配置文件等，删除可能导致软件无法正常运行</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--color-danger)] text-white shrink-0">高风险</span>
            <p className="text-xs text-[var(--text-muted)]">系统核心文件，<span className="text-[var(--color-danger)] font-medium">删除可能导致系统无法启动</span>，强烈建议不要删除</p>
          </div>
        </div>
      </div>

      {/* 注意事项 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          注意事项
        </h4>
        <div className="bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/20 rounded-2xl p-5 space-y-2">
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 删除操作不可撤销，请在清理前仔细确认文件内容
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 建议定期备份重要数据，避免误删造成损失
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 系统瘦身功能涉及系统级操作，操作前请确保了解其影响
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 关闭休眠功能后将无法使用快速启动和休眠模式
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 清理Windows组件存储后可能无法卸载某些系统更新
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • <span className="text-[var(--color-danger)] font-medium">深度清理</span>会直接从磁盘永久删除文件，不经过回收站，无法恢复
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 卸载残留扫描会自动跳过包含可执行文件（.exe/.dll/.sys）的文件夹
          </p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            • 注册表清理前会自动创建 .reg 备份文件，可通过双击恢复
          </p>
        </div>
      </div>

      {/* 免责声明 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <ShieldAlert className="w-3.5 h-3.5" />
          免责声明
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            本软件仅提供文件扫描和删除功能，所有删除操作均由用户主动确认执行。开发者不对因使用本软件造成的任何数据丢失、系统故障或其他损失承担责任。使用本软件即表示您已了解并接受上述风险，请在操作前做好数据备份。
          </p>
        </div>
      </div>
    </div>
  );
}

// 意见反馈 - 微信风格
const QQ_GROUP = '834582563';

function FeedbackSettings() {
  const [copiedQQ, setCopiedQQ] = useState(false);

  const handleCopyQQ = async () => {
    try {
      await navigator.clipboard.writeText(QQ_GROUP);
      setCopiedQQ(true);
      setTimeout(() => setCopiedQQ(false), 2000);
    } catch (err) {
      console.error('复制失败:', err);
    }
  };

  return (
    <div className="space-y-6">
      {/* 问题反馈 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <HelpCircle  className="w-3.5 h-3.5"/>
          问题反馈
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              如果您在使用过程中遇到任何问题或有改进建议，欢迎通过以下方式联系我
            </p>
          </div>

          <div className="space-y-2">
            <a
              href="https://github.com/Chunyu33/light-c/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between p-3 rounded-xl bg-[var(--bg-card)] hover:bg-[var(--bg-hover)] transition-colors group"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-gray-800 flex items-center justify-center">
                  <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">GitHub Issues</p>
                  <p className="text-xs text-[var(--text-muted)]">在 GitHub 上提交问题</p>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-[var(--text-faint)] group-hover:text-[var(--text-muted)]" />
            </a>

            <a
              href="mailto:1378813463@qq.com"
              className="flex items-center justify-between p-3 rounded-xl bg-[var(--bg-card)] hover:bg-[var(--bg-hover)] transition-colors group"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[var(--brand-green)] flex items-center justify-center">
                  <MessageSquare className="w-4 h-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">邮件反馈</p>
                  <p className="text-xs text-[var(--text-muted)]">1378813463@qq.com</p>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-[var(--text-faint)] group-hover:text-[var(--text-muted)]" />
            </a>
          </div>
        </div>
      </div>

      {/* 联系方式 - QQ群和微信 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <MessageCircle className="w-3.5 h-3.5" />
          交流
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-4 space-y-3">
          {/* QQ群 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--text-secondary)]">QQ群：</span>
              <span className="text-sm font-medium text-[var(--text-primary)]">{QQ_GROUP}</span>
            </div>
            <button
              onClick={handleCopyQQ}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-200 ${copiedQQ
                  ? 'bg-[var(--brand-green)]/10 text-[var(--brand-green)]'
                  : 'bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                }`}
            >
              {copiedQQ ? (
                <><CheckCircle className="w-3 h-3" />已复制</>
              ) : (
                <><Copy className="w-3 h-3" />复制</>
              )}
            </button>
          </div>
          {/* 微信号 */}
          {/* <div className="flex items-center justify-between pt-3 border-t border-[var(--border-color)]">
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--text-secondary)]"> 微 信：</span>
              <span className="text-sm font-medium text-[var(--text-primary)]">{WECHAT_ID}</span>
            </div>
            <button
              onClick={handleCopyWechat}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-200 ${copiedWechat
                  ? 'bg-[var(--brand-green)]/10 text-[var(--brand-green)]'
                  : 'bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                }`}
            >
              {copiedWechat ? (
                <><CheckCircle className="w-3 h-3" />已复制</>
              ) : (
                <><Copy className="w-3 h-3" />复制</>
              )}
            </button>
          </div> */}
        </div>
      </div>

      {/* 支持作者 - 赞赏功能 */}
      <SupportAuthor />
    </div>
  );
}

// 关于 - 微信风格
function AboutSettings() {
  const [appVersion, setAppVersion] = useState('');
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loadingSystemInfo, setLoadingSystemInfo] = useState(true);

  // 获取应用版本号和系统信息
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion('未知'));

    // 获取系统信息
    getSystemInfo()
      .then(setSystemInfo)
      .catch(err => console.error('获取系统信息失败:', err))
      .finally(() => setLoadingSystemInfo(false));
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
              <p className="text-xs text-[var(--text-faint)] mt-1">版本 {appVersion || '...'}</p>
            </div>
          </div>
          {/* 检查更新按钮 */}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('lightc:check-update'))}
            className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-[var(--brand-green)] bg-[var(--brand-green)]/10 rounded-xl hover:bg-[var(--brand-green)]/20 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            检查更新
          </button>
          <p className="text-xs text-[var(--text-faint)] mt-3">温馨提示：更新源为GitHub，国内可能会出现间歇性DNS污染，如果失败可以稍后重试。</p>
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
            <span className="text-sm text-[var(--text-secondary)]">开源地址</span>
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

// ============================================================================
// 支持作者组件 - 赞赏功能（含点击放大 Modal）
// ============================================================================

type PaymentType = 'wechat' | 'alipay';

function SupportAuthor() {
  const [paymentType, setPaymentType] = useState<PaymentType>('wechat');
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);

  // 切换支付方式时的淡入淡出动画
  const handlePaymentChange = (type: PaymentType) => {
    if (type === paymentType) return;
    setIsTransitioning(true);
    setTimeout(() => {
      setPaymentType(type);
      setIsTransitioning(false);
    }, 150);
  };

  // 打开放大 Modal
  const openModal = () => {
    setShowModal(true);
    requestAnimationFrame(() => setModalVisible(true));
  };

  // 关闭放大 Modal
  const closeModal = () => {
    setModalVisible(false);
    setTimeout(() => setShowModal(false), 200);
  };

  // ESC 键关闭 Modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showModal) {
        closeModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showModal]);

  return (
    <>
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Coffee className="w-3.5 h-3.5" />
          支持作者
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5">
          {/* 文案说明 */}
          <p className="text-sm text-[var(--text-secondary)] text-center mb-4">
            维护不易，如果软件对您有帮助，请我喝杯咖啡~（自愿原则）
          </p>

          {/* 赞赏码图片 - 可点击放大 */}
          <div className="flex justify-center mb-2">
            <div
              onClick={openModal}
              className="relative w-36 h-36 rounded-xl border border-[var(--border-color)] overflow-hidden bg-white p-2 cursor-pointer hover:shadow-lg hover:border-[var(--brand-green)] transition-all duration-200 group"
            >
              <img
                src={paymentType === 'wechat' ? wechatQr : alipayQr}
                alt={paymentType === 'wechat' ? '微信赞赏码' : '支付宝赞赏码'}
                className={`w-full h-full object-contain transition-opacity duration-150 ${isTransitioning ? 'opacity-0' : 'opacity-100'
                  }`}
              />
              {/* 悬浮放大提示 */}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-200 flex items-center justify-center">
                <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-black/60 text-white text-[10px] px-2 py-1 rounded-full">
                  点击放大
                </div>
              </div>
            </div>
          </div>

          {/* 点击提示文字 */}
          <p className="text-[10px] text-[var(--text-faint)] text-center mb-3">
            点击图片可放大扫描
          </p>

          {/* Segmented Control 切换开关 */}
          <div className="flex justify-center">
            <div className="inline-flex bg-[var(--bg-card)] rounded-xl p-1 border border-[var(--border-color)]">
              <button
                onClick={() => handlePaymentChange('wechat')}
                className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${paymentType === 'wechat'
                    ? 'bg-[#07C160] text-white shadow-sm'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
              >
                微信
              </button>
              <button
                onClick={() => handlePaymentChange('alipay')}
                className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${paymentType === 'alipay'
                    ? 'bg-[#1677FF] text-white shadow-sm'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
              >
                支付宝
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 放大 Modal - 半透明磨砂背景 */}
      {showModal && createPortal(
        <div
          className={`fixed inset-0 z-[10000] flex items-center justify-center transition-all duration-200 ${modalVisible ? 'bg-black/50 backdrop-blur-sm' : 'bg-transparent'
            }`}
          onClick={closeModal}
        >
          <div
            className={`relative bg-white rounded-2xl shadow-2xl p-4 transition-all duration-200 ${modalVisible ? 'scale-100 opacity-100' : 'scale-90 opacity-0'
              }`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 关闭按钮 */}
            <button
              onClick={closeModal}
              className="absolute -top-2 -right-2 w-8 h-8 bg-[var(--bg-card)] rounded-full shadow-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors z-10"
            >
              <X className="w-4 h-4" />
            </button>

            {/* 高清大图 */}
            <img
              src={paymentType === 'wechat' ? wechatQr : alipayQr}
              alt={paymentType === 'wechat' ? '微信赞赏码' : '支付宝赞赏码'}
              className="w-72 h-72 object-contain"
            />

            {/* 底部切换 */}
            <div className="flex justify-center mt-4">
              <div className="inline-flex bg-gray-100 rounded-xl p-1">
                <button
                  onClick={() => handlePaymentChange('wechat')}
                  className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${paymentType === 'wechat'
                      ? 'bg-[#07C160] text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                    }`}
                >
                  微信
                </button>
                <button
                  onClick={() => handlePaymentChange('alipay')}
                  className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${paymentType === 'alipay'
                      ? 'bg-[#1677FF] text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                    }`}
                >
                  支付宝
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
