/**
 * Tiny rune-based i18n: dictionary lookup with `{param}` interpolation.
 * The chosen locale persists in localStorage.
 */
import en, { type Dict, type TKey } from "./en";
import id from "./id";

export type Locale = "en" | "id";

const dictionaries: Record<Locale, Dict> = { en, id };
const STORAGE_KEY = "lova.locale";

class I18n {
  locale = $state<Locale>("en");

  constructor() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "en" || saved === "id") this.locale = saved;
    } catch {
      /* localStorage unavailable — keep default */
    }
  }

  set(locale: Locale): void {
    this.locale = locale;
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* ignore */
    }
  }

  t(key: TKey, params?: Record<string, string | number>): string {
    let text: string = dictionaries[this.locale][key] ?? dictionaries.en[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replaceAll(`{${k}}`, String(v));
      }
    }
    return text;
  }
}

export const i18n = new I18n();

/** Convenience function usable directly in markup. */
export function t(key: TKey, params?: Record<string, string | number>): string {
  return i18n.t(key, params);
}
