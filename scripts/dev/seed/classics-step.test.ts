import { expect, test } from 'bun:test';
import { SeedApiError, type SeedApi } from './api.ts';
import { ensureClassicSourceGraph } from './classics-step.ts';
import { seedKey } from './plan.ts';

test('G-909: source projection is created once, then replay only reads the immutable conversion', async () => {
  const path = '/v1/sources/conversions/00000000-0000-4000-a000-000000000001/source-graph';
  let exists = false;
  const calls: string[] = [];
  const api = {
    get: async (route: string, token: string) => {
      expect(route).toBe(path); expect(token).toBe('token'); calls.push('GET');
      if (!exists) throw new SeedApiError('Source graph', 404, '{}');
      return {};
    },
    post: async (route: string, body: unknown, token: string, key: string) => {
      expect(route).toBe(path); expect(token).toBe('token');
      expect(body).toEqual({ profile: 'source-open-library-work-v1' });
      expect(key).toBe(seedKey('source-graph', 'alice'));
      calls.push('POST'); exists = true; return {};
    },
  } as unknown as SeedApi;
  for (let run = 0; run < 2; run++) await ensureClassicSourceGraph(api, path.split('/')[4]!, 'token', 'alice');
  expect(calls).toEqual(['GET', 'POST', 'GET']);
});

test('G-909: a denied or unavailable source projection read never triggers a write', async () => {
  for (const status of [403, 503]) {
    let writes = 0;
    const api = { get: async () => { throw new SeedApiError('Source graph', status, '{}'); },
      post: async () => { writes++; return {}; } } as unknown as SeedApi;
    await expect(ensureClassicSourceGraph(api, 'conversion', 'token', 'alice')).rejects.toThrow(`HTTP ${status}`);
    expect(writes).toBe(0);
  }
});
