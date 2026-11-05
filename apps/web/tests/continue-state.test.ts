import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { PlatformClosedError } from '../src/kernel/platform-closed';
import { continueFailure, continueRetryDelay, type ContinueSource } from '../src/library/continue-source';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadContinueState } = await import('../src/library/continue-read');
const client = createKernelClient('https://kernel.example.test');
const request = () =>
  new Request('https://site.example.test/en/library/continue', { headers: { authorization: 'Bearer owner' } });

test('the private consumer preserves empty, preparation and native failure separately', async () => {
  for (const result of [
    { state: 'loaded', entries: [], next: null } as const,
    continueFailure(202, '2'),
    continueFailure(503),
    continueFailure(403),
  ]) {
    let reads = 0;
    const source: ContinueSource = async (_client, authorization, input) => {
      reads += 1;
      expect(authorization).toBe('Bearer owner');
      expect(input).toEqual({ limit: 6 });
      return { ...result, ...(result.state === 'loaded' ? { entries: [] } : {}) };
    };
    expect(await loadContinueState(client, request(), {}, {}, source)).toEqual(result);
    expect(reads).toBe(1);
  }
});

test('the delivered default caller reads one native FULL page and signed-out makes no source read', async () => {
  const calls: Request[] = [];
  const native = createKernelClient('https://kernel.example.test', {
    async fetch(input, init) {
      calls.push(new Request(input, init));
      return Response.json({ subjects: [], next: null });
    },
  });
  expect(await loadContinueState(native, request(), {})).toEqual({ state: 'loaded', entries: [], next: null });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe('GET');
  expect(new URL(calls[0]!.url).pathname).toBe('/v1/libraryContinue');
  expect([...new URL(calls[0]!.url).searchParams]).toEqual([
    ['limit', '6'],
    ['view', 'FULL'],
  ]);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer owner');
  const source: ContinueSource = async () => {
    throw new Error('must not read');
  };
  expect(await loadContinueState(client, new Request('https://site.example.test/en'), {}, {}, source)).toEqual({
    state: 'signed-out',
  });
});

test('the prepared reader preserves typed and serialized platform closure from its source', async () => {
  const failures = [
    new PlatformClosedError(403, { code: 'platform_closed' }),
    Object.assign(new Error('rezics-platform-closed'), { name: 'PlatformClosedError' }),
  ];
  for (const failure of failures) {
    const source: ContinueSource = async () => {
      throw failure;
    };
    expect(await loadContinueState(client, request(), {}, {}, source)).toEqual({ state: 'closed' });
  }
});

test('only preparation retries, with a capped delay and two automatic attempts', () => {
  expect(continueRetryDelay(continueFailure(503), 0)).toBeNull();
  expect(continueRetryDelay(continueFailure(202, '600'), 0)).toBe(30_000);
  expect(continueRetryDelay(continueFailure(202, '2'), 1)).toBe(2_000);
  expect(continueRetryDelay(continueFailure(202, '2'), 2)).toBeNull();
});
