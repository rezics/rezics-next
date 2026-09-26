import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { NpmResolution } from '../../../services/main/src/modules/package/npm-resolution.ts';
import { npmBytes } from './npm-lock-snapshot.ts';
import { npmPlatformDocuments, npmPlatformFixture, npmPlatformRequest, npmTargets } from './npm-platform-snapshot.ts';

export async function assertNpmPlatformApi(context: {
  call: (method: string, path: string, token: string, body?: unknown, key?: string) => Promise<Response>;
  pool: Pool; resolveToken: string; readToken: string; otherReadToken: string;
}) {
  const { call, pool, resolveToken, readToken, otherReadToken } = context;
  const path = '/v1/package-resolutions/npm';
  const body = npmPlatformFixture('platform-branch', npmTargets[1]);
  const key = `npm-platform-${randomUUID()}`;
  expect((await call('POST', path, readToken, body, key)).status).toBe(401);
  expect((await pool.query('SELECT id FROM pkg.npm_resolution WHERE idempotency_key = $1', [key])).rowCount).toBe(0);
  const concurrent = await Promise.all([0, 1].map(() => call('POST', path, resolveToken, body, key)));
  expect(concurrent.map(response => response.status).sort()).toEqual([200, 201]);
  const writes = await Promise.all(concurrent.map(response => response.json())) as
    Array<{ resolution: NpmResolution; replayed: boolean }>;
  const receipt = writes[0]!.resolution;
  expect(writes[1]!.resolution).toEqual(receipt);
  expect(receipt).toMatchObject({ profile: 'npm-lock-topology-receipt-v2', request: body,
    outcome: { status: 'validated', target: npmTargets[1],
      omittedInstances: [{ path: 'node_modules/addon', causePath: 'node_modules/addon' },
        { path: 'node_modules/leaf', causePath: 'node_modules/addon' }] } });
  const id = receipt.resolution.split('/').at(-1)!;
  const readPath = `${path}/${id}`;
  expect((await call('GET', readPath, resolveToken)).status).toBe(401);
  expect((await call('GET', readPath, otherReadToken)).status).toBe(404);
  const read = await call('GET', readPath, readToken);
  expect(read.headers.get('cache-control')).toBe('no-store');
  expect(await read.json()).toEqual(receipt);
  expect(await (await call('POST', path, resolveToken, body, key)).json()).toEqual({ resolution: receipt, replayed: true });
  const raw = (part: 'manifest' | 'lock') => Buffer.from(body[part].bytesBase64, 'base64').toString();
  const { target: _target, ...v1Fields } = body;
  for (const changed of [{ ...body, target: npmTargets[0] }, { ...body, target: { os: 'future', cpu: 'x64' } },
    { ...body, target: { os: 'win32', cpu: 'arm64' } }, { ...body, manifest: npmBytes(raw('manifest') + '\n') },
    { ...body, lock: npmBytes(raw('lock') + ' ') }, { ...body, policy: 'legacy-peers' },
    { ...v1Fields, profile: 'npm-lock-v3-topology-v1', policy: 'literal-sources-required-peers-v1' }]) {
    expect((await call('POST', path, resolveToken, changed, key)).status).toBe(409);
  }
  expect((await pool.query('SELECT request, outcome FROM pkg.npm_resolution WHERE id = $1', [id])).rows)
    .toEqual([{ request: body, outcome: receipt.outcome }]);
  await expect(pool.query('UPDATE pkg.npm_resolution SET request = $2 WHERE id = $1',
    [id, JSON.stringify({ ...body, target: npmTargets[0] })])).rejects.toThrow();
  await expect(pool.query('DELETE FROM pkg.npm_resolution WHERE id = $1', [id])).rejects.toThrow();
  for (const [request, status] of [[npmPlatformFixture('optional-child-platform', npmTargets[1]), 'validated'],
    [npmPlatformFixture('required-peer-shadow'), 'invalid-topology'], [npmPlatformFixture('optional-peer-shadow'), 'invalid-topology'],
    [npmPlatformFixture('required-missing'), 'incomplete-source-data'],
    [npmPlatformFixture('shared-platform-required', npmTargets[1]), 'invalid-topology'],
    [{ ...body, target: { os: 'future', cpu: 'x64' } }, 'unsupported-semantics'],
    [{ ...body, lock: npmBytes(raw('lock') + ' '.repeat(65_536)) }, 'budget-exhausted']] as const) {
    const response = await call('POST', path, resolveToken, request);
    expect(response.status).toBe(201);
    const saved = await response.json() as { resolution: NpmResolution };
    expect(saved.resolution.outcome.status).toBe(status);
    expect(saved.resolution.request).toEqual(request);
    if (status !== 'validated') expect(saved.resolution.outcome).toMatchObject({ instances: [], edges: [],
      activeInstances: [], activeEdges: [], omittedInstances: [], omittedEdges: [] });
    expect(await (await call('GET', `${path}/${saved.resolution.resolution.split('/').at(-1)}`, readToken)).json()).toEqual(saved.resolution);
  }
  const malformedSelector = npmPlatformDocuments(); malformedSelector.lock.packages['node_modules/addon']!.os = [1];
  for (const [malformed, status] of [[{ ...body, manifest: { ...body.manifest, sha256: '0'.repeat(64) } }, 422],
    [{ ...body, target: {} }, 400], [{ ...body, target: null }, 400], [{ ...body, lock: npmBytes('{') }, 422],
    [npmPlatformRequest(malformedSelector.manifest, malformedSelector.lock), 422]] as const) {
    const invalidKey = `npm-platform-invalid-${randomUUID()}`;
    expect((await call('POST', path, resolveToken, malformed, invalidKey)).status).toBe(status);
    expect((await pool.query('SELECT id FROM pkg.npm_resolution WHERE idempotency_key = $1', [invalidKey])).rowCount).toBe(0);
  }
  return { body, key, path, readPath, receipt, id };
}
