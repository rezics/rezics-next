import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { pageSubjects } from '../src/semantic/page.ts';
import { decodeCursor } from '../src/tokens/cursor.ts';
import type { KeyRing } from '../src/tokens/seal.ts';
import { dropTestDatabase } from './support/drop-test-database.ts';
import {
  checkGrowth,
  measure,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from './support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = '/postgres';
const databases = new pg.Pool({ connectionString: adminUrl.href, max: 1 });
const ring: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) };
const partition = 46;
const route = partition * 16;
const size = 2;
const unit = 512;
let db: GrowthDatabase;
let fixture: string | undefined;

// Fixture UUIDs share a route and differ in their leading key. All growing history sorts before the fixed tail.
function subjectId(key: number, subjectRoute = route): string {
  return `${key.toString(16).padStart(8, '0')}-0000-7000-8000-${subjectRoute.toString(16).padStart(4, '0')}00000000`;
}

function population(name: string, selectedPartition: number, key: (ordinal: number) => number): Population {
  const subjectRoute = selectedPartition * 16;
  return {
    name,
    hotPartition: selectedPartition,
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'semantic.subject': [
        {
          route: subjectRoute,
          subject_id: subjectId(key(ordinal), subjectRoute),
          type: 'schema:Book',
          recorded_transaction_id: subjectId(key(ordinal), subjectRoute),
        },
      ],
    }),
  };
}

beforeEach(async () => {
  const name = `keyset_growth_${randomUUID().replaceAll('-', '')}`;
  const template = decodeURIComponent(new URL(databaseUrl).pathname.slice(1)).replaceAll('"', '""');
  await databases.query(`CREATE DATABASE ${name} TEMPLATE "${template}"`);
  fixture = name;
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  db = await openGrowthDatabase(url.href);
});

afterEach(async () => {
  try {
    await db?.close();
  } finally {
    if (fixture) {
      await dropTestDatabase(databases, fixture);
      fixture = undefined;
    }
  }
});
afterAll(() => databases.end());

async function prove(state: 'deep' | 'empty', axis: 'selected history' | 'unrelated population'): Promise<void> {
  const history = population('keyset-selected-history', partition, (ordinal) => ordinal + 1);
  const unrelated = population('keyset-unrelated', partition + 1, (ordinal) => ordinal + 1);
  const tailKey = (ordinal: number) => 0xf0000000 + ordinal;
  const tail = population('keyset-tail', partition, tailKey);
  await seed(db, history, { from: 0, to: unit });
  await seed(db, unrelated, { from: 0, to: unit });
  await seed(db, tail, { from: 0, to: 5 });

  // Walk real pages to obtain the continuation; no offset or hand-built after-key enters the paginator.
  const boundary = subjectId(tailKey(state === 'deep' ? 1 : 3));
  let cursor: string | undefined;
  let visited = 0;
  for (;;) {
    const page = await pageSubjects(db.pool, ring, { partition, size, cursor });
    expect(page?.subjects).toHaveLength(size);
    expect(page?.next).toBeString();
    visited += page!.subjects.length;
    cursor = page!.next!;
    if (page!.subjects.at(-1)!.id === boundary) break;
    if (visited > unit + 4) throw new Error('The paginator missed the selected tail');
  }
  expect(visited).toBe(unit + (state === 'deep' ? 2 : 4));
  await expect(pageSubjects(db.pool, ring, { partition: partition + 1, size, cursor })).rejects.toMatchObject({
    reason: 'invalid',
  });

  if (state === 'empty') {
    // Simulate the outstanding lookahead disappearing between requests, without changing the issued token.
    // This seed has no facts; removal is fixture setup, not a claim about erasure cost or eligibility.
    const removed = await db.admin.query('DELETE FROM semantic.subject WHERE route = $1 AND subject_id = $2', [
      route,
      subjectId(tailKey(4)),
    ]);
    expect(removed.rowCount).toBe(1);
  }

  const tokenOnly = await measure(db, async () =>
    decodeCursor(ring, { operation: 'subject.list', parameters: { partition } }, cursor!),
  );
  expect(tokenOnly.value).toMatchObject({ ok: true });
  expect(tokenOnly.cost).toMatchObject({ statements: 0, rows: 0, blocks: 0, plans: 0 });

  const report = await checkGrowth(db, {
    name: `${state} keyset continuation as ${axis} grows`,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    // One partition probe, one full-key subject seek, and at most size + 1 empty term-head probes.
    indexProbes: 2 + size + 1,
    grow: async (database, scale, previous) => {
      await seed(database, axis === 'selected history' ? history : unrelated, {
        from: unit + previous * unit,
        to: unit + scale * unit,
      });
    },
    operation: async () => {
      const page = await pageSubjects(db.pool, ring, { partition, size, cursor });
      expect(page).not.toBeNull();
      expect(page!.subjects).toEqual(
        state === 'empty'
          ? []
          : [2, 3].map((ordinal) => ({
              id: subjectId(tailKey(ordinal)),
              labels: {},
            })),
      );
      if (state === 'empty') expect(page!.next).toBeNull();
      else expect(page!.next).toBeString();
      return page;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    for (const cost of sample.repetitions) {
      // Native plan rows include filter/recheck removals and the discarded lookahead, not just returned rows.
      expect(cost.statements).toBeGreaterThan(0);
      expect(cost.plans).toBeGreaterThan(0);
      expect(cost.rows).toBeLessThanOrEqual(state === 'empty' ? 1 : 1 + size + 1);
      expect(cost.relations['semantic.subject']).toBeDefined();
      expect(cost.relations['semantic.subject']!.rows).toBe(state === 'empty' ? 0 : size + 1);
      expect(cost.relations['semantic.subject']!.sequentialScans).toBe(0);
    }
  }
}

test(
  'Deep keyset continuation stays bounded as selected history grows',
  () => prove('deep', 'selected history'),
  180_000,
);
test(
  'Deep keyset continuation stays bounded as unrelated population grows',
  () => prove('deep', 'unrelated population'),
  180_000,
);
test(
  'Empty keyset continuation stays bounded as selected history grows',
  () => prove('empty', 'selected history'),
  180_000,
);
test(
  'Empty keyset continuation stays bounded as unrelated population grows',
  () => prove('empty', 'unrelated population'),
  180_000,
);
