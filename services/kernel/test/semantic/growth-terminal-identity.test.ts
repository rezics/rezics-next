import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { accessCheck } from '../../src/request/access.ts';
import { updateSubjectIdentity } from '../../src/semantic/subject.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  identityFixture,
  terminalReader,
  sealedIdentityReader,
  homeOf,
  basisReader,
  readyBasis,
  readOptions,
  resource,
  deadline,
  release,
  type IdentityFixture,
} from './identity-fixture.ts';

let db: GrowthDatabase;
let f: IdentityFixture;
beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  db = await openGrowthDatabase(url);
}, 30_000);
beforeEach(async () => {
  f = await identityFixture(db.pool, db.admin);
}, 30_000);
afterAll(async () => {
  if (db) await db.close();
});
const scales = [64, 512, 4096] as const;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;

test('terminal identity and fixed-home digest stay bounded as irrelevant editorial history grows', async () => {
  const original = await f.create(0x6b10);
  const root = await f.create(0x6b00);
  await f.merge(original, root);
  await f.finishMove(original, root);
  await f.baseline(original);
  const terminal = await terminalReader();
  const basis = await basisReader();
  const metadata = await sealedIdentityReader();
  const stable = await readyBasis(basis, db.pool);
  let historySubject = '';
  const report = await checkGrowth(db, {
    name: 'terminal identity and fixed-home digest stay bounded as irrelevant editorial history grows',
    scales,
    bounds,
    warmups: 1,
    repetitions: 3,
    async grow(_database, scale, previous) {
      for (let ordinal = previous; ordinal < scale; ordinal++) {
        // Respect native per-slot history limits: a new unrelated subject every sixteen edits.
        if (ordinal % 16 === 0) {
          historySubject = await f.create(0x6b10);
          await f.real.grant(resource(historySubject), 'editor', 'subject:create');
        }
        const authorize = await accessCheck(f.access, f.editor, 'subject:create', resource(historySubject), {
          pool: db.pool,
          deadline: deadline(),
        });
        await updateSubjectIdentity(db.pool, {
          subject: historySubject,
          labels: { en: `Editorial history ${ordinal}` },
          release,
          authorize,
        });
      }
    },
    async operation() {
      expect(await readyBasis(basis, db.pool)).toEqual(stable);
      const result = await terminal(db.pool, original, readOptions(f));
      expect(result).toMatchObject({ state: 'ready', id: root });
      // Charge the producer point alongside the original native sample, never prove cost with null/not_ready.
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        expect(await metadata(client, original)).toMatchObject({
          state: 'ready',
          terminal: root,
          home: { partition: homeOf(original), pending: 0n },
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    },
  });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    expect(sample.cost.relations['semantic.fact']).toBeUndefined();
    expect(sample.cost.relations['semantic.revision']).toBeUndefined();
    expect(sample.cost.relations['semantic.identity_home']?.rows).toBeGreaterThanOrEqual(4096);
  }
}, 600_000);
