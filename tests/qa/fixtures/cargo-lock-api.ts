import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { CargoResolution } from '../../../services/main/src/modules/package/cargo-resolution.ts';
import { cargoLockFixture, withCargoLock } from './cargo-lock-snapshot.ts';

export async function assertCargoLockApi(context: {
  call: (method: string, path: string, token: string, body?: unknown, key?: string) => Promise<Response>;
  pool: Pool; resolveToken: string; readToken: string; otherReadToken: string;
}): Promise<{ body: ReturnType<typeof cargoLockFixture>; key: string; readPath: string }> {
  const { call, pool, resolveToken, readToken, otherReadToken } = context;
  const path = '/v1/package-resolutions/cargo';
  const body = cargoLockFixture();
  const key = `cargo-lock-${randomUUID()}`;
  expect((await call('POST', path, readToken, body, key)).status).toBe(401);
  const concurrent = await Promise.all([0, 1].map(() => call('POST', path, resolveToken, body, key)));
  expect(concurrent.map(result => result.status).sort()).toEqual([200, 201]);
  const writes = await Promise.all(concurrent.map(result => result.json())) as
    Array<{ resolution: CargoResolution; replayed: boolean }>;
  const receipt = writes[0]!.resolution;
  expect(writes[1]!.resolution).toEqual(receipt);
  expect(receipt).toMatchObject({ profile: 'cargo-index-exact-resolution-v3', request: body,
    outcome: { status: 'solved', lockEvidence: { provenance: 'caller-supplied',
      sha256: body.existingLock!.sha256, version: 4, packageCount: 2 },
      reusedYanked: [{ name: 'leaf', version: '1.0.0', source: body.registryIndexUrl,
        lockSource: `sparse+${body.registryIndexUrl}`, lockChecksum: 'a'.repeat(64) }] } });
  const id = receipt.resolution.split('/').at(-1)!;
  const readPath = `${path}/${id}`;
  expect((await call('GET', readPath, resolveToken)).status).toBe(401);
  expect((await call('GET', readPath, otherReadToken)).status).toBe(404);
  expect(await (await call('GET', readPath, readToken)).json()).toEqual(receipt);
  expect(await (await call('POST', path, resolveToken, body, key)).json())
    .toEqual({ resolution: receipt, replayed: true });
  const rawLock = Buffer.from(body.existingLock!.bytesBase64, 'base64').toString('utf8');
  for (const changed of [withCargoLock(body, rawLock + '\n# different exact bytes\n'),
    withCargoLock(body, null), { ...body, registryIndexUrl: 'https://other.example.invalid/index/' },
    { ...body, profile: 'cargo-index-exact-resolver2-v2', existingLock: undefined }]) {
    expect((await call('POST', path, resolveToken, changed, key)).status).toBe(409);
  }
  const rows = await pool.query('SELECT request, request_digest FROM pkg.cargo_resolution WHERE id = $1', [id]);
  expect(rows.rows).toEqual([{ request: body, request_digest: receipt.requestDigest }]);
  await expect(pool.query('UPDATE pkg.cargo_resolution SET request = $2 WHERE id = $1',
    [id, JSON.stringify(withCargoLock(body, null))])).rejects.toThrow();
  const cases = [
    [cargoLockFixture('fresh-yanked'), 'unsatisfiable'],
    [cargoLockFixture('changed-source'), 'unsatisfiable'],
    [cargoLockFixture('missing-checksum'), 'solved'],
    [cargoLockFixture('changed-root'), 'solved'],
    [cargoLockFixture('changed-checksum'), 'inconsistent-source-data'],
    [cargoLockFixture('links-conflict'), 'unsatisfiable'],
    [withCargoLock(body, rawLock.replace('version = 4', 'version = 3')), 'unsupported-semantics'],
    [{ ...body, indexFiles: [] }, 'incomplete-source-data'],
    [withCargoLock(body, 'version = 4\n' + Array.from({ length: 130 }, (_, i) =>
      `\n[[package]]\nname = "old${i}"\nversion = "1.0.0"\n`).join('')), 'budget-exhausted'],
  ] as const;
  for (const [request, status] of cases) {
    const created = await call('POST', path, resolveToken, request);
    expect(created.status).toBe(201);
    const saved = await created.json() as { resolution: CargoResolution };
    expect(saved.resolution.outcome.status).toBe(status);
    expect(saved.resolution.request).toEqual(request);
    expect(await (await call('GET', `${path}/${saved.resolution.resolution.split('/').at(-1)}`, readToken)).json())
      .toEqual(saved.resolution);
  }
  for (const malformed of [withCargoLock(body, 'version = ['),
    withCargoLock(body, rawLock.replace('version = 4', 'version = 4.0')), { ...body,
    existingLock: { ...body.existingLock!, sha256: '0'.repeat(64) } }]) {
    const malformedKey = `cargo-malformed-${randomUUID()}`;
    expect((await call('POST', path, resolveToken, malformed, malformedKey)).status).toBe(422);
    expect((await pool.query('SELECT id FROM pkg.cargo_resolution WHERE idempotency_key = $1',
      [malformedKey])).rowCount).toBe(0);
  }
  return { body, key, readPath };
}
