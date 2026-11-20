import { afterEach, expect, test } from 'bun:test';
import { creationFixture, dom, flush, open, chooseLocale } from './creation-page-fixture';
import type { Root } from 'react-dom/client';
import { AuthPage, AuthShell } from '../src/frame';
import { localeNames } from '../src/locale-choice';
import {
  applyDocumentLocale,
  initializeDocumentLocale,
  observeLocaleComponent,
  restoreDocumentLocale,
} from '../src/locale-observation';
import { cookieName, getLocale, isServer, locales } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

creationFixture();
const { hydrateRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
afterEach(() => {
  document.cookie = `${cookieName}=; path=/; max-age=0`;
});
const Page = observeLocaleComponent(function Page() {
  return (
    <AuthShell>
      <AuthPage heading={m.auth_login_heading()} />
    </AuthShell>
  );
});
const apply = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.auth-locale-actions button')!.click();
const selectedLabel = (control: Element) => control.querySelector('[data-slot="select-value"]')?.textContent;

const shellChoices =
  'real shell offers eight autonyms, stages/cancels with focus, and preserves rapid/restored choices';
test(shellChoices, async () => {
  // Paraglide captures its realm at import time. An earlier SSR test can cache its server runtime.
  if (isServer && process.env.REZICS_LOCALE_CHOICE_CHILD !== '1') {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path, '--test-name-pattern', shellChoices], {
      env: { ...process.env, REZICS_LOCALE_CHOICE_CHILD: '1' },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code, error).toBe(0);
    return;
  }

  initializeDocumentLocale('en');
  const p = await open(<Page />, {});
  await flush(() => p.host.querySelector<HTMLButtonElement>('[role=combobox]')!.click());
  const options = [...document.querySelectorAll<HTMLElement>('[role=option]')];
  expect(options).toHaveLength(8);
  expect(options.map((option) => [option.lang, option.textContent])).toEqual(
    locales.map((locale) => [locale, localeNames[locale]]),
  );
  await flush(() => document.querySelector<HTMLElement>('[role=option][lang=en]')!.click());
  const control = p.host.querySelector<HTMLButtonElement>('[role=combobox]')!;
  expect(p.host.querySelector(`label[for="${control.id}"]`)?.textContent).toContain('Language');
  await chooseLocale(p.host, 'ja');
  expect(getLocale()).toBe('en');
  await flush(() => p.host.querySelectorAll<HTMLButtonElement>('.auth-locale-actions button')[1]!.click());
  expect(selectedLabel(control)).toBe(localeNames.en);
  expect(document.activeElement).toBe(control);
  for (const locale of locales) {
    await chooseLocale(p.host, locale);
    if (p.host.querySelector('.auth-locale-actions')) await flush(() => apply(p.host));
    expect(document.documentElement.lang).toBe(locale);
    expect(selectedLabel(control)).toBe(localeNames[locale]);
    expect(p.host.querySelector('h1')?.textContent).toBe(m.auth_login_heading({}, { locale }));
    expect(control).toBe(p.host.querySelector('[role=combobox]'));
  }
  expect(p.calls).toHaveLength(0);
  expect(document.cookie).toBe(`${cookieName}=es`);
  expect(applyDocumentLocale('../../unsupported')).toBe('unsupported');
  expect(getLocale()).toBe('es');
  await chooseLocale(p.host, 'ja');
  await chooseLocale(p.host, 'de');
  await flush(() => apply(p.host));
  expect(getLocale()).toBe('de');
  await chooseLocale(p.host, 'es');
  await flush(() => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event));
  document.cookie = `${cookieName}=fr; path=/`;
  await flush(() => {
    restoreDocumentLocale();
    window.dispatchEvent(new dom.Event('pageshow') as unknown as Event);
  });
  expect(selectedLabel(control)).toBe(localeNames.fr);
  expect(document.cookie).toBe(`${cookieName}=fr`);
  expect(p.host.querySelector('.auth-locale-actions')).toBeNull();
  expect(p.calls).toHaveLength(0);
});

test('blocked persistence preserves exact hydration language and reports the current-document choice', async () => {
  const cookie = Object.getOwnPropertyDescriptor(document, 'cookie');
  let root: Root | undefined;
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get() {
      throw new Error('blocked');
    },
    set() {},
  });
  try {
    initializeDocumentLocale('fr');
    const host = document.body.appendChild(document.createElement('div'));
    host.innerHTML = renderToString(<Page />);
    expect(selectedLabel(host.querySelector('[role=combobox]')!)).toBe(localeNames.fr);
    const errors: unknown[] = [];
    await flush(() => {
      root = hydrateRoot(host, <Page />, { onRecoverableError: (error) => errors.push(error) });
    });
    expect(errors).toEqual([]);
    expect(selectedLabel(host.querySelector('[role=combobox]')!)).toBe(localeNames.fr);
    expect(host.querySelector('h1')?.textContent).toBe(m.auth_login_heading({}, { locale: 'fr' }));
    await chooseLocale(host, 'ko');
    await flush(() => apply(host));
    expect(document.documentElement.lang).toBe('ko');
    expect(host.querySelector('[role=status]')?.textContent).toBe(m.auth_locale_temporary());
  } finally {
    await flush(() => root?.unmount());
    if (cookie) Object.defineProperty(document, 'cookie', cookie);
    else Reflect.deleteProperty(document, 'cookie');
  }
});
