import { browser } from 'wxt/browser';
import type { Lang } from '@/core/prompts';

// WXT 将 getMessage 参数收窄为已知 key 的字面量联合类型，
// 这里放宽为 string 以便动态 key 访问。
const getMessage = browser.i18n.getMessage as unknown as (
  key: string,
  substitutions?: string | string[],
) => string;

/** 用户手动设置的语言覆盖；'auto' 表示跟随浏览器 */
let langOverride: Lang | 'auto' = 'auto';

/** 双语词典缓存（从 _locales 加载，用于语言切换；加载失败回退 browser.i18n） */
let dicts: Partial<Record<Lang, Record<string, string>>> | null = null;

async function loadDicts(): Promise<void> {
  try {
    const [zh, en] = await Promise.all([
      fetch(browser.runtime.getURL('/_locales/zh_CN/messages.json')).then((r) => r.json()),
      fetch(browser.runtime.getURL('/_locales/en/messages.json')).then((r) => r.json()),
    ]);
    const normalize = (obj: Record<string, { message: string }>): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = v.message;
      return out;
    };
    dicts = { zh: normalize(zh), en: normalize(en) };
  } catch {
    dicts = null;
  }
}
void loadDicts();

/** 设置语言覆盖（settings.lang 变更时调用；'auto' 恢复跟随浏览器） */
export function setLangOverride(lang: Lang | 'auto'): void {
  langOverride = lang;
}

function browserLang(): Lang {
  return browser.i18n.getUILanguage().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function uiLang(): Lang {
  return langOverride === 'auto' ? browserLang() : langOverride;
}

/** 取本地化文案，支持 {placeholder} 替换；优先用当前语言的词典（支持运行时切换） */
export function t(
  key: string,
  params?: Record<string, string | number>,
): string {
  const dict = dicts?.[uiLang()];
  let msg = dict?.[key] ?? (getMessage(key) || key);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replaceAll(`{${k}}`, String(v));
    }
  }
  return msg;
}
