import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { createAccess } from '../../src/access/index.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { newId } from '../../src/route/route.ts';
import { decodeCursor } from '../../src/tokens/cursor.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { standingFixture } from '../access/standing-fixture.ts';

const routeKey = new Uint8Array(32).fill(71);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) };
const route = 0x4321;
const creator = newId(0x1234);
const initialAt = '2026-10-01T00:00:00.000Z';
const fixedNow = Date.parse('2026-10-27T00:00:00.000Z');

type SitemapItem = { id: string; address?: string; lastModified: string };
type SpaceFixture = { id: string; revision: string; address: string | null };
type RealmFixture = { id: string; revision: string; spaceId: string; visibility: 'public' | 'protected' };

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let fixture: Awaited<ReturnType<typeof standingFixture>>;
let kernel: ReturnType<typeof createKernel>;
let bearer: string;
let spaces: SpaceFixture[];
let realms: RealmFixture[];
const anonymouslyUnreadable = new Set<string>();

beforeAll(async () => {
  db = await openGrowthDatabase();
  fixture = await standingFixture(['space:read', 'realm:read']);
  await fixture.reset();

  const authenticate = fixture.access.authenticate;
  const issued: string[] = [];
  fixture.access.authenticate = (token, context) => {
    issued.push(token);
    return authenticate(token, { ...context, pool: db.pool });
  };
  try {
    await fixture.context();
    bearer = issued[0]!;
  } finally {
    fixture.access.authenticate = authenticate;
  }

  kernel = createKernel({
    pool: db.pool,
    routeKey: routeKey,
    tokens,
    clock: () => new Date(fixedNow),
    access: (config) => {
      const access = createAccess(config);
      return deriveAccess(access, {
        authenticate: (token, context) => fixture.access.authenticate(token, { ...context, pool: db.pool }),
        async authorize(client, actor, action, resource, evidence, time) {
          if (actor.kind === 'anonymous' && action === 'space:read' && anonymouslyUnreadable.has(resource.id))
            return false;
          return access.authorize(client, actor, action, resource, evidence, time);
        },
      });
    },
  });
  spaces = [];
  realms = [];
  const inaccessible = await addSpace('hidden-space-address', initialAt);
  anonymouslyUnreadable.add(inaccessible.id);
  const noAddress = await addSpace(null, initialAt);
  const publicHost = await addSpace('public-host', initialAt);
  const protectedHost = await addSpace('protected-host', initialAt);
  const publicRealm = await addRealm(publicHost.id, 'public');
  const protectedRealm = await addRealm(protectedHost.id, 'protected');
  const noBoardHost = await addSpace('public-no-board-host', '2026-10-01T00:00:02.000Z');
  const publicRealmWithoutBoard = await addRealm(noBoardHost.id, 'public');
  realms.push(publicRealm, protectedRealm, publicRealmWithoutBoard);
  expect(noAddress.address).toBeNull();
});

afterAll(async () => {
  await fixture?.close();
  await db?.close();
});

async function addSpace(address: string | null, at: string): Promise<SpaceFixture> {
  const id = newId(route);
  const revision = newId(route);
  await inTransaction(async (client) => {
    await client.query(
      `INSERT INTO community.space(route,space_id,state,head_revision_id,created_at,creator)
     VALUES ($1,$2,'active',$3,$4,$5)`,
      [route, id, revision, at, creator],
    );
    await client.query(
      `INSERT INTO community.space_revision(route,space_id,revision_id,predecessor,address,title,summary,created_at,author)
     VALUES ($1,$2,$3,NULL,$4,'Sitemap Space','',$5,$6)`,
      [route, id, revision, address, at, creator],
    );
  });
  const value = { id, revision, address };
  spaces.push(value);
  return value;
}

async function addRealm(spaceId: string, visibility: 'public' | 'protected'): Promise<RealmFixture> {
  const id = newId(route);
  const revision = newId(route);
  await inTransaction(async (client) => {
    await client.query(
      `INSERT INTO community.realm(route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
     VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8)`,
      [route, id, spaceId, visibility, GLOBAL_CONTEXT, revision, initialAt, creator],
    );
    await client.query(
      `INSERT INTO community.realm_revision(route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author)
     VALUES ($1,$2,$3,NULL,'Sitemap Realm','',$4,$5,$6,$7)`,
      [route, id, revision, visibility, GLOBAL_CONTEXT, initialAt, creator],
    );
  });
  return { id, revision, spaceId, visibility };
}

async function inTransaction(operation: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await operation(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function addBoard(realmId: string, at: string): Promise<string> {
  const id = newId(route);
  await db.admin.query(
    `INSERT INTO content.board(route,board_id,realm_id,subject_id,title,visibility,security_revision,recorded_transaction_id,created_at)
     VALUES ($1,$2,$3,$4,'Sitemap board','published',1,$2,$5)`,
    [route, id, realmId, newId(0x6789), at],
  );
  return id;
}

async function get(feed: 'realms' | 'spaces', values: Record<string, string> = {}, token?: string) {
  const response = await kernel.handle(
    new Request(`http://kernel.test/v1/sitemap/${feed}?${new URLSearchParams(values)}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );
  return { response, text: await response.clone().text(), body: await response.json() };
}

async function walk(feed: 'realms' | 'spaces', limit: number, token?: string): Promise<SitemapItem[]> {
  const items: SitemapItem[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await get(feed, { limit: String(limit), ...(cursor ? { cursor } : {}) }, token);
    expect(page.response.status).toBe(200);
    expect(page.body.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.body.items);
    cursor = page.body.next;
    expect(++pages).toBeLessThan(500);
  } while (cursor);
  return items;
}

test('the Realm and Space sitemap feeds are public and use the shared page shapes', async () => {
  const document = openApiDocument(kernel);
  for (const feed of ['realms', 'spaces'] as const) {
    const operation = document.paths[`/v1/sitemap/${feed}`]?.get;
    expect(operation?.operationId).toBe(`sitemap_${feed}.list`);
    expect(operation?.['x-exposure']).toBe('public');
    expect(actionCatalogue(kernel).has(operation?.['x-action'] as string)).toBe(true);
    expect(kernel.routes.filter((entry) => entry.path === `/v1/sitemap/${feed}`)).toHaveLength(1);
    const firstPage = await get(feed, { limit: '1' });
    expect(firstPage.response.status).toBe(200);
    expect(firstPage.body.items).toHaveLength(1);
  }
});

test('the Realm and Space sitemap feeds walk every listed item exactly once through their cursors', async () => {
  const expectedRealms = realms
    .filter((realm) => realm.visibility === 'public')
    .map((realm) => realm.id)
    .sort();
  const expectedSpaces = spaces
    .filter((space) => space.address !== null && space.id !== spaces[0]!.id && space.id !== spaces[3]!.id)
    .map((space) => space.id)
    .sort();
  for (const limit of [1, 2, 1000]) {
    const listedRealms = await walk('realms', limit);
    const realmIds = listedRealms.map((item) => item.id);
    expect(new Set(realmIds).size).toBe(realmIds.length);
    expect([...realmIds].sort()).toEqual(expectedRealms);
    for (const item of listedRealms) expect(Object.keys(item).sort()).toEqual(['id', 'lastModified']);

    const listedSpaces = await walk('spaces', limit);
    const spaceIds = listedSpaces.map((item) => item.id);
    expect(new Set(spaceIds).size).toBe(spaceIds.length);
    expect([...spaceIds].sort()).toEqual(expectedSpaces);
    for (const item of listedSpaces) expect(Object.keys(item).sort()).toEqual(['address', 'id', 'lastModified']);
    expect(listedSpaces.find((item) => item.id === spaces[2]!.id)?.address).toBe('public-host');
  }
});

test('a protected Realm and a Space without an address or anonymous read are never listed', async () => {
  const protectedRealm = realms.find((realm) => realm.visibility === 'protected')!;
  expect((await walk('realms', 1000)).some((item) => item.id === protectedRealm.id)).toBe(false);
  expect((await walk('spaces', 1000)).some((item) => item.id === protectedRealm.spaceId)).toBe(false);
  expect((await walk('spaces', 1000)).some((item) => item.id === spaces[1]!.id)).toBe(false);
  const inaccessible = await getSpace(spaces[0]!.id);
  expect(inaccessible.status).toBe(404);
});

async function getSpace(id: string): Promise<Response> {
  return kernel.handle(new Request(`http://kernel.test/v1/spaces/${id}`));
}

test('a bearer caller receives the same Realm and Space feeds as an anonymous caller', async () => {
  for (const feed of ['realms', 'spaces'] as const) {
    const anonymous = await get(feed, { limit: '1' });
    const authenticated = await get(feed, { limit: '1' }, bearer);
    expect(authenticated.response.status).toBe(200);
    expect(authenticated.text).toBe(anonymous.text);
    if (anonymous.body.next) {
      const continued = await get(feed, { limit: '1', cursor: anonymous.body.next });
      const bearerContinued = await get(feed, { limit: '1', cursor: anonymous.body.next }, bearer);
      expect(bearerContinued.text).toBe(continued.text);
    }
  }
});

test('lastModified follows a new Realm or Space revision and a new board in the Realm', async () => {
  const publicRealm = realms.find((realm) => realm.visibility === 'public')!;
  const publicSpace = spaces.find((space) => space.id === publicRealm.spaceId)!;
  const beforeRealm = (await walk('realms', 1000)).find((item) => item.id === publicRealm.id)!.lastModified;
  const beforeSpace = (await walk('spaces', 1000)).find((item) => item.id === publicSpace.id)!;

  const newSpaceRevision = newId(route);
  const spaceAt = '2026-10-02T00:00:00.000Z';
  await inTransaction(async (client) => {
    await client.query(
      `INSERT INTO community.space_revision(route,space_id,revision_id,predecessor,address,title,summary,created_at,author)
     VALUES ($1,$2,$3,$4,'public-host-v2','Sitemap Space revision','',$5,$6)`,
      [route, publicSpace.id, newSpaceRevision, publicSpace.revision, spaceAt, creator],
    );
    await client.query('UPDATE community.space SET head_revision_id=$3 WHERE route=$1 AND space_id=$2', [
      route,
      publicSpace.id,
      newSpaceRevision,
    ]);
  });
  const newRealmRevision = newId(route);
  const realmAt = '2026-10-03T00:00:00.000Z';
  await inTransaction(async (client) => {
    await client.query(
      `INSERT INTO community.realm_revision(route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author)
     VALUES ($1,$2,$3,$4,'Sitemap Realm revision','',$5,$6,$7,$8)`,
      [
        route,
        publicRealm.id,
        newRealmRevision,
        publicRealm.revision,
        publicRealm.visibility,
        GLOBAL_CONTEXT,
        realmAt,
        creator,
      ],
    );
    await client.query('UPDATE community.realm SET head_revision_id=$3 WHERE route=$1 AND realm_id=$2', [
      route,
      publicRealm.id,
      newRealmRevision,
    ]);
  });
  await addBoard(publicRealm.id, '2026-10-04T00:00:00.000Z');

  const realmItem = (await walk('realms', 1000)).find((item) => item.id === publicRealm.id)!;
  const spaceItem = (await walk('spaces', 1000)).find((item) => item.id === publicSpace.id)!;
  expect(beforeRealm).toBe(initialAt);
  expect(realmItem.lastModified).toBe('2026-10-04T00:00:00.000000Z');
  expect(realmItem.lastModified > beforeRealm).toBe(true);
  expect(spaceItem.lastModified).toBe(spaceAt);
  expect(spaceItem.lastModified > beforeSpace.lastModified).toBe(true);
  expect(spaceItem.address).toBe('public-host-v2');
});

test('a cursor that stops on a skipped candidate contains no id, route or timestamp of that candidate in its decoded bytes', async () => {
  const hiddenIds: string[] = [];
  for (let index = 0; index < 8; index++) {
    const host = await addSpace(`protected-host-${index}`, initialAt);
    hiddenIds.push(host.id);
    const realm = await addRealm(host.id, 'protected');
    hiddenIds.push(realm.id);
  }
  for (const feed of ['realms', 'spaces'] as const) {
    let cursor: string | null = null;
    let cursorAfterSkipped: string | null = null;
    let pages = 0;
    do {
      const page = await get(feed, { limit: '1', ...(cursor ? { cursor } : {}) });
      expect(page.response.status).toBe(200);
      cursor = page.body.next;
      if (!page.body.items.length && cursor) {
        cursorAfterSkipped = cursor;
        break;
      }
      expect(++pages).toBeLessThan(500);
    } while (cursor);
    expect(cursorAfterSkipped).toEqual(expect.any(String));
    const opaque = cursorAfterSkipped!;
    const scope = { operation: `sitemap.${feed}.list`, parameters: {} };
    const decoded = decodeCursor(tokens, scope, opaque, fixedNow);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error('Cursor did not decode');
    const readable = Buffer.from(opaque.split('.')[0]!, 'base64url').toString('utf8');
    for (const id of hiddenIds) expect(readable).not.toContain(id);
    expect(decoded.after).toHaveLength(2);
    expect(typeof decoded.after[0]).toBe('number');
    expect(typeof decoded.after[1]).toBe('string');
  }
});
