import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createAccess } from '../../src/access/index.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { listSitemapRealms, listSitemapSpaces, type SitemapRealmItem } from '../../src/community/sitemap.ts';
import type { Access } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { decodeListCursor } from '../../src/tokens/list-cursor.ts';

const route = 0x4321;
const creator = newId(0x1234);
const at = '2026-10-01T00:00:00.000Z';
const now = Date.parse('2026-10-30T00:00:00.000Z');
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(93)]]) };
let admin: Pool;
let pool: Pool;
let kernel: ReturnType<typeof createKernel>;
let access: Access;
const denied = new Set<string>();
const observations = new Map<string, number>();
let afterAuthorize: ((id: string, action: string, count: number) => Promise<void>) | undefined;

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  admin = new Pool({ connectionString: url, max: 1 });
  pool = createPool(url);
  pool.options.max = 1;
  kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(92),
    tokens,
    clock: () => new Date(now),
    access(config) {
      const native = createAccess(config);
      access = deriveAccess(native, {
        async authorize(client, actor, action, resource, evidence, time) {
          expect(actor.kind).toBe('anonymous');
          const count = (observations.get(resource.id) ?? 0) + 1;
          observations.set(resource.id, count);
          const allowed = await native.authorize(client, actor, action, resource, evidence, time);
          await afterAuthorize?.(resource.id, action, count);
          return allowed && !denied.has(resource.id);
        },
      });
      return access;
    },
  });
});

beforeEach(async () => {
  denied.clear();
  observations.clear();
  afterAuthorize = undefined;
  await admin.query(
    'TRUNCATE community.realm, community.realm_revision, community.space, community.space_revision, community.space_address_claim CASCADE',
  );
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

async function space(address: string | null = null) {
  const id = newId(route);
  const revision = newId(route);
  await admin.query('BEGIN');
  try {
    await admin.query(
      `INSERT INTO community.space(route,space_id,state,head_revision_id,created_at,creator)
      VALUES ($1,$2,'active',$3,$4,$5)`,
      [route, id, revision, at, creator],
    );
    await admin.query(
      `INSERT INTO community.space_revision(route,space_id,revision_id,predecessor,address,title,summary,created_at,author)
      VALUES ($1,$2,$3,NULL,$4,'Sitemap home','',$5,$6)`,
      [route, id, revision, address, at, creator],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  if (address !== null) await claim(id, address);
  return { id, revision, address };
}

async function claim(spaceId: string, address: string, state: 'active' | 'pending' | 'reserved' = 'active') {
  const addressRoute = createHash('sha256').update(address).digest().readUInt16BE(0);
  await admin.query(
    `INSERT INTO community.space_address_claim
    (route,normalized_address,space_id,state,expires_at,reserved_until,transaction_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (route,normalized_address) DO UPDATE SET
      space_id=EXCLUDED.space_id,state=EXCLUDED.state,expires_at=EXCLUDED.expires_at,reserved_until=EXCLUDED.reserved_until`,
    [
      addressRoute,
      address,
      spaceId,
      state,
      state === 'pending' ? '2026-11-01' : null,
      state === 'reserved' ? '2026-11-01' : null,
      newId(addressRoute),
    ],
  );
}

async function realm(spaceId: string, visibility: 'public' | 'protected' = 'public') {
  const id = newId(route);
  const revision = newId(route);
  await admin.query('BEGIN');
  try {
    await admin.query(
      `INSERT INTO community.realm
      (route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
      VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8)`,
      [route, id, spaceId, visibility, GLOBAL_CONTEXT, revision, at, creator],
    );
    await admin.query(
      `INSERT INTO community.realm_revision
      (route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author)
      VALUES ($1,$2,$3,NULL,'Sitemap Realm','',$4,$5,$6,$7)`,
      [route, id, revision, visibility, GLOBAL_CONTEXT, at, creator],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  return { id, revision, spaceId };
}

async function page(feed: 'realms' | 'spaces', limit = 1000, cursor?: string, bearer?: string) {
  const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
  const response = await kernel.handle(
    new Request(`http://kernel.test/v1/sitemap/${feed}?${query}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function moveSpaceHead(host: Awaited<ReturnType<typeof space>>, address: string | null, time: string) {
  const revision = newId(route);
  await admin.query('BEGIN');
  try {
    await admin.query(
      `INSERT INTO community.space_revision
      (route,space_id,revision_id,predecessor,address,title,summary,created_at,author)
      VALUES ($1,$2,$3,$4,$5,'Changed home','',$6,$7)`,
      [route, host.id, revision, host.revision, address, time, creator],
    );
    await admin.query('UPDATE community.space SET head_revision_id=$3 WHERE route=$1 AND space_id=$2', [
      route,
      host.id,
      revision,
    ]);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

test('public carried Realm and host Space emit exactly one canonically addressed eligible family with current anonymous disclosure and bounded cursor work', async () => {
  const host = await space('carried-home');
  const carried = await realm(host.id);
  const standalone = await space('standalone-home');
  const fallbackHost = await space();
  const fallback = await realm(fallbackHost.id);
  const real = await page('realms');
  expect(real.status).toBe(200);
  expect(real.body.items).toEqual(
    [
      {
        id: carried.id,
        lastModified: at,
        canonicalDestination: { kind: 'space', spaceId: host.id, address: host.address },
      },
      { id: fallback.id, lastModified: at, canonicalDestination: { kind: 'realm', realmId: fallback.id } },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
  expect((await page('spaces')).body.items).toEqual([
    { id: standalone.id, address: standalone.address, lastModified: at },
  ]);
  expect(observations.get(carried.id)).toBe(2);
  // The Space feed may independently deny a carried host, but cannot emit it.
  expect(observations.get(host.id)).toBeGreaterThanOrEqual(2);
});

test('native HTTP contract exposes the closed tagged destination and preserves public route metadata', async () => {
  const document = openApiDocument(kernel);
  const published = await Bun.file(new URL('../../../../contracts/openapi.json', import.meta.url)).json();
  for (const feed of ['realms', 'spaces'] as const) {
    const operation = document.paths[`/v1/sitemap/${feed}`]!.get!;
    expect(operation['x-exposure']).toBe('public');
    expect(operation.operationId).toBe(`sitemap_${feed}.list`);
    expect(operation.parameters).toMatchObject([{ name: 'cursor' }, { name: 'limit' }]);
    expect(operation.responses!['200']).toEqual(published.paths[`/v1/sitemap/${feed}`].get.responses['200']);
  }
  const response = document.paths['/v1/sitemap/realms']!.get!.responses!['200']!;
  expect(JSON.stringify(response)).toContain('canonicalDestination');
  expect(JSON.stringify(response)).toContain('spaceId');
  expect(JSON.stringify(response)).toContain('realmId');
});

test('denied or removed hosts suppress both addressed and addressless Realm families without Context mutation', async () => {
  for (const address of ['hidden-home', null]) {
    const host = await space(address);
    const carried = await realm(host.id);
    denied.add(host.id);
    expect((await page('realms')).body.items).toEqual([]);
    denied.delete(host.id);
    await admin.query("UPDATE community.space SET state='removed' WHERE route=$1 AND space_id=$2", [route, host.id]);
    expect((await page('realms')).body.items).toEqual([]);
    expect((await page('spaces')).body.items).toEqual([]);
    expect(
      (await admin.query('SELECT context_id FROM community.realm WHERE route=$1 AND realm_id=$2', [route, carried.id]))
        .rows[0].context_id,
    ).toBe(GLOBAL_CONTEXT);
  }
});

test('protected, unreadable and removed carried slots never become standalone Spaces', async () => {
  const protectedHost = await space('protected-home');
  await realm(protectedHost.id, 'protected');
  const deniedHost = await space('denied-realm-home');
  const deniedRealm = await realm(deniedHost.id);
  denied.add(deniedRealm.id);
  const removedHost = await space('removed-realm-home');
  const removed = await realm(removedHost.id);
  await admin.query("UPDATE community.realm SET state='removed' WHERE route=$1 AND realm_id=$2", [route, removed.id]);
  expect((await page('realms')).body.items).toEqual([]);
  expect((await page('spaces')).body.items).toEqual([]);
});

test('pending, reserved, missing and foreign active address bindings never disclose an address or fall back', async () => {
  const other = await space();
  for (const state of ['pending', 'reserved', 'missing', 'foreign'] as const) {
    const host = await space(`${state}-home`);
    await realm(host.id);
    const standalone = await space(`${state}-standalone`);
    for (const target of [host, standalone]) {
      if (state === 'missing') {
        await admin.query('DELETE FROM community.space_address_claim WHERE normalized_address=$1', [target.address]);
      } else
        await claim(
          state === 'foreign' ? other.id : target.id,
          target.address!,
          state === 'foreign' ? 'active' : state,
        );
    }
  }
  expect((await page('realms')).body.items).toEqual([]);
  expect((await page('spaces')).body.items).toEqual([]);
});

test('final disclosure rejects host/Realm removal and lifecycle cycles, native head changes, new carried slots and lost anonymous permission after address validation', async () => {
  for (const change of [
    'host-removed',
    'realm-removed',
    'host-cycle',
    'realm-cycle',
    'host-head',
    'permission',
  ] as const) {
    const host = await space(`race-${change}`);
    const carried = await realm(host.id);
    afterAuthorize = async (id, action, count) => {
      if (id !== host.id || action !== 'space:read' || count !== 2) return;
      if (change === 'host-removed')
        await admin.query("UPDATE community.space SET state='removed' WHERE route=$1 AND space_id=$2", [
          route,
          host.id,
        ]);
      if (change === 'realm-removed')
        await admin.query("UPDATE community.realm SET state='removed' WHERE route=$1 AND realm_id=$2", [
          route,
          carried.id,
        ]);
      if (change === 'host-cycle' || change === 'realm-cycle') {
        const [table, key, target] =
          change === 'host-cycle' ? ['space', 'space_id', host.id] : ['realm', 'realm_id', carried.id];
        await admin.query(
          `UPDATE community.${table} SET lifecycle_version=lifecycle_version+2 WHERE route=$1 AND ${key}=$2`,
          [route, target],
        );
      }
      if (change === 'host-head') await moveSpaceHead(host, 'unclaimed-private-new-home', '2026-10-02T00:00:00.000Z');
      if (change === 'permission') denied.add(host.id);
    };
    expect((await page('realms')).body.items).toEqual([]);
    afterAuthorize = undefined;
    denied.add(host.id);
  }
  const standalone = await space('racing-slot');
  afterAuthorize = async (id, _action, count) => {
    if (id === standalone.id && count === 2) await realm(standalone.id);
  };
  expect((await page('spaces')).body.items).toEqual([]);
  const emptyHost = await space('racing-lifecycle');
  afterAuthorize = async (id, _action, count) => {
    if (id === emptyHost.id && count === 2)
      await admin.query(
        'UPDATE community.space SET lifecycle_version=lifecycle_version+2 WHERE route=$1 AND space_id=$2',
        [route, id],
      );
  };
  observations.clear();
  expect((await page('spaces')).body.items).toEqual([]);
});

test('family lastModified includes actual host head/address and board changes while native id stays fixed', async () => {
  const host = await space('old-home');
  const carried = await realm(host.id);
  const changedAt = '2026-10-03T00:00:00.000Z';
  await moveSpaceHead(host, 'new-home', changedAt);
  await claim(host.id, 'old-home', 'reserved');
  await claim(host.id, 'new-home');
  let item = (await page('realms')).body.items[0] as SitemapRealmItem;
  expect(item).toEqual({
    id: carried.id,
    lastModified: changedAt,
    canonicalDestination: { kind: 'space', spaceId: host.id, address: 'new-home' },
  });
  const board = newId(route);
  await admin.query(
    `INSERT INTO content.board
    (route,board_id,realm_id,subject_id,title,visibility,security_revision,recorded_transaction_id,created_at)
    VALUES ($1,$2,$3,$4,'New board','published',1,$2,$5)`,
    [route, board, carried.id, newId(0x6789), '2026-10-04T00:00:00.000Z'],
  );
  item = (await page('realms')).body.items[0];
  expect(item.lastModified).toBe('2026-10-04T00:00:00.000000Z');
  expect(item.id).toBe(carried.id);
  expect((await page('spaces')).body.items).toEqual([]);
});

test('bounded suppression advances the signed native cursor without refilling, tampering or crossing feed families', async () => {
  const hidden: string[] = [];
  for (let index = 0; index < 5; index++) {
    const host = await space(`protected-${index}`);
    hidden.push((await realm(host.id, 'protected')).id);
  }
  const host = await space('visible-after-skips');
  const visible = await realm(host.id);
  const first = await page('realms', 1);
  expect(first.status).toBe(200);
  expect(first.body.items).toEqual([]);
  expect(first.body.next).toEqual(expect.any(String));
  const cursor = await decodeListCursor(
    tokens,
    { route: 'GET /v1/sitemap/realms', viewer: null, query: {} },
    first.body.next,
    new Date(now),
  );
  expect(cursor.ok).toBe(true);
  if (!cursor.ok) throw new Error('Expected signed native cursor');
  expect(cursor.after).toEqual([route, hidden.sort()[3]!]);
  const second = await page('realms', 1, first.body.next);
  expect(second.body.items[0].id).toBe(visible.id);
  expect(second.body.items[0].canonicalDestination.spaceId).toBe(host.id);
  expect((await page('spaces', 1, first.body.next)).status).toBe(400);
  const opaque = Buffer.from(first.body.next, 'base64url');
  opaque[Math.floor(opaque.length / 2)]! ^= 1;
  expect((await page('realms', 1, opaque.toString('base64url'))).status).toBe(400);
  expect((await page('realms', 1001)).status).toBe(400);
});

test('an expired request deadline never discloses a family', async () => {
  const host = await space('deadline-home');
  await realm(host.id);
  const dependencies = { pool, access, tokens, clock: () => new Date(now) };
  for (const list of [listSitemapRealms, listSitemapSpaces]) {
    await expect(list(dependencies, Date.now() - 1)).rejects.toMatchObject({ reason: 'deadline' });
  }
});
