// ============================================================================
// 通用设置页面
// ============================================================================

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, ClipboardList, ChevronRight, FolderOpen, HardDrive, History, Info, LayoutGrid, MonitorCog, RefreshCw, Rocket, Search, Trash2, Type } from 'lucide-react';
import { Select } from '../ui/Select';
import { useFontSize, CUSTOM_FONT_SIZE_MIN, CUSTOM_FONT_SIZE_MAX, useSettings, type ThemeMode } from '../../contexts';
import { useToast } from '../Toast';
import { clearSelectedLocalData, getStorageLocationInfo, listClearableDataItems, migrateLegacyPortableData, openInFolder, openLogsFolder, openStartupManager, openStorageSettings, pickFolderDialog, setDataDirectory, type ClearableDataItem, type StorageLocationInfo } from '../../api/commands';
import { formatSize } from '../../utils/format';
import { getStoredSearchEngine, SEARCH_ENGINE_CHANGED_EVENT, SEARCH_ENGINE_OPTIONS, setStoredSearchEngine, type SearchEngine } from '../../utils/searchEngine';
import { ClearLocalDataDialog } from './ClearLocalDataDialog';
import { FONT_SIZE_CONFIGS, FONT_SIZE_OPTIONS, LAYOUT_MODE_OPTIONS, THEME_OPTIONS } from './constants';

export function GeneralSettings({ mode, setMode }: { mode: ThemeMode; setMode: (mode: ThemeMode) => void }) {
  const { level: fontSizeLevel, setLevel: setFontSizeLevel, customFontSize, setCustomFontSize } = useFontSize();
  const { settings, updateSettings } = useSettings();
  const { showToast } = useToast();
  const [dataDir, setDataDir] = useState('');
  const [storageInfo, setStorageInfo] = useState<StorageLocationInfo | null>(null);
  const [isChangingDir, setIsChangingDir] = useState(false);
  const [isMigratingLegacyData, setIsMigratingLegacyData] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearableItems, setClearableItems] = useState<ClearableDataItem[]>([]);
  const [selectedClearItemIds, setSelectedClearItemIds] = useState<string[]>([]);
  const [customFontSizeDraft, setCustomFontSizeDraft] = useState(String(customFontSize));

  useEffect(() => {
    setCustomFontSizeDraft(String(customFontSize));
  }, [customFontSize]);

  // 后端统一返回发行模式和路径，避免前端重复推断便携版目录。
  useEffect(() => {
    getStorageLocationInfo()
      .then((info) => {
        setStorageInfo(info);
        setDataDir(info.current_data_directory);
      })
      .catch(() => setDataDir('未知'));
  }, []);

  const handleOpenLogsFolder = async () => {
    try {
      await openLogsFolder();
    } catch (error) {
      console.error('打开日志文件夹失败:', error);
    }
  };

  const handleOpenStoragePath = async (path: string, label: string) => {
    try {
      await openInFolder(path);
    } catch (error) {
      showToast({
        type: 'error',
        title: `打开${label}失败`,
        description: String(error),
      });
    }
  };

  // 更改数据目录
  const handleChangeDataDir = async () => {
    try {
      setIsChangingDir(true);
      const folder = await pickFolderDialog();
      if (!folder) { setIsChangingDir(false); return; }
      await setDataDirectory(folder);
      try {
        const info = await getStorageLocationInfo();
        setStorageInfo(info);
        setDataDir(info.current_data_directory);
      } catch {
        // 设置命令已经成功时，状态刷新失败不能误报为迁移失败。
        setDataDir(folder);
      }
      showToast({
        type: 'success',
        title: '数据目录已更改',
        description: folder,
      });
    } catch (error) {
      console.error('更改数据目录失败:', error);
      showToast({
        type: 'error',
        title: '更改数据目录失败',
        description: String(error),
      });
    } finally {
      setIsChangingDir(false);
    }
  };

  const handleMigrateLegacyData = async () => {
    try {
      setIsMigratingLegacyData(true);
      const info = await migrateLegacyPortableData();
      setStorageInfo(info);
      setDataDir(info.current_data_directory);
      showToast({
        type: 'success',
        title: '旧版数据迁移完成',
        description: '原 AppData 数据未删除，便携版现在优先使用程序目录。',
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '旧版数据迁移失败',
        description: String(error),
      });
    } finally {
      setIsMigratingLegacyData(false);
    }
  };

  // 清空本地数据
  const handleClearData = async () => {
    try {
      setIsClearing(true);
      const items = await listClearableDataItems();
      setClearableItems(items);
      // 驱动备份文件通常较大且承担误删后的手动恢复作用，必须由用户单独确认清理。
      setSelectedClearItemIds(items
        .filter(item => item.id !== 'driver_backups' && item.exists && item.file_count > 0)
        .map(item => item.id));
      setClearDialogOpen(true);
    } catch (error) {
      showToast({
        type: 'error',
        title: '读取清理项失败',
        description: String(error),
      });
    } finally {
      setIsClearing(false);
    }
  };

  const executeClearData = async () => {
    if (selectedClearItemIds.length === 0) {
      showToast({ type: 'info', title: '未选择清理项' });
      return;
    }

    try {
      setIsClearing(true);
      const result = await clearSelectedLocalData(selectedClearItemIds);
      setClearDialogOpen(false);
      showToast({
        type: 'success',
        title: '数据已清空',
        description: `已删除 ${result.deleted_files} 个文件，释放 ${formatSize(result.freed_bytes)}`,
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

  const toggleClearItem = (itemId: string) => {
    setSelectedClearItemIds(prev =>
      prev.includes(itemId) ? prev.filter(id => id !== itemId) : [...prev, itemId]
    );
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
              {THEME_OPTIONS.map(({ mode: m, label, icon: Icon }) => (
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
          <div className="pt-4 border-t border-[var(--border-color)]">
            <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[140px] flex-1">
              <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                <Type className="w-4 h-4 text-[var(--text-muted)]" />
                字体大小
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-1">调整应用内文字大小</p>
            </div>
            {/* 字号分段控制器 */}
            <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1 p-1 bg-[var(--bg-card)] rounded-xl border border-[var(--border-color)]">
              {FONT_SIZE_OPTIONS.map(({ level, label }) => (
                <button
                  key={level}
                  onClick={() => setFontSizeLevel(level)}
                  title={level === 'custom'
                    ? `${label}（当前 ${customFontSize}px）`
                    : `${label} (+${FONT_SIZE_CONFIGS[level].offset}px)`}
                  className={`whitespace-nowrap px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200 ${fontSizeLevel === level
                      ? 'bg-[var(--brand-green)] text-white'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                    }`}
                >
                  {label}
                </button>
              ))}
            </div>
            </div>

            {/* 自定义字号单独展开，避免未选择时占用通用设置空间。 */}
            <AnimatePresence initial={false}>
              {fontSizeLevel === 'custom' && (
                <motion.div
                  initial={{ opacity: 0, height: 0, y: -6 }}
                  animate={{ opacity: 1, height: 'auto', y: 0 }}
                  exit={{ opacity: 0, height: 0, y: -6 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  className="overflow-hidden"
                >
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-[var(--text-secondary)]">自定义字号</p>
                      <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">范围 {CUSTOM_FONT_SIZE_MIN}-{CUSTOM_FONT_SIZE_MAX}px</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <input
                        type="number"
                        min={CUSTOM_FONT_SIZE_MIN}
                        max={CUSTOM_FONT_SIZE_MAX}
                        step={1}
                        value={customFontSizeDraft}
                        onChange={(event) => setCustomFontSizeDraft(event.target.value)}
                        onBlur={() => {
                          const parsedValue = Number(customFontSizeDraft);
                          const nextValue = Number.isFinite(parsedValue)
                            ? Math.min(CUSTOM_FONT_SIZE_MAX, Math.max(CUSTOM_FONT_SIZE_MIN, Math.floor(parsedValue)))
                            : customFontSize;
                          setCustomFontSize(nextValue);
                          setCustomFontSizeDraft(String(nextValue));
                        }}
                        className="h-9 w-20 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-3 text-right text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--brand-green)]"
                        title={`自定义字号，范围 ${CUSTOM_FONT_SIZE_MIN}-${CUSTOM_FONT_SIZE_MAX}px`}
                      />
                      <span className="text-xs text-[var(--text-muted)]">px</span>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* 布局设置 */}
          <div className="flex items-center justify-between pt-4 border-t border-[var(--border-color)]">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                <LayoutGrid className="w-4 h-4 text-[var(--text-muted)]" />
                布局设置
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                调整页面布局模式
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-[var(--bg-card)] rounded-xl border border-[var(--border-color)]">
              {LAYOUT_MODE_OPTIONS.map(({ mode, label, icon: Icon, description }) => (
                <button
                  key={mode}
                  onClick={() => updateSettings({ layoutMode: mode })}
                  title={`${label}：${description}`}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-200 ${
                    settings.layoutMode === mode
                      ? 'bg-[var(--brand-green)] text-white shadow-sm'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </button>
              ))}
            </div>
          </div>

          <SearchEngineSettings />

          {/* 清理日志保留 */}
          <div className="flex items-center justify-between pt-4 border-t border-[var(--border-color)]">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                <ClipboardList className="w-4 h-4 text-[var(--text-muted)]" />
                清理日志保留
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-1">超过数量后自动删除最旧日志，范围 1-100 条</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={settings.cleanupLogRetention}
                onChange={(event) => {
                  const nextValue = Math.min(100, Math.max(1, Math.floor(Number(event.target.value) || 10)));
                  updateSettings({ cleanupLogRetention: nextValue });
                }}
                className="h-9 w-20 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-3 text-right text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--brand-green)]"
                title="清理日志最多保留条数"
              />
              <span className="text-xs text-[var(--text-muted)]">条</span>
            </div>
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
          {/* 当前存储位置 */}
          <div className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-xs text-[var(--text-muted)]">配置位置</span>
              <div className="flex min-w-0 items-center gap-2">
                <span className="max-w-[230px] truncate text-right text-[10px] text-[var(--text-faint)]" title={storageInfo?.config_file}>
                  {storageInfo?.config_file ? shortenPathMiddle(storageInfo.config_file) : '加载中...'}
                </span>
                <button
                  onClick={() => storageInfo?.config_file && handleOpenStoragePath(storageInfo.config_file, '配置文件')}
                  disabled={!storageInfo?.config_file}
                  className="shrink-0 text-[10px] text-[var(--brand-green)] transition hover:opacity-80 disabled:opacity-40"
                >
                  前往
                </button>
              </div>
            </div>
            {storageInfo?.webview_data_directory && (
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-xs text-[var(--text-muted)]">界面数据</span>
                <span className="max-w-[280px] truncate text-right text-[10px] text-[var(--text-faint)]" title={storageInfo.webview_data_directory}>
                  {storageInfo.webview_data_directory}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-xs text-[var(--text-muted)]">数据位置</span>
              <div className="flex min-w-0 items-center gap-2">
                <span className="max-w-[230px] truncate text-[10px] text-[var(--text-faint)]" title={dataDir}>
                  {dataDir || '加载中...'}
                </span>
                <button
                  onClick={() => handleOpenStoragePath(dataDir, '数据目录')}
                  className="shrink-0 text-[10px] text-[var(--brand-green)] transition hover:opacity-80"
                >
                  前往
                </button>
              </div>
            </div>
            {storageInfo && !storageInfo.can_write && (
              <p className="flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                当前存储位置不可写，请将便携包解压到具有写入权限的目录。
              </p>
            )}
            {storageInfo?.migration_completed && storageInfo.distribution_channel === 'portable' && (
              <p className="flex items-center gap-1.5 text-[11px] text-[var(--brand-green)]">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                旧版 AppData 数据已兼容迁移，原数据未删除。
              </p>
            )}
            {storageInfo?.migration_available && (
              <button
                onClick={handleMigrateLegacyData}
                disabled={isMigratingLegacyData}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--brand-green)] px-3 py-2 text-xs text-[var(--brand-green)] transition hover:bg-[var(--brand-green-10)] disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isMigratingLegacyData ? 'animate-spin' : ''}`} />
                {isMigratingLegacyData ? '迁移中...' : '迁移旧版 AppData 数据'}
              </button>
            )}
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
                <p className="text-xs text-[var(--text-muted)] mt-0.5">选择独立空文件夹存储清理日志和缓存数据，配置文件不会迁移</p>
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
                <p className="text-xs text-[var(--text-muted)] mt-0.5">选择性清理日志、备份、快照、历史缓存和虚拟磁盘记录</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors" />
          </button>
        </div>
      </div>

      <ClearLocalDataDialog
        isOpen={clearDialogOpen}
        items={clearableItems}
        selectedIds={selectedClearItemIds}
        isClearing={isClearing}
        onToggleItem={toggleClearItem}
        onCancel={() => setClearDialogOpen(false)}
        onConfirm={executeClearData}
      />

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

// 中间省略可以同时保留盘符、目录层级和配置文件名，用户仍可通过 title 查看完整路径。
function shortenPathMiddle(path: string, maxLength = 54): string {
  if (path.length <= maxLength) {
    return path;
  }

  const visibleLength = maxLength - 3;
  const leftLength = Math.ceil(visibleLength * 0.45);
  const rightLength = visibleLength - leftLength;
  return `${path.slice(0, leftLength)}...${path.slice(-rightLength)}`;
}

function SearchEngineSettings() {
  const [searchEngine, setSearchEngine] = useState<SearchEngine>(() => getStoredSearchEngine());

  useEffect(() => {
    const handleSearchEngineChange = (event: Event) => {
      const nextEngine = (event as CustomEvent<SearchEngine>).detail;
      setSearchEngine(nextEngine);
    };

    window.addEventListener(SEARCH_ENGINE_CHANGED_EVENT, handleSearchEngineChange);
    return () => window.removeEventListener(SEARCH_ENGINE_CHANGED_EVENT, handleSearchEngineChange);
  }, []);

  const handleChange = (engine: SearchEngine) => {
    setSearchEngine(engine);
    setStoredSearchEngine(engine);
  };

  return (
    <div className="flex items-center justify-between pt-4 border-t border-[var(--border-color)]">
      <div>
        <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-1.5">
          <Search className="w-4 h-4 text-[var(--text-muted)]" />
          搜索引擎
        </p>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          设置各模块搜索按钮打开的默认搜索引擎
        </p>
      </div>
      <Select<SearchEngine>
        value={searchEngine}
        options={SEARCH_ENGINE_OPTIONS}
        onChange={handleChange}
        widthClass="w-32"
      />
    </div>
  );
}
