import { describe, expect, test } from 'bun:test';
import { i18n } from '../i18n/locale.ts';
import { uiLocales } from '../i18n/locale.ts';
import { resources } from '../i18n/resources.ts';

const namespaces = ['common', 'auth', 'consent', 'account', 'admin'] as const;

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || '$nativeI18n' in value) return [prefix];
  return Object.entries(value).flatMap(([key, item]) => keys(item, prefix ? `${prefix}.${key}` : key));
}

describe('Accounts message catalogs', () => {
  test('every namespace has the same messages in all interface locales after English fallback', async () => {
    expect(Object.keys(resources.loaders.en).sort()).toEqual([...namespaces].sort());
    for (const namespace of namespaces) {
      const english = await resources.loaders.en[namespace]();
      for (const locale of uiLocales) {
        const localized = await resources.loaders[locale][namespace]();
        expect({ namespace, locale, keys: keys(localized).sort() })
          .toEqual({ namespace, locale, keys: keys(english).sort() });
      }
    }
  });

  test('no namespace uses a key a function already owns', async () => {
    // native-i18n exposes a namespace as a function with its messages assigned.
    for (const namespace of namespaces) {
      const english = await resources.loaders.en[namespace]();
      for (const reserved of ['name', 'length', 'prototype', 'caller', 'arguments']) {
        expect(Object.keys(english)).not.toContain(reserved);
      }
    }
  });

  test('messages materialize translated keys and English per-key fallbacks', async () => {
    const [english, chinese, japanese] = await Promise.all([i18n.getTranslation(namespaces, ['en']),
      i18n.getTranslation(namespaces, ['zh-Hans']), i18n.getTranslation(namespaces, ['ja'])]);
    expect(english.t.account.greeting({ name: 'Ada' })).toBe('Welcome, Ada');
    expect(chinese.t.account.greeting({ name: 'Ada' })).toBe('欢迎，Ada');
    expect(japanese.t.account.greeting({ name: 'Ada' })).toBe('ようこそ、Ada さん');
    expect(english.t.account.appsCardBody(0)).toBe('No apps can use your account');
    expect(english.t.account.appsCardBody(2)).toBe('2 apps can use your account');
    expect(chinese.t.account.deviceOn({ browser: 'Chrome', os: 'macOS' })).toBe('macOS 上的 Chrome');
    expect(english.t.consent.title({ app: 'Reader' })).toBe('Reader wants to access your REZICS Account');
  });
});
