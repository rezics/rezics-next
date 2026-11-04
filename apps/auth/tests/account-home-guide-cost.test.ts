import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountHomeGuide } from '../src/account-home-guide';
import { locales, overwriteGetLocale } from '../src/paraglide/runtime.js';
import en from '../messages/en.json';

test('all eight public guides contain translated prerequisites and perform zero observations', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error('public guide attempted a request');
  }) as typeof fetch;
  try {
    const keys = Object.keys(en).filter((key) => key.startsWith('auth_home_'));
    for (const locale of locales) {
      const copy = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
      expect(keys.every((key) => typeof copy[key] === 'string' && copy[key].length > 0)).toBe(true);
      overwriteGetLocale(() => locale);
      const html = renderToStaticMarkup(createElement(AccountHomeGuide));
      expect(html).toContain(copy.auth_home_organization);
      expect(html).toContain(copy.auth_home_selection_heading);
      expect(html).toContain('href="/automated/new"');
      expect(html).not.toContain('<details');
    }
    expect(locales).toHaveLength(8);
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    overwriteGetLocale(() => 'en');
  }
});
