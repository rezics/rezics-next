import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { globalContext, loadExposure, parseDiscovery } from '../src/platform/exposure/data';

const metadata = {
  operationId: 'exposure.open',
  'x-action': 'exposure:open',
  'x-exposure': 'public',
  'x-authority-resource-types': ['semantic.context'],
  'x-authority-resource-id': globalContext.id,
};
const document = (detail: Record<string, unknown>) => ({
  paths: { '/v1/platform/exposure/{group}:open': { post: detail } },
});

test('exposure discovery consumes the genuine mounted fixed Global reference and rejects malformed fixed declarations', () => {
  expect(parseDiscovery(document(metadata))?.bindings).toEqual([
    { action: 'open', type: 'semantic.context', id: globalContext.id },
  ]);
  for (const invalid of [
    { 'x-authority-resource-id': null },
    { 'x-authority-resource-id': '00000000-0000-8000-8000-000000000001' },
    { 'x-authority-resource-id': `${globalContext.id}\n` },
    { 'x-authority-resource-types': undefined, 'x-resource-types': ['semantic.context'] },
    { 'x-authority-resource-types': ['access.account'] },
    { 'x-authority-resource-types': ['semantic.context', 'access.account'] },
    { 'x-authority-anchor': 'own-account' },
    { 'x-account-authority': 'self' },
  ])
    expect(parseDiscovery(document({ ...metadata, ...invalid }))?.bindings).toEqual([]);
});

test('fixed Global exposure controls require the exact native resource, action and operation independently of configuration admission', async () => {
  for (const [action, operation, id, offered] of [
    ['exposure:open', 'exposure.open', globalContext.id, ['open']],
    ['exposure:open', 'exposure.close', globalContext.id, []],
    ['exposure:manage_read', 'exposure.open', globalContext.id, []],
    ['gate:any', 'exposure.open', globalContext.id, []],
    ['exposure:open', 'exposure.open', '00000000-0000-8000-8000-000000000001', null],
  ] as const) {
    const calls: string[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        calls.push(path);
        expect(request.headers.get('authorization')).toBe('Bearer viewer');
        if (path === '/v1/openapi.json') return Response.json(document(metadata));
        if (path !== '/v1/viewerActions') throw new Error(`Unexpected request: ${path}`);
        expect(await request.json()).toEqual({ resources: [{ type: 'semantic.context', id: globalContext.id }] });
        return Response.json({
          resources: [{ type: 'semantic.context', id, viewerActions: [{ action, operations: [operation] }] }],
        });
      }) as typeof fetch,
    });
    const page = await loadExposure(client, 'Bearer viewer');
    expect(page.status).toBe('ready');
    if (page.status !== 'ready') throw new Error('Missing discovery page');
    expect(page.authority).toEqual(
      offered === null ? { status: 'unavailable' } : { status: 'available', offered: [...offered] },
    );
    expect(calls).toEqual(['/v1/openapi.json', '/v1/viewerActions']);
  }
});
