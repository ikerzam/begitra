import { createI18n } from "vue-i18n";

import en from "./en.json";
import es from "./es.json";

/** The English messages define the schema; `es.json` must carry exactly the same keys. */
export type MessageSchema = typeof en;

export const locales = ["en", "es"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

/** Called by vue-i18n when a key is missing in the active locale (and then in the fallback). */
export type MissingHandler = (locale: string, key: string) => void;

export interface AppI18nOptions {
  locale?: Locale;
  missing?: MissingHandler;
}

/**
 * Builds an i18n instance in composition mode. The app installs one (see `i18n` below);
 * tests build their own so that a locale change never leaks into the next test.
 */
export function createAppI18n(options: AppI18nOptions = {}) {
  return createI18n<[MessageSchema], Locale, false>({
    legacy: false,
    locale: options.locale ?? defaultLocale,
    fallbackLocale: defaultLocale,
    messages: { en, es },
    missing: options.missing,
  });
}

export const i18n = createAppI18n();

/** Switches the active locale and keeps `<html lang>` in sync for assistive technology. */
export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}
