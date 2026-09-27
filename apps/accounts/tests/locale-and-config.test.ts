import { describe, expect, test } from 'bun:test';
import { accountsConfig, httpOrigin } from '../features/config/env.ts';
import { applyLocaleParameter, LOCALE_COOKIE, resolveLocale } from '../i18n/locale.ts';

describe('Accounts configuration', () => {
  test('defaults match the shared task dev backend', () => {
    const config = accountsConfig({});
    expect(config.ACCOUNT_SERVICE_ORIGIN).toBe('http://127.0.0.1:3002');
    expect(config.ACCOUNT_BASE_URL).toBe('http://127.0.0.1:3004');
    expect(config.WEB_ORIGIN).toBe('http://127.0.0.1:3000');
  });

  test('origins must be bare HTTP(S) origins', () => {
    expect(httpOrigin('X', 'https://accounts.rezics.test/')).toBe('https://accounts.rezics.test');
    for (const value of ['https://a.test/api', 'https://a.test/?q', 'ftp://a.test/', 'https://u:p@a.test/']) {
      expect(() => httpOrigin('X', value)).toThrow('X must be an HTTP(S) origin');
    }
  });
});

describe('Accounts interface locale', () => {
  test('a chosen locale wins, then the browser’s languages', () => {
    expect(resolveLocale('zh-CN', 'en-US,en;q=0.8')).toBe('zh-CN');
    expect(resolveLocale(undefined, 'zh-CN,zh;q=0.9')).toBe('zh-CN');
    expect(resolveLocale('fr', 'fr-FR')).toBe('en');
    expect(resolveLocale(undefined, null)).toBe('en');
  });

  test('?hl= renders this request in that language and remembers it', () => {
    const { request, setCookie } = applyLocaleParameter(new Request('https://accounts.test/security?hl=zh-CN',
      { headers: { cookie: `a=1; ${LOCALE_COOKIE}=en` } }));
    expect(request.headers.get('cookie')).toBe(`a=1; ${LOCALE_COOKIE}=zh-CN`);
    expect(setCookie).toBe(`${LOCALE_COOKIE}=zh-CN; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure`);
    for (const url of ['https://accounts.test/?hl=de', 'https://accounts.test/']) {
      expect(applyLocaleParameter(new Request(url)).setCookie).toBeUndefined();
    }
    expect(applyLocaleParameter(new Request('https://accounts.test/?hl=zh-CN', { method: 'POST' }))
      .setCookie).toBeUndefined();
  });

  test('an OAuth ui_locales hint applies once and never overrides a chosen language', () => {
    const hinted = applyLocaleParameter(new Request('http://accounts.test/sign-in?ui_locales=zh-Hans%20en'));
    expect(hinted.request.headers.get('cookie')).toBe(`${LOCALE_COOKIE}=zh-CN`);
    expect(hinted.setCookie).toBeUndefined();
    const chosen = new Request('http://accounts.test/sign-in?ui_locales=zh-CN',
      { headers: { cookie: `${LOCALE_COOKIE}=en` } });
    expect(applyLocaleParameter(chosen).request).toBe(chosen);
  });
});
