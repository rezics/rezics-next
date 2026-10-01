import { expect, test } from 'bun:test';
import type { SeedEndpoints } from './api.ts';
import { waitForSeedApis } from './readiness.ts';

const endpoints: SeedEndpoints = { account: 'http://localhost:3004', main: 'http://localhost:3001',
  mailpit: 'http://localhost:8025', clientId: '', redirectUri: '', resource: '', scope: '' };

test('G-543: seed waits for a refused Accounts listener and an unready Main before fixture writes', async () => {
  const attempts = new Map<string, number>();
  const transport = async (url: string, init: RequestInit) => {
    const count = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, count);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url.includes('get-session') && count === 1) throw new TypeError('connection refused');
    return new Response(null, { status: url.includes('health/ready') && count === 1 ? 503 : 200 });
  };
  await waitForSeedApis(endpoints, { fetch: transport, retryMs: 1, timeoutMs: 1_000 });
  expect(Object.fromEntries(attempts)).toEqual({
    'http://localhost:3004/api/auth/get-session': 2,
    'http://localhost:3001/health/ready': 2,
    'http://localhost:8025/api/v1/messages?limit=1': 1,
  });
});

test('G-543: seed startup fails within its shared deadline when an API stays unavailable', async () => {
  const transport = async () => new Response(null, { status: 503 });
  await expect(waitForSeedApis(endpoints, { fetch: transport, retryMs: 1, timeoutMs: 15 }))
    .rejects.toThrow('Seed API did not become ready within the startup deadline:');
});

test('G-909: readiness probes Account directly while its public issuer still points to the Accounts proxy', async () => {
  const urls: string[] = [];
  await waitForSeedApis({ ...endpoints, accountService: 'http://localhost:3002' }, {
    fetch: async url => { urls.push(url); return new Response(null); }, timeoutMs: 1_000,
  });
  expect(urls).toContain('http://localhost:3002/api/auth/get-session');
  expect(urls).not.toContain('http://localhost:3004/api/auth/get-session');
  expect(endpoints.account).toBe('http://localhost:3004');
});
