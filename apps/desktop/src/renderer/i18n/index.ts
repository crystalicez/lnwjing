import type { UiLocale } from '@lnwjing/ipc-contracts';
import { en, th, type MessageKey, type Messages } from './messages.js';

const catalogs: Record<UiLocale, Messages> = { th, en };

export type TranslationParams = Readonly<Record<string, string | number>>;
export type Translator = (key: MessageKey, params?: TranslationParams) => string;

export function createTranslator(locale: UiLocale): Translator {
  const catalog = catalogs[locale] ?? th;
  return (key: MessageKey, params?: TranslationParams): string => interpolate(catalog[key] ?? en[key] ?? key, params);
}

function interpolate(template: string, params: TranslationParams | undefined): string {
  if (params === undefined) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}
