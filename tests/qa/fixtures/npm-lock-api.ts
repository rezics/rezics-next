import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { NpmResolutionStore, type NpmResolution } from '../../../services/main/src/modules/package/npm-resolution.ts';
import { npmBytes, npmDocuments, npmFixture, npmRequest } from './npm-lock-snapshot.ts';
import { assertNpmPlatformApi } from './npm-platform-api.ts';
import { assertNpmIdentityApi } from './npm-identity-api.ts';
import { assertNpmCompositionApi } from './npm-composition-api.ts';

export async function assertNpmLockApi(context: {
  call: (method: string, path: string, token: string, body?: unknown, key?: string) => Promise<Response>;
  pool: Pool; principalId: string; resolveToken: string; readToken: string; otherReadToken: string;
}): Promise<{ body: ReturnType<typeof npmFixture>; key: string; path: string; readPath: string;
  platform: Awaited<ReturnType<typeof assertNpmPlatformApi>>;
  identity: Awaited<ReturnType<typeof assertNpmIdentityApi>>;
  composition: Awaited<ReturnType<typeof assertNpmCompositionApi>> }> {
  const { call, pool, principalId, resolveToken, readToken, otherReadToken } = context;
  const path = '/v1/package-resolutions/npm';
  const body = npmFixture();
  const key = `npm-${randomUUID()}`;
  expect((await call('POST', path, readToken, body, key)).status).toBe(401);
  expect((await pool.query('SELECT id FROM pkg.npm_resolution WHERE idempotency_key = $1', [key])).rowCount).toBe(0);
  const concurrent = await Promise.all([0, 1].map(() => call('POST', path, resolveToken, body, key)));
  expect(concurrent.map(response => response.status).sort()).toEqual([200, 201]);
  const writes = await Promise.all(concurrent.map(response => response.json())) as
    Array<{ resolution: NpmResolution; replayed: boolean }>;
  const receipt = writes[0]!.resolution;
  expect(writes[1]!.resolution).toEqual(receipt);
  expect(receipt).toMatchObject({ profile: 'npm-lock-topology-receipt-v1', request: body,
    outcome: { status: 'validated', provenance: 'caller-supplied' } });
  expect(receipt.outcome.instances.filter(node => node.name === 'shared').map(node => node.version)).toEqual(['1.0.0', '2.0.0']);
  const peer = receipt.outcome.instances.find(node => node.path === 'node_modules/left/node_modules/plugin')!;
  const host = receipt.outcome.instances.find(node => node.path === 'node_modules/left/node_modules/shared')!;
  expect(peer.peerHosts).toEqual([{ name: 'shared', specifier: '1.0.0', host: host.id, path: host.path }]);
  const id = receipt.resolution.split('/').at(-1)!;
  const readPath = `${path}/${id}`;
  expect((await call('GET', readPath, resolveToken)).status).toBe(401);
  expect((await call('GET', readPath, otherReadToken)).status).toBe(404);
  const read = await call('GET', readPath, readToken);
  expect(read.headers.get('cache-control')).toBe('no-store');
  expect(await read.json()).toEqual(receipt);
  expect(await (await call('POST', path, resolveToken, body, key)).json()).toEqual({ resolution: receipt, replayed: true });
  const raw = (part: 'manifest' | 'lock') => Buffer.from(body[part].bytesBase64, 'base64').toString();
  for (const changed of [{ ...body, manifest: npmBytes(raw('manifest') + '\n') },
    { ...body, lock: npmBytes(raw('lock') + ' ') }, { ...body, policy: 'legacy-peers' },
    { ...body, npmVersion: '11.0.0' }]) {
    expect((await call('POST', path, resolveToken, changed, key)).status).toBe(409);
  }
  expect((await pool.query('SELECT request, outcome FROM pkg.npm_resolution WHERE id = $1', [id])).rows)
    .toEqual([{ request: body, outcome: receipt.outcome }]);
  await expect(pool.query('UPDATE pkg.npm_resolution SET outcome = $2 WHERE id = $1',
    [id, JSON.stringify({ status: 'validated' })])).rejects.toThrow();
  await expect(pool.query('DELETE FROM pkg.npm_resolution WHERE id = $1', [id])).rejects.toThrow();
  const unsupported = npmDocuments(); unsupported.lock.packages['node_modules/left']!.optionalDependencies = {};
  for (const [request, status] of [[npmFixture('incompatible-peer'), 'invalid-topology'],
    [npmFixture('missing-peer'), 'incomplete-source-data'], [npmFixture('child-local-peer'), 'invalid-topology'],
    [npmRequest(unsupported.manifest, unsupported.lock), 'unsupported-semantics'],
    [{ ...body, lock: npmBytes(raw('lock') + ' '.repeat(65_536)) }, 'budget-exhausted']] as const) {
    const write = await call('POST', path, resolveToken, request);
    expect(write.status).toBe(201);
    const saved = await write.json() as { resolution: NpmResolution };
    expect(saved.resolution.outcome).toMatchObject({ status, instances: [], edges: [] });
    expect(saved.resolution.request).toEqual(request);
    expect(await (await call('GET', `${path}/${saved.resolution.resolution.split('/').at(-1)}`, readToken)).json())
      .toEqual(saved.resolution);
  }
  for (const malformed of [{ ...body, manifest: { ...body.manifest, sha256: '0'.repeat(64) } },
    { ...body, lock: npmBytes('{') },
    { ...body, lock: npmBytes(raw('lock').replace('"packages":{', '"packages":{"node_modules\\u002fleft":{},')) }]) {
    const invalidKey = `npm-invalid-${randomUUID()}`;
    expect((await call('POST', path, resolveToken, malformed, invalidKey)).status).toBe(422);
    expect((await pool.query('SELECT id FROM pkg.npm_resolution WHERE idempotency_key = $1', [invalidKey])).rowCount).toBe(0);
  }
  const platform = await assertNpmPlatformApi(context);
  const identity = await assertNpmIdentityApi(context);
  const composition = await assertNpmCompositionApi(context);
  expect((await call('POST', path, resolveToken, platform.body, key)).status).toBe(409);
  expect((await call('POST', path, resolveToken, identity.body, key)).status).toBe(409);
  expect((await call('POST', path, resolveToken, identity.body, platform.key)).status).toBe(409);
  for (const previousKey of [key, platform.key, identity.key]) {
    expect((await call('POST', path, resolveToken, composition.body, previousKey)).status).toBe(409);
  }
  // Real owner calls and native plans at growing unrelated history sizes.
  // Background is bulk copied once per scale, never command seeded or revalidated.
  const statements: Array<{ sql: string; values: unknown[]; rows: number | null }> = [];
  const observed = new NpmResolutionStore({ query: async (sql: string, values: unknown[]) => {
    const result = await pool.query(sql, values);
    statements.push({ sql, values, rows: result.rowCount });
    return result;
  } } as unknown as Pool);
  let previous = 0;
  const evidence: unknown[] = [];
  for (const count of [64, 512, 4096]) {
    await pool.query(`INSERT INTO pkg.npm_resolution
      (id, principal_id, idempotency_key, request_digest, request, outcome)
      SELECT gen_random_uuid(), principal_id, $2 || n, request_digest, request, outcome
      FROM pkg.npm_resolution CROSS JOIN generate_series($3::int, $4::int) n WHERE id = $1`,
    [id, `${key}-history-`, previous + 1, count]);
    previous = count;
    await pool.query('ANALYZE pkg.npm_resolution');
    statements.length = 0;
    expect(await observed.read(principalId, id)).toEqual(receipt);
    expect(await observed.resolve(principalId, key, body)).toEqual({ resolution: receipt, replayed: true });
    expect(await observed.read(principalId, platform.id)).toEqual(platform.receipt);
    expect(await observed.resolve(principalId, platform.key, platform.body)).toEqual({ resolution: platform.receipt, replayed: true });
    expect(await observed.read(principalId, identity.id)).toEqual(identity.receipt);
    expect(await observed.resolve(principalId, identity.key, identity.body)).toEqual({ resolution: identity.receipt, replayed: true });
    expect(await observed.read(principalId, composition.id)).toEqual(composition.receipt);
    expect(await observed.resolve(principalId, composition.key, composition.body)).toEqual({ resolution: composition.receipt, replayed: true });
    expect(statements.map(statement => statement.rows)).toEqual([1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1]);
    const plans: Array<{ type: string; rows: number; filtered: number; blocks: number }> = [];
    for (const statement of statements.filter(statement => statement.sql.startsWith('SELECT'))) {
      const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${statement.sql}`, statement.values);
      const plan = result.rows[0]['QUERY PLAN'][0].Plan;
      expect(plan['Actual Rows']).toBe(1);
      // PostgreSQL may scan a 64-row table when it fits in a few pages.
      // At material history sizes the indexed owner lookup must stay selective.
      if (count >= 512) expect(plan['Rows Removed by Filter'] ?? 0).toBeLessThanOrEqual(1);
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(32);
      expect(plan['Temp Read Blocks']).toBe(0);
      plans.push({ type: plan['Node Type'], rows: plan['Actual Rows'], filtered: plan['Rows Removed by Filter'] ?? 0,
        blocks: plan['Shared Hit Blocks'] + plan['Shared Read Blocks'] });
    }
    evidence.push({ unrelatedReceipts: count, operationRows: statements.map(statement => statement.rows),
      planOrder: ['v1-id', 'v1-key', 'v2-id', 'v2-key', 'v3-id', 'v3-key', 'v4-id', 'v4-key'], plans,
      costs: [receipt.outcome.cost, platform.receipt.outcome.cost, identity.receipt.outcome.cost, composition.receipt.outcome.cost] });
    expect(receipt.outcome.cost).toEqual((await observed.read(principalId, id))!.outcome.cost);
    expect(platform.receipt.outcome.cost).toEqual((await observed.read(principalId, platform.id))!.outcome.cost);
    expect(identity.receipt.outcome.cost).toEqual((await observed.read(principalId, identity.id))!.outcome.cost);
    expect(composition.receipt.outcome.cost).toEqual((await observed.read(principalId, composition.id))!.outcome.cost);
  }
  await writeFile(join(Bun.env.REZICS_QA_ARTIFACT_DIR ?? '.temp', 'npm-receipt-reads.json'), JSON.stringify(evidence, null, 2));
  return { body, key, path, readPath, platform, identity, composition };
}
