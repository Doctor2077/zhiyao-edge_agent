import { z } from 'zod';
import { browser } from 'wxt/browser';
import { ProviderConfigSchema } from './providers';

export const SettingsSchema = z.object({
  providers: z.array(ProviderConfigSchema).default([]),
  activeProviderId: z.string().default(''),
  /** 密钥存储方式：true=记住（local，明文本机）；false=仅本次会话（session，关浏览器即清） */
  rememberKeys: z.boolean().default(false),
  /** 演示模式：无 Key 或手动开启时使用本地 mock 回复 */
  demoMode: z.boolean().default(true),
  /** 发送前自动读取当前页面 */
  autoReadPage: z.boolean().default(true),
  /** 发送前展示将发送的页面上下文 */
  previewBeforeSend: z.boolean().default(true),
  /** 已启用的技能 id 列表（启用后指令注入系统提示词） */
  enabledSkillIds: z.array(z.string()).default([]),
  /** 默认技能是否已自动播种（仅首次生效，之后尊重用户开关/删除） */
  defaultSkillsSeeded: z.boolean().default(false),
  /** 界面语言：auto=跟随浏览器，zh=中文，en=English */
  lang: z.enum(['auto', 'zh', 'en']).default('auto'),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

const SETTINGS_KEY = 'settings';
const KEYS_STORE_KEY = 'apiKeys';

export async function loadSettings(): Promise<Settings> {
  const data = await browser.storage.local.get(SETTINGS_KEY);
  const parsed = SettingsSchema.safeParse(data[SETTINGS_KEY]);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

function keyArea(remember: boolean) {
  return remember ? browser.storage.local : browser.storage.session;
}

/** 读取服务商 API Key（按 rememberKeys 决定存储区域） */
export async function getApiKey(
  providerId: string,
  rememberKeys: boolean,
): Promise<string> {
  const data = await keyArea(rememberKeys).get(KEYS_STORE_KEY);
  const keys = (data[KEYS_STORE_KEY] as Record<string, string> | undefined) ?? {};
  return keys[providerId] ?? '';
}

export async function setApiKey(
  providerId: string,
  key: string,
  rememberKeys: boolean,
): Promise<void> {
  const area = keyArea(rememberKeys);
  const data = await area.get(KEYS_STORE_KEY);
  const keys = (data[KEYS_STORE_KEY] as Record<string, string> | undefined) ?? {};
  if (key === '') {
    delete keys[providerId];
  } else {
    keys[providerId] = key;
  }
  await area.set({ [KEYS_STORE_KEY]: keys });
}

/** rememberKeys 切换时把密钥在两个区域间迁移 */
export async function migrateKeys(fromRemember: boolean, toRemember: boolean): Promise<void> {
  if (fromRemember === toRemember) return;
  const fromArea = keyArea(fromRemember);
  const toArea = keyArea(toRemember);
  const [fromData, toData] = await Promise.all([
    fromArea.get(KEYS_STORE_KEY),
    toArea.get(KEYS_STORE_KEY),
  ]);
  const fromKeys = (fromData[KEYS_STORE_KEY] as Record<string, string> | undefined) ?? {};
  const toKeys = (toData[KEYS_STORE_KEY] as Record<string, string> | undefined) ?? {};
  const merged = { ...toKeys, ...fromKeys };
  await toArea.set({ [KEYS_STORE_KEY]: merged });
  await fromArea.remove(KEYS_STORE_KEY);
}
