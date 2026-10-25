import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../src/database/pool.ts';
import { createKernel } from '../src/http/kernel.ts';
import { bootstrapRelease } from '../src/semantic/definitions.ts';
import { globalReadEligibility } from '../src/semantic/eligibility.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
beforeAll(() => bootstrapRelease(pool, bundledRelease));
afterAll(() => pool.end());
// No access override: the kernel installs its production Access, so only a public floor admits anonymous readers.
const kernel = createKernel({ pool, routeKey: new Uint8Array(32).fill(7) });

async function call(method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

test('anonymous readers may search and suggest the global catalogue', async () => {
  // This kernel has no index, so an admitted read reaches index_not_ready; a denied one is forbidden.
  const search = await call('POST', '/v1/subjects:search', { text: 'kokoro' });
  expect([search.status, search.body.code]).toEqual([503, 'index_not_ready']);
  const suggest = await call('GET', '/v1/subjects:suggest?q=ko');
  expect([suggest.status, suggest.body.code]).toEqual([503, 'index_not_ready']);
});

test('anonymous readers may read the active definitions', async () => {
  const active = await call('GET', '/v1/definitions/active');
  expect(active.status).toBe(200);
  expect(active.body.digest).toBe(bundledDigest);
  const release = await call('GET', `/v1/definitions/releases/${encodeURIComponent(bundledDigest)}`);
  expect(release.status).toBe(200);
  expect(release.body.digest).toBe(bundledDigest);
});

test('the public floor is bound to read actions', () => {
  for (const action of ['subject:read', 'definitions:read', 'presentation:read'] as const)
    expect(globalReadEligibility(action)).toBeDefined();
  for (const action of ['subject:create', 'definitions:publish', 'access:grant'])
    expect(() => globalReadEligibility(action as never)).toThrow(TypeError);
});
