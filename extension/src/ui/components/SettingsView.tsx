import { useState } from 'react';
import { browser } from 'wxt/browser';
import {
  PROVIDER_PRESETS,
  presetToConfig,
  type ProviderConfig,
} from '@/core/providers';
import { fetchModels } from '@/core/chatEngine';
import { t, setLangOverride } from '../i18n';
import { useSettings } from '../SettingsContext';
import LogsSection from './LogsSection';
import ScheduledTasksSection from './ScheduledTasksSection';

export default function SettingsView() {
  const {
    ready,
    settings,
    activeProvider,
    apiKeys,
    upsertProvider,
    removeProvider,
    setActiveProvider,
    setKey,
    changeRemember,
    updateSettings,
    testProvider,
  } = useSettings();

  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  const [presetId, setPresetId] = useState('');

  if (!ready) return <div className="settings" />;

  const startAdd = (id: string) => {
    if (!id) return;
    const preset = PROVIDER_PRESETS.find((p) => p.id === id);
    if (preset) setEditing(presetToConfig(preset));
    setPresetId('');
  };

  return (
    <div className="settings">
      <h2 className="settings-heading">{t('settingsTitle')}</h2>

      <section className="settings-section">
        <h3>{t('langTitle')}</h3>
        <div className="lang-options">
          {(['auto', 'zh', 'en'] as const).map((v) => (
            <button
              key={v}
              className={`btn btn-small ${settings.lang === v ? 'btn-primary' : ''}`}
              onClick={() => {
                setLangOverride(v);
                void updateSettings({ lang: v });
              }}
            >
              {v === 'auto' ? t('langAuto') : v === 'zh' ? t('langZh') : t('langEn')}
            </button>
          ))}
        </div>
        <p className="skills-hint">{t('langHint')}</p>
      </section>

      <section className="settings-section">
        <h3>{t('providerSection')}</h3>
        {settings.providers.map((p) => (
          <div
            key={p.id}
            className={`provider-row ${activeProvider?.id === p.id ? 'active' : ''}`}
          >
            <span className="provider-avatar">{p.name.charAt(0)}</span>
            <button
              className="provider-main"
              onClick={() => void setActiveProvider(p.id)}
            >
              <span className="provider-name">
                {p.name}
                {activeProvider?.id === p.id && <span className="active-dot" />}
              </span>
              <span className="provider-sub">
                {p.baseUrl} · {p.activeModel}
              </span>
            </button>
            <button className="btn btn-small" onClick={() => setEditing(p)}>
              {t('edit')}
            </button>
            <button
              className="btn btn-small btn-danger"
              onClick={() => void removeProvider(p.id)}
            >
              {t('delete')}
            </button>
          </div>
        ))}

        {settings.providers.length === 0 && (
          <p className="empty">{t('none')}</p>
        )}

        <div className="add-provider">
          <select value={presetId} onChange={(e) => startAdd(e.target.value)}>
            <option value="">{t('addProvider')}…</option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </section>

      {editing && (
        <ProviderForm
          key={editing.id}
          initial={editing}
          apiKey={apiKeys[editing.id] ?? ''}
          onCancel={() => setEditing(null)}
          onSave={async (config, keyInput) => {
            await upsertProvider(config);
            if (keyInput !== '') await setKey(config.id, keyInput);
            setEditing(null);
          }}
          onTest={testProvider}
        />
      )}

      <section className="settings-section">
        <h3>{t('navSettings')}</h3>
        <Toggle
          label={t('demoMode')}
          hint={t('demoModeHint')}
          checked={settings.demoMode}
          onChange={(v) => void updateSettings({ demoMode: v })}
        />
        <Toggle
          label={t('autoReadPage')}
          checked={settings.autoReadPage}
          onChange={(v) => void updateSettings({ autoReadPage: v })}
        />
        <Toggle
          label={t('previewBeforeSend')}
          checked={settings.previewBeforeSend}
          onChange={(v) => void updateSettings({ previewBeforeSend: v })}
        />
        <Toggle
          label={t('keyRemember')}
          hint={t('keyRememberHint')}
          checked={settings.rememberKeys}
          onChange={(v) => void changeRemember(v)}
        />
        <p className="privacy-hint">{t('privacyHint')}</p>
      </section>

      <ScheduledTasksSection />

      <LogsSection />
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="switch-row">
      <span className="switch-text">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <span className="switch">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="switch-track">
          <span className="switch-thumb" />
        </span>
      </span>
    </label>
  );
}

interface ProviderFormProps {
  initial: ProviderConfig;
  apiKey: string;
  onSave(config: ProviderConfig, keyInput: string): void;
  onCancel(): void;
  onTest(
    config: ProviderConfig,
    apiKey: string,
  ): Promise<{ ok: boolean; message: string }>;
}

function ProviderForm({ initial, apiKey, onSave, onCancel, onTest }: ProviderFormProps) {
  const [name, setName] = useState(initial.name);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [modelsText, setModelsText] = useState(initial.models.join(', '));
  const [activeModel, setActiveModel] = useState(initial.activeModel);
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchResult, setFetchResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );

  const models = modelsText
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const buildConfig = (): ProviderConfig => ({
    ...initial,
    name: name.trim() || initial.name,
    baseUrl: baseUrl.trim(),
    models: models.length ? models : initial.models,
    activeModel: models.includes(activeModel)
      ? activeModel
      : (models[0] ?? initial.activeModel),
  });

  const handleTest = async () => {
    const cfg = buildConfig();
    if (!cfg.baseUrl || !cfg.activeModel) {
      setTestResult({ ok: false, message: 'Base URL / Model required' });
      return;
    }
    const k = key.trim() || apiKey;
    if (!k) {
      setTestResult({ ok: false, message: 'API Key required' });
      return;
    }
    setTesting(true);
    const r = await onTest(cfg, k);
    setTestResult({ ok: r.ok, message: r.message });
    setTesting(false);
  };

  /** 从服务商 /models 端点拉取模型列表，自动填充（手动输入仍可作高级兜底） */
  const handleFetchModels = async () => {
    const cfg = buildConfig();
    if (!cfg.baseUrl) {
      setFetchResult({ ok: false, message: 'Base URL required' });
      return;
    }
    const k = key.trim() || apiKey;
    if (!k) {
      setFetchResult({ ok: false, message: 'API Key required' });
      return;
    }
    setFetching(true);
    const r = await fetchModels(cfg, k);
    if (r.ok && r.models) {
      const ids = r.models;
      setModelsText(ids.join(', '));
      setActiveModel((cur) => (ids.includes(cur) ? cur : (ids[0] ?? '')));
      setFetchResult({ ok: true, message: t('fetchModelsOk', { n: ids.length }) });
    } else {
      setFetchResult({ ok: false, message: r.message });
    }
    setFetching(false);
  };

  return (
    <section className="settings-section provider-form">
      <h3>{name || t('addProvider')}</h3>
      <label>
        {t('presetLabel')}
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        {t('baseUrlLabel')}
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </label>
      <label>
        {t('modelsLabel')}
        <span className="models-input">
          <input value={modelsText} onChange={(e) => setModelsText(e.target.value)} />
          <button
            type="button"
            className="btn btn-small"
            disabled={fetching}
            onClick={() => void handleFetchModels()}
          >
            {fetching ? t('fetchingModels') : t('fetchModels')}
          </button>
        </span>
      </label>
      {fetchResult && (
        <p className={`test-result ${fetchResult.ok ? 'ok' : 'fail'}`}>
          {fetchResult.ok
            ? fetchResult.message
            : `${t('fetchModelsFail')}: ${fetchResult.message}`}
        </p>
      )}
      <label>
        {t('modelLabel')}
        <select value={activeModel} onChange={(e) => setActiveModel(e.target.value)}>
          {(models.length ? models : initial.models).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('apiKeyLabel')}
        <span className="key-input">
          <input
            type={showKey ? 'text' : 'password'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={apiKey ? '••••••••（已保存）' : ''}
          />
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? '•••' : 'abc'}
          </button>
        </span>
      </label>
      <div className="form-actions">
        <button
          className="btn"
          disabled={testing}
          onClick={() => void handleTest()}
        >
          {testing ? t('testing') : t('testConnection')}
        </button>
        <button className="btn btn-primary" onClick={() => onSave(buildConfig(), key.trim())}>
          {t('save')}
        </button>
        <button className="btn" onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
      {testResult && (
        <div className="test-result-row">
          <p className={`test-result ${testResult.ok ? 'ok' : 'fail'}`}>
            {testResult.ok
              ? `${t('testOk')} (${testResult.message})`
              : `${t('testFail')}: ${testResult.message}`}
          </p>
          {!testResult.ok && /grant origin|permission/i.test(testResult.message) && (
            <button
              className="btn btn-small"
              onClick={async () => {
                try {
                  const origin = new URL(baseUrl.trim()).origin;
                  await browser.permissions.request({ origins: [`${origin}/*`] });
                } catch {
                  // 无效 URL：忽略
                }
              }}
            >
              {t('grantOrigin')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
