import { afterAll, expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { ShelfTitlePreparationSteps } from '../src/library/shelf-title-preparation';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());
const { prepareShelfTitleStep } = await import('../src/library/personal-library-server');

test('title preparation retries the exact key and allocates the next key only for the next explicit step', async () => {
  const steps = new ShelfTitlePreparationSteps();
  const keys: string[] = [];
  let calls = 0;
  const prepare = async (key: string) => {
    keys.push(key);
    calls++;
    if (calls === 1) throw new Error('response lost');
    return calls === 2
      ? { installation: 'pending' as const, prepared: 100 }
      : { installation: 'installed' as const, prepared: 20 };
  };

  await expect(steps.run(prepare)).rejects.toThrow('response lost');
  expect(await steps.run(prepare)).toEqual({ installation: 'pending', prepared: 100 });
  expect(await steps.run(prepare)).toEqual({ installation: 'installed', prepared: 20 });
  expect(keys[0]).toBe(keys[1]);
  expect(keys[2]).not.toBe(keys[1]);
});

test('a preparation step uses the generated native POST with its exact key and locale', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.invalid', {
    headers: { 'accept-language': 'ja-JP, ja;q=0.9' },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({ installation: 'pending', prepared: 40 });
    },
  });
  const key = '85941352-2101-4261-b25d-9eb49ed338a6';
  expect(await prepareShelfTitleStep(client, 'Bearer owner', key)).toEqual({
    installation: 'pending',
    prepared: 40,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.method).toBe('POST');
  expect(new URL(requests[0]!.url).pathname).toBe('/v1/libraryShelfTitlePreparation');
  expect(await requests[0]!.clone().text()).toBe('');
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer owner');
  expect(requests[0]!.headers.get('idempotency-key')).toBe(key);
  expect(requests[0]!.headers.get('accept-language')).toBe('ja-JP, ja;q=0.9');
  expect(requests[0]!.cache).toBe('no-store');
  expect(requests[0]!.redirect).toBe('manual');
});
