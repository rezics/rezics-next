import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { NpmResolution } from '../../../services/main/src/modules/package/npm-resolution.ts';
import { npmBytes } from './npm-lock-snapshot.ts';
import { npmIdentityFixture } from './npm-identity-snapshot.ts';

export async function assertNpmIdentityApi(context: {
  call: (method: string, path: string, token: string, body?: unknown, key?: string) => Promise<Response>;
  pool: Pool; resolveToken: string; readToken: string; otherReadToken: string;
}) {
  const { call, pool, resolveToken, readToken, otherReadToken } = context;
  const path = '/v1/package-resolutions/npm';
  const body = npmIdentityFixture('workspace-internal');
  const key = `npm-identity-${randomUUID()}`;
  expect((await call('POST', path, readToken, body, key)).status).toBe(401);
  expect((await pool.query('SELECT id FROM pkg.npm_resolution WHERE idempotency_key = $1', [key])).rowCount).toBe(0);
  const concurrent = await Promise.all([0, 1].map(() => call('POST', path, resolveToken, body, key)));
  expect(concurrent.map(response => response.status).sort()).toEqual([200, 201]);
  const writes = await Promise.all(concurrent.map(response => response.json())) as
    Array<{ resolution: NpmResolution; replayed: boolean }>;
  const receipt = writes[0]!.resolution;
  expect(writes[1]!.resolution).toEqual(receipt);
  expect(receipt).toMatchObject({ profile: 'npm-lock-topology-receipt-v3', request: body,
    outcome: { status: 'validated', provenance: 'caller-supplied' } });
  expect(receipt.outcome.instances).toContainEqual(expect.objectContaining({ kind: 'registry',
    path: 'node_modules/renamed', slotName: 'renamed', name: 'actual' }));
  expect(receipt.outcome.instances).toContainEqual(expect.objectContaining({ kind: 'link',
    path: 'node_modules/widget', resolved: 'packages/widget', linkTarget: expect.objectContaining({ path: 'packages/widget' }) }));
  const id = receipt.resolution.split('/').at(-1)!;
  const readPath = `${path}/${id}`;
  expect((await call('GET', readPath, resolveToken)).status).toBe(401);
  expect((await call('GET', readPath, otherReadToken)).status).toBe(404);
  const read = await call('GET', readPath, readToken);
  expect(read.headers.get('cache-control')).toBe('no-store');
  expect(await read.json()).toEqual(receipt);
  expect(await (await call('POST', path, resolveToken, body, key)).json()).toEqual({ resolution: receipt, replayed: true });
  const raw = (part: 'manifest' | 'lock') => Buffer.from(body[part].bytesBase64, 'base64').toString();
  const changedWorkspace = structuredClone(body);
  changedWorkspace.workspaces[0]!.manifest = npmBytes(Buffer.from(body.workspaces[0]!.manifest.bytesBase64, 'base64').toString() + '\n');
  const { workspaces: _workspaces, ...v1Fields } = body;
  for (const changed of [{ ...body, manifest: npmBytes(raw('manifest') + '\n') },
    { ...body, lock: npmBytes(raw('lock') + ' ') }, changedWorkspace, { ...body, workspaces: [] },
    { ...body, policy: 'legacy-peers' }, { ...body, npmVersion: '12.0.0' },
    npmIdentityFixture('workspace-name-path'),
    { ...v1Fields, profile: 'npm-lock-v3-topology-v1', policy: 'literal-sources-required-peers-v1' }]) {
    expect((await call('POST', path, resolveToken, changed, key)).status).toBe(409);
  }
  const newKey = await call('POST', path, resolveToken, body);
  expect(newKey.status).toBe(201);
  const independent = (await newKey.json() as { resolution: NpmResolution }).resolution;
  expect(independent.resolution).not.toBe(receipt.resolution);
  expect(independent.requestDigest).toBe(receipt.requestDigest);
  expect(independent.outcome).toEqual(receipt.outcome);
  expect((await pool.query('SELECT request, outcome FROM pkg.npm_resolution WHERE id = $1', [id])).rows)
    .toEqual([{ request: body, outcome: receipt.outcome }]);
  await expect(pool.query('UPDATE pkg.npm_resolution SET request = $2 WHERE id = $1',
    [id, JSON.stringify(changedWorkspace)])).rejects.toThrow();
  await expect(pool.query('DELETE FROM pkg.npm_resolution WHERE id = $1', [id])).rejects.toThrow();
  for (const [request, status] of [[npmIdentityFixture('two-aliases'), 'validated'],
    [npmIdentityFixture('workspace-name-path'), 'validated'], [npmIdentityFixture('alias-peer'), 'invalid-topology'],
    [npmIdentityFixture('missing-workspace-target'), 'incomplete-source-data'],
    [npmIdentityFixture('alias-identity-mismatch'), 'unsupported-semantics'],
    [npmIdentityFixture('overrides'), 'unsupported-semantics'],
    [{ ...body, lock: npmBytes(raw('lock') + ' '.repeat(65_536)) }, 'budget-exhausted']] as const) {
    const response = await call('POST', path, resolveToken, request);
    expect(response.status).toBe(201);
    const saved = await response.json() as { resolution: NpmResolution };
    expect(saved.resolution.outcome.status).toBe(status);
    expect(saved.resolution.request).toEqual(request);
    if (status !== 'validated') expect(saved.resolution.outcome).toMatchObject({ instances: [], edges: [] });
    expect(await (await call('GET', `${path}/${saved.resolution.resolution.split('/').at(-1)}`, readToken)).json()).toEqual(saved.resolution);
  }
  for (const [malformed, status] of [[npmIdentityFixture('malformed-link'), 422],
    [npmIdentityFixture('malformed-source'), 422], [npmIdentityFixture('malformed-integrity'), 422],
    [{ ...body, workspaces: null }, 400], [{ ...body, workspaces: [body.workspaces[0], body.workspaces[0]] }, 422],
    [{ ...body, workspaces: [{ ...body.workspaces[0], manifest: { ...body.workspaces[0]!.manifest, sha256: '0'.repeat(64) } }] }, 422]] as const) {
    const invalidKey = `npm-identity-invalid-${randomUUID()}`;
    expect((await call('POST', path, resolveToken, malformed, invalidKey)).status).toBe(status);
    expect((await pool.query('SELECT id FROM pkg.npm_resolution WHERE idempotency_key = $1', [invalidKey])).rowCount).toBe(0);
  }
  return { body, key, path, readPath, receipt, id };
}
