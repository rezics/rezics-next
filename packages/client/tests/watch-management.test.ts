import { expect, test } from 'bun:test';
import { createKernelClient, type WatchManagementItem, type WatchManagementKind, type WatchManagementPage } from '../src/index.ts';

const accountId = '019a1b2c-3d4e-7f00-8a00-000000000001';
const watchId = '019a1b2c-3d4e-7f00-8a00-000000000002';
const boardId = '019a1b2c-3d4e-7f00-8a00-000000000003';
const kind: WatchManagementKind = 'board';
const hidden: WatchManagementItem = {
  id: watchId, kind, revision: 3, createdAt: '2026-11-04T00:00:00.000Z', state: 'unavailable',
};

test('installed watch methods preserve concealed DTOs, exact cursor retries and removal identity', async () => {
  const sent: { url: URL; method: string; body: unknown; key: string | null }[] = [];
  const page: WatchManagementPage = { items: [hidden], next: null };
  const client = createKernelClient('http://kernel.test', {
    fetch: (async (input, init) => {
      sent.push({
        url: new URL(String(input)), method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
        key: new Headers(init?.headers).get('idempotency-key'),
      });
      return Response.json(init?.method === 'DELETE' ? { removed: true } : page);
    }) as typeof fetch,
  });
  const watches = client.accounts({ accountId }).watches;
  const cursor = 'same+cursor/with=padding';
  for (let retry = 0; retry < 2; retry++) {
    const result = await watches.get({ query: { kind, limit: 1, cursor } });
    const installed: WatchManagementPage | null = result.data;
    expect(installed).toEqual(page);
  }
  const key = JSON.stringify(crypto.randomUUID());
  for (let retry = 0; retry < 2; retry++) {
    expect((await watches({ watchId }).delete({ expectedRevision: hidden.revision }, {
      query: { kind }, headers: { 'idempotency-key': key },
    })).data).toEqual({ removed: true });
  }
  expect(sent.map(({ url, method }) => `${method} ${url.pathname}`)).toEqual([
    ...Array(2).fill(`GET /v1/accounts/${accountId}/watches`),
    ...Array(2).fill(`DELETE /v1/accounts/${accountId}/watches/${watchId}`),
  ]);
  for (const request of sent.slice(0, 2)) {
    expect(Object.fromEntries(request.url.searchParams)).toEqual({ kind, limit: '1', cursor });
  }
  for (const request of sent.slice(2)) {
    expect(request.url.searchParams.get('kind')).toBe(kind);
    expect(request.body).toEqual({ expectedRevision: 3 });
    expect(request.key).toBe(key);
  }
});

test('installed board control sends explicit CAS state and reads confirmed state', async () => {
  let state = { watching: false, revision: 0 };
  const client = createKernelClient('http://kernel.test', {
    fetch: (async (_input, init) => {
      if (init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toEqual({ watching: true, expectedRevision: 0 });
        state = { watching: true, revision: 1 };
      }
      return Response.json(state);
    }) as typeof fetch,
  });
  const watch = client.boards({ id: boardId }).watch;
  expect((await watch.get()).data).toEqual({ watching: false, revision: 0 });
  expect((await watch.put({ watching: true, expectedRevision: 0 }, {
    headers: { 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
  })).data).toEqual({ watching: true, revision: 1 });
  expect((await watch.get()).data).toEqual({ watching: true, revision: 1 });
});
