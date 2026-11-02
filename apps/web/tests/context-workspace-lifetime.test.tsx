// Authored regressions; original acceptance execution is deferred to integration custody.
import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import type { Command } from '../src/features/contexts/model';
import type { EntityPickerProps } from '@rezics/ui/entity-picker';

const readerA = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const readerB = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const csrf = 'AAAAAAAAAAAAAAAAAAAAAA';
const signedIn = (subject = readerA) => ({ state: 'signed-in' as const, subject, csrfToken: csrf });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Mode = 'directory' | 'create' | 'detail' | 'mutation' | 'search';
type Delivery = 'success' | 'failure' | 'throw';
type Gate = {
  mode: Mode;
  entered: ReturnType<typeof deferred<void>>;
  delivery: ReturnType<typeof deferred<Delivery>>;
  token?: string;
};
let nextGate: Gate | undefined;
function hold(mode: Mode, token?: string) {
  const gate: Gate = { mode, entered: deferred<void>(), delivery: deferred<Delivery>(), ...(token ? { token } : {}) };
  nextGate = gate;
  return gate;
}
let serverReader = readerA;
let currentRequest: Request;
let preparing: ReturnType<typeof deferred<void>> | undefined;
const envelopes: { mode: Mode; method: string; data: unknown; headers: Headers }[] = [];
const searchNativeCalls: { headers: Record<string, string>; query: { q: string } }[] = [];
const { contextFixture, fixtureId } = await import('../src/features/contexts/fixtures');
let fixture = contextFixture();
mock.module('cloudflare:workers', () => ({
  env: {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'website',
    WEBSITE_CLIENT_KEY: '{}',
    SITE_ORIGINS: 'https://site.test',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          const waiting = preparing;
          preparing = undefined;
          if (waiting) await waiting.promise;
          return { status: 'active', subject: serverReader, accessToken: 'context-fixture', csrfToken: csrf };
        },
      }),
    },
  },
}));
mock.module('@tanstack/react-start/server', () => ({ ...start, getRequest: () => currentRequest }));
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn: (options: { method: string }) => {
    let validate: ((data: unknown) => unknown) | undefined;
    const chain = {
      validator(next: typeof validate) {
        validate = next;
        return chain;
      },
      handler(handler: (input: { data: unknown }) => Promise<unknown>) {
        return async (input: { data?: Record<string, unknown>; headers?: HeadersInit } = {}) => {
          const mode: Mode = input.data?.operation
            ? 'mutation'
            : input.data?.text
              ? 'search'
              : input.data?.id
                ? 'detail'
                : input.data
                  ? 'directory'
                  : 'create';
          const headers = new Headers(input.headers);
          envelopes.push({ mode, method: options.method, data: structuredClone(input.data), headers });
          headers.set('cookie', `__Host-rezics_session=${'a'.repeat(43)}`);
          headers.set('origin', 'https://site.test');
          currentRequest = new Request('https://site.test/_server/context', { method: options.method, headers });
          const gate = nextGate?.mode === mode ? nextGate : undefined;
          if (gate) nextGate = undefined;
          const result = await handler({ data: validate ? validate(input.data) : input.data });
          if (!gate) return result;
          gate.entered.resolve();
          const delivery = await gate.delivery.promise;
          if (delivery === 'throw') throw new Error('Late Context transport failure');
          if (delivery === 'failure')
            return mode === 'directory'
              ? { page: { kind: 'denied' }, creation: { kind: 'denied' } }
              : { kind: 'denied' };
          return gate.token && result && typeof result === 'object' ? { ...result, session: gate.token } : result;
        };
      },
    };
    return chain;
  },
}));
mock.module('../src/kernel/client', () => ({
  requestLocale: () => 'en',
  kernelClient: () =>
    new Proxy(fixture.client, {
      get(target, key, receiver) {
        if (key === 'subjects')
          return {
            $suggest: {
              get: async (options: (typeof searchNativeCalls)[number]) => {
                searchNativeCalls.push(options);
                return {
                  status: 200,
                  data: {
                    subjects: [
                      {
                        id: fixtureId,
                        type: 'test:work',
                        labels: { en: 'Private target' },
                        facts: {},
                        summary: null,
                      },
                    ],
                    as_of: '2026-01-01T00:00:00.000Z',
                  },
                  error: null,
                };
              },
            },
          };
        return Reflect.get(target, key, receiver);
      },
    }),
}));
mock.module('../src/subject/definitions', () => ({
  readRelease: async () => ({ types: { 'test:work': { labels: { en: 'Work' } } } }),
}));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/my/contexts' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLSelectElement: window.HTMLSelectElement,
  Element: window.Element,
  Node: window.Node,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { ContextSession } = await import('../src/features/contexts/session');
const actions = await import('../src/features/contexts/actions');
const { sessionQuery } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const o = { locale: 'en' as const };
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
async function until(predicate: () => boolean) {
  for (let turn = 0; turn < 80; turn++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('Context condition did not settle');
}
function button(host: HTMLElement, text: string) {
  const found = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
function retained(node: Element, event: string): (input: unknown) => void {
  const key = Object.keys(node).find((key) => key.startsWith('__reactProps'));
  if (!key) throw new Error('Missing React event props');
  return (node as unknown as Record<string, Record<string, (input: unknown) => void>>)[key]![event]!;
}
function pickerProps(host: HTMLElement): EntityPickerProps {
  const node = host.querySelector('[data-slot="entity-picker"]')!;
  const key = Object.keys(node).find((key) => key.startsWith('__reactFiber'))!;
  type Fiber = { memoizedProps?: Partial<EntityPickerProps>; return?: Fiber };
  let fiber = (node as unknown as Record<string, Fiber>)[key];
  while (fiber && typeof fiber.memoizedProps?.search !== 'function') fiber = fiber.return;
  if (!fiber?.memoizedProps?.search) throw new Error('Missing production Context target callback');
  return fiber.memoizedProps as EntityPickerProps;
}
async function mount(mode: Exclude<Mode, 'mutation' | 'search'>, strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, signedIn());
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const props =
    mode === 'detail'
      ? { mode, id: fixtureId }
      : mode === 'directory'
        ? { mode, input: { deleted: false, limit: 20 } }
        : { mode };
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(strict ? StrictMode : 'div', null, createElement(ContextSession, props)),
      ),
    ),
  );
  return {
    client,
    host: host as unknown as HTMLElement,
    dispose: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}
function replace(client: QueryClient, kind: 'same' | 'aba' | 'error' | 'remove') {
  if (kind === 'error')
    client
      .getQueryCache()
      .find({ queryKey: sessionQuery.queryKey })!
      .setState({ status: 'error', error: new Error('session failed') });
  else if (kind === 'remove') client.removeQueries({ queryKey: sessionQuery.queryKey });
  else {
    if (kind === 'aba') client.setQueryData(sessionQuery.queryKey, signedIn(readerB));
    client.setQueryData(sessionQuery.queryKey, signedIn());
  }
}
afterAll(async () => {
  mock.restore();
  await window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('original prepared Context reader must match before any native directory, creation, detail, target search or mutation I/O', async () => {
  for (const mode of ['directory', 'create', 'detail', 'mutation', 'search'] as const) {
    fixture = contextFixture();
    serverReader = readerA;
    const waiting = deferred<void>();
    preparing = waiting;
    const headers = { 'X-Context-Reader': readerA, 'X-CSRF-Token': csrf };
    const command: Command = {
      operation: 'create',
      key: crypto.randomUUID(),
      labels: { en: 'Original private draft' },
    };
    const running =
      mode === 'directory'
        ? actions.readContextDirectory({ data: { deleted: false, limit: 20 }, headers })
        : mode === 'create'
          ? actions.readContextCreation({ headers })
          : mode === 'detail'
            ? actions.readContextWorkspace({ data: { id: fixtureId }, headers })
            : mode === 'search'
              ? actions.readContextTargets({ data: { text: 'Private', locale: 'en' }, headers })
              : actions.changeContextWorkspace({ data: command, headers });
    serverReader = readerB;
    waiting.resolve();
    const result = await running;
    expect(fixture.calls).toHaveLength(0);
    expect(searchNativeCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('Readers');
    expect(
      mode === 'directory' ? (result as { page: { kind: string } }).page.kind : (result as { kind: string }).kind,
    ).toBe('signed-out');
  }
  serverReader = readerA;
  envelopes.length = 0;
});

test('each original directory, creation and detail read retires permanently on same-subject success and batched A-B-A, including late failure and throw', async () => {
  for (const mode of ['directory', 'create', 'detail'] as const) {
    for (const replacement of ['same', 'aba', 'error', 'remove'] as const) {
      for (const delivery of ['success', 'failure', 'throw'] as const) {
        fixture = contextFixture();
        serverReader = readerA;
        const gate = hold(mode, 'old-private-continuation');
        const mounted = await mount(mode);
        await gate.entered.promise;
        const oldKeys = mounted.client
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey[0] === 'context-workspace')
          .map((query) => query.queryKey);
        await act(async () => replace(mounted.client, replacement));
        if (replacement === 'error' || replacement === 'remove')
          await act(async () => mounted.client.setQueryData(sessionQuery.queryKey, signedIn()));
        await until(() => envelopes.filter((call) => call.mode === mode).length >= 2);
        await until(() =>
          mounted.client
            .getQueryCache()
            .getAll()
            .some(
              (query) =>
                query.queryKey[0] === 'context-workspace' &&
                query.state.status === 'success' &&
                query.state.fetchStatus === 'idle',
            ),
        );
        const before = mounted.client
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey[0] === 'context-workspace')
          .map((query) => [query.queryKey, query.state.data]);
        await act(async () => gate.delivery.resolve(delivery));
        await flush();
        expect(
          mounted.client
            .getQueryCache()
            .getAll()
            .filter((query) => query.queryKey[0] === 'context-workspace')
            .map((query) => [query.queryKey, query.state.data]),
        ).toEqual(before);
        for (const key of oldKeys) expect(mounted.client.getQueryData(key)).toBeUndefined();
        expect(mounted.host.textContent).not.toContain('old-private-continuation');
        expect(JSON.stringify(before.map(([key]) => key))).not.toContain('current-context-session');
        await mounted.dispose();
        envelopes.length = 0;
      }
    }
  }
});

test('retained form and reload callbacks refuse queued old work while the fresh same-subject creation remains usable', async () => {
  fixture = contextFixture();
  const mounted = await mount('create', true);
  await until(() => !button(mounted.host, m.ctxw_create({}, o)).disabled);
  const oldSubmit = retained(mounted.host.querySelector('form')!, 'onSubmit');
  const oldReload = retained(button(mounted.host, m.ctxw_reread({}, o)), 'onClick');
  const otherKey = ['context-workspace', readerA, 'unrelated-visit'];
  mounted.client.setQueryData(otherKey, { private: 'Other owned visit' });
  await act(async () => replace(mounted.client, 'same'));
  await until(() => !button(mounted.host, m.ctxw_create({}, o)).disabled);
  const before = envelopes.length;
  await act(async () => {
    oldSubmit({ preventDefault() {} });
    oldReload({});
  });
  expect(envelopes).toHaveLength(before);
  const input = mounted.host.querySelector('input')!;
  await act(async () => retained(input, 'onChange')({ target: { value: 'Fresh draft' } }));
  await act(async () => retained(mounted.host.querySelector('form')!, 'onSubmit')({ preventDefault() {} }));
  await until(() => mounted.host.textContent?.includes(m.ctxw_confirmed({}, o)) ?? false);
  expect(mounted.client.getQueryData(otherKey)).toEqual({ private: 'Other owned visit' });
  expect(envelopes.at(-1)?.headers.get('X-Context-Reader')).toBe(readerA);
  await mounted.dispose();
  envelopes.length = 0;
});

test('late creation and lifecycle settlement cannot refetch, focus or change a fresh visit, for success, denial and throw', async () => {
  for (const mode of ['create', 'detail'] as const)
    for (const replacement of ['same', 'aba'] as const)
      for (const delivery of ['success', 'failure', 'throw'] as const) {
        fixture = contextFixture();
        const mounted = await mount(mode);
        await until(() =>
          mode === 'create'
            ? !button(mounted.host, m.ctxw_create({}, o)).disabled
            : mounted.host.querySelector('h1') !== null && mounted.host.textContent?.includes('Readers') === true,
        );
        const gate = hold('mutation');
        if (mode === 'create') {
          await act(async () =>
            retained(mounted.host.querySelector('input')!, 'onChange')({ target: { value: 'Retired draft' } }),
          );
          await act(async () => retained(mounted.host.querySelector('form')!, 'onSubmit')({ preventDefault() {} }));
        } else {
          await act(async () => button(mounted.host, m.ctxw_delete({}, o)).click());
          await until(() => window.document.querySelector('[role="alertdialog"]') !== null);
          const confirm = [...window.document.querySelectorAll('button')]
            .filter((node) => node.textContent?.trim() === m.ctxw_delete({}, o))
            .at(-1)!;
          await act(async () => confirm.click());
        }
        await gate.entered.promise;
        await act(async () => replace(mounted.client, replacement));
        await until(() =>
          mounted.client
            .getQueryCache()
            .getAll()
            .some(
              (query) =>
                query.queryKey[0] === 'context-workspace' &&
                query.state.status === 'success' &&
                query.state.fetchStatus === 'idle',
            ),
        );
        const before = envelopes.length;
        const content = mounted.host.innerHTML;
        const focus = window.document.activeElement;
        await act(async () => gate.delivery.resolve(delivery));
        await flush();
        expect(envelopes).toHaveLength(before);
        expect(mounted.host.innerHTML).toBe(content);
        expect(window.document.activeElement).toBe(focus);
        await mounted.dispose();
        envelopes.length = 0;
      }
});

test('a cancelled detail read cannot overwrite the continuation used by the following read or immutable lifecycle retry', async () => {
  fixture = contextFixture('unknown');
  const mounted = await mount('detail');
  await until(() => mounted.host.textContent?.includes('Readers') ?? false);
  const gate = hold('detail', 'cancelled-read-token');
  await act(async () => button(mounted.host, m.ctxw_reread({}, o)).click());
  await gate.entered.promise;
  await act(async () =>
    mounted.client.cancelQueries({ predicate: (query) => query.queryKey[0] === 'context-workspace' }),
  );
  await act(async () => gate.delivery.resolve('success'));
  await flush();
  await act(async () => button(mounted.host, m.ctxw_reread({}, o)).click());
  await flush();
  const latest = envelopes.filter((call) => call.mode === 'detail').at(-1)!;
  expect(latest.method).toBe('POST');
  expect(latest.data).toMatchObject({ session: 'current-context-session' });
  expect(JSON.stringify(latest.data)).not.toContain('cancelled-read-token');
  await act(async () => button(mounted.host, m.ctxw_delete({}, o)).click());
  await until(() => window.document.querySelector('[role="alertdialog"]') !== null);
  await act(async () =>
    [...window.document.querySelectorAll('button')]
      .filter((node) => node.textContent?.trim() === m.ctxw_delete({}, o))
      .at(-1)!
      .click(),
  );
  await until(() => mounted.host.textContent?.includes(m.ctxw_unknown({}, o)) ?? false);
  await act(async () => button(mounted.host, m.ctxw_retry_same({}, o)).click());
  await until(() => mounted.host.textContent?.includes(m.ctxw_confirmed({}, o)) ?? false);
  const writes = envelopes.filter((call) => call.mode === 'mutation');
  expect(writes).toHaveLength(2);
  expect(writes[0]!.data).toEqual(writes[1]!.data);
  expect(writes[0]!.data).toMatchObject({ operation: 'delete', id: fixtureId, session: 'current-context-session' });
  await mounted.dispose();
  envelopes.length = 0;
});

test('a mutation queued behind cancellation refuses transport after its original admission is replaced', async () => {
  fixture = contextFixture();
  const mounted = await mount('create');
  await until(() => !button(mounted.host, m.ctxw_create({}, o)).disabled);
  await act(async () =>
    retained(mounted.host.querySelector('input')!, 'onChange')({ target: { value: 'Queued private draft' } }),
  );
  const cancelled = deferred<void>();
  const originalCancel = mounted.client.cancelQueries.bind(mounted.client);
  let queued = false;
  mounted.client.cancelQueries = ((...args: Parameters<typeof originalCancel>) => {
    const result = originalCancel(...args);
    if (queued) return result;
    queued = true;
    return result.then(() => cancelled.promise);
  }) as typeof mounted.client.cancelQueries;
  await act(async () => retained(mounted.host.querySelector('form')!, 'onSubmit')({ preventDefault() {} }));
  expect(queued).toBe(true);
  await act(async () => replace(mounted.client, 'same'));
  await act(async () => cancelled.resolve());
  await flush();
  expect(envelopes.filter((call) => call.mode === 'mutation')).toHaveLength(0);
  expect(mounted.host.querySelector('input')!.value).toBe('');
  expect(button(mounted.host, m.ctxw_create({}, o)).disabled).toBe(false);
  await mounted.dispose();
  envelopes.length = 0;
});

test('late refresh success, denial, throw and finally leave the new admission UI and focus alone', async () => {
  for (const mode of ['create', 'detail'] as const)
    for (const delivery of ['success', 'failure', 'throw'] as const) {
      fixture = contextFixture();
      const mounted = await mount(mode);
      await until(() =>
        mode === 'create'
          ? !button(mounted.host, m.ctxw_create({}, o)).disabled
          : !!mounted.host.querySelector('[data-slot="entity-picker"]'),
      );
      const gate = hold(mode);
      await act(async () => button(mounted.host, m.ctxw_reread({}, o)).click());
      await gate.entered.promise;
      await act(async () => replace(mounted.client, 'aba'));
      await until(() =>
        mounted.client
          .getQueryCache()
          .getAll()
          .some(
            (query) =>
              query.queryKey[0] === 'context-workspace' &&
              query.state.status === 'success' &&
              query.state.fetchStatus === 'idle',
          ),
      );
      const before = mounted.host.innerHTML;
      const focus = window.document.activeElement;
      await act(async () => gate.delivery.resolve(delivery));
      await flush();
      expect(mounted.host.innerHTML).toBe(before);
      expect(window.document.activeElement).toBe(focus);
      await mounted.dispose();
      envelopes.length = 0;
    }
});

test('original target searches and retained selection callbacks refuse queued work and late success, denial and throw', async () => {
  for (const replacement of ['same', 'aba'] as const)
    for (const delivery of ['success', 'failure', 'throw'] as const) {
      fixture = contextFixture();
      const mounted = await mount('detail');
      await until(() => !!mounted.host.querySelector('[data-slot="entity-picker"]'));
      const old = pickerProps(mounted.host);
      const gate = hold('search');
      const running = old.search('Private', new AbortController().signal).then(
        () => 'settled',
        () => 'retired',
      );
      await gate.entered.promise;
      await act(async () => replace(mounted.client, replacement));
      await until(() => !!mounted.host.querySelector('[data-slot="entity-picker"]'));
      const before = envelopes.length;
      expect(
        await old.search('Queued', new AbortController().signal).then(
          () => 'settled',
          () => 'retired',
        ),
      ).toBe('retired');
      expect(envelopes).toHaveLength(before);
      await act(async () => gate.delivery.resolve(delivery));
      expect(await running).toBe('retired');
      await act(async () =>
        old.onValueChange?.([{ id: fixtureId, title: 'Retired selection', types: [], typeLabel: '', cover: null }]),
      );
      expect(mounted.host.textContent).not.toContain('Retired selection');
      const fresh = pickerProps(mounted.host);
      const results = await fresh.search('Private', new AbortController().signal);
      expect(results[0]?.title).toBe('Private target');
      expect(searchNativeCalls.at(-1)?.headers.authorization).toBe('Bearer context-fixture');
      await mounted.dispose();
      envelopes.length = 0;
      searchNativeCalls.length = 0;
    }
});

test('a fresh uncertain create retries the exact original sealed command and key', async () => {
  fixture = contextFixture('unknown');
  const mounted = await mount('create');
  await until(() => !button(mounted.host, m.ctxw_create({}, o)).disabled);
  await act(async () =>
    retained(mounted.host.querySelector('input')!, 'onChange')({ target: { value: 'Original labels' } }),
  );
  await act(async () => retained(mounted.host.querySelector('form')!, 'onSubmit')({ preventDefault() {} }));
  await until(() => mounted.host.textContent?.includes(m.ctxw_unknown({}, o)) ?? false);
  await act(async () => button(mounted.host, m.ctxw_retry_same({}, o)).click());
  await until(() => mounted.host.textContent?.includes(m.ctxw_confirmed({}, o)) ?? false);
  const writes = envelopes.filter((call) => call.mode === 'mutation');
  expect(writes).toHaveLength(2);
  expect(writes[0]!.data).toEqual(writes[1]!.data);
  expect(writes[0]!.data).toMatchObject({ operation: 'create', labels: { en: 'Original labels' } });
  expect(writes[0]!.headers.get('X-CSRF-Token')).toBe(csrf);
  await mounted.dispose();
  envelopes.length = 0;
});
