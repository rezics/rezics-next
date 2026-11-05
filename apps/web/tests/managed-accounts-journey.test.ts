import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installManagedModuleMocks } from './fixtures/managed-module-mocks';

// Paraglide reads the locale from the document URL only when a window exists before its runtime loads.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/settings' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
// Each file owns its globals while its tests run; test files load together in one process.
const install = () => {
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
};
install();
// The shared module mocks load before the settings modules, so no cached import keeps a different environment.
installManagedModuleMocks();
beforeAll(install);
const { failure, issuerPage, loadDetail, loadInventory, readCursors } = await import('../src/accounts/management/data');
const { AccountManagementPage } = await import('../src/accounts/management/pages');
const { inventoryExample, detailExample, organization, human, automation } = await import(
  '../src/accounts/management/story-api'
);
const { getLocale, locales, setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
const { isSignedInPath } = await import('../src/session/guard');
const { managedAccountHref } = await import('../src/settings/managed-accounts-read');
const { managedAccountsBackHref } = await import('../src/settings/managed-account-detail-read');

afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Settings directory/detail return preserves the locale and unrelated repeated query operands', () => {
  for (const locale of locales) {
    const directory = `/${locale}/settings?panel=compact&filter=a%2Bb&filter=c%26d#account`;
    const target = managedAccountHref(directory, organization.id);
    expect(managedAccountsBackHref(target)).toBe(directory);
    expect(managedAccountsBackHref(`${target.replace('#account', '')}&managedAccount=${human.id}#account`)).toBe(
      directory,
    );
  }
});

// Focused transport tests. Native and real served journey review runs at integration, not in this fixture.
test('management adapters use generated native paths and the current caller credential without a target identity override', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(
        new URL(request.url).pathname.endsWith('/management') ? detailExample(organization.id) : inventoryExample(),
      );
    }) as typeof fetch,
  });
  const inventory = await loadInventory(client, 'Bearer current-viewer', {
    organizationsCursor: 'org-page',
    operatorsCursor: 'operator-page',
  });
  const detail = await loadDetail(client, 'Bearer current-viewer', organization.id, { membersCursor: 'member-page' });
  expect(inventory.state).toBe('ready');
  expect(detail.state).toBe('ready');
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    '/v1/me/managedAccounts',
    `/v1/accounts/${organization.id}/management`,
  ]);
  expect(new URL(requests[0]!.url).searchParams.get('organizationsCursor')).toBe('org-page');
  expect(new URL(requests[1]!.url).searchParams.get('membersCursor')).toBe('member-page');
  for (const request of requests) {
    expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
    expect(request.method).toBe('GET');
    expect(request.body).toBeNull();
    expect(new URL(request.url).searchParams.has('requested_by')).toBe(false);
  }
});

test('denial and unavailable reads never become an empty successful inventory', async () => {
  for (const [status, expected] of [
    [403, 'denied'],
    [503, 'unavailable'],
    [401, 'signed-out'],
    [404, 'missing'],
  ] as const) {
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async () => Response.json({ code: 'forbidden' }, { status })) as typeof fetch,
    });
    expect(await loadInventory(client, 'Bearer current-viewer', {})).toEqual({ state: expected });
  }
  expect(failure(503, { code: 'membership_inverse_incomplete' })).toEqual({ state: 'preparing' });
});

test('issuer links retain the two supported page profiles and account routes are private in every launch locale', () => {
  expect(issuerPage('https://auth.example.test', '/organizations/new')).toBe(
    'https://auth.example.test/organizations/new',
  );
  expect(issuerPage('https://auth.example.test', '/account/delete')).toBe('https://auth.example.test/account/delete');
  expect(issuerPage('javascript:alert(1)', '/account/delete')).toBeNull();
  expect(issuerPage('https://secret@auth.example.test', '/account/delete')).toBeNull();
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    expect(isSignedInPath(`/${locale}/accounts`)).toBe(true);
    expect(isSignedInPath(`/${locale}/accounts/${organization.id}`)).toBe(true);
    expect(isSignedInPath(`/${locale}/organizations/${organization.id}`)).toBe(true);
  }
  expect(readCursors({ operatorsCursor: 'next', membersCursor: 'x'.repeat(4097), requested_by: 'foreign' })).toEqual({
    operatorsCursor: 'next',
  });
});

test('Legacy account and organization management reaches the current selected Settings target without inferring permission or another fetch', async () => {
  const previousLocale = getLocale();
  const requests: Request[] = [];
  const targets = [
    detailExample(human.id),
    detailExample(automation.id),
    detailExample(organization.id),
    {
      ...detailExample(organization.id),
      role: 'member' as const,
      members: { state: 'denied' as const, items: [], next: null },
      responsibilities: null,
    },
  ];
  try {
    for (const value of targets) {
      const client = createKernelClient('https://kernel.example.test', {
        fetch: (async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json(value);
        }) as typeof fetch,
      });
      const page = await loadDetail(client, 'Bearer current-viewer', value.account.id, {});
      const requestCount = requests.length;
      for (const locale of locales) {
        window.history.replaceState(null, '', `/${locale}/settings`);
        setLocale(locale, { reload: false });
        const html = renderToStaticMarkup(
          createElement(AccountManagementPage, {
            page: { ...page, issuer: 'https://auth.example.test', organizationsAvailable: null },
            retry() {},
          }),
        );
        // Exactly one selector, with no permission, operation or caller context attached.
        expect(html.match(/href="[^"]*\?managedAccount=[^"]*"/g)).toEqual([
          `href="/${locale}/settings?managedAccount=${encodeURIComponent(value.account.id)}#account"`,
        ]);
        expect(html).toContain(m.managed_options());
        expect(html).toContain(m.managed_options_guidance());
        expect(html).toContain(m.managed_operation_status());
        expect(html.includes('https://auth.example.test/account/delete')).toBe(value.self);
        if (value.members.state === 'denied') expect(html).toContain(m.managed_holders_denied());
        expect(html).not.toContain('current-viewer');
        expect(requests).toHaveLength(requestCount);
      }
      const request = requests.at(-1)!;
      expect(request.method).toBe('GET');
      expect(request.url).toBe(`https://kernel.example.test/v1/accounts/${value.account.id}/management`);
      expect(request.body).toBeNull();
    }
    for (const status of [401, 403, 404, 503]) {
      const client = createKernelClient('https://kernel.example.test', {
        // Even a response carrying fixture identity must not yield a target after a denied read.
        fetch: (async () =>
          Response.json({ ...detailExample(organization.id), code: 'forbidden' }, { status })) as typeof fetch,
      });
      const page = await loadDetail(client, 'Bearer current-viewer', organization.id, {});
      for (const locale of locales) {
        setLocale(locale, { reload: false });
        const html = renderToStaticMarkup(createElement(AccountManagementPage, { page, retry() {} }));
        expect(html).not.toContain('managedAccount=');
        expect(html).not.toContain(organization.id);
        expect(html).not.toContain(m.managed_options());
      }
    }
  } finally {
    setLocale(previousLocale, { reload: false });
  }
});
