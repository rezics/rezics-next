import { describe, expect, test } from 'bun:test';
import { i18n } from '../i18n/locale.ts';
import { resources } from '../i18n/resources.ts';

const namespaces = Object.keys(resources.loaders.en) as (keyof typeof resources.loaders.en)[];

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || '$nativeI18n' in value) return [prefix];
  return Object.entries(value).flatMap(([key, item]) => keys(item, prefix ? `${prefix}.${key}` : key));
}

describe('Accounts message catalogs', () => {
  test('every namespace has the same messages in both locales', async () => {
    for (const namespace of namespaces) {
      const [english, chinese] = await Promise.all([resources.loaders.en[namespace](),
        resources.loaders['zh-CN'][namespace]()]);
      expect(keys(chinese).sort()).toEqual(keys(english).sort());
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

  test('messages materialize in both locales', async () => {
    const [english, chinese] = await Promise.all([i18n.getTranslation(namespaces, ['en']),
      i18n.getTranslation(namespaces, ['zh-CN'])]);
    expect(english.t.account.greeting({ name: 'Ada' })).toBe('Welcome, Ada');
    expect(chinese.t.account.greeting({ name: 'Ada' })).toBe('欢迎，Ada');
    expect(english.t.account.appsCardBody(0)).toBe('No apps can use your account');
    expect(english.t.account.appsCardBody(2)).toBe('2 apps can use your account');
    expect(chinese.t.account.deviceOn({ browser: 'Chrome', os: 'macOS' })).toBe('macOS 上的 Chrome');
    expect(english.t.consent.title({ app: 'Reader' })).toBe('Reader wants to access your REZICS Account');
  });
});
