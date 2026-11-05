import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  readNativeCurationOpening,
  startCurationOpeningRead,
  type NativeCurationOpeningClient,
} from '../src/features/pages/curation-opening-read';

test('private opening forwards cancellation through the native client and never starts retired work', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push(new Request(input, init));
        return Response.json({ state: 'missing' });
      },
      { preconnect: fetch.preconnect },
    ),
  }) as unknown as NativeCurationOpeningClient<unknown>;
  const work = startCurationOpeningRead((signal) => readNativeCurationOpening(client, 'Bearer curator', signal));
  await work.promise;
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(new URL(request.url).pathname).toBe('/v1/presentation/curation');
  expect(request.headers.get('authorization')).toBe('Bearer curator');
  expect(request.cache).toBe('no-store');
  expect(request.redirect).toBe('manual');
  expect(request.signal.aborted).toBe(false);
  work.retire();
  expect(request.signal.aborted).toBe(true);
  const retired = startCurationOpeningRead((signal) => readNativeCurationOpening(client, 'Bearer curator', signal));
  retired.retire();
  await expect(retired.promise).rejects.toHaveProperty('name', 'AbortError');
  expect(() => readNativeCurationOpening(client, 'Bearer curator', retired.signal)).toThrow();
  expect(requests).toHaveLength(1);
});
