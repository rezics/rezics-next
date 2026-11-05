import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { routeOf } from '../src/route/route.ts';
import { populateContextDirectory } from '../src/semantic/context-directory.ts';
import { pageSubjects } from '../src/semantic/page.ts';
import { decodeCursor } from '../src/tokens/cursor.ts';
import type { KeyRing } from '../src/tokens/seal.ts';
import { dropTestDatabase } from './support/drop-test-database.ts';
import { createDeletionFixture } from './semantic/support/deletion-fixture.ts';
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
    const page = await pageSubjects(db.pool, ring, { partition, size, ...(cursor ? { cursor } : {}) });
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

test('Viewer/query-bound deep and empty production continuation retains bounded native SQL and Access work at three independent history and unrelated scales', async () => {
  const app = await createDeletionFixture(db);
  db.pool.options.max = 1;
  await app.setup();

  const limit = 100;
  const unit = 100;
  const targetLabels = (prefix: string) =>
    [0, 1].map((ordinal) => `${prefix} target ${ordinal.toString().padStart(4, '0')}`);
  const label = (prefix: string, population: string, ordinal: number) =>
    population === 'unrelated'
      ? `unrelated ${prefix} ${ordinal.toString().padStart(4, '0')}`
      : `${prefix} ${population} ${ordinal.toString().padStart(4, '0')}`;

  async function createContexts(prefix: string, population: string, from: number, to: number): Promise<string[]> {
    const ids: string[] = [];
    for (let ordinal = from; ordinal < to; ordinal++) {
      const name = label(prefix, population, ordinal);
      const response = await app.call('POST', '/v1/contexts', 'owner', {
        labels: { en: name, fr: `Expanded ${population} ${ordinal}` },
      });
      app.status(response, 201);
      ids.push(response.body.context.id as string);
    }
    return ids;
  }

  async function prepareDirectory(): Promise<void> {
    await populateContextDirectory(db.pool, app.clock, 1000);
  }

  async function deny(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    await app.admin.query(
      `INSERT INTO access.resource_denial(route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
         SELECT route,resource_id,$3,'','context:read','resource','(,)',transaction_id
         FROM unnest($1::int[],$2::uuid[],$4::uuid[]) AS denied(route,resource_id,transaction_id)`,
      [ids.map((id) => routeOf(id)!), ids, app.accounts.owner, ids.map(() => randomUUID())],
    );
  }

  async function scenario(state: 'deep' | 'empty', axis: 'selected history' | 'unrelated population') {
    const prefix = `growth-${randomUUID()}`;
    const targets = await createContexts(prefix, 'target', 0, 2);
    const withheld = await createContexts(prefix, 'withheld', 0, 101);
    await deny(withheld);
    await createContexts(prefix, axis === 'selected history' ? 'unrelated' : 'history', 0, unit);
    await prepareDirectory();

    const prepared = new Map<number, { deep: string; empty: string }>();
    const path = (cursor?: string) => {
      const query = new URLSearchParams({ query: prefix, limit: String(limit), ...(cursor ? { cursor } : {}) });
      return `/v1/contexts?${query}`;
    };
    async function list(cursor?: string) {
      const response = await app.call('GET', path(cursor), 'owner');
      app.status(response, 200);
      return response.body as {
        contexts: Array<{ id: string; labels: Record<string, string> }>;
        next: string | null;
      };
    }
    async function issueCursors(): Promise<{ deep: string; empty: string }> {
      let cursor: string | undefined;
      for (let pageNo = 0; pageNo < 16; pageNo++) {
        const page = await list(cursor);
        if (page.contexts.some((entry) => entry.id === targets[0])) {
          expect(page.contexts.map((entry) => entry.id)).toEqual(targets);
          expect(page.contexts.map((entry) => entry.labels)).toEqual(
            targetLabels(prefix).map((name, ordinal) => ({
              en: name,
              fr: `Expanded target ${ordinal}`,
            })),
          );
          expect(cursor).toBeString();
          expect(page.next).toBeString();
          return { deep: cursor!, empty: page.next! };
        }
        if (!page.next) throw new Error('Production pagination exhausted before the selected tail');
        cursor = page.next;
      }
      throw new Error('Production pagination did not reach the selected tail');
    }
    async function ensureCursors(scale: number): Promise<{ deep: string; empty: string }> {
      let value = prepared.get(scale);
      if (!value) {
        value = await issueCursors();
        prepared.set(scale, value);
      }
      return value;
    }
    async function request(scale: number) {
      const cursors = await ensureCursors(scale);
      const page = await list(state === 'deep' ? cursors.deep : cursors.empty);
      if (state === 'deep') {
        expect(page.contexts.map((entry) => entry.id)).toEqual(targets);
        expect(page.next).toBeString();
      } else {
        expect(page.contexts).toEqual([]);
        expect(page.next).toBeNull();
      }
      return page;
    }

    const report = await checkGrowth(db, {
      name: `${state} viewer/query-bound production continuation as ${axis} grows`,
      scales: [1, 2, 4],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      // The production directory admits at most 100 native candidate IDs plus fixed partition and owner anchors.
      indexProbes: 256,
      grow: async (_database, scale, previous) => {
        const population = axis === 'selected history' ? 'history' : 'unrelated';
        await createContexts(prefix, population, previous * unit, scale * unit);
        await prepareDirectory();
      },
      warmup: async (_database, scale) => {
        await request(scale);
      },
      prepare: async (_database, scale) => {
        await ensureCursors(scale);
      },
      operation: (_database, scale) => request(scale),
    });

    expect(report.samples.map(({ scale }) => scale)).toEqual([1, 2, 4]);
    for (const sample of report.samples) {
      for (const cost of sample.repetitions) {
        expect(cost.statements).toBeGreaterThan(0);
        expect(cost.statements).toBeLessThanOrEqual(64);
        expect(cost.plans).toBeGreaterThan(0);
        expect(cost.blocks).toBeGreaterThan(0);
        expect(cost.relations['semantic.context_directory_entry']?.rows).toBe(state === 'deep' ? 100 : 3);
        expect(cost.relations['access.resource_denial']?.rows).toBe(state === 'deep' ? 98 : 3);
        expect(cost.rows).toBeLessThanOrEqual(state === 'deep' ? 10_000 : 2_000);
      }
    }
  }

  try {
    for (const axis of ['selected history', 'unrelated population'] as const) {
      for (const state of ['deep', 'empty'] as const) await scenario(state, axis);
    }
  } finally {
    await app.close();
  }
}, 600_000);
