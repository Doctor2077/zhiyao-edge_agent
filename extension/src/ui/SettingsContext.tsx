import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_SETTINGS,
  getApiKey,
  loadSettings,
  migrateKeys,
  saveSettings,
  setApiKey,
  type Settings,
} from '@/core/settings';
import type { ProviderConfig } from '@/core/providers';
import {
  testConnection as engineTest,
  type TestConnectionResult,
} from '@/core/chatEngine';
import {
  BUILTIN_SKILLS,
  installSkill as persistInstall,
  loadInstalledSkills,
  removeSkill as persistRemove,
  saveInstalledSkills,
  validateImport,
  type Skill,
} from '@/core/skills';
import { log } from '@/core/logger';
import { setLangOverride } from './i18n';

interface SettingsContextValue {
  ready: boolean;
  settings: Settings;
  providers: ProviderConfig[];
  activeProvider: ProviderConfig | null;
  apiKeys: Record<string, string>;
  installedSkills: Skill[];
  updateSettings(patch: Partial<Settings>): Promise<void>;
  upsertProvider(config: ProviderConfig): Promise<void>;
  removeProvider(id: string): Promise<void>;
  setActiveProvider(id: string): Promise<void>;
  setKey(providerId: string, key: string): Promise<void>;
  changeRemember(remember: boolean): Promise<void>;
  testProvider(config: ProviderConfig, apiKey: string): Promise<TestConnectionResult>;
  installSkill(skill: Skill): Promise<void>;
  removeSkill(id: string): Promise<void>;
  toggleSkill(id: string, enabled: boolean): Promise<void>;
  importSkillJson(raw: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

async function loadAllKeys(remember: boolean, providers: ProviderConfig[]) {
  const entries = await Promise.all(
    providers.map(async (p) => [p.id, await getApiKey(p.id, remember)] as const),
  );
  return Object.fromEntries(entries);
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [installedSkills, setInstalledSkills] = useState<Skill[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      setLangOverride(s.lang); // 应用用户语言设置
      let skills = await loadInstalledSkills();
      const enabled = new Set(s.enabledSkillIds);
      // 默认技能播种（仅首次生效）：自动安装并启用 defaultEnabled 的内置技能；
      // 之后尊重用户的开关/删除操作，不重复播种。
      if (!s.defaultSkillsSeeded) {
        let changed = false;
        for (const b of BUILTIN_SKILLS) {
          if (!b.defaultEnabled) continue;
          if (!skills.some((x) => x.id === b.id)) {
            skills = [...skills, structuredClone(b)];
            changed = true;
          }
          if (!enabled.has(b.id)) {
            enabled.add(b.id);
            changed = true;
          }
        }
        if (changed) await saveInstalledSkills(skills);
        const seeded: Settings = {
          ...s,
          enabledSkillIds: Array.from(enabled),
          defaultSkillsSeeded: true,
        };
        await saveSettings(seeded);
        setSettingsState(seeded);
        log('info', 'skill', 'default skills seeded');
      } else {
        setSettingsState(s);
      }
      setApiKeys(await loadAllKeys(s.rememberKeys, s.providers));
      setInstalledSkills(skills);
      setReady(true);
    })();
  }, []);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      void saveSettings(next);
      return next;
    });
  }, []);

  const upsertProvider = useCallback(
    async (config: ProviderConfig) => {
      setSettingsState((prev) => {
        const idx = prev.providers.findIndex((p) => p.id === config.id);
        const providers =
          idx >= 0
            ? prev.providers.map((p) => (p.id === config.id ? config : p))
            : [...prev.providers, config];
        const next: Settings = {
          ...prev,
          providers,
          activeProviderId: prev.activeProviderId || config.id,
        };
        void saveSettings(next);
        return next;
      });
    },
    [],
  );

  const removeProvider = useCallback(async (id: string) => {
    setSettingsState((prev) => {
      const providers = prev.providers.filter((p) => p.id !== id);
      const next: Settings = {
        ...prev,
        providers,
        activeProviderId:
          prev.activeProviderId === id ? (providers[0]?.id ?? '') : prev.activeProviderId,
      };
      void saveSettings(next);
      return next;
    });
  }, []);

  const setActiveProvider = useCallback(async (id: string) => {
    setSettingsState((prev) => {
      const next = { ...prev, activeProviderId: id };
      void saveSettings(next);
      return next;
    });
  }, []);

  const setKey = useCallback(
    async (providerId: string, key: string) => {
      await setApiKey(providerId, key, settings.rememberKeys);
      setApiKeys((prev) => ({ ...prev, [providerId]: key }));
    },
    [settings.rememberKeys],
  );

  const changeRemember = useCallback(
    async (remember: boolean) => {
      await migrateKeys(settings.rememberKeys, remember);
      const next = { ...settings, rememberKeys: remember };
      await saveSettings(next);
      setSettingsState(next);
      setApiKeys(await loadAllKeys(remember, next.providers));
    },
    [settings],
  );

  const testProvider = useCallback(async (config: ProviderConfig, apiKey: string) => {
    return engineTest(config, apiKey);
  }, []);

  const activeProvider = useMemo(
    () => settings.providers.find((p) => p.id === settings.activeProviderId) ?? null,
    [settings.providers, settings.activeProviderId],
  );

  const installSkill = useCallback(async (skill: Skill) => {
    await persistInstall(skill);
    setInstalledSkills(await loadInstalledSkills());
  }, []);

  const removeSkill = useCallback(async (id: string) => {
    await persistRemove(id);
    setInstalledSkills(await loadInstalledSkills());
    setSettingsState((prev) => {
      const next: Settings = {
        ...prev,
        enabledSkillIds: prev.enabledSkillIds.filter((s) => s !== id),
      };
      void saveSettings(next);
      return next;
    });
  }, []);

  const toggleSkill = useCallback(
    async (id: string, enabled: boolean) => {
      setSettingsState((prev) => {
        const ids = new Set(prev.enabledSkillIds);
        if (enabled) ids.add(id);
        else ids.delete(id);
        const next: Settings = { ...prev, enabledSkillIds: Array.from(ids) };
        void saveSettings(next);
        return next;
      });
    },
    [],
  );

  const importSkillJson = useCallback(
    async (raw: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false, error: '不是有效的 JSON' };
      }
      const v = validateImport(parsed);
      if (!v.ok) {
        log('warn', 'skill', `import failed: ${v.error}`);
        return { ok: false, error: v.error };
      }
      await persistInstall(v.skill);
      log('info', 'skill', `imported ${v.skill.id} v${v.skill.version}`);
      setInstalledSkills(await loadInstalledSkills());
      return { ok: true };
    },
    [],
  );

  const value = useMemo<SettingsContextValue>(
    () => ({
      ready,
      settings,
      providers: settings.providers,
      activeProvider,
      apiKeys,
      installedSkills,
      updateSettings,
      upsertProvider,
      removeProvider,
      setActiveProvider,
      setKey,
      changeRemember,
      testProvider,
      installSkill,
      removeSkill,
      toggleSkill,
      importSkillJson,
    }),
    [
      ready,
      settings,
      activeProvider,
      apiKeys,
      installedSkills,
      updateSettings,
      upsertProvider,
      removeProvider,
      setActiveProvider,
      setKey,
      changeRemember,
      testProvider,
      installSkill,
      removeSkill,
      toggleSkill,
      importSkillJson,
    ],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
