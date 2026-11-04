import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadExposure, parseDiscovery } from '../src/platform/exposure/data';

const openOperation = {
  operationId: 'exposure.open',
  'x-action': 'exposure:open',
  'x-exposure': 'public',
};
const document = {
  paths: {
    '/v1/collections': {
      get: { operationId: 'collection.list', 'x-action': 'collection:list', 'x-exposure': 'gate:collections' },
    },
    '/v1/platform/exposure/{group}:open': { post: openOperation },
  },
};
const management = (open: boolean) => ({
  viewer: { accountId: 'viewer', clientId: 'exposure-management' },
  actions: { open, close: false },
  exposureGroups: [{ group: 'collections', open: false, at: '2026-10-31T00:00:00.123456Z' }],
  next: null,
});

test('viewer-filtered OpenAPI remains partial group discovery and malformed discovery cannot hide native management', async () => {
  expect(parseDiscovery(document)).toEqual({ status: 'available', groups: ['collections'] });
  for (const discovery of [
    Response.json({ paths: { '/broken': { get: {} } } }),
    new Response('offline', { status: 503 }),
  ]) {
    const calls: string[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        const path = new URL(new Request(input, init).url).pathname;
        calls.push(path);
        if (path === '/v1/openapi.json') return discovery;
        if (path === '/v1/platform/exposure/management') return Response.json(management(true));
        throw new Error(`Unexpected request: ${path}`);
      }) as typeof fetch,
    });
    const page = await loadExposure(client, 'Bearer viewer');
    expect(page).toMatchObject({
      status: 'ready',
      discovery: { status: 'unavailable' },
      current: { status: 'available', actions: { open: true, close: false } },
    });
    expect(calls.sort()).toEqual(['/v1/openapi.json', '/v1/platform/exposure/management']);
  }
});

test('visible command metadata does not grant advice that the native management response withholds', async () => {
  const calls: string[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      calls.push(path);
      if (path === '/v1/openapi.json') return Response.json(document);
      if (path === '/v1/platform/exposure/management') return Response.json(management(false));
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch,
  });
  const page = await loadExposure(client, 'Bearer viewer');
  expect(page.status).toBe('ready');
  if (page.status !== 'ready') throw new Error('Expected the admitted native page');
  expect(page.current.actions).toEqual({ open: false, close: false });
  expect(calls.sort()).toEqual(['/v1/openapi.json', '/v1/platform/exposure/management']);
});
