// Authored connected acceptance. UNRUN: execution belongs to integration/native/browser custody.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import definitions from '../src/kernel/recorded/definitions-release.json';
import { providerQueueFixture } from '../src/kernel/fake/provider-review-queue';
import { readContextChoices, readContextChoice } from '../src/features/contexts/choice-native';

const readerA = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const readerB = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const originalToken = 'AAAAAAAAAAAAAAAAAAAAAA';
const replacementToken = 'BBBBBBBBBBBBBBBBBBBBBB';
const signedIn = (subject = readerA, csrfToken: string | null = originalToken) => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Mode = 'search' | 'resolve' | 'queue' | 'prepare' | 'decision' | 'reread';
let fixture = providerQueueFixture('comparison');
let actualReader = readerA;
let actualToken: string | null = originalToken;
let request: Request;
let requestCount = 0;
let preparing: ReturnType<typeof deferred<void>> | undefined;
const envelopes: { mode: Mode; headers: Headers; data: unknown }[] = [];
const cacheHeaders: string[] = [];
let gate:
  | { mode: Mode; entered: ReturnType<typeof deferred<void>>; delivered: ReturnType<typeof deferred<void>> }
  | undefined;
function hold(mode: Mode) {
  gate = { mode, entered: deferred<void>(), delivered: deferred<void>() };
  return gate;
}
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
          return { status: 'active', subject: actualReader, accessToken: 'provider-fixture', csrfToken: actualToken };
        },
      }),
    },
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => {
    requestCount++;
    return request;
  },
  setResponseHeader: (name: string, value: string) => {
    if (name.toLowerCase() === 'cache-control') cacheHeaders.push(value);
  },
}));
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn: (options: { method: string }) => {
    let validate: ((input: unknown) => unknown) | undefined;
    const chain = {
      validator(next: typeof validate) {
        validate = next;
        return chain;
      },
      handler(handler: (input: { data: unknown }) => Promise<unknown>) {
        return async (input: { data?: unknown; headers?: HeadersInit } = {}) => {
          const data = input.data as Record<string, unknown> | undefined;
          const mode: Mode = Array.isArray(data)
            ? 'reread'
            : data?.operation
              ? 'decision'
              : data?.scope
                ? 'queue'
                : data?.id
                  ? 'resolve'
                  : data && 'query' in data
                    ? 'search'
                    : 'prepare';
          const headers = new Headers(input.headers);
          envelopes.push({ mode, headers, data: structuredClone(data) });
          headers.set('cookie', `__Host-rezics_session=${'a'.repeat(43)}`);
          headers.set('origin', 'https://site.test');
          request = new Request('https://site.test/_server/provider', { method: options.method, headers });
          const waiting = gate?.mode === mode ? gate : undefined;
          if (waiting) gate = undefined;
          const result = await handler({ data: validate ? validate(data) : data });
          if (waiting) {
            waiting.entered.resolve();
            await waiting.delivered.promise;
          }
          return result;
        };
      },
    };
    return chain;
  },
}));
mock.module('../src/kernel/client', () => ({ kernelClient: () => fixture.client }));
mock.module('../src/subject/definitions', () => ({ readRelease: async () => definitions.release }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/imports/review' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLSelectElement: window.HTMLSelectElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { ProviderQueueJourney } = await import('../src/features/import-review/provider-queue-journey');
const actions = await import('../src/features/import-review/provider-queue-actions');
const { sessionQuery } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const { providerSourceLabel } = await import('../src/features/import-review/provider-context-choice');
const { ProviderSessionSource, ProviderVisit } = await import('../src/features/import-review/provider-visit');
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
async function until(predicate: () => boolean) {
  for (let turn = 0; turn < 100; turn++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('Provider condition did not settle');
}
function retained(node: Element, name: string): (value?: unknown) => unknown {
  const key = Object.keys(node).find((key) => key.startsWith('__reactProps'));
  if (!key) throw new Error('Missing mounted React props');
  return (node as unknown as Record<string, Record<string, (value?: unknown) => unknown>>)[key]![name]!;
}
function button(host: ParentNode, text: string) {
  const value = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  if (!value) throw new Error(`Missing provider button: ${text}`);
  return value as unknown as HTMLButtonElement;
}
async function click(host: ParentNode, text: string) {
  await act(async () => button(host, text).click());
}
async function field(host: ParentNode, label: string, value: string) {
  const text = [...host.querySelectorAll('label')].find((entry) => entry.textContent === label)!;
  const input = window.document.getElementById(text.getAttribute('for')!)!;
  await act(async () => retained(input, 'onChange')({ target: { value } }));
}
async function mount(strict = false, csrfToken: string | null = originalToken) {
  let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, signedIn(readerA, csrfToken));
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let key = 0;
  const render = async () =>
    act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(strict ? StrictMode : 'div', null, createElement(ProviderQueueJourney, { key })),
        ),
      ),
    );
  await render();
  await until(() => !!host.querySelector('form'));
  return {
    host: host as unknown as HTMLElement,
    get client() {
      return client;
    },
    replaceClient: async () => {
      client = new QueryClient();
      client.setQueryData(sessionQuery.queryKey, signedIn());
      await render();
    },
    replaceVisit: async () => {
      key++;
      await render();
    },
    dispose: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}
async function chooseNamed(host: HTMLElement) {
  await field(host, m.prq_source(), 'wikidata');
  await field(host, m.provider_scope_search(), 'Book');
  await click(host, m.provider_scope_find());
  await until(() => host.textContent!.includes('Book editors'));
  await click(host, m.provider_scope_choose());
  await until(() => host.textContent!.includes(m.provider_scope_selected({ label: 'Book editors' })));
}
async function load(host: HTMLElement) {
  await click(host, m.prq_load());
  await until(() => host.querySelectorAll('[role="checkbox"]').length > 0);
}
async function seal(host: HTMLElement) {
  const checkbox = host.querySelector('[role="checkbox"]')!;
  await act(async () => (checkbox as HTMLElement).click());
  await click(host, m.candidate_accept());
  await until(() => !!window.document.querySelector('[role="alertdialog"]'));
  return window.document.querySelector('[role="alertdialog"]') as unknown as HTMLElement;
}
function replace(client: QueryClient, kind: 'equal' | 'token' | 'signout' | 'remove' | 'query' | 'aba') {
  if (kind === 'token') actualToken = replacementToken;
  if (kind === 'remove' || kind === 'query') client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
  if (kind === 'signout')
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  else if (kind !== 'remove') {
    if (kind === 'aba') client.setQueryData(sessionQuery.queryKey, signedIn(readerB, replacementToken));
    client.setQueryData(sessionQuery.queryKey, signedIn(readerA, kind === 'token' ? replacementToken : originalToken));
  }
}
beforeEach(() => {
  fixture = providerQueueFixture('comparison');
  actualReader = readerA;
  actualToken = originalToken;
  envelopes.length = 0;
  cacheHeaders.length = 0;
  requestCount = 0;
  gate = undefined;
  preparing = undefined;
});
afterAll(async () => {
  mock.restore();
  await window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Actual named Context selection through native provider queue/preparation/exact decision and uncertain reread', async () => {
  const mounted = await mount(true);
  try {
    expect(fixture.calls).toHaveLength(0); // Original event-owned, private first render.
    await chooseNamed(mounted.host);
    const directory = fixture.calls.find((call) => call.path.startsWith('/v1/contexts?'))!;
    expect(Object.fromEntries(new URL(directory.path, 'https://queue.test').searchParams)).toEqual({
      query: 'Book',
      limit: '20',
      deleted: 'false',
    });
    expect(fixture.calls.some((call) => call.path === `/v1/contexts/${fixture.editorial.id}/lifecycle`)).toBe(true);
    fixture.setScenario('unavailable');
    await click(mounted.host, m.prq_load());
    await until(() => mounted.host.textContent!.includes(m.prq_unavailable()));
    await click(mounted.host, m.prq_prepare());
    await until(() => mounted.host.textContent!.includes(m.prq_preparing()));
    await click(mounted.host, m.prq_retry());
    await until(() =>
      [...mounted.host.querySelectorAll('button')].some((entry) => entry.textContent === m.prq_continue()),
    );
    await click(mounted.host, m.prq_continue());
    await until(() => mounted.host.querySelectorAll('[role="checkbox"]').length === 2);
    expect(mounted.host.textContent).toContain('Book editors');
    expect(mounted.host.textContent).toContain('Wikidata');
    expect(mounted.host.textContent).toContain('1943');
    expect(mounted.host.textContent).toContain('1946');
    const dialog = await seal(mounted.host);
    expect(dialog.textContent).toContain('Book editors');
    expect(dialog.textContent).toContain('Wikidata');
    fixture.setDecisionMode('unknown');
    fixture.setReadingStatus(503);
    await click(dialog, m.provider_confirm_accept());
    await until(() => mounted.host.textContent!.includes(m.provider_reading_failed()));
    const write = envelopes.find((entry) => entry.mode === 'decision')!;
    expect(write.headers.get('X-CSRF-Token')).toBe(originalToken);
    expect(write.headers.get('X-Provider-Token')).toBe(originalToken);
    const command = write.data as {
      subject: string;
      candidate: string;
      context: string;
      head: number | null;
      key: string;
      session: string;
    };
    expect(command).toMatchObject({
      subject: fixture.native.id,
      candidate: fixture.native.candidate.id,
      context: fixture.editorial.id,
      head: null,
      session: 'queue-session',
    });
    const reread = envelopes.find((entry) => entry.mode === 'reread')!;
    expect(reread.data).toEqual([
      {
        subject: command.subject,
        candidate: command.candidate,
        context: command.context,
        head: command.head,
        operation: 'accept',
        key: command.key,
        session: command.session,
      },
    ]);
    expect(fixture.calls.filter((call) => call.method === 'POST' && call.path.endsWith(':accept'))).toHaveLength(1);
    expect(mounted.host.textContent).toContain(m.provider_unavailable());
    expect([...mounted.host.querySelectorAll('button')].some((node) => node.textContent === m.provider_finish())).toBe(
      false,
    );
    fixture.setReadingStatus(200);
    await click(mounted.host, m.provider_refresh());
    expect(fixture.calls.filter((call) => call.path.endsWith(':accept'))).toHaveLength(1);
    const oldRetry = retained(button(mounted.host, m.provider_retry_failed()), 'onClick');
    fixture.setDecisionMode('normal');
    await click(mounted.host, m.provider_retry_failed());
    await until(() => mounted.host.textContent!.includes(m.provider_accepted()));
    const writes = fixture.calls.filter((call) => call.path.endsWith(':accept'));
    expect(writes).toHaveLength(2);
    expect(writes[1]!.key).toBe(writes[0]!.key);
    expect(writes[1]!.body).toEqual(writes[0]!.body);
    await act(async () => {
      oldRetry();
    });
    expect(fixture.calls.filter((call) => call.path.endsWith(':accept'))).toHaveLength(2);
    await click(mounted.host, m.provider_refresh());
    expect(fixture.calls.filter((call) => call.path.endsWith(':accept'))).toHaveLength(2);
    expect(cacheHeaders.every((value) => value === 'private, no-store')).toBe(true);
    expect(requestCount).toBe(envelopes.length); // One actual prepared Request per server call.
  } finally {
    await mounted.dispose();
  }
});

test('explicit Global, arbitrary valid provider aliases and healthy null-CSRF browsing retain native authority', async () => {
  const mounted = await mount(false, null);
  actualToken = null;
  try {
    await field(mounted.host, m.prq_source(), 'community-feed_2');
    await click(mounted.host, m.prq_global());
    await until(() => mounted.host.textContent!.includes(m.provider_scope_selected({ label: m.prq_global() })));
    await load(mounted.host);
    expect(fixture.calls.some((call) => call.path.includes('/lifecycle'))).toBe(true);
    expect(fixture.calls.find((call) => call.path.startsWith('/v1/review-candidates?'))!.path).toContain(
      'source=community-feed_2',
    );
    expect(
      [...mounted.host.querySelectorAll('[role="checkbox"]')].every(
        (entry) => entry.getAttribute('aria-disabled') === 'true' || entry.hasAttribute('disabled'),
      ),
    ).toBe(true);
    expect(envelopes.every((entry) => entry.headers.get('X-CSRF-Token') === null)).toBe(true);
    expect(envelopes.some((entry) => entry.mode === 'prepare' || entry.mode === 'decision')).toBe(false);
    expect(providerSourceLabel('open-library')).toBe('Open Library');
    expect(providerSourceLabel('community-feed_2')).toBe('community-feed_2');
  } finally {
    await mounted.dispose();
  }
});

test('query/cursor/source fields refuse invalid values and deleted/hidden exact choices conceal the old queue', async () => {
  expect(await readContextChoices(fixture.client.contexts, 'Bearer fixture', { query: 'x'.repeat(257) })).toEqual({
    kind: 'invalid',
    field: 'query',
  });
  expect(
    await readContextChoices(fixture.client.contexts, 'Bearer fixture', { query: '', cursor: 'x'.repeat(4097) }),
  ).toEqual({ kind: 'invalid', field: 'cursor' });
  expect(fixture.calls).toHaveLength(0);
  const mounted = await mount();
  try {
    await chooseNamed(mounted.host);
    await load(mounted.host);
    fixture.setChoiceStatus(404);
    await click(mounted.host, m.prq_refresh());
    await until(() => mounted.host.textContent!.includes(m.provider_scope_denied()));
    expect(mounted.host.querySelector('[role="checkbox"]')).toBeNull();
    expect(mounted.host.textContent).not.toContain('Book editors');
    expect(mounted.host.textContent).not.toContain('1946');
    fixture.setChoiceStatus(200);
    fixture.editorial.state = 'deleted';
    await click(mounted.host, m.provider_scope_find());
    await until(() => mounted.host.textContent!.includes(m.provider_scope_empty()));
    expect(await readContextChoice(fixture.client, 'Bearer fixture', fixture.editorial.id)).toEqual({ kind: 'denied' });
    await field(mounted.host, m.prq_source(), 'Bad Source');
    await click(mounted.host, m.prq_global());
    await until(() => mounted.host.textContent!.includes(m.provider_scope_selected({ label: m.prq_global() })));
    await click(mounted.host, m.prq_load());
    expect(mounted.host.textContent).toContain(m.provider_scope_source_invalid());
  } finally {
    await mounted.dispose();
  }
});

const replacements = ['equal', 'token', 'signout', 'remove', 'query', 'aba'] as const;
for (const kind of replacements)
  for (const mode of ['search', 'resolve', 'queue', 'prepare', 'decision', 'reread'] as const) {
    test(`deferred ${mode} is retired by ${kind} before commit, dispatch, publication and finally`, async () => {
      const mounted = await mount();
      try {
        let waiting: ReturnType<typeof hold>;
        if (mode === 'search') {
          waiting = hold(mode);
          await click(mounted.host, m.provider_scope_find());
        } else if (mode === 'resolve') {
          waiting = hold(mode);
          await click(mounted.host, m.prq_global());
        } else {
          await chooseNamed(mounted.host);
          if (mode === 'queue') {
            waiting = hold(mode);
            await click(mounted.host, m.prq_load());
          } else if (mode === 'prepare') {
            fixture.setScenario('unavailable');
            await click(mounted.host, m.prq_load());
            await until(() => mounted.host.textContent!.includes(m.prq_unavailable()));
            waiting = hold(mode);
            await click(mounted.host, m.prq_prepare());
          } else {
            await load(mounted.host);
            const dialog = await seal(mounted.host);
            waiting = hold(mode);
            if (mode === 'decision') fixture.setDecisionMode('unknown');
            await click(dialog, m.provider_confirm_accept());
          }
        }
        await waiting.entered.promise;
        const before = fixture.calls.length;
        const buttons = [...mounted.host.querySelectorAll('button')];
        const callbacks = buttons.map((node) => retained(node, 'onClick')).filter(Boolean);
        // Actual cache success is synchronous. Retained callbacks run before React is allowed to commit.
        await act(async () => {
          replace(mounted.client, kind);
          for (const callback of callbacks) callback({ preventDefault() {}, stopPropagation() {} });
          waiting.delivered.resolve();
        });
        await flush();
        expect(fixture.calls.length).toBe(before);
        expect(mounted.host.textContent).not.toContain('1946');
        expect(mounted.host.querySelector('[role="checkbox"]')).toBeNull();
        if (kind !== 'signout' && kind !== 'remove') {
          await until(() => !!mounted.host.querySelector('form'));
          await chooseNamed(mounted.host);
          await load(mounted.host);
          expect(mounted.host.querySelector('[role="checkbox"]')).not.toBeNull();
          // The stale completion/finally never unlocks or replaces this new matching private result.
          expect(mounted.host.textContent).toContain('Book editors');
        }
      } finally {
        gate?.delivered.resolve();
        await mounted.dispose();
      }
    });
  }

for (const replacement of ['scope', 'client', 'visit', 'unmount'] as const) {
  test(`mounted confirmation and queued callbacks cannot survive ${replacement} replacement or ABA`, async () => {
    const mounted = await mount();
    let disposed = false;
    try {
      await chooseNamed(mounted.host);
      await load(mounted.host);
      const dialog = await seal(mounted.host);
      const confirm = retained(button(dialog, m.provider_confirm_accept()), 'onClick');
      const before = fixture.calls.length;
      if (replacement === 'scope') {
        await field(mounted.host, m.prq_source(), 'bangumi');
        await field(mounted.host, m.prq_source(), 'wikidata');
      } else if (replacement === 'client') await mounted.replaceClient();
      else if (replacement === 'visit') await mounted.replaceVisit();
      else {
        await mounted.dispose();
        disposed = true;
      }
      await act(async () => {
        confirm();
      });
      expect(fixture.calls.length).toBe(before);
      expect(envelopes.some((entry) => entry.mode === 'decision')).toBe(false);
      expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
    } finally {
      if (!disposed) await mounted.dispose();
    }
  });
}

test('ordinary non-success notifications preserve confirmation; equal success and fresh token never authorize its old callback', async () => {
  const mounted = await mount();
  try {
    await chooseNamed(mounted.host);
    await load(mounted.host);
    const dialog = await seal(mounted.host);
    const query = mounted.client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true })!;
    await act(async () =>
      query.setState({ fetchStatus: 'fetching', status: 'error', error: new Error('ordinary notification') }),
    );
    expect(window.document.querySelector('[role="alertdialog"]')).not.toBeNull();
    const original = retained(button(dialog, m.provider_confirm_accept()), 'onClick');
    const before = fixture.calls.length;
    await act(async () => {
      actualToken = replacementToken;
      mounted.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, replacementToken));
      original();
    });
    expect(fixture.calls.length).toBe(before);
    expect(envelopes.some((entry) => entry.mode === 'decision')).toBe(false);
  } finally {
    await mounted.dispose();
  }
});

test('actual prepared-reader mismatch is compared before native work and exposes useful fresh-response recovery', async () => {
  const mounted = await mount();
  try {
    const waiting = deferred<void>();
    preparing = waiting;
    await click(mounted.host, m.provider_scope_find());
    actualReader = readerB;
    await act(async () => waiting.resolve());
    await until(() => mounted.host.textContent!.includes(m.prq_denied()));
    expect(fixture.calls).toHaveLength(0);
    actualReader = readerA;
    await click(mounted.host, m.prq_retry());
    await until(() => !!mounted.host.querySelector('form'));
    await chooseNamed(mounted.host);
    await load(mounted.host);
    expect(mounted.host.textContent).toContain('1946');
    const before = fixture.calls.length;
    const response = await actions.prepareProviderScopeAction({
      data: fixture.scope,
      headers: { 'X-Provider-Reader': readerA },
    });
    expect(response.result).toEqual({ state: 'denied' });
    expect(fixture.calls.length).toBe(before);
  } finally {
    await mounted.dispose();
  }
});

test('directory growth stays one page, sparse native next is not refilled, strict rows and independent resolution remain bounded', async () => {
  for (const unrelated of [0, 1_000, 10_000]) {
    const source = providerQueueFixture();
    const extra = Array.from({ length: unrelated }, (_, index) => ({
      ...source.editorial,
      labels: { en: `Unrelated ${index}` },
    }));
    source.population.contexts.push(...extra);
    source.population.subjects.push(...extra.map((entry) => ({ id: entry.id })));
    source.population.candidates.push(...extra.map((entry) => ({ candidate: entry.id })));
    source.population.revisions.push(...extra.map((_, revision) => ({ revision })));
    expect(source.population.contexts).toHaveLength(unrelated);
    source.setDirectory([], 'opaque+/directory==');
    expect(await source.contexts.search({ query: 'Book' })).toEqual({ contexts: [], next: 'opaque+/directory==' });
    expect(source.calls).toHaveLength(1);
    source.setDirectory([source.editorial]);
    expect(await source.contexts.search({ query: 'Book', cursor: 'opaque+/directory==' })).toMatchObject({
      contexts: [source.editorial],
      next: null,
    });
    expect(await source.contexts.resolve(source.editorial.id)).toEqual({ context: source.editorial });
    expect(source.calls).toHaveLength(3);
    expect(
      source.calls
        .filter((call) => call.path.startsWith('/v1/contexts?'))
        .every((call) => call.path.includes('limit=20')),
    ).toBe(true);
    source.setDirectory(Array.from({ length: 21 }, () => source.editorial));
    expect(await source.contexts.search({ query: '' })).toEqual({ kind: 'unavailable' });
  }
});

test('session Query identity and equal success are observed independently of subject equality; visits are monotonic', () => {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, signedIn());
  const source = new ProviderSessionSource(client);
  const first = source.snapshot()!;
  const stop = source.subscribe(() => {});
  const visit = new ProviderVisit(() => source.current(first));
  client.setQueryData(sessionQuery.queryKey, signedIn());
  expect(visit.live()).toBe(false);
  client.setQueryData(sessionQuery.queryKey, signedIn(readerB));
  client.setQueryData(sessionQuery.queryKey, signedIn());
  expect(visit.live()).toBe(false);
  expect(source.snapshot()).not.toBe(first);
  stop();
  source.retire();
  client.clear();
});

test('independently refused exact Subjects conceal only their rows and selection stays bounded at the original twenty', async () => {
  const mounted = await mount();
  try {
    const hidden = '019a1b2c-3d4e-7000-8000-001000000885';
    fixture.setCandidateSubject(fixture.suggestions[1]!.id, hidden);
    fixture.setSubjectStatus(hidden, 403);
    await chooseNamed(mounted.host);
    await load(mounted.host);
    expect(mounted.host.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
    expect(mounted.host.textContent).toContain(m.provider_missing());
    expect(mounted.host.textContent).toContain('1946');
    expect(mounted.host.textContent).not.toContain('wikidata-2');
    const dialog = await seal(mounted.host);
    expect(dialog.textContent).toContain('1946');
    expect(dialog.textContent).not.toContain('wikidata-2');
    await click(dialog, m.provider_cancel());
    fixture.setSubjectStatus(hidden, 503);
    await click(mounted.host, m.prq_refresh());
    await until(() => mounted.host.querySelectorAll('[role="checkbox"]').length === 2);
    expect(mounted.host.textContent).toContain(m.prq_comparison_unavailable());
    expect(
      [...mounted.host.querySelectorAll('[role="checkbox"]')].filter(
        (entry) => entry.getAttribute('aria-disabled') === 'true' || entry.hasAttribute('disabled'),
      ),
    ).toHaveLength(1);
    expect(mounted.host.textContent).toContain('1946');
    fixture.setSubjectStatus(hidden, 200);
    while (fixture.suggestions.length < 20) {
      const candidate = structuredClone(fixture.native.candidate);
      candidate.id = `019a1b2c-3d4e-7000-8000-${String(fixture.suggestions.length + 900).padStart(12, '0')}`;
      candidate.statement.id = candidate.id;
      fixture.suggestions.push(candidate);
    }
    await click(mounted.host, m.prq_refresh());
    await until(() => mounted.host.querySelectorAll('[role="checkbox"]').length === 20);
    await act(async () => {
      for (const checkbox of mounted.host.querySelectorAll('[role="checkbox"]')) (checkbox as HTMLElement).click();
    });
    await click(mounted.host, m.candidate_accept());
    const bounded = window.document.querySelector('[role="alertdialog"]')!;
    expect(bounded.querySelectorAll('li')).toHaveLength(20);
    expect(fixture.calls.filter((call) => call.path.endsWith(':accept'))).toHaveLength(0);
  } finally {
    await mounted.dispose();
  }
});

for (const replacement of ['scope', 'client', 'visit', 'unmount'] as const)
  for (const mode of ['search', 'resolve', 'queue', 'prepare', 'decision', 'reread'] as const) {
    test(`late ${mode} success/finally cannot publish after ${replacement} changes the mounted owner`, async () => {
      const mounted = await mount();
      let disposed = false;
      let waiting: ReturnType<typeof hold> | undefined;
      try {
        if (mode === 'search') {
          waiting = hold(mode);
          await click(mounted.host, m.provider_scope_find());
        } else if (mode === 'resolve') {
          waiting = hold(mode);
          await click(mounted.host, m.prq_global());
        } else {
          await chooseNamed(mounted.host);
          if (mode === 'queue') {
            waiting = hold(mode);
            await click(mounted.host, m.prq_load());
          } else if (mode === 'prepare') {
            fixture.setScenario('unavailable');
            await click(mounted.host, m.prq_load());
            await until(() => mounted.host.textContent!.includes(m.prq_unavailable()));
            waiting = hold(mode);
            await click(mounted.host, m.prq_prepare());
          } else {
            await load(mounted.host);
            const dialog = await seal(mounted.host);
            waiting = hold(mode);
            await click(dialog, m.provider_confirm_accept());
          }
        }
        await waiting.entered.promise;
        if (replacement === 'scope') {
          // Search/choice is in the form's lifetime; a source change must also retire that work.
          await field(mounted.host, m.prq_source(), 'bangumi');
          await field(mounted.host, m.prq_source(), 'wikidata');
        } else if (replacement === 'client') await mounted.replaceClient();
        else if (replacement === 'visit') await mounted.replaceVisit();
        else {
          await mounted.dispose();
          disposed = true;
        }
        const count = fixture.calls.length;
        await act(async () => waiting!.delivered.resolve());
        await flush();
        expect(fixture.calls.length).toBe(count);
        expect(mounted.host.querySelector('[role="checkbox"]')).toBeNull();
        expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
      } finally {
        waiting?.delivered.resolve();
        if (!disposed) await mounted.dispose();
      }
    });
  }

test('complete mounted story eight-locale caller closure retains authored public and private-SSR assertions UNRUN', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, signedIn());
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(ProviderQueueJourney)),
  );
  expect(html).not.toContain('1946');
  expect(html).not.toContain('Book editors');
  expect(fixture.calls).toHaveLength(0);
  expect(envelopes).toHaveLength(0);
  client.clear();
  const locales = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
  const keys = [
    'context',
    'help',
    'search',
    'find',
    'choose',
    'selected',
    'empty',
    'denied',
    'query_invalid',
    'cursor_invalid',
    'source_invalid',
    'source_help',
    'unnamed',
  ];
  for (const locale of locales) {
    const messages = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
    for (const key of keys) expect(typeof messages[`provider_scope_${key}`]).toBe('string');
    expect(messages.provider_scope_selected).toContain('{label}');
  }
});

test('retained Context Next and choice callbacks cannot dispatch after query/page replacement or A-B-A restoration', async () => {
  const mounted = await mount();
  try {
    fixture.setDirectory([fixture.editorial], 'original-opaque-next');
    await click(mounted.host, m.provider_scope_find());
    await until(
      () => !![...mounted.host.querySelectorAll('button')].find((entry) => entry.textContent === m.prq_continue()),
    );
    const next = retained(button(mounted.host, m.prq_continue()), 'onClick');
    const choose = retained(button(mounted.host, m.provider_scope_choose()), 'onClick');
    await field(mounted.host, m.provider_scope_search(), 'New query');
    await field(mounted.host, m.provider_scope_search(), '');
    const before = fixture.calls.length;
    await act(async () => {
      next();
      choose();
    });
    expect(fixture.calls.length).toBe(before);
    expect(mounted.host.textContent).not.toContain(m.provider_scope_selected({ label: 'Book editors' }));
  } finally {
    await mounted.dispose();
  }
});

test('mounted invalid query and native opaque cursor failures stay attached to the Context field', async () => {
  const mounted = await mount();
  try {
    await field(mounted.host, m.provider_scope_search(), 'x'.repeat(257));
    const before = fixture.calls.length;
    await click(mounted.host, m.provider_scope_find());
    expect(mounted.host.textContent).toContain(m.provider_scope_query_invalid());
    expect(fixture.calls.length).toBe(before);
    await field(mounted.host, m.provider_scope_search(), 'Book');
    fixture.setDirectory([], 'x'.repeat(4097));
    await click(mounted.host, m.provider_scope_find());
    await until(() => mounted.host.textContent!.includes(m.provider_scope_cursor_invalid()));
    expect(fixture.calls.length).toBe(before + 1);
    expect(mounted.host.querySelector('[role="checkbox"]')).toBeNull();
  } finally {
    await mounted.dispose();
  }
});

test('a stale queue finally cannot unlock a newer pending visit or publish over its matching response', async () => {
  const mounted = await mount();
  try {
    await chooseNamed(mounted.host);
    const old = hold('queue');
    await click(mounted.host, m.prq_load());
    await old.entered.promise;
    await act(async () => replace(mounted.client, 'equal'));
    await until(() => !!mounted.host.querySelector('form'));
    await chooseNamed(mounted.host);
    const fresh = hold('queue');
    await click(mounted.host, m.prq_load());
    await fresh.entered.promise;
    const count = fixture.calls.length;
    await act(async () => old.delivered.resolve());
    await flush();
    expect(fixture.calls.length).toBe(count);
    expect(mounted.host.querySelector('[role="checkbox"]')).toBeNull();
    expect(mounted.host.textContent).toContain(m.prq_loading());
    await act(async () => fresh.delivered.resolve());
    await until(() => mounted.host.querySelectorAll('[role="checkbox"]').length === 2);
    expect(mounted.host.textContent).toContain('Book editors');
    expect(mounted.host.textContent).toContain('1946');
    expect(fixture.calls.length).toBe(count);
  } finally {
    gate?.delivered.resolve();
    await mounted.dispose();
  }
});
