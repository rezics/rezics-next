import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { createHomeSpaceSelection, readHomeSpace, type HomeSpace } from '../src/features/pages/home-feed-spaces';
import { PlatformClosedError } from '../src/kernel/platform-closed';

const space: HomeSpace = {
  spaceId: '00000000-0000-7000-8000-000000000001',
  headRevisionId: '00000000-0000-7000-8000-000000000002',
  realmId: '00000000-0000-7000-8000-000000000003',
  title: 'Reading room',
  address: 'reading-room',
};
function client(
  point: () => Promise<unknown>,
  resolve: () => Promise<unknown> = async () => ({ status: 200, data: { spaceId: space.spaceId } }),
) {
  return { spaceAddresses: () => ({ get: resolve }), spaces: () => ({ get: point }) } as unknown as KernelClient;
}

test('independent Space refusal or point failure disables an already selected address without losing its identity', async () => {
  for (const [status, code, expected] of [
    [401, 'authentication_required', 'auth'],
    [403, 'forbidden', 'denied'],
    [403, 'platform_closed', 'closed'],
    [404, 'not_found', 'not_found'],
    [503, 'index_not_ready', 'unavailable'],
    [409, 'stale_cursor', 'unavailable'],
    [0, 'network', 'unavailable'],
    [0, 'platform_closed', 'closed'],
  ] as const) {
    let fail = false;
    const reader = client(async () => {
      if (!fail) return { status: 200, data: { space: { ...space, state: 'active' } } };
      if (status) return { status, error: { value: { code } } };
      throw code === 'network' ? new Error('network') : new PlatformClosedError(403, { code });
    });
    const applied: boolean[] = [];
    const selection = createHomeSpaceSelection(
      (input, signal) => readHomeSpace(reader, input, undefined, signal),
      (_space, available) => {
        applied.push(available);
      },
    );
    await selection.lookup(space.address!, 'https://rezics.example');
    selection.select();
    fail = true;
    await selection.lookup(space.address!, 'https://rezics.example');
    expect(selection.snapshot()).toMatchObject({ status: expected, selected: space, available: false });
    expect(applied).toEqual([true, false]);
  }
});

test('Space admission and cancellation do no extra owner work; resolver closure stays distinct from denial', async () => {
  let calls = 0;
  const resolve = async () => {
    calls++;
    return { status: 403, error: { value: { code: 'platform_closed' } } };
  };
  const reader = client(async () => {
    calls++;
    throw new Error('unexpected point');
  }, resolve);
  expect(await readHomeSpace(reader, { spaceId: 'invalid' })).toEqual({ status: 'invalid' });
  const aborted = AbortSignal.abort();
  expect(await readHomeSpace(reader, { address: space.address! }, undefined, aborted)).toEqual({
    status: 'unavailable',
  });
  expect(calls).toBe(0);
  expect(await readHomeSpace(reader, { address: space.address! })).toEqual({ status: 'closed' });
  expect(calls).toBe(1);
  const malformed = client(
    async () => {
      throw new Error('unexpected point');
    },
    async () => ({ status: 200, data: {} }),
  );
  expect(await readHomeSpace(malformed, { address: space.address! })).toEqual({ status: 'unavailable' });
});
