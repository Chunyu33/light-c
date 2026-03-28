// ============================================================================
// 设置弹窗组件 - 仿微信设置布局
// ============================================================================

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Settings, MessageSquare, Info, Sun, Moon, Monitor, ExternalLink, RefreshCw, CheckCircle, BookOpen, Shield, AlertTriangle, Cpu, HardDrive, Monitor as MonitorIcon, User, Clock, Zap, FileBox, MessageCircle, Layers, Package, Database, Code2, HelpCircle, FolderOpen, History, ChevronRight, Palette, Coffee, Copy, Users, MousePointerClick } from 'lucide-react';

// 赞赏码图片
import wechatQr from '../assets/r_wechat_qr.jpg';
import alipayQr from '../assets/r_alipay_qr.jpg';
import { useTheme, type ThemeMode } from '../contexts';
// import { check } from '@tauri-apps/plugin-updater'; // 自动更新功能已停用
// import { relaunch } from '@tauri-apps/plugin-process'; // 自动更新功能已停用
import { getVersion } from '@tauri-apps/api/app';
import { getSystemInfo, type SystemInfo, openLogsFolder } from '../api/commands';
import { formatSize } from '../utils/format';

type SettingsTab = 'general' | 'guide' | 'feedback' | 'about';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const tabs: { id: SettingsTab; label: string; icon: typeof Settings }[] = [
  { id: 'general', label: '通用', icon: Settings },
  { id: 'guide', label: '使用说明', icon: BookOpen },
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
      <div className={`relative w-[600px] h-[450px] bg-[var(--bg-card)] rounded-2xl shadow-2xl flex overflow-hidden ${isVisible ? 'modal-content-in' : enteredRef.current ? 'modal-content-out' : 'opacity-0'}`}>
        {/* 左侧导航 - 使用主背景色 */}
        <div className="w-[160px] bg-[var(--bg-main)] border-r border-[var(--border-color)] py-4">
          <div className="px-4 mb-4">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">设置</h2>
          </div>
          <nav className="space-y-1 px-2">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${
                  activeTab === id
                    ? 'bg-[var(--brand-green-10)] text-[var(--brand-green)] font-medium'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* 右侧内容 - 卡片背景 */}
        <div className="flex-1 flex flex-col bg-[var(--bg-card)]">
          {/* 标题栏 */}
          <div className="h-12 flex items-center justify-between px-5 border-b border-[var(--border-color)]">
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
  const handleOpenLogsFolder = async () => {
    try {
      await openLogsFolder();
    } catch (error) {
      console.error('打开日志文件夹失败:', error);
    }
  };

  return (
    <div className="space-y-6">
      {/* 外观设置 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Palette className="w-3.5 h-3.5" />
          外观设置
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">主题模式</p>
              <p className="text-xs text-[var(--text-muted)] mt-1">选择应用的外观主题</p>
            </div>
            {/* 分段控制器 - 仅激活状态使用 brand-green */}
            <div className="flex items-center gap-1 p-1 bg-[var(--bg-card)] rounded-xl border border-[var(--border-color)]">
              {themeOptions.map(({ mode: m, label, icon: Icon }) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  title={label}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200 ${
                    mode === m
                      ? 'bg-[var(--brand-green)] text-white'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
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

      {/* 数据管理 - 使用 border-t 分隔 */}
      <div className="space-y-3 pt-2 border-t border-[var(--border-color)]">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <History className="w-3.5 h-3.5" />
          数据管理
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl">
          {/* 清理历史记录 */}
          <button
            onClick={handleOpenLogsFolder}
            className="w-full flex items-center justify-between p-4 hover:bg-[var(--bg-hover)] rounded-2xl transition-colors group"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[var(--brand-green-10)] flex items-center justify-center">
                <FolderOpen className="w-4.5 h-4.5 text-[var(--brand-green)]" />
              </div>
              <div className="text-left">
                <p className="text-sm font-medium text-[var(--text-primary)]">清理日志</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">记录最近10次清理的详细文件清单与结果</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors" />
          </button>
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
              扫描 AppData 和 ProgramData 目录中已卸载软件遗留的孤立文件夹。系统会自动排除仍在注册表中的已安装程序。
              <span className="text-[var(--color-warning)] font-medium">深度清理</span>功能将直接从磁盘永久删除文件，不经过回收站。
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
              通过<span className="text-[var(--brand-green)] font-medium">语义识别技术</span>深度分析 AppData 目录，智能识别占用空间最大的文件夹。
              系统会自动标记<span className="text-[var(--color-warning)] font-medium">程序缓存</span>和<span className="text-[var(--color-danger)] font-medium">潜在风险项</span>，
              帮助您快速定位 C 盘空间的"元凶"，精准释放磁盘空间。
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6 mt-2">
              <span className="text-[var(--brand-green)] font-medium">智能下钻：</span>开启深度扫描后，当目录超过 <span className="font-medium">5GB</span> 且包含超过 <span className="font-medium">1000</span> 个文件时，
              系统会自动分析其子目录结构，最多下钻 <span className="font-medium">3 层</span>，展示每层占用空间最大的前 3 个子目录，帮助您精准定位空间占用来源。
            </p>
          </div>
        </div>
      </div>

      {/* 深度扫描功能说明 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Layers className="w-3.5 h-3.5" />
          深度扫描功能
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Package className="w-4 h-4 text-[var(--color-warning)]" />
              模拟器残留检测
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              支持检测主流安卓模拟器（<span className="font-medium">雷电、蓝叠、夜神、MuMu、MEmu、腾讯手游助手</span>等）的卸载残留。
              系统会扫描 AppData、LocalLow、ProgramData 目录下的模拟器配置文件、虚拟磁盘文件（.vmdk/.vdi/.vhd）等大型残留，
              这些文件通常占用<span className="text-[var(--color-danger)] font-medium">数十GB</span>空间。
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <Database className="w-4 h-4 text-[var(--color-warning)]" />
              冗余注册表深度扫描
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed pl-6">
              深度扫描 HKEY_CURRENT_USER\Software 和 HKEY_LOCAL_MACHINE\SOFTWARE 下的孤立注册表项，
              识别已卸载软件遗留的配置信息和<span className="text-[var(--color-warning)] font-medium">孤立驱动服务项</span>。
              清理前会自动创建备份，确保操作安全可逆。
            </p>
          </div>
          <div className="bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/20 rounded-xl p-3">
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              <span className="font-medium">💡 使用提示：</span>在卸载残留模块中开启"深度扫描"开关，即可启用模拟器残留和虚拟磁盘文件检测功能。
              大型残留文件会以<span className="text-[var(--color-danger)] font-medium">红色高亮</span>显示，方便快速识别。
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
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">免责声明</h4>
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
function FeedbackSettings() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">联系我</h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">问题反馈</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              如果您在使用过程中遇到任何问题或有改进建议，欢迎通过以下方式联系我：
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
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
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
              href="mailto:liucygm33@gmail.com"
              className="flex items-center justify-between p-3 rounded-xl bg-[var(--bg-card)] hover:bg-[var(--bg-hover)] transition-colors group"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[var(--brand-green)] flex items-center justify-center">
                  <MessageSquare className="w-4 h-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">邮件反馈</p>
                  <p className="text-xs text-[var(--text-muted)]">liucygm33@gmail.com</p>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-[var(--text-faint)] group-hover:text-[var(--text-muted)]" />
            </a>
          </div>
        </div>
      </div>
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

  // 自动更新功能已停用，相关代码已移除

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
          <div className="flex items-center justify-between">
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
          </div>
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

      {/* 交流群 */}
      <CommunityGroup />

      {/* 支持作者 - 赞赏功能 */}
      <SupportAuthor />

      <div className="text-center pt-4">
        <p className="text-xs text-[var(--text-faint)]">
          Copyright © {new Date().getFullYear()} LightC. All rights reserved.
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// 交流群组件 - 复制群号功能
// ============================================================================

const QQ_GROUP = '834582563';

function CommunityGroup() {
  const [copied, setCopied] = useState(false);

  // 复制群号到剪贴板
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(QQ_GROUP);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('复制失败:', err);
    }
  };

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
        <Users className="w-3.5 h-3.5" />
        交流群
      </h4>
      <div className="bg-[var(--bg-main)] rounded-2xl p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--text-secondary)]">QQ群：</span>
            <span className="text-sm font-medium text-[var(--text-primary)]">{QQ_GROUP}</span>
          </div>
          <button
            onClick={handleCopy}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-200 ${
              copied
                ? 'bg-[var(--brand-green)]/10 text-[var(--brand-green)]'
                : 'bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            {copied ? (
              <>
                <CheckCircle className="w-3 h-3" />
                已复制
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                复制
              </>
            )}
          </button>
        </div>
      </div>
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
            维护不易，请我喝杯咖啡~（自愿原则）
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
                className={`w-full h-full object-contain transition-opacity duration-150 ${
                  isTransitioning ? 'opacity-0' : 'opacity-100'
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
                className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${
                  paymentType === 'wechat'
                    ? 'bg-[#07C160] text-white shadow-sm'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                微信
              </button>
              <button
                onClick={() => handlePaymentChange('alipay')}
                className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${
                  paymentType === 'alipay'
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
          className={`fixed inset-0 z-[10000] flex items-center justify-center transition-all duration-200 ${
            modalVisible ? 'bg-black/50 backdrop-blur-sm' : 'bg-transparent'
          }`}
          onClick={closeModal}
        >
          <div 
            className={`relative bg-white rounded-2xl shadow-2xl p-4 transition-all duration-200 ${
              modalVisible ? 'scale-100 opacity-100' : 'scale-90 opacity-0'
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
                  className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${
                    paymentType === 'wechat'
                      ? 'bg-[#07C160] text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  微信
                </button>
                <button
                  onClick={() => handlePaymentChange('alipay')}
                  className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${
                    paymentType === 'alipay'
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
