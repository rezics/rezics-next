import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';

const actor: AccountActor = {
  kind: 'account',
  accountId: newId(0x1234),
  clientId: newId(0x5678),
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};
const access: Access = {
  async authenticate() {
    return actor;
  },
  async authorize() {
    return true;
  },
};
const pool = createPool('postgres://kernel.invalid/reading-page-mount');
afterAll(() => pool.end());
const kernel = createKernel({
  pool,
  routeKey: new Uint8Array(32).fill(7),
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) },
  access,
});

test('thread reading page is mounted once with its closed public read contract', () => {
  expect(kernel.routes.filter((route) => route.method === 'GET' && route.path === '/v1/threads/:id/reading-page'))
    .toHaveLength(1);
  const operation = openApiDocument(kernel).paths['/v1/threads/{id}/reading-page']?.get;
  expect(operation).toMatchObject({
    operationId: 'thread.reading_page',
    'x-resource-types': ['content.thread'],
    'x-exposure': 'public',
    'x-action': 'thread:read',
  });
  expect(operation?.responses?.[200]?.content?.['application/json']?.schema).toBeDefined();
});
