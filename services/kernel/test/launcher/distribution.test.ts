import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { randomUUID } from 'node:crypto';
import { PLATFORM_RESOURCE } from '../../src/access/governance-reach.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

async function distributionFixture() {
  const database = process.env.DATABASE_URL;
  if (!database) throw new Error('DATABASE_URL must name the migrated test database');
  const pool = createPool(database);
  try {
    const auth = await createRealAccess(pool, { steward: newId(0x7102), outsider: newId(0x7103) }, [
      'exposure:open',
      'launcher:publish',
      'launcher:withdraw',
    ]);
    await bootstrapRelease(pool, bundledRelease);
    for (const action of ['exposure:open', 'launcher:publish', 'launcher:withdraw'])
      await auth.grant(PLATFORM_RESOURCE, 'steward', action);
    const kernel = createKernel({
      pool,
      access: auth.access,
      routeKey: new Uint8Array(32).fill(31),
      receiptKeys: testReceiptKeys(),
      requestDeadlineMs: 30_000,
      writeRate: auth.writeRate,
      ratePeer: () => '127.0.0.1',
    });
    function send(
      persona: 'anonymous' | 'steward' | 'outsider',
      method: 'GET' | 'POST',
      path: string,
      body?: unknown,
      key = randomUUID(),
    ) {
      return kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers: {
            ...(persona === 'anonymous' ? {} : { authorization: `Bearer ${auth.bearer(persona)}` }),
            ...(method === 'POST' ? { 'idempotency-key': JSON.stringify(key) } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    }
    return { pool, send, close: () => pool.end() };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

let fixture: Awaited<ReturnType<typeof distributionFixture>>;

beforeAll(async () => {
  fixture = await distributionFixture();
}, 120_000);

afterAll(async () => fixture?.close());

const collection = '/v1/launcher/packages';
const label = `launcher-${process.pid}`;
const pkg = {
  id: `${label}.guide`,
  kind: 'overlay-panel',
  title: 'Overlay Guide',
  publisher: 'REZICS',
  summary: 'A guide panel for the Overlay.',
};
const packagePath = `${collection}/${pkg.id}`;
const releases = `${packagePath}/releases`;
const guide = {
  packageId: pkg.id,
  id: 'guide-1',
  version: '1.0.0',
  compatibility: { kind: 'overlay-panel', launcherRange: '^1.0.0' },
  artifact: { url: 'https://example.test/guide.json', size: 123, sha256: 'a'.repeat(64) },
  requires: [],
};

async function status(response: Response, expected: number, code?: string) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(expected);
  if (code) expect(body.code).toBe(code);
  return body;
}

test('curated releases use native authorization, immutable publish, exact read and withdrawal', async () => {
  const path = `${releases}/${guide.id}`;
  const body = { package: pkg, release: guide };
  await status(await fixture.send('steward', 'POST', '/v1/platform/exposure/launcher_distribution:open'), 200);
  await status(await fixture.send('anonymous', 'POST', releases, body), 401, 'authentication_required');
  await status(await fixture.send('outsider', 'POST', releases, body), 403, 'forbidden');
  await status(
    await fixture.send('steward', 'POST', releases, {
      package: pkg,
      release: { ...guide, artifact: { ...guide.artifact, size: 16_385 } },
    }),
    400,
    'invalid_request',
  );

  const key = randomUUID();
  expect(await status(await fixture.send('steward', 'POST', releases, body, key), 201)).toEqual(guide);
  expect(await status(await fixture.send('steward', 'POST', releases, body, key), 201)).toEqual(guide);
  await status(
    await fixture.send(
      'steward',
      'POST',
      releases,
      {
        package: pkg,
        release: { ...guide, artifact: { ...guide.artifact, sha256: 'b'.repeat(64) } },
      },
      key,
    ),
    422,
    'idempotency_conflict',
  );
  await status(await fixture.send('steward', 'POST', releases, body), 409, 'conflict');
  expect(await status(await fixture.send('anonymous', 'GET', packagePath), 200)).toEqual(pkg);
  expect(
    await status(await fixture.send('anonymous', 'GET', `${collection}?kind=overlay-panel&q=OVERLAY`), 200),
  ).toEqual({
    items: [pkg],
    nextCursor: null,
  });
  const fetched = await fixture.send('anonymous', 'GET', path);
  expect(fetched.headers.get('cache-control')).toBe('no-store');
  expect(await status(fetched, 200)).toEqual(guide);

  const utilityPackage = { ...pkg, id: `${label}.utility`, title: 'Utility Panel' };
  const utilityRelease = { ...guide, packageId: utilityPackage.id };
  expect(
    await status(
      await fixture.send('steward', 'POST', `${collection}/${utilityPackage.id}/releases`, {
        package: utilityPackage,
        release: utilityRelease,
      }),
      201,
    ),
  ).toEqual(utilityRelease);
  const update = {
    ...guide,
    id: 'guide-2',
    version: '1.1.0',
    requires: [{ packageId: utilityPackage.id, releaseId: utilityRelease.id }],
  };
  expect(await status(await fixture.send('steward', 'POST', releases, { package: pkg, release: update }), 201)).toEqual(
    update,
  );
  await status(await fixture.send('outsider', 'POST', `${path}:withdraw`), 403, 'forbidden');
  await status(
    await fixture.send('steward', 'POST', `${collection}/${utilityPackage.id}/releases/${utilityRelease.id}:withdraw`),
    200,
  );
  await status(
    await fixture.send('steward', 'POST', releases, {
      package: pkg,
      release: { ...update, id: 'guide-3', version: '1.2.0' },
    }),
    409,
    'conflict',
  );
  await status(await fixture.send('steward', 'POST', `${path}:withdraw`), 200);
  await status(await fixture.send('steward', 'POST', `${path}:withdraw`), 200);
  await status(await fixture.send('anonymous', 'GET', path), 404, 'not_found');
  expect(await status(await fixture.send('anonymous', 'GET', releases), 200)).toEqual({
    items: [update],
    nextCursor: null,
  });

  await status(await fixture.send('steward', 'POST', `${releases}/${update.id}:withdraw`), 200);
  await status(await fixture.send('anonymous', 'GET', packagePath), 404, 'not_found');
  expect(
    await status(await fixture.send('anonymous', 'GET', `${collection}?kind=overlay-panel&q=OVERLAY`), 200),
  ).toEqual({
    items: [],
    nextCursor: null,
  });
  await status(await fixture.send('steward', 'POST', releases, body), 409, 'conflict');
}, 120_000);

test('cursor pages use title order and exact release order and reject reuse under a different query', async () => {
  // Seed released fixture facts directly to exercise growth without introducing an HTTP batch publisher.
  const entries = 33;
  const modId = `${label}.mods`;
  const prefix = 'MVP Fixture';
  // A test-local transaction keeps the release rows and the catalogue projection consistent.
  await fixture.pool.query(
    `WITH mods AS (
       INSERT INTO launcher.package (id, kind, publisher, title, title_key, summary, live_count)
       SELECT $1 || concat('.', n), 'minecraft-mod', 'Fixture', $2 || ' ' || n,
              lower($2 || ' ' || n) COLLATE "C", '', 1
       FROM generate_series(1, $3) n
       RETURNING id
     )
     INSERT INTO launcher.release (
       package_id, id, version, compatibility, artifact_url, artifact_size, artifact_sha256, requirements, published_at
     )
     SELECT id, '1', '1.0.0', '{"kind":"minecraft-mod","gameVersion":"1.21.1","loader":"fabric"}',
            'https://example.test/mod.jar', 123, repeat('b',64), '[]', now()
     FROM mods`,
    [modId, prefix, entries],
  );
  const query = `${collection}?kind=minecraft-mod`;
  const first = await status(await fixture.send('anonymous', 'GET', `${query}&q=MVP%20Fixture`), 200);
  expect(first.items).toHaveLength(25);
  expect(typeof first.nextCursor).toBe('string');
  const cursor = encodeURIComponent(first.nextCursor);
  const second = await status(await fixture.send('anonymous', 'GET', `${query}&q=mvp%20fixture&cursor=${cursor}`), 200);
  expect(second.items).toHaveLength(entries - 25);
  expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(entries);
  expect(second.nextCursor).toBeNull();
  await status(await fixture.send('anonymous', 'GET', `${query}&q=other&cursor=${cursor}`), 400, 'invalid_cursor');

  const modReleases = (id: string) => `${collection}/${modId}.${id}/releases`;
  await fixture.pool.query(
    `INSERT INTO launcher.release (
       package_id, id, version, compatibility, artifact_url, artifact_size, artifact_sha256, requirements, published_at
     )
     SELECT package_id, n::text, concat('1.0.', n), compatibility, artifact_url, artifact_size,
            artifact_sha256, requirements, published_at
     FROM launcher.release, generate_series(2, $2) n
     WHERE package_id = $1 AND id = '1'`,
    [`${modId}.1`, entries],
  );
  await fixture.pool.query('UPDATE launcher.package SET live_count = $2 WHERE id = $1', [`${modId}.1`, entries]);
  const versions = await status(await fixture.send('anonymous', 'GET', modReleases('1')), 200);
  expect(versions.items).toHaveLength(25);
  expect(versions.items[0]?.id).toBe('9');
  const versionCursor = encodeURIComponent(versions.nextCursor);
  const remaining = await status(
    await fixture.send('anonymous', 'GET', `${modReleases('1')}?cursor=${versionCursor}`),
    200,
  );
  expect(remaining.items).toHaveLength(entries - 25);
  expect(remaining.items.at(-1)?.id).toBe('1');
  expect(new Set([...versions.items, ...remaining.items].map((item) => item.id)).size).toBe(entries);
  expect(remaining.nextCursor).toBeNull();
  await status(
    await fixture.send('anonymous', 'GET', `${modReleases('2')}?cursor=${versionCursor}`),
    400,
    'invalid_cursor',
  );
});
