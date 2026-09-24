import { describe, expect, test } from 'bun:test';
import { i18n, resolveLocale } from '../i18n/locale.ts';

describe('interface locale', () => {
  test('a selected locale wins over browser preference and invalid choices fall back', () => {
    expect(resolveLocale('zh-CN', 'en-US,en;q=0.8')).toBe('zh-CN');
    expect(resolveLocale('en', 'zh-CN,zh;q=0.8')).toBe('en');
    expect(resolveLocale(undefined, 'zh-CN,zh;q=0.8,en;q=0.5')).toBe('zh-CN');
    expect(resolveLocale('not-supported', 'en-US,en;q=0.8')).toBe('en');
    expect(resolveLocale(undefined, null)).toBe('en');
  });

  test('native-i18n resolves isolated catalogs for concurrent requests', async () => {
    const [english, chinese] = await Promise.all([
      i18n.getTranslation('search', ['en']),
      i18n.getTranslation('search', ['zh-CN']),
    ]);
    expect(english.locale.current).toBe('en');
    expect(chinese.locale.current).toBe('zh-CN');
    expect(english.t.title).toBe('Search works');
    expect(chinese.t.title).toBe('搜索作品');
    expect(english.t.anyLanguage).toBe('Any language');
    expect(chinese.t.anyLanguage).toBe('不限语言');
  });

  test('every visible namespace resolves in both supported locales', async () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const result = await i18n.getTranslation(['shell', 'home', 'search', 'auth', 'work', 'studio'], [locale]);
      expect(result.locale.current).toBe(locale);
      expect(result.t.auth.signInHeading).toBe(locale === 'en' ? 'Sign in to REZICS' : '登录 REZICS');
      expect(result.t.studio.createHeading).toBe(locale === 'en' ? 'Create a Work' : '创建作品');
      for (const namespace of ['shell', 'home', 'search', 'auth', 'work', 'studio'] as const) {
        const single = await i18n.getTranslation(namespace, [locale]);
        expect(single.locale.current).toBe(locale);
      }
    }
  });
});
