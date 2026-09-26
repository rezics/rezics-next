import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { NpmResolution } from '../../../services/main/src/modules/package/npm-resolution.ts';
import { npmPolicyFixture } from './npm-policy-snapshot.ts';

export async function assertNpmPolicyApi(context: {
  call: (method: string, path: string, token: string, body?: unknown, key?: string) => Promise<Response>;
  pool: Pool; resolveToken: string; readToken: string; otherReadToken: string;
}) {
  const { call, pool, resolveToken, readToken, otherReadToken } = context;
  const path = '/v1/package-resolutions/npm';
  const body = npmPolicyFixture();
  const key = `npm-policy-${randomUUID()}`;
  expect((await call('POST', path, readToken, body, key)).status).toBe(401);
  expect((await pool.query('SELECT id FROM pkg.npm_resolution WHERE idempotency_key = $1', [key])).rowCount).toBe(0);
  const writes = await Promise.all([0, 1].map(() => call('POST', path, resolveToken, body, key)));
  expect(writes.map(response => response.status).sort()).toEqual([200, 201]);
  const responses = await Promise.all(writes.map(response => response.json())) as
    Array<{ resolution: NpmResolution; replayed: boolean }>;
  const receipt = responses[0]!.resolution;
  expect(responses[1]!.resolution).toEqual(receipt);
  expect(receipt).toMatchObject({ profile: 'npm-lock-topology-receipt-v5', request: body,
    outcome: { status: 'validated', engineTarget: body.engineTarget,
      overrideSelections: [expect.objectContaining({ name: 'leaf', declaredSpecifier: '1.0.0',
        effectiveSpecifier: '2.0.0' })] } });
  const id = receipt.resolution.split('/').at(-1)!;
  expect((await call('GET', `${path}/${id}`, resolveToken)).status).toBe(401);
  expect((await call('GET', `${path}/${id}`, otherReadToken)).status).toBe(404);
  expect(await (await call('GET', `${path}/${id}`, readToken)).json()).toEqual(receipt);
  expect(await (await call('POST', path, resolveToken, body, key)).json())
    .toEqual({ resolution: receipt, replayed: true });
  for (const changed of [{ ...body, engineTarget: { ...body.engineTarget, nodeVersion: '27.0.0' } },
    npmPolicyFixture('engine-incompatible'), npmPolicyFixture('nested-override')]) {
    expect((await call('POST', path, resolveToken, changed, key)).status).toBe(409);
  }
  for (const [kind, status] of [['engine-incompatible', 'invalid-topology'],
    ['nested-override', 'unsupported-semantics'], ['direct-conflict', 'unsupported-semantics'],
    ['missing-provenance', 'incomplete-source-data']] as const) {
    const request = npmPolicyFixture(kind);
    const result = await call('POST', path, resolveToken, request);
    expect(result.status).toBe(201);
    expect((await result.json() as { resolution: NpmResolution }).resolution.outcome.status).toBe(status);
  }
  expect((await pool.query('SELECT request, outcome FROM pkg.npm_resolution WHERE id = $1', [id])).rows)
    .toEqual([{ request: body, outcome: receipt.outcome }]);
  await expect(pool.query('UPDATE pkg.npm_resolution SET request = $2 WHERE id = $1',
    [id, JSON.stringify({ ...body, policy: 'altered' })])).rejects.toThrow();
  return { body, key, receipt, id };
}
