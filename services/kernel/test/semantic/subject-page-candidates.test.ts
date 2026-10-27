import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { KernelClock } from '../../src/clock.ts';
import { CommandUnavailableError } from '../../src/access/unavailable.ts';
import { PageCursorError } from '../../src/semantic/page.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { newId } from '../../src/route/route.ts';
import { decodeCursor, encodeCursor } from '../../src/tokens/cursor.ts';
import { seal, type KeyRing } from '../../src/tokens/seal.ts';
import { capture, costOf, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';

// A missing implementation must fail a behavior assertion after opening the migrated database.
const modulePath = '../../src/semantic/subject-page-candidates.ts';
type Window = {
  candidates: { route: number; id: string }[];
  next: string | null;
  component: { partition: number; epoch: number; position: bigint };
};
type Page = (
  pool: Pool,
  ring: KeyRing,
  options: {
    partition: number;
    size?: number;
    cursor?: string;
    clock?: KernelClock;
  },
) => Promise<Window>;
let page: Page;
let db: GrowthDatabase;
const partition = 123;
const route = partition * 16;
const epoch = 7;
const position = 9007199254740993n;
const now = Date.UTC(2026, 9, 20);
const clock = () => new Date(now);
const ring: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(43)]]) };
const binding = (size = 20, owner = partition) => ({
  operation: 'subject-pages.candidates',
  parameters: { partition: owner, size },
});
const expected: { route: number; id: string }[] = [];

beforeAll(async () => {
  db = await openGrowthDatabase(process.env.DATABASE_URL!);
  if (existsSync(new URL(modulePath, import.meta.url))) page = (await import(modulePath)).pageSubjectPageCandidates;
  await db.admin.query('UPDATE core.partition SET epoch = $2, position = $3 WHERE partition_no = $1', [
    partition,
    epoch,
    position.toString(),
  ]);
  await seed(
    db,
    {
      name: 'candidate-window-behavior',
      hotPartition: partition,
      hotShare: 1,
      rows: ({ ordinal }) => {
        const ownerRoute = ordinal < 1003 ? route + (ordinal % 16) : route + 16;
        const id = newId(ownerRoute);
        if (ordinal < 1003) expected.push({ route: ownerRoute, id });
        const tx = randomUUID();
        const facts = itemFacts(id, { labels: { en: `Title only ${ordinal}` } });
        return {
          'semantic.subject': [
            {
              route: ownerRoute,
              subject_id: id,
              type: 'schema:Book',
              visibility: ordinal % 3 === 0 ? 'hidden' : ordinal % 3 === 1 ? 'taken_down' : 'visible',
              security_revision: 1,
              current_facts: facts.length,
              recorded_transaction_id: tx,
            },
          ],
          'semantic.fact': facts.map((fact) => ({
            ...fact,
            route: ownerRoute,
            subject_id: id,
            recorded_transaction_id: tx,
          })),
        };
      },
    },
    { from: 0, to: 1103 },
  );
  expected.sort((a, b) => a.route - b.route || a.id.localeCompare(b.id));
});
afterAll(async () => {
  if (db) await db.close();
});

function ready() {
  expect(page, 'the internal candidate-window primitive must exist').toBeFunction();
}

test('candidate windows inspect one source partition and preserve the unprocessed sentinel', async () => {
  ready();
  const measured = await capture(db, () => page(db.pool, ring, { partition, size: 1, clock }));
  const first = measured.value;
  expect(first.candidates).toEqual(expected.slice(0, 1));
  expect(first.component).toEqual({ partition, epoch, position });
  expect(decodeCursor(ring, binding(1), first.next!, now)).toEqual({
    ok: true,
    epoch,
    after: [expected[0]!.route, expected[0]!.id],
  });
  const second = await page(db.pool, ring, { partition, size: 1, cursor: first.next!, clock });
  expect(second.candidates).toEqual(expected.slice(1, 2));
  const sql = measured.capture.statements.join('\n');
  expect(sql).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(sql).not.toMatch(/semantic\.(?:fact|hidden_candidate)|labels|OFFSET|visibility/i);
  expect(sql.match(/FROM core.partition/g)).toHaveLength(1);
  expect(sql.match(/FROM semantic.subject/g)).toHaveLength(1);
  expect(JSON.stringify(measured.capture.plans)).toContain(`route >= ${route}`);
  expect(JSON.stringify(measured.capture.plans)).toContain(`route < ${route + 16}`);
  expect(sql).toMatch(/LIMIT \$\d+::integer/);
  const cost = costOf(measured.capture);
  expect(Object.keys(cost.relations).sort()).toEqual(['core.partition', 'semantic.subject']);
  expect(cost.relations['semantic.subject']!.rows).toBe(2);
  expect(cost.statements + cost.controlStatements).toBe(5);
});

test('unchanged candidate traversal visits every hidden and title-only key exactly once', async () => {
  ready();
  const seen: Window['candidates'] = [];
  let cursor: string | undefined;
  do {
    const window = await page(db.pool, ring, { partition, size: 1000, clock, ...(cursor ? { cursor } : {}) });
    expect(window.candidates.length).toBeLessThanOrEqual(1000);
    expect(window.component).toEqual({ partition, epoch, position });
    seen.push(...window.candidates);
    cursor = window.next ?? undefined;
  } while (cursor);
  expect(seen).toEqual(expected);
  expect(new Set(seen.map(({ id }) => id)).size).toBe(expected.length);
});

test('candidate sizes and empty or other owner windows preserve their actual component', async () => {
  ready();
  expect((await page(db.pool, ring, { partition, clock })).candidates).toEqual(expected.slice(0, 20));
  expect((await page(db.pool, ring, { partition, size: 1000, clock })).candidates).toHaveLength(1000);
  const other = await page(db.pool, ring, { partition: partition + 1 });
  expect(other.candidates).toHaveLength(20);
  expect(other.candidates.every(({ route: r }) => r === route + 16)).toBe(true);
  const measured = await capture(db, () => page(db.pool, ring, { partition: partition + 2 }));
  expect(measured.value).toEqual({
    candidates: [],
    next: null,
    component: { partition: partition + 2, epoch: 1, position: 0n },
  });
  expect(costOf(measured.capture).relations['semantic.subject']!.rows).toBe(0);
  expect(measured.capture.statements.filter((sql) => /FROM core.partition/.test(sql))).toHaveLength(1);
  for (const size of [0, -1, 1.1, 1001, NaN, Infinity])
    await expect(page(db.pool, ring, { partition, size })).rejects.toBeInstanceOf(RangeError);
  for (const invalid of [-1, 4096, 0.5, NaN, Infinity])
    await expect(page(db.pool, ring, { partition: invalid })).rejects.toBeInstanceOf(RangeError);
});

test('candidate cursors bind owner size and epoch', async () => {
  ready();
  const first = await page(db.pool, ring, { partition, size: 1, clock });
  const invalid = async (cursor: string, options = {}) => {
    await expect(page(db.pool, ring, { partition, size: 1, clock, cursor, ...options })).rejects.toMatchObject({
      name: 'PageCursorError',
      reason: 'invalid',
    });
  };
  await invalid(first.next!.slice(0, -3) + 'abc');
  await invalid(first.next!, { size: 2 });
  await invalid(first.next!, { partition: partition + 1 });
  await invalid(expected[0]!.id);
  await invalid(
    encodeCursor(
      ring,
      { operation: 'subject.list', parameters: { partition } },
      { epoch, after: [route, expected[0]!.id] },
      now,
    ),
  );
  for (const after of [
    [],
    [route],
    [route, expected[0]!.id, 1],
    [route + 16, newId(route + 16)],
    [route - 1, newId(route - 1)],
    [String(route), expected[0]!.id],
    [route, newId(route + 1)],
    [route, expected[0]!.id.toUpperCase()],
    [route, '00000000-0000-0000-0000-000000000000'],
  ]) {
    await invalid(encodeCursor(ring, binding(1), { epoch, after }, now));
  }
  // The cursor encoder refuses fractions itself; sign this malformed payload directly.
  await invalid(
    seal(ring, `cursor\0subject-pages.candidates\0${JSON.stringify(binding(1).parameters)}`, {
      e: epoch,
      a: [route + 0.5, expected[0]!.id],
      t: now,
    }),
  );
  await expect(
    page(db.pool, ring, { partition, size: 1, cursor: first.next!, clock: () => new Date(now + 900001) }),
  ).rejects.toMatchObject({ name: 'PageCursorError', reason: 'expired' });
  await invalid(first.next!, { clock: () => new Date(now - 60001) });
  await db.admin.query('UPDATE core.partition SET epoch = epoch + 1 WHERE partition_no = $1', [partition]);
  try {
    await expect(page(db.pool, ring, { partition, size: 1, cursor: first.next!, clock })).rejects.toBeInstanceOf(
      PageCursorError,
    );
    await expect(page(db.pool, ring, { partition, size: 1, cursor: first.next!, clock })).rejects.toMatchObject({
      reason: 'stale',
    });
  } finally {
    await db.admin.query('UPDATE core.partition SET epoch = $2 WHERE partition_no = $1', [partition, epoch]);
  }
});

test('missing and moved owners fail with typed availability and fenced owners remain readable', async () => {
  ready();
  const owner = 4000;
  await db.admin.query(
    "UPDATE core.partition SET write_state = 'moved', moved_to = 'other-node' WHERE partition_no = $1",
    [owner],
  );
  try {
    await expect(page(db.pool, ring, { partition: owner })).rejects.toBeInstanceOf(CommandUnavailableError);
    await expect(page(db.pool, ring, { partition: owner })).rejects.toMatchObject({
      reason: 'moved',
      partition: owner,
      movedTo: 'other-node',
    });
    await db.admin.query("UPDATE core.partition SET write_state = 'fenced', moved_to = NULL WHERE partition_no = $1", [
      owner,
    ]);
    expect((await page(db.pool, ring, { partition: owner })).candidates).toEqual([]);
    await db.admin.query('DELETE FROM core.partition WHERE partition_no = $1', [owner]);
    await expect(page(db.pool, ring, { partition: owner })).rejects.toMatchObject({
      reason: 'deadline',
      partition: owner,
    });
  } finally {
    await db.admin.query(
      "INSERT INTO core.partition(partition_no,node) VALUES ($1,'local') ON CONFLICT (partition_no) DO UPDATE SET write_state = 'active', moved_to = NULL",
      [owner],
    );
  }
});
