import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import type { ValueRead } from '../src/features/catalogue/value-explanation';

const alice = '00000000-0000-8000-8000-000000000001',
  bob = '00000000-0000-8000-8000-000000000002';
let reader: string | null = alice;
let hold: Promise<void> | undefined;
const envelopes: Array<{ data: Record<string, unknown>; headers?: HeadersInit }> = [];
mock.module('cloudflare:workers', () => ({
  env: {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'website',
    WEBSITE_CLIENT_KEY: '{}',
    SITE_ORIGINS: 'https://site.test',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        credential: async () =>
          reader
            ? { status: 'active', subject: reader, accessToken: reader, csrfToken: 'A'.repeat(22) }
            : { status: 'absent' },
      }),
    },
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () =>
    new Request('https://site.test/value', {
      headers: reader ? { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } : {},
    }),
}));
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn: () => {
    let validate = (input: unknown): unknown => input;
    const chain = {
      validator(next: typeof validate) {
        validate = next;
        return chain;
      },
      handler(fn: (input: { data: unknown }) => Promise<unknown>) {
        return async (input: { data: Record<string, unknown>; headers?: HeadersInit }) => {
          const pause = hold;
          hold = undefined;
          envelopes.push(input);
          const result = await fn({ data: validate(input.data) });
          await pause;
          return result;
        };
      },
    };
    return chain;
  },
}));
const { valueExplanationFixture } = await import('../src/kernel/fake/value-explanation');
const fixture = valueExplanationFixture('paged');
mock.module('../src/kernel/client', () => ({ kernelClient: () => fixture.client }));
mock.module('../src/subject/load-reader', () => ({
  loadReader: async () => ({ spoilerLevel: 0, suitability: 'blur' }),
}));
const { ValueExplanationSession } = await import('../src/features/catalogue/value-explanation-session');
const { loadValueExplanation } = await import('../src/features/catalogue/value-explanation-actions');
const { m } = await import('../src/paraglide/messages.js');

test('prepared value entry, refresh, reader retirement and public reentry cannot reuse private continuations', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const client = new QueryClient();
  const observe = () =>
    client.setQueryData(['session'], {
      state: reader ? 'signed-in' : 'signed-out',
      subject: reader,
      csrfToken: reader ? 'A'.repeat(22) : null,
    });
  observe();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host as unknown as HTMLElement);
  let episode: ValueRead = await loadValueExplanation({ data: fixture.address });
  const render = () =>
    act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(ValueExplanationSession, { id: fixture.id, address: { ...fixture.address }, locale: 'en', episode }),
        ),
      ),
    );
  const button = (name: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === name)!;
  const savedClick = (node: object) =>
    Reflect.get(
      node,
      Object.keys(node).find((key) => key.startsWith('__reactProps$'))!,
    ).onClick as () => void;
  let release!: () => void;
  const pause = () => {
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  try {
    await render();
    expect(host.textContent).toContain('9780156012195');
    expect(envelopes.at(-1)?.data.expectedReader).toBe(alice);
    expect(new Headers(envelopes.at(-1)?.headers).get('X-CSRF-Token')).toBe('A'.repeat(22));
    const healthy = envelopes.length;
    await render();
    expect(envelopes).toHaveLength(healthy);
    const staleMore = savedClick(button(m.value_more()));
    pause();
    await act(async () => button(m.value_more()).click());
    expect(envelopes.at(-1)?.data.session).toBe('value-session');
    reader = bob;
    fixture.selected.value = { type: 'value', content: 'Bob current value' };
    await act(async () => {
      observe();
      staleMore();
    });
    expect(host.textContent).toContain('Bob current value');
    expect(envelopes.at(-1)?.data).toMatchObject({ expectedReader: bob, cursor: undefined, session: undefined });
    await act(async () => release());
    expect(host.textContent).not.toContain('9780156012195');
    const calls = fixture.calls.length;
    expect(await loadValueExplanation({ data: { ...fixture.address, expectedReader: alice } })).toEqual({
      kind: 'denied',
    });
    expect(await loadValueExplanation({ data: { ...fixture.address, expectedReader: null } })).toEqual({
      kind: 'denied',
    });
    expect(fixture.calls).toHaveLength(calls);
    pause();
    await act(async () => button(m.candidate_reload()).click());
    const lost = release;
    fixture.selected.value = { type: 'value', content: 'Refreshed current value' };
    episode = { kind: 'unavailable' };
    await render();
    await act(async () => lost());
    expect(host.textContent).toContain('Refreshed current value');
    reader = null;
    await act(async () => observe());
    expect(host.textContent).toContain('Refreshed current value');
    expect(fixture.calls.at(-1)?.authorization).toBeNull();
    await act(async () => {
      reader = alice;
      observe();
      reader = bob;
      observe();
      reader = alice;
      observe();
    });
    expect(envelopes.at(-1)?.data).toMatchObject({ expectedReader: alice, session: undefined });
    pause();
    await act(async () => button(m.candidate_reload()).click());
    const retired = savedClick(button(m.candidate_reload()));
    await act(async () => root.unmount());
    const count = envelopes.length;
    await act(async () => {
      retired();
      release();
    });
    expect(envelopes).toHaveLength(count);
    expect(host.textContent).toBe('');
  } finally {
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
