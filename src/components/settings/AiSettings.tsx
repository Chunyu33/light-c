// ============================================================================
// AI 助手设置页
//
// 只做界面与交互：网络请求、密钥存储、协议适配全在后端，
// 所以这里**永远接触不到明文 API Key** —— 只显示掩码。
// ============================================================================

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, Loader2, Plus, Sparkles, X } from 'lucide-react';
import { Select } from '../ui/Select';
import { useToast } from '../Toast';
import {
  deleteAiProfile,
  getAiConfig,
  listAiProviders,
  saveAiProfile,
  setActiveAiProfile,
  setAiDataDir,
  testAiConnection,
} from '../../api/ai';
import type { AiProviderPreset, AiPublicConfig } from '../../types/ai';

/** 统一的设置行：左侧标题与描述，右侧控件。 */
function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)]">{title}</p>
        {description ? <div className="text-xs text-[var(--text-muted)] mt-1">{description}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** 统一样式的文本输入框（设置页里目前只有本页用到）。 */
function TextField({
  value,
  placeholder,
  onChange,
  widthClass = 'w-64',
  password = false,
}: {
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
  widthClass?: string;
  password?: boolean;
}) {
  return (
    <input
      type={password ? 'password' : 'text'}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      className={`${widthClass} rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--brand-green)]`}
    />
  );
}

export function AiSettings() {
  const { t } = useTranslation('settings');
  const { showToast } = useToast();

  const [providers, setProviders] = useState<AiProviderPreset[]>([]);
  const [saved, setSaved] = useState<AiPublicConfig | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [loaded, setLoaded] = useState(false);

  // 表单草稿：与已保存配置分开，改动不落盘直到点保存/测试
  const [providerId, setProviderId] = useState('deepseek');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  // 密钥输入框始终为空：留空 = 沿用已保存的密钥（后端约定）
  const [apiKey, setApiKey] = useState('');
  // AI 数据目录：留空 = 跟随主数据目录（默认位置，显示为占位提示）。
  // 它是**全局设置**，不属于某个服务商 —— 换服务商不该把聊天记录也搬走。
  const [dataDir, setDataDir] = useState('');
  // 当前正在编辑的档案 id。表单里的字段都属于它。
  const [activeId, setActiveId] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [presetList, config] = await Promise.all([listAiProviders(), getAiConfig()]);
        if (cancelled) return;
        setProviders(presetList);
        setSaved(config);
        // 表单初值取自"当前档案"，不是某个全局字段 —— 多档案之后只有档案才是配置单位
        const active = config.profiles.find((item) => item.id === config.activeProfileId) ?? config.profiles[0];
        const preset = presetList.find((item) => item.id === active?.providerId);
        setActiveId(active?.id ?? '');
        setProviderId(active?.providerId || preset?.id || 'deepseek');
        setBaseUrl(active?.baseUrl || preset?.baseUrl || '');
        setModel(active?.model || '');
        // 模型下拉直接读档案里缓存的列表：重启后也还在，不用每次进来重新拉
        setModelOptions(active?.models ?? []);
        setDataDir(config.dataDir || '');
      } catch (error) {
        if (!cancelled) setErrorMessage(String(error));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 当前档案：密钥状态与新档案名都取它 —— 多档案之后没有"全局密钥"这种东西。 */
  const activeProfile = useMemo(
    () => saved?.profiles.find((item) => item.id === saved.activeProfileId) ?? saved?.profiles[0],
    [saved],
  );

  const currentPreset = useMemo(
    () => providers.find((item) => item.id === providerId),
    [providers, providerId],
  );

  /** 切换服务商时，把地址与默认模型一并带过去 —— 用户只需要再填一个密钥。 */
  const handleProviderChange = useCallback(
    (nextId: string) => {
      setProviderId(nextId);
      const preset = providers.find((item) => item.id === nextId);
      if (preset) {
        setBaseUrl(preset.baseUrl);
        setModel(preset.defaultModel);
      }
      setModelOptions([]);
      setErrorMessage('');
    },
    [providers],
  );

  /** 保存草稿。apiKey 为空时后端会沿用已保存的密钥。 */
  const persist = useCallback(async () => {
    // 密钥留空 = 后端沿用已保存的（前端只拿得到掩码，回传不了明文）
    // name 原样带回：档案名由用户维护，这里不该覆盖掉
    const next = await saveAiProfile({ id: activeId, name: activeProfile?.name ?? '', providerId, baseUrl, model, apiKey });
    // 数据目录是全局的，单独保存；它不属于任何一份档案
    const withDir = await setAiDataDir(dataDir);
    setSaved(withDir);
    setActiveId(withDir.activeProfileId);
    // 保存后端会回填 id（新增档案时），这里同步一次，否则再保存会又插入一份
    const active = withDir.profiles.find((item) => item.id === withDir.activeProfileId);
    if (active) setActiveId(active.id);
    setApiKey(''); // 保存成功后清空输入框，回到"掩码显示"状态
    return next;
  }, [activeId, providerId, baseUrl, model, apiKey, dataDir]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setErrorMessage('');
    try {
      await persist();
      showToast({ type: 'success', title: t('aiAssistant.saved') });
    } catch (error) {
      setErrorMessage(String(error));
    } finally {
      setIsSaving(false);
    }
  }, [persist, showToast, t]);

  /**
   * 测试连接 = 先保存再拉模型列表。
   * 必须先保存：后端拉列表时读的是**已保存**的配置，不保存就会拿着旧配置去测。
   */
  const handleTest = useCallback(async () => {
    setIsTesting(true);
    setErrorMessage('');
    try {
      await persist();
      const models = await testAiConnection();
      setModelOptions(models);
      // 拉到了列表但还没选模型时，自动选中第一个，省一步操作
      if (!model.trim() && models.length > 0) setModel(models[0]);
      showToast({
        type: 'success',
        title: t('aiAssistant.testOk'),
        description: t('aiAssistant.testOkDesc', { count: models.length }),
      });
    } catch (error) {
      setErrorMessage(String(error));
    } finally {
      setIsTesting(false);
    }
  }, [persist, model, showToast, t]);

  /** 把一个配置应用到表单上（切换档案、保存后回填都走这里，保证只有一处同步逻辑）。 */
  const applyConfig = useCallback(
    (config: AiPublicConfig) => {
      const active = config.profiles.find((item) => item.id === config.activeProfileId) ?? config.profiles[0];
      const preset = providers.find((item) => item.id === active?.providerId);
      setSaved(config);
      setActiveId(active?.id ?? '');
      setProviderId(active?.providerId || preset?.id || 'deepseek');
      setBaseUrl(active?.baseUrl || preset?.baseUrl || '');
      setModel(active?.model || '');
      setModelOptions(active?.models ?? []);
      setApiKey('');
      setErrorMessage('');
    },
    [providers],
  );

  const handleSwitchProfile = useCallback(
    async (profileId: string) => {
      if (profileId === activeId) return;
      try {
        applyConfig(await setActiveAiProfile(profileId));
      } catch (error) {
        setErrorMessage(String(error));
      }
    },
    [activeId, applyConfig],
  );

  /** 新增：直接建一份空档案并切过去，用户接着填密钥即可。 */
  const handleAddProfile = useCallback(async () => {
    try {
      applyConfig(await saveAiProfile({ id: '', name: '', providerId: 'deepseek', baseUrl: '', model: '', apiKey: '' }));
    } catch (error) {
      setErrorMessage(String(error));
    }
  }, [applyConfig]);

  const handleDeleteProfile = useCallback(
    async (profileId: string) => {
      try {
        applyConfig(await deleteAiProfile(profileId));
      } catch (error) {
        setErrorMessage(String(error));
      }
    },
    [applyConfig],
  );

  const modelSelectOptions = useMemo(
    () => modelOptions.map((id) => ({ value: id, label: id })),
    [modelOptions],
  );

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5" />
          {t('aiAssistant.section')}
        </h4>

        <div className="glass-block bg-[var(--bg-main)] rounded-2xl p-5 space-y-5">
          {/* 服务商档案栏：点标签切换，+ 新增，悬停出现删除。
              多份配置并存，切换只改一个 id，不搬动其它设置。 */}
          <div className="flex flex-wrap items-center gap-2">
            {saved?.profiles.map((profile) => {
              const isActive = profile.id === saved.activeProfileId;
              const label =
                profile.name ||
                providers.find((item) => item.id === profile.providerId)?.name ||
                profile.providerId;
              return (
                <span
                  key={profile.id}
                  className={`group inline-flex items-center gap-1 rounded-xl border px-2.5 py-1 text-xs transition-colors ${
                    isActive
                      ? 'border-[var(--brand-green)] bg-[var(--brand-green-10)] text-[var(--brand-green)]'
                      : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void handleSwitchProfile(profile.id)}
                    className="max-w-[12em] truncate"
                    title={profile.model || t('aiAssistant.profileNoModel')}
                  >
                    {label}
                    {profile.model ? ` · ${profile.model}` : ''}
                  </button>
                  {saved.profiles.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => void handleDeleteProfile(profile.id)}
                      title={t('aiAssistant.profileDelete')}
                      aria-label={t('aiAssistant.profileDelete')}
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : null}
                </span>
              );
            })}
            <button
              type="button"
              onClick={() => void handleAddProfile()}
              className="inline-flex items-center gap-1 rounded-xl border border-dashed border-[var(--border-color)] px-2.5 py-1 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)]"
            >
              <Plus className="h-3 w-3" />
              {t('aiAssistant.profileAdd')}
            </button>
          </div>

          <SettingRow title={t('aiAssistant.provider')} description={t('aiAssistant.providerDesc')}>
            <Select<string>
              value={providerId}
              options={providers.map((item) => ({ value: item.id, label: item.name }))}
              onChange={handleProviderChange}
              widthClass="w-64"
            />
          </SettingRow>

          <div className="border-t border-[var(--border-color)] pt-5">
            <SettingRow title={t('aiAssistant.baseUrl')} description={t('aiAssistant.baseUrlDesc')}>
              <TextField value={baseUrl} onChange={setBaseUrl} widthClass="w-64" />
            </SettingRow>
          </div>

          <div className="border-t border-[var(--border-color)] pt-5">
            <SettingRow
              title={t('aiAssistant.apiKey')}
              description={
                activeProfile?.hasApiKey
                  ? t('aiAssistant.apiKeySaved', { masked: activeProfile?.apiKeyMasked ?? '' })
                  : t('aiAssistant.apiKeyDesc')
              }
            >
              <TextField
                value={apiKey}
                onChange={setApiKey}
                placeholder={activeProfile?.hasApiKey ? t('aiAssistant.apiKeyKeep') : 'sk-...'}
                widthClass="w-64"
                password
              />
            </SettingRow>
          </div>

          <div className="border-t border-[var(--border-color)] pt-5">
            <SettingRow title={t('aiAssistant.model')} description={t('aiAssistant.modelDesc')}>
              {modelSelectOptions.length > 0 ? (
                <Select<string>
                  value={model}
                  options={modelSelectOptions}
                  onChange={setModel}
                  widthClass="w-64"
                />
              ) : (
                <TextField
                  value={model}
                  onChange={setModel}
                  placeholder={currentPreset?.defaultModel || 'model-name'}
                  widthClass="w-64"
                />
              )}
            </SettingRow>
          </div>

          <div className="border-t border-[var(--border-color)] pt-5">
            <SettingRow
              title={t('aiAssistant.dataDir')}
              description={t('aiAssistant.dataDirDesc')}
            >
              {/* 留空 = 跟随主数据目录。这里不强制用文件夹选择器：
                  高级设置里手填路径更省事，也方便直接粘贴。 */}
              <TextField
                value={dataDir}
                onChange={setDataDir}
                placeholder={t('aiAssistant.dataDirDefault')}
                widthClass="w-64"
              />
            </SettingRow>
          </div>

          <div className="border-t border-[var(--border-color)] pt-5 flex items-center justify-between gap-4">
            <div className="min-w-0 text-xs">
              {currentPreset?.local ? (
                <span className="flex items-center gap-1.5 text-[var(--brand-green)]">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  {t('aiAssistant.localHint')}
                </span>
              ) : (
                <span className="text-[var(--text-muted)]">{t('aiAssistant.remoteHint')}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void handleTest()}
                disabled={isTesting || isSaving}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--brand-green-20)] px-3 py-1.5 text-xs font-medium text-[var(--brand-green)] transition-colors hover:bg-[var(--brand-green-10)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {isTesting ? t('aiAssistant.testing') : t('aiAssistant.test')}
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={isSaving || isTesting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-green)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--brand-green-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {t('aiAssistant.save')}
              </button>
            </div>
          </div>

          {errorMessage ? (
            <div className="flex items-start gap-2 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 p-3 text-xs text-[var(--color-danger)]">
              <AlertCircle className="mt-0.5 w-3.5 h-3.5 shrink-0" />
              <span className="min-w-0 break-all">{errorMessage}</span>
            </div>
          ) : null}

          {!loaded ? (
            <p className="text-xs text-[var(--text-muted)]">{t('aiAssistant.loading')}</p>
          ) : null}
        </div>
      </div>

      <p className="text-xs text-[var(--text-muted)] leading-relaxed">{t('aiAssistant.privacyNote')}</p>
    </div>
  );
}
