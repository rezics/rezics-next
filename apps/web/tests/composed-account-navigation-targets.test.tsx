import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import recording from '../src/kernel/recorded/agent-page.json';
import type { AccountViewerActions } from '../src/features/pages/account-read';
import type { OverviewValue } from '../src/features/pages/overview';

mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/@haruka' });
const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, value });
afterAll(() => {
  mock.restore();
  for (const [key, value] of previous)
    value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
  window.happyDOM.abort();
});
const accountRead = await import('../src/features/pages/account-read');
const replies: ((value: AccountViewerActions) => void)[] = [];
mock.module('../src/features/pages/account-read', () => ({
  ...accountRead,
  readAccountViewerActions: ({ data }: { data: string }) => {
    expect(data).toBe(recording.account);
    return new Promise<AccountViewerActions>((resolve) => replies.push(resolve));
  },
}));
const { createRoot } = await import('react-dom/client');
const { AccountIdentity } = await import('../src/features/pages/account');
const { OverviewContext } = await import('../src/features/pages/overview');
const { sessionQuery } = await import('../src/session/query');
const client = new QueryClient();
const body = Object.values(recording.reads).find((read) => 'accounts' in read.body)!.body;
const value = {
  locale: 'en',
  subject: null,
  reader: { suitability: 'blur' },
  labels: { cover: {} },
  link: 'a',
  sections: new Map([['identity', { ok: true, read: { kind: 'account' }, body }]]),
} as unknown as OverviewValue;
const ui = (
  <QueryClientProvider client={client}>
    <OverviewContext.Provider value={value}>
      <AccountIdentity id="identity" />
    </OverviewContext.Provider>
  </QueryClientProvider>
);
const host = window.document.createElement('main') as HTMLElement;
const links = () =>
  [...host.querySelectorAll('[data-slot="account-management-links"] a')].map((link) => link.getAttribute('href'));
const settle = async (action: () => void) =>
  act(async () => {
    action();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
const step = async (action: () => void, expected: string[] = []) => {
  await settle(action);
  expect(links()).toEqual(expected);
};
const session = (subject: string) => ({ state: 'signed-in', subject, csrfToken: 'same-token' });
const ready = (...operations: string[]): AccountViewerActions => ({
  state: 'ready',
  actions: ['account:read', 'account:update', 'account:manage'].map((action) => ({ action, operations })),
  securityHref: 'https://auth.test/security',
});

test('Account management actions follow the current reader and permissions through account changes and retry.', async () => {
  client.setQueryData(sessionQuery.queryKey, session('reader-a'));
  expect(renderToString(ui)).not.toContain('account-management-links');
  expect(replies).toHaveLength(0);
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    await step(() => root.render(ui));
    await step(
      () =>
        replies[0]!(
          ready(
            'account.update',
            'account.read_editable_profile',
            'account.read_preferences',
            'account.set_preferences',
            'account.read_verification_request',
          ),
        ),
      ['/en/settings', '/en/accounts', `/en/accounts/${recording.account}/verification`, 'https://auth.test/security'],
    );
    const oldLink = host.querySelector('[data-slot="account-management-links"] a')!;
    let replace!: (value: ReturnType<typeof session>) => void;
    await settle(() => {
      void client.fetchQuery({
        ...sessionQuery,
        staleTime: 0,
        queryFn: () =>
          new Promise<ReturnType<typeof session>>((resolve) => {
            replace = resolve;
          }),
      });
      expect(oldLink.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false);
    });
    expect(links()).toEqual([]);
    await step(() => replace(session('reader-b')));
    await settle(() => replies[1]!({ state: 'unavailable' }));
    await step(() => host.querySelector('button')!.click());
    await step(() => replies[2]!(ready('account.update', 'account.read_editable_profile')), ['/en/accounts']);
    await step(() => {
      void client.invalidateQueries({ queryKey: ['account-viewer-actions'] });
    });
    await step(() => replies[3]!(ready()));
    await step(() => client.setQueryData(sessionQuery.queryKey, session('reader-a')));
    await settle(() => client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null }));
    await step(() => replies[4]!(ready('account.update', 'account.read_editable_profile')));
    await step(() => client.setQueryData(sessionQuery.queryKey, session('reader-a')));
    await step(
      () => replies[5]!(ready('account.read_preferences', 'account.set_preferences')),
      ['/en/settings', 'https://auth.test/security'],
    );
  } finally {
    await settle(() => root.unmount());
    client.clear();
    host.remove();
  }
});
