import { resourceHref } from '../features/address/path.ts';
import { describe, expect, test } from 'bun:test';
import { defineMessages, localeNames, uiLocales } from '../i18n/define.ts';
import { i18n } from '../i18n/instance.ts';
import {
  isPublicPagePath,
  localizedPath,
  matchUiLocaleTag,
  pathLocale,
  resolveLocale,
  withoutLocale,
} from '../i18n/locale.ts';
import { navigation } from '../features/shell/navigation.ts';
import { defaultModuleTitle } from '../features/zones/messages.ts';

describe('interface locale', () => {
  test('a selected locale wins over browser preference and invalid choices fall back', () => {
    expect(resolveLocale('zh-Hans', 'en-US,en;q=0.8')).toBe('zh-Hans');
    expect(resolveLocale('en', 'zh-Hans,zh;q=0.8')).toBe('en');
    expect(resolveLocale(undefined, 'zh-Hans,zh;q=0.8,en;q=0.5')).toBe('zh-Hans');
    expect(resolveLocale('not-supported', 'en-US,en;q=0.8')).toBe('en');
    expect(resolveLocale(undefined, 'zh-TW,zh;q=0.8')).toBe('zh-Hant');
    expect(resolveLocale(undefined, 'zh-CN,zh;q=0.8')).toBe('zh-Hans');
    expect(resolveLocale(undefined, 'ja-JP,de;q=0.5')).toBe('ja');
    expect(resolveLocale(undefined, 'pt-BR,fr-FR;q=0.6')).toBe('fr');
    expect(resolveLocale(undefined, null)).toBe('en');
  });

  test('all eight prefixes are canonical and regional browser tags match them', () => {
    expect(uiLocales).toEqual(['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']);
    expect(Object.values(localeNames)).toEqual([
      'English',
      '繁體中文',
      '简体中文',
      '日本語',
      '한국어',
      'Deutsch',
      'Français',
      'Español',
    ]);
    for (const locale of uiLocales) expect(pathLocale(`/${locale}/search`)).toBe(locale);
    for (const tag of ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO'])
      expect(matchUiLocaleTag(tag)).toBe('zh-Hant');
    for (const tag of ['zh', 'zh-Hans', 'zh-CN', 'zh-SG'])
      expect(matchUiLocaleTag(tag)).toBe('zh-Hans');
    expect(matchUiLocaleTag('ko-KR')).toBe('ko');
    expect(matchUiLocaleTag('pt-BR')).toBeUndefined();
  });

  test('main navigation has a full accessible name and concise phone captions', () => {
    for (const locale of uiLocales) {
      for (const item of navigation) expect(item.label[locale].trim()).not.toBe('');
    }
    const notifications = navigation.find((item) => item.href === '/notifications')!;
    expect(notifications.label.de).toBe('Benachrichtigungen');
    expect(notifications.bottomLabel?.de).toBe('Meldungen');
    expect(notifications.label.fr).toBe('Notifications');
    expect(notifications.bottomLabel?.fr).toBe('Alertes');
    expect(notifications.label.es).toBe('Notificaciones');
    expect(notifications.bottomLabel?.es).toBe('Avisos');
    const library = navigation.find((item) => item.href === '/library')!;
    expect(library.label.fr).toBe('Bibliothèque');
    expect(library.bottomLabel?.fr).toBe('Livres');
  });

  test('every supplied locale is returned as given', () => {
    const en = { heading: 'Hello', action: 'Continue' };
    const catalog = defineMessages({
      en,
      'zh-Hant': en,
      'zh-Hans': { heading: '你好', action: '继续' },
      ja: en,
      ko: en,
      de: { heading: 'Hallo', action: 'Weiter' },
      fr: en,
      es: en,
    });
    expect(catalog.de).toEqual({ heading: 'Hallo', action: 'Weiter' });
    expect(catalog.fr).toEqual(en);
    expect(catalog['zh-Hans'].heading).toBe('你好');
  });

  test('page paths keep one locale prefix while preserving query and fragments', () => {
    expect(pathLocale(localizedPath(resourceHref('/w/', 'book'), 'zh-Hans'))).toBe('zh-Hans');
    expect(pathLocale('/english/w/book')).toBeNull();
    expect(localizedPath(`${resourceHref('/w/', 'book')}?scope=realm#ratings`, 'zh-Hans')).toBe(
      localizedPath(`${resourceHref('/w/', 'book')}?scope=realm#ratings`, 'zh-Hans'),
    );
    expect(
      localizedPath(localizedPath(`${resourceHref('/w/', 'book')}?scope=mine`, 'en'), 'zh-Hans'),
    ).toBe(localizedPath(`${resourceHref('/w/', 'book')}?scope=mine`, 'zh-Hans'));
    expect(localizedPath('/', 'en')).toBe('/en');
    expect(withoutLocale(localizedPath(resourceHref('/w/', 'book'), 'en'))).toBe(
      resourceHref('/w/', 'book'),
    );
    expect(isPublicPagePath(localizedPath(resourceHref('/w/', 'book'), 'zh-Hans'))).toBe(true);
    expect(isPublicPagePath('/identity/select')).toBe(false);
    expect(isPublicPagePath('/inbox')).toBe(false);
  });

  test('native-i18n resolves isolated catalogs for concurrent requests', async () => {
    const [english, chinese] = await Promise.all([
      i18n.getTranslation('search', ['en']),
      i18n.getTranslation('search', ['zh-Hans']),
    ]);
    expect(english.locale.current).toBe('en');
    expect(chinese.locale.current).toBe('zh-Hans');
    expect(english.t.title).toBe('Search works');
    expect(chinese.t.title).toBe('搜索作品');
    expect(english.t.anyLanguage).toBe('Any language');
    expect(chinese.t.anyLanguage).toBe('不限语言');
  });

  test('every visible namespace resolves in all eight supported locales', async () => {
    for (const locale of uiLocales) {
      const result = await i18n.getTranslation(
        ['shell', 'home', 'search', 'auth', 'work', 'studio'],
        [locale],
      );
      expect(result.locale.current).toBe(locale);
      expect(result.t.auth.signInHeading).toContain('REZICS');
      if (locale === 'en') expect(result.t.auth.signInHeading).toBe('Sign in to REZICS');
      expect(result.t.studio.newHeading.length).toBeGreaterThan(0);
      if (locale === 'en') expect(result.t.studio.newHeading).toBe('Start a new work');
      for (const namespace of ['shell', 'home', 'search', 'auth', 'work', 'studio'] as const) {
        const single = await i18n.getTranslation(namespace, [locale]);
        expect(single.locale.current).toBe(locale);
      }
    }
  });

  test('Zone module fallback headings resolve in every interface locale', async () => {
    const types = [
      'hero-carousel',
      'chip-nav',
      'announcement',
      'shelf',
      'ranking',
      'editorial-list',
      'quote-stream',
      'rising',
      'decision-log',
      'discussion-list',
      'people',
    ] as const;
    for (const locale of uiLocales) {
      const { t } = await i18n.getTranslation('zones', [locale]);
      for (const type of types) expect(defaultModuleTitle(type, t).trim()).not.toBe('');
      if (locale !== 'en') expect(defaultModuleTitle('hero-carousel', t)).not.toBe('Featured');
    }
  });
});
