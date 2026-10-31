import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { nativeContinueSource } from '../src/library/continue-adapter';
import { continueFailure } from '../src/library/continue-source';

test('Continue accepts genuine native empty and forwards the opaque cursor unchanged', async () => {
  const calls: Request[] = [];
  const cursor = 'opaque+/cursor==';
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return Response.json({ subjects: [], next: null });
    }) as typeof fetch,
  });

  expect(await nativeContinueSource(client, 'Bearer owner', { limit: 6, cursor })).toEqual({
    state: 'loaded',
    entries: [],
    next: null,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe('GET');
  expect(new URL(calls[0]!.url).pathname).toBe('/v1/libraryContinue');
  expect([...new URL(calls[0]!.url).searchParams]).toEqual([
    ['limit', '6'],
    ['cursor', cursor],
  ]);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer owner');
});

test('Continue keeps native preparation, credential, cursor and readiness failures distinct', async () => {
  for (const status of [202, 401, 403, 409, 503]) {
    const calls: Request[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        calls.push(new Request(input, init));
        return Response.json({}, { status, headers: { 'retry-after': '2' } });
      }) as typeof fetch,
    });

    expect(await nativeContinueSource(client, 'Bearer owner', { limit: 6 })).toEqual(continueFailure(status, '2'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer owner');
  }
});
