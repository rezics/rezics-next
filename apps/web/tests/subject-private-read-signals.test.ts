import { expect, mock, test } from 'bun:test';
import { subjectReadServerFixture } from './subject-read-server-fixture';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const server = subjectReadServerFixture();
const calls: { signal: AbortSignal; path: string }[] = [];
const serverSignals = server.signals;
let preparation = Promise.resolve();
let response = Promise.resolve();
let ownReactionUnavailable = false;
const id = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const native = createKernelClient('https://kernel.test', {
  fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, signal: init!.signal! });
    await response; // Deliberately ignores cancellation: admission must still reject it.
    if (path.endsWith('/reaction'))
      return Response.json({ kind: null }, { status: ownReactionUnavailable ? 503 : 200 });
    if (path.endsWith('/reactions')) return Response.json({ counts: [], watermark: null });
    if (path.endsWith('/source-statistics')) return Response.json([]);
    return new Response(null, { status: 404 });
  },
});
const session = await import('../src/session/request');
mock.module('../src/session/request', () => ({
  ...session,
  prepareSession: () => preparation,
  sessionSubject: () => 'reader',
  viewerCredential: () => 'Bearer token',
}));
mock.module('@tanstack/react-start', () => ({ ...start, createServerFn: server.createServerFn }));
mock.module('@tanstack/react-start/server', () => ({ ...start, getRequest: server.getRequest }));
mock.module('cloudflare:workers', () => ({ env: {} }));
const kernel = await import('../src/kernel/client');
mock.module('../src/kernel/client', () => ({ ...kernel, kernelClient: () => native }));
const {
  subjectRatingQuery,
  subjectReactionsQuery,
  subjectReaderQuery,
  subjectOwnRatingQuery,
  subjectOwnReactionQuery,
} = await import('../src/features/pages/subject-queries');
const scope = {
  reader: 'reader',
  admission: 1,
  view: 'overview',
  cacheEpoch: 1,
  scopeKey: 'test',
  isCurrent: () => true,
  hasLiveObserver: () => true,
};
const factories = [
  () => subjectRatingQuery(id, 'en', 'statistics'),
  () => subjectReactionsQuery(id, 'en'),
  () => subjectReaderQuery(id, 'en', scope),
  () => subjectOwnRatingQuery(id, 'en', scope),
  () => subjectOwnReactionQuery(id, 'en', scope),
] as const;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('retiring during private preparation prevents native scheduling and produces no successful empty outcome', async () => {
  for (const factory of factories.slice(2)) {
    calls.length = 0;
    const gate = deferred<void>();
    preparation = gate.promise;
    const client = new QueryClient();
    const options = factory() as ReturnType<typeof subjectReaderQuery>;
    const pending = client.fetchQuery(options).catch(() => undefined);
    await tick();
    await client.cancelQueries({ queryKey: options.queryKey, exact: true });
    gate.resolve();
    await pending;
    await tick();
    expect(calls).toHaveLength(0);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    client.clear();
    preparation = Promise.resolve();
  }
});

test('an exact live observer retains shared work; a fresh return replaces abandoned ignored-abort work', async () => {
  for (const factory of factories) {
    calls.length = serverSignals.length = 0;
    const gate = deferred<void>();
    response = gate.promise;
    const client = new QueryClient();
    const options = factory() as ReturnType<typeof subjectRatingQuery>;
    const first = new QueryObserver(client, { ...options, enabled: true });
    const second = new QueryObserver(client, { ...options, enabled: true });
    const detachFirst = first.subscribe(() => {});
    const detachSecond = second.subscribe(() => {});
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBe(serverSignals[0]!);
    detachFirst();
    expect(calls[0]!.signal.aborted).toBe(false);
    detachSecond();
    expect(calls[0]!.signal.aborted).toBe(true);
    response = Promise.resolve();
    const fresh = await client.fetchQuery(options);
    expect(calls).toHaveLength(2);
    gate.resolve();
    await tick();
    expect(client.getQueryData(options.queryKey)).toBe(fresh);
    client.clear();
  }
});

test('an own-reaction write settling before an unavailable old read keeps the current vote', async () => {
  const client = new QueryClient();
  const gate = deferred<void>();
  response = gate.promise;
  let revision = 0;
  const options = subjectOwnReactionQuery(id, 'en', { ...scope, getWriteRevision: () => revision });
  const pending = client.fetchQuery(options);
  await tick();
  revision++;
  ownReactionUnavailable = true;
  const written = { reader: 'reader', value: 'like' as const };
  client.setQueryData(options.queryKey, written);
  gate.resolve();
  expect(await pending).toEqual(written);
  expect(client.getQueryData(options.queryKey)).toEqual(written);
  response = Promise.resolve();
  ownReactionUnavailable = false;
  client.clear();
});
