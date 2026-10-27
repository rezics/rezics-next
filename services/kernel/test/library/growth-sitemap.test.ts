import { afterAll, beforeAll, expect, test } from 'bun:test';
import { actionCatalogue } from '../../src/http/request.ts';
import { encodeListCursor } from '../../src/tokens/list-cursor.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { testKernel, testTokens } from '../support/test-kernel.ts';

const scales = [256, 1024, 4096] as const;
const limit = 4;
const route = 63; // Three empty partitions, then fifteen empty routes, before the fixed public population.
const tokens = testTokens();
const now = new Date('2026-10-27T01:00:00Z');
let db: GrowthDatabase;
let app: ReturnType<typeof testKernel>;
let denied: ReturnType<typeof testKernel>;
const columns =
  '(route,collection_id,curator_account_id,title,visibility,state,revision,created_at,updated_at,transaction_id)';
function id(n: number) {
  return `10000000-0000-7000-8000-003f${n.toString(16).padStart(8, '0')}`;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  app = testKernel({ pool: db.pool, tokens, clock: () => now });
  const actions = new Map(actionCatalogue(app));
  actions.set('collection:read', { anonymous: false });
  denied = testKernel({ pool: db.pool, tokens, clock: () => now, actions });
  await db.admin.query(
    `INSERT INTO access.exposure_opening("group",valid,transaction_id)
    VALUES ('collections','[2020-01-01,)', $1)`,
    [id(99999)],
  );
});
afterAll(async () => {
  await db?.close();
});

async function fixed() {
  await db.admin.query('DELETE FROM library.collection');
  // Enough same-route rows for the production planner to prefer the bounded partial-index seek.
  await db.admin.query(
    `INSERT INTO library.collection ${columns}
    SELECT $1,id,$2,'Fixed','public','active',1,'2026-01-01','2026-05-01',id
    FROM (SELECT ('10000000-0000-7000-8000-003f'||lpad(to_hex(n),8,'0'))::uuid id
      FROM generate_series(1,32000) n) s`,
    [route, id(99999)],
  );
  // Empty interval seeks also need a fixed same-route population: otherwise the planner reasonably uses the
  // primary key for a tiny route and filters its handful of private rows. Keep that choice out of the growth axis.
  await db.admin.query(`INSERT INTO library.collection ${columns}
    SELECT r,id,('10000000-0000-7000-8000-'||lpad(to_hex(r),4,'0')||'0001869f')::uuid,
      'Fixed private','private','active',1,'2026-01-01','2026-05-01',id
    FROM (SELECT r,('30000000-0000-7000-8000-'||lpad(to_hex(r),4,'0')||lpad(to_hex(n),8,'0'))::uuid id
      FROM generate_series(0,62) r,generate_series(1,2000) n) s`);
}
async function grow(dimension: 'listed' | 'hidden' | 'denied', previous: number, scale: number) {
  if (previous === 0) await fixed();
  await db.admin.query(
    `INSERT INTO library.collection ${columns}
    SELECT r,id,('10000000-0000-7000-8000-'||lpad(to_hex(r),4,'0')||'0001869f')::uuid,'Growing',
      CASE WHEN $4 AND n%3=0 THEN 'private' WHEN $4 AND n%3=1 THEN 'unlisted' ELSE 'public' END,
      CASE WHEN $4 AND n%3=2 THEN 'deleted' ELSE 'active' END,
      1,'2026-01-01','2026-05-01',$1::uuid
    FROM (SELECT n,CASE WHEN $4 THEN n%64 ELSE 63 END r,
      ('20000000-0000-7000-8000-'||lpad(to_hex(CASE WHEN $4 THEN n%64 ELSE 63 END),4,'0')
        ||lpad(to_hex(n),8,'0'))::uuid id FROM generate_series($2::int+1,$3::int) n) s`,
    [id(99999), previous, scale, dimension === 'hidden'],
  );
}
async function page(kernel: typeof app, cursor?: string) {
  const response = await kernel.handle(
    new Request(
      `https://kernel.test/v1/sitemap/collections?${new URLSearchParams({
        limit: String(limit),
        ...(cursor ? { cursor } : {}),
      })}`,
    ),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { items: { id: string }[]; next: string | null };
}

test('Collection sitemap page cost stays bounded as Collections and hidden candidates grow', async () => {
  for (const dimension of ['listed', 'hidden', 'denied'] as const) {
    for (const position of ['first', 'continuation'] as const) {
      const cursor =
        position === 'first'
          ? undefined
          : await encodeListCursor(
              tokens,
              { route: 'GET /v1/sitemap/collections', viewer: null, query: { limit } },
              { epoch: 1, after: ['collections', 3, 'scan', route, id(100)] },
              now,
            );
      const report = await checkGrowth(db, {
        name: `Collection sitemap (${dimension}, ${position})`,
        scales,
        warmups: 1,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        grow: (_database, scale, previous) => grow(dimension, previous, scale),
        async operation() {
          const result = await page(dimension === 'denied' ? denied : app, cursor);
          expect(result.items).toHaveLength(dimension === 'denied' ? 0 : limit);
          expect(result.next).toBeString();
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([...scales]);
      // checkGrowth uses the shared catalog classifier and enforces its probe bound for every sample.
      expect(report.samples.every((sample) => sample.cost.catalogStatements >= 0)).toBe(true);
    }
  }
}, 300_000);
