import { afterEach, expect, test } from 'bun:test';
import { useState } from 'react';
import { creationFixture, dom, flush, open } from './creation-page-fixture';
import { AuthPage, AuthShell } from '../src/frame';
import { localeNames } from '../src/locale-choice';
import {
  applyDocumentLocale,
  initializeDocumentLocale,
  observeLocaleComponent,
  restoreDocumentLocale,
} from '../src/locale-observation';
import { cookieName, getLocale, locales } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

creationFixture();
afterEach(() => {
  document.cookie = `${cookieName}=; path=/; max-age=0`;
});
const Page = observeLocaleComponent(function Page() {
  const [draft, setDraft] = useState('');
  return (
    <AuthShell>
      <AuthPage heading={m.auth_login_heading()}>
        <input aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </AuthPage>
    </AuthShell>
  );
});
function select(host: HTMLElement, value: string) {
  const control = host.querySelector('select')!;
  control.value = value;
  control.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event);
}
const apply = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.auth-locale-actions button')!.click();

test('real shell offers eight autonyms, stages/cancels with focus, and changes the mounted presentation', async () => {
  initializeDocumentLocale('en');
  const p = await open(<Page />, {});
  const options = [...p.host.querySelectorAll('option')];
  expect(options.map((option) => [option.value, option.textContent, option.lang])).toEqual(
    locales.map((locale) => [locale, localeNames[locale], locale]),
  );
  const control = p.host.querySelector('select')!;
  expect(p.host.querySelector(`label[for="${control.id}"]`)?.textContent).toContain('Language');
  await flush(() => select(p.host, 'ja'));
  expect(getLocale()).toBe('en');
  await flush(() => p.host.querySelectorAll<HTMLButtonElement>('.auth-locale-actions button')[1]!.click());
  expect(control.value).toBe('en');
  expect(document.activeElement).toBe(control);
  for (const locale of locales) {
    await flush(() => select(p.host, locale));
    if (p.host.querySelector('.auth-locale-actions')) await flush(() => apply(p.host));
    expect(document.documentElement.lang).toBe(locale);
    expect(control.value).toBe(locale);
    expect(p.host.querySelector('h1')?.textContent).toBe(m.auth_login_heading({}, { locale }));
    expect(control).toBe(p.host.querySelector('select'));
  }
  expect(p.calls).toHaveLength(0);
  expect(document.cookie).toBe(`${cookieName}=es`);
  expect(applyDocumentLocale('../../unsupported')).toBe('unsupported');
  expect(getLocale()).toBe('es');
});

test('blocked persistence preserves exact hydration language and reports the current-document choice', async () => {
  const cookie = Object.getOwnPropertyDescriptor(document, 'cookie');
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get() {
      throw new Error('blocked');
    },
    set() {},
  });
  try {
    initializeDocumentLocale('fr');
    const p = await open(<Page />, {});
    expect(p.host.querySelector('select')!.value).toBe('fr');
    expect(p.host.querySelector('h1')?.textContent).toBe(m.auth_login_heading({}, { locale: 'fr' }));
    await flush(() => select(p.host, 'ko'));
    await flush(() => apply(p.host));
    expect(document.documentElement.lang).toBe('ko');
    expect(p.host.querySelector('[role=status]')?.textContent).toBe(m.auth_locale_temporary());
  } finally {
    if (cookie) Object.defineProperty(document, 'cookie', cookie);
    else Reflect.deleteProperty(document, 'cookie');
  }
});

test('rapid draft replacement and restored choice cannot republish a departed selection', async () => {
  initializeDocumentLocale('en');
  const p = await open(<Page />, {});
  await flush(() => {
    select(p.host, 'ja');
    select(p.host, 'de');
  });
  await flush(() => apply(p.host));
  expect(getLocale()).toBe('de');
  await flush(() => select(p.host, 'es'));
  await flush(() => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event));
  document.cookie = `${cookieName}=fr; path=/`;
  await flush(() => {
    restoreDocumentLocale();
    window.dispatchEvent(new dom.Event('pageshow') as unknown as Event);
  });
  expect(p.host.querySelector('select')!.value).toBe('fr');
  expect(document.cookie).toBe(`${cookieName}=fr`);
  expect(p.host.querySelector('.auth-locale-actions')).toBeNull();
  expect(p.calls).toHaveLength(0);
});
