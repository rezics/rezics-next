import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
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

test('the missing generated caller is explicit unavailable and signed-out makes no source read', async () => {
  expect(await loadContinueState(client, request(), {})).toEqual({ state: 'unavailable', reason: 'missing-binding' });
  const source: ContinueSource = async () => {
    throw new Error('must not read');
  };
  expect(await loadContinueState(client, new Request('https://site.example.test/en'), {}, {}, source)).toEqual({
    state: 'signed-out',
  });
});

test('only preparation retries, with a capped delay and two automatic attempts', () => {
  expect(continueRetryDelay(continueFailure(503), 0)).toBeNull();
  expect(continueRetryDelay(continueFailure(202, '600'), 0)).toBe(30_000);
  expect(continueRetryDelay(continueFailure(202, '2'), 1)).toBe(2_000);
  expect(continueRetryDelay(continueFailure(202, '2'), 2)).toBeNull();
});
