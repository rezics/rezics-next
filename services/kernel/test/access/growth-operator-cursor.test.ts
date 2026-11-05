import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createOperatorCommands } from '../../src/access/operator.ts';
import { createAccess } from '../../src/access/permission.ts';
import { newId } from '../../src/route/route.ts';
import { encodeListCursor } from '../../src/tokens/list-cursor.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const route = 0x6520;
const operatorAccountId = newId(route);
const unrelated = newId(route);
const cursorKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const actions = new Map([['account:manage', { anonymous: false }]]);
const access = createAccess({ actions, accountEvidence: () => null });
const id = (n: number) => `00000000-0000-8000-8000-6520${n.toString(16).padStart(8, '0')}`;
let db: GrowthDatabase;
const commands = () =>
  createOperatorCommands({ pool: db.pool, actions, access, managementAction: 'account:manage', cursorKeys });
beforeAll(async () => {
  db = await openGrowthDatabase(url);
});
afterAll(async () => db?.close());

test('operator responsibility keyset seeks stay bounded with mixed-purpose history and unrelated reservations', async () => {
  // Operator rows on both sides of a deep fixed seek; mixed-purpose rows precede
  // and interleave the twenty results so a purpose filter on the PK is unbounded.
  for (const late of [false, true]) {
    const start = late ? 1_000_000 : 0;
    const report = await checkGrowth(db, {
      name: late ? 'later operator page' : 'first operator page',
      scales: [1, 4, 16],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: async (database, scale, previous) => {
        for (let n = previous * 100 + 1; n <= scale * 100; n++) {
          // Reserve result keys spaced far apart; these fixtures have the same
          // route/account/purpose/UUID shape as native pending holds.
          const rows = [
            [operatorAccountId, id(start + n * 100), 'operator'],
            [operatorAccountId, id(start + n), 'membership'],
            [operatorAccountId, id(start + 100 + (n % 19) * 100 + 1 + Math.floor(n / 19)), 'membership'],
            [unrelated, newId(route), 'operator'],
          ];
          for (const [account, reservation, purpose] of rows) {
            await database.admin.query(
              `INSERT INTO access.lifecycle_coordination VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
              [route, account, reservation, newId(route), purpose, newId(route)],
            );
          }
          if (late) {
            await database.admin.query(
              `INSERT INTO access.lifecycle_coordination VALUES ($1,$2,$3,$4,'operator',$5) ON CONFLICT DO NOTHING`,
              [route, operatorAccountId, id(200_000 + n), newId(route), newId(route)],
            );
          }
        }
        await database.admin.query('VACUUM ANALYZE access.lifecycle_coordination');
      },
      operation: async () => {
        let cursor: string | undefined;
        if (late) {
          // A fixed deep position is minted by the shared codec, just as a
          // preceding native page would do; never pass raw IDs to the page port.
          cursor = await encodeListCursor(
            cursorKeys,
            {
              route: 'access.operator.responsibility.list',
              viewer: null,
              query: { operatorAccountId, purpose: 'operator', sort: 'reservationId:asc', limit: 20 },
            },
            { epoch: 1, after: [id(start)] },
            new Date(),
          );
        }
        const page = await commands().responsibilityPage({ operatorAccountId, ...(cursor ? { cursor } : {}) });
        expect(page.operators.map((row) => row.reservationId)).toEqual(
          Array.from({ length: 20 }, (_, i) => id(start + (i + 1) * 100)),
        );
        expect(page.next).toBeString();
      },
    });
    for (const sample of report.samples) {
      expect(sample.cost.rows).toBeLessThanOrEqual(22);
      expect(sample.cost.statements).toBe(2);
      expect(sample.cost.relations?.['access.lifecycle_coordination']?.rows).toBe(21);
      expect(sample.cost.relations?.['access.lifecycle_coordination']?.sequentialScans).toBe(0);
    }
  }
}, 60000);
