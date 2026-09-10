import { uiLang } from '../i18n';

/** 按界面语言取中文或英文标签 */
export function langLabel(zh: string, en?: string): string {
  return uiLang() === 'zh' ? zh : (en || zh);
}
