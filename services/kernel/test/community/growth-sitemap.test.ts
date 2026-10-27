import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernel } from '../../src/http/kernel.ts';
import { newId } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(81);
const scales = [1, 4, 16] as const;
const rowsPerScale = 256;
const pageLimit = 4;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const creator = '019a1b2c-3d4e-7f00-8a00-ed170e000001';
const at = '2026-10-01T00:00:00.000Z';

let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;

beforeAll(async () => {
  db = await openGrowthDatabase();
  kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) },
  });
});

afterAll(async () => {
  await db?.close();
});

function population(name: string, kind: 'realm' | 'space', visibility: 'public' | 'protected'): Population {
  return {
    name,
    hotPartition: 0x4321 >>> 4,
    hotShare: 1,
    rows: ({ route }) => {
      const spaceId = newId(route);
      const spaceRevisionId = newId(route);
      const realmId = newId(route);
      const realmRevisionId = newId(route);
      return {
        'community.space': [
          { route, space_id: spaceId, state: 'active', head_revision_id: spaceRevisionId, created_at: at, creator },
        ],
        'community.space_revision': [
          {
            route,
            space_id: spaceId,
            revision_id: spaceRevisionId,
            predecessor: null,
            address: `sitemap-${spaceId}`,
            title: 'Sitemap growth Space',
            summary: '',
            created_at: at,
            author: creator,
          },
        ],
        ...(kind === 'realm'
          ? {
              'community.realm': [
                {
                  route,
                  realm_id: realmId,
                  space_id: spaceId,
                  state: 'active',
                  visibility,
                  context_id: GLOBAL_CONTEXT,
                  head_revision_id: realmRevisionId,
                  created_at: at,
                  creator,
                },
              ],
              'community.realm_revision': [
                {
                  route,
                  realm_id: realmId,
                  revision_id: realmRevisionId,
                  predecessor: null,
                  title: 'Sitemap growth Realm',
                  summary: '',
                  visibility,
                  context_id: GLOBAL_CONTEXT,
                  created_at: at,
                  author: creator,
                },
              ],
            }
          : {}),
      };
    },
  };
}

async function reset(): Promise<void> {
  await db.admin.query(
    'TRUNCATE community.realm, community.realm_revision, community.space, community.space_revision CASCADE',
  );
}

async function page(feed: 'realms' | 'spaces', requireItems: boolean) {
  const response = await kernel.handle(new Request(`http://kernel.test/v1/sitemap/${feed}?limit=${pageLimit}`));
  const body = (await response.json()) as { items: unknown[]; next: string | null };
  if (response.status !== 200) throw new Error(`${feed} sitemap status ${response.status}`);
  if (body.items.length > pageLimit) throw new Error(`${feed} sitemap exceeded its fixed page size`);
  if (requireItems && body.items.length !== pageLimit)
    throw new Error(`${feed} sitemap did not return a full listed page`);
  if (!requireItems && (body.items.length !== 0 || body.next === null))
    throw new Error(`${feed} sitemap did not stop within its protected candidate bound`);
  return body;
}

async function check(
  feed: 'realms' | 'spaces',
  kind: 'realm' | 'space',
  visibility: 'public' | 'protected',
  title: string,
) {
  await reset();
  const rows = population(title, kind, visibility);
  const report = await checkGrowth(db, {
    name: title,
    scales,
    bounds,
    repetitions: 1,
    warmups: 1,
    async grow(database, scale, previous) {
      await seed({ pool: database.pool, admin: database.admin }, rows, {
        from: previous * rowsPerScale,
        to: scale * rowsPerScale,
      });
    },
    operation: async () => page(feed, visibility === 'public'),
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([...scales]);
  expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
}

test('Realm sitemap page stays within its bound as listed items grow', async () => {
  await check('realms', 'realm', 'public', 'Realm sitemap page stays within its bound as listed items grow');
});

test('Space sitemap page stays within its bound as listed items grow', async () => {
  await check('spaces', 'space', 'public', 'Space sitemap page stays within its bound as listed items grow');
});

test('Realm sitemap page stays within its bound as protected Realms grow', async () => {
  await check('realms', 'realm', 'protected', 'Realm sitemap page stays within its bound as protected Realms grow');
});

test('Space sitemap page stays within its bound as protected Realms grow', async () => {
  await check('spaces', 'realm', 'protected', 'Space sitemap page stays within its bound as protected Realms grow');
});
