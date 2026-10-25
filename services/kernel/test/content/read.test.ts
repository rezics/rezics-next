import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createResourcePublicEligibility, createAccess } from '../../src/access/index.ts';
import { withConnection } from '../../src/database/pool.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { accessCheck, type Resource } from '../../src/request/access.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { readBoard } from '../../src/content/reads.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const route = 0x9abc;
const board: Resource = { route, id: newId(route) };
const subject = newId(0xdef0);
const action = 'board:read';
const actor = { kind: 'anonymous' } as const;
const access = createAccess({ actions: new Map([[action, { anonymous: true }]]) });
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
let database: GrowthDatabase;

beforeAll(async () => {
  database = await openGrowthDatabase(databaseUrl);
  await database.admin.query(
    `INSERT INTO content.board
     (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
     VALUES ($1, $2, $3, 'Public board', 'public', 1, $2)`,
    [route, board.id, subject],
  );
});
afterAll(async () => {
  if (!database) return;
  await database.admin.query('DELETE FROM content.board WHERE route = $1', [route]);
  await database.close();
});

function context() {
  return { pool: database.pool, deadline: Date.now() + 5_000 };
}

// This consumes the Accounts capability directly before any content adapter is
// implemented. Catalogue metadata alone is deliberately insufficient evidence.
test('shared Access consumes anchored current public eligibility without a grant or scope', async () => {
  const calls: string[] = [];
  const resource = {
    ...board,
    eligibility: createResourcePublicEligibility({
      resource: board,
      action,
      async prepare({ pool, resource }) {
        calls.push('prepare');
        return withConnection(pool, async (client) => {
          const anchor = await readPartition(client, partitionOf(resource.route));
          const result = await client.query<{ security_revision: string; visibility: string }>(
            'SELECT security_revision, visibility FROM content.board WHERE route = $1 AND board_id = $2',
            [resource.route, resource.id],
          );
          return { anchor, row: result.rows[0] };
        });
      },
      async verify({ client, resource, evidence, at }) {
        calls.push('verify');
        expect(Number.isFinite(Date.parse(at))).toBe(true);
        if (!evidence.anchor || evidence.row?.visibility !== 'public') return false;
        const result = await client.query<{ security_revision: string; visibility: string }>(
          'SELECT security_revision, visibility FROM content.board WHERE route = $1 AND board_id = $2',
          [resource.route, resource.id],
        );
        return (
          result.rows[0]?.visibility === 'public' &&
          result.rows[0]?.security_revision === evidence.row.security_revision
        );
      },
    }),
  };
  const check = await accessCheck(access, actor, action, resource, context());
  const allowed = await withConnection(database.pool, (client) => check(client));
  expect(allowed).toBe(true);
  expect(calls).toEqual(['prepare', 'verify']);
});

test('missing trusted eligibility fails closed despite an anonymous action catalogue', async () => {
  const resource = {
    ...board,
    eligibility: createResourcePublicEligibility({
      resource: board,
      action,
      async prepare() {
        return null;
      },
      async verify() {
        return false;
      },
    }),
  };
  const check = await accessCheck(access, actor, action, resource, context());
  expect(await withConnection(database.pool, (client) => check(client))).toBe(false);
});

test('readBoard returns current public metadata with an authoritative partition head', async () => {
  const result = await readBoard({ pool: database.pool, access, tokens }, board.id, { actor, ...context() });
  expect(result.value).toMatchObject({ id: board.id, route, title: 'Public board', securityRevision: '1' });
  const partition = await readPartition(database.admin, partitionOf(route));
  expect(partition).not.toBeNull();
  expect(result.anchor).toEqual({ partition: partition!, epoch: partition!.epoch, position: partition!.position });
});

test('checkGrowth bounds real board disclosure as unrelated data in the same partition grows', async () => {
  const report = await checkGrowth(database, {
    name: 'current board disclosure',
    scales: [32, 256, 2048],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(db, scale, previous) {
      // Setup is outside measurement. The operation, response and resource stay
      // fixed; only unrelated rows sharing the exact route grow.
      for (let ordinal = previous; ordinal < scale; ordinal++) {
        const id = newId(route);
        await db.admin.query(
          `INSERT INTO content.board
           (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
           VALUES ($1, $2, $3, 'Distractor', 'public', 1, $2)`,
          [route, id, subject],
        );
      }
      await db.admin.query('ANALYZE content.board');
    },
    async operation(db) {
      const result = await readBoard({ pool: db.pool, access, tokens }, board.id, { actor, ...context() });
      expect(result.value?.id).toBe(board.id);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([32, 256, 2048]);
  console.info(JSON.stringify(report));
}, 60_000);
