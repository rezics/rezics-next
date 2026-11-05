import { expect, test } from 'bun:test';
import './support/collection-publication-server-mock';
import { createKernelClient } from '@rezics/client';
import {
  publishQueryNative,
  readQueryPublicationNative,
  queryPublicationInput,
  queryPublicationResponse,
} from '../src/library/saved-query-publication/query';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';

const collectionId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const id = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const generation = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const input = { collectionId, revision: 7, visibility: 'unlisted' as const, idempotencyKey: crypto.randomUUID() };
const csrfToken = 'A'.repeat(22);
const request = () =>
  new Request('https://site.test/_serverFn/query-publication', {
    method: 'POST',
    headers: {
      authorization: 'Bearer owner-token',
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin: 'https://site.test',
      'X-CSRF-Token': csrfToken,
    },
  });
const env: Partial<SessionEnv> = {
  SITE_ORIGINS: 'https://site.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'publication-test',
  WEBSITE_CLIENT_KEY: 'unused',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({ signedIn: async () => ({ signedIn: true, csrfToken }) }),
  } as unknown as DurableObjectNamespace<SessionStore>,
};

test('whole-query transport retains the exact request after lost acknowledgement and reads its actual completed generation', async () => {
  const calls: Request[] = [];
  const status = { id, collectionId, visibility: input.visibility, phase: 'staging' };
  const client = createKernelClient('https://kernel.test', {
    fetch: async (url, init) => {
      calls.push(new Request(url, init));
      if (calls.length === 1) throw new TypeError('Connection lost after dispatch');
      return Response.json(
        calls.length === 2 ? status : { ...status, phase: 'complete', publication: { generation } },
        { status: calls.length === 2 ? 202 : 200 },
      );
    },
  });
  expect(await publishQueryNative(client, request(), env, input)).toEqual({ ok: false, reason: 'unknown' });
  expect(await publishQueryNative(client, request(), env, input)).toEqual({ ok: true, status });
  expect(await readQueryPublicationNative(client, request(), env, { collectionId, id })).toEqual({
    ok: true,
    status: { ...status, phase: 'complete', publication: { generation } },
  });
  for (const call of calls.slice(0, 2)) {
    expect(new URL(call.url).pathname).toBe(`/v1/collections/${collectionId}:publish`);
    expect(call.headers.get('authorization')).toBe('Bearer owner-token');
    expect(call.headers.get('idempotency-key')).toBe(input.idempotencyKey);
    expect(await call.json()).toEqual({ revision: 7, visibility: 'unlisted' });
  }
  expect(calls[2]!.method).toBe('GET');
  expect(new URL(calls[2]!.url).pathname).toBe(`/v1/collectionPublications/${id}`);
});

test('whole-query boundary excludes subsets and never treats a pending or foreign generation as complete', () => {
  expect(queryPublicationInput(input)).toEqual(input);
  expect(() => queryPublicationInput({ ...input, subjectIds: [] })).toThrow();
  const status = { id, collectionId, visibility: input.visibility, phase: 'staging', publication: { generation } };
  expect(queryPublicationResponse(202, status, collectionId)).toEqual({
    ok: true,
    status: { id, collectionId, visibility: input.visibility, phase: 'staging' },
  });
  expect(queryPublicationResponse(200, { ...status, phase: 'complete' }, id).ok).toBe(false);
  expect(queryPublicationResponse(200, { ...status, phase: 'complete', publication: {} }, collectionId).ok).toBe(false);
});

test('returning to publication retries an unacknowledged request, then resumes the accepted episode without creating another', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/collections/test/publish' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    sessionStorage: window.sessionStorage,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryPublicationView } = await import('../src/library/saved-query-publication/query-view');
  const { m } = await import('../src/paraglide/messages.js');
  const host = document.createElement('div');
  document.body.append(host);
  let root = createRoot(host);
  const attempts: unknown[] = [];
  const reads: unknown[] = [];
  const status = { id, collectionId, visibility: 'unlisted' as const, phase: 'staging' as const };
  const transport = {
    async begin(input: unknown) {
      attempts.push(input);
      return attempts.length === 1 ? { ok: false as const, reason: 'unknown' as const } : { ok: true as const, status };
    },
    async read(input: unknown) {
      reads.push(input);
      return { ok: true as const, status: { ...status, phase: 'complete' as const, publication: { generation } } };
    },
  };
  const show = () =>
    act(async () => {
      root.render(
        <QueryPublicationView
          subject="owner"
          collectionId={collectionId}
          revision={7}
          capture={() => transport}
          isCurrent={() => true}
          canBegin={() => true}
        />,
      );
    });
  const click = (text: string) =>
    act(async () => {
      const button = [...host.querySelectorAll('button')].find((button) => button.textContent === text);
      expect(button).toBeDefined();
      button!.click();
      button!.click();
    });
  const remount = async () => {
    await act(async () => root.unmount());
    root = createRoot(host);
    await show();
  };
  try {
    await show();
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click(m.library_query_publication_publish());
    expect(attempts).toHaveLength(1);
    await remount();
    await click(m.library_publication_retry());
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await remount();
    await click(m.library_query_publication_status());
    expect(reads).toEqual([{ collectionId, id }]);
    expect(attempts).toHaveLength(2);
    expect(host.textContent).toContain(m.library_query_publication_complete());
    expect(host.textContent).toContain(generation);
    expect(host.querySelector('a')?.getAttribute('href')).toBe(`/en/collections/${collectionId}`);
    expect(sessionStorage.length).toBe(0);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
