import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import type { MembershipResult } from '../src/community/space';
import type { RealmViewer } from '../src/community/realm-membership-queries';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({ ...start, getRequest: () => start.getRequest() }));
mock.module('cloudflare:workers', () => ({ env: {} }));
let reads = 0;
let read: () => Promise<RealmViewer>;
let send: () => Promise<MembershipResult>;
mock.module('../src/community/realm-membership-actions', () => ({
  readRealmMembership: () => {
    reads++;
    return read();
  },
}));
mock.module('../src/community/space-actions', () => ({ changeRealmMembership: () => send() }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/spaces/atlas' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { RealmMembership } = await import('../src/community/realm-membership');
const { m } = await import('../src/paraglide/messages.js');
afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test.each(['join', 'leave', 'recovery', 'survive', 'pointer', 'move', 'renew', 'background'])(
  '%s keeps only the explicit current keyboard operation at its membership result',
  async (scenario) => {
    const member = ['leave', 'recovery', 'survive'].includes(scenario);
    const failed = ['recovery', 'survive'].includes(scenario);
    const viewer = (state: RealmViewer['state']): RealmViewer => ({ state, idempotencyKey: 'immutable-key' });
    reads = 0;
    read = async () => viewer(member ? 'member' : 'none');
    let commands = 0;
    send = async () =>
      ++commands === 1 && failed ? { outcome: 'refused' } : { outcome: 'accepted', workflowId: 'focus-workflow' };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const session = { state: 'signed-in', subject: 'focus-person', csrfToken: 'original' };
    client.setQueryData(['session'], session);
    const realm = { id: 'focus-realm', visibility: 'public' as const, viewer: null };
    const route = createRootRoute({ component: () => <RealmMembership realm={realm} returnTo="/spaces/atlas" /> });
    const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
    await router.load();
    const host = window.document.createElement('main');
    window.document.body.append(host);
    const root = createRoot(host as unknown as HTMLElement);
    const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
    const tick = () =>
      act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    const until = async (ready: () => boolean) => {
      for (let turn = 0; turn < 100 && !ready(); turn++) await tick();
      expect(ready()).toBe(true);
    };
    const activate = async (label: string, detail = 0) => {
      const control = button(label);
      await act(async () => {
        control.focus();
        control.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail }));
      });
      return control;
    };
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>,
        ),
      );
      await until(() => !!button(member ? m.realm_leave() : m.realm_join()));
      expect(window.document.activeElement).toBe(window.document.body);
      let resolve!: (value: RealmViewer) => void;
      const result = new Promise<RealmViewer>((done) => {
        resolve = done;
      });
      read = () => result;
      let source: ReturnType<typeof button> | undefined;
      if (scenario === 'background') void client.refetchQueries({ queryKey: ['realm-membership'] });
      else source = await activate(member ? m.realm_leave() : m.realm_join());
      if (failed) {
        const label = m.realm_membership_retry();
        await until(() => !!button(label));
        source = await activate(label);
      }
      await until(() => reads === 2);
      if (scenario === 'pointer') host.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      const sentinel = window.document.createElement('button');
      host.append(sentinel);
      if (scenario === 'move') sentinel.focus();
      if (scenario === 'renew') {
        await act(async () => {
          client.setQueryData(['session'], { ...session, csrfToken: 'renewed' });
        });
        await until(() => reads === 3);
      }
      resolve(viewer(member && scenario !== 'survive' ? 'none' : 'member'));
      await until(() => !client.isFetching());
      await tick();
      const expected =
        scenario === 'survive'
          ? source
          : scenario === 'move'
            ? sentinel
            : ['pointer', 'renew', 'background'].includes(scenario)
              ? window.document.body
              : host.querySelector('[data-member-state]');
      expect(window.document.activeElement).toBe(expected);
      expect(commands).toBe(scenario === 'background' ? 0 : 1);
      expect(reads).toBe(scenario === 'renew' ? 3 : 2);
    } finally {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    }
  },
);
