const uiLocales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
type UiLocale = (typeof uiLocales)[number];

/** Map the tag LocaleProvider already supplies onto an interface locale. */
export function uiCopyLocale(tag: string | undefined): UiLocale {
  const value = (tag ?? 'en').toLowerCase();
  if (value === 'zh' || value === 'zh-hans' || value === 'zh-cn' || value === 'zh-sg') return 'zh-Hans';
  if (value === 'zh-hant' || value.startsWith('zh-tw') || value.startsWith('zh-hk') || value.startsWith('zh-mo')) {
    return 'zh-Hant';
  }
  const primary = value.split('-')[0] ?? 'en';
  if (primary === 'ja' || primary === 'ko' || primary === 'de' || primary === 'fr' || primary === 'es') return primary;
  return 'en';
}
