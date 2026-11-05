import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { createShelfActiveReader } from '../../src/library/shelf-active.ts';
import type { ShelfSession } from '../../src/library/shelf-contract.ts';
import { readSession } from '../../src/library/progress-store.ts';
import { newId } from '../../src/route/route.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import { capture, checkGrowth, costOf, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
const reader = createShelfActiveReader();
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

async function insert(
  client: Pick<PoolClient, 'query'>,
  route: number,
  owner: string,
  subject: string,
  values: Partial<ShelfSession> & { changed?: string } = {},
): Promise<string> {
  const id = values.id ?? newId(route);
  await client.query(
    `INSERT INTO library.progress_session
       (route, session_id, account_id, subject_id, version_subject_id, mode, unit, total, amount,
        locator, position, completed_unit_count, state, revision, started_at, completed_at,
        transaction_id, last_changed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      route,
      id,
      owner,
      subject,
      values.versionSubjectId ?? null,
      values.mode ?? 'scalar_amount',
      values.unit ?? 'page',
      values.total ?? null,
      values.amount ?? null,
      values.locator ?? null,
      values.position ?? null,
      values.completedUnitCount ?? 0,
      values.state ?? 'active',
      values.revision ?? 1,
      values.startedAt ?? '2026-10-01T00:00:00Z',
      values.completedAt ?? null,
      newId(route),
      values.changed ?? '2026-10-27T00:00:00Z',
    ],
  );
  return id;
}

test('active probes keep scalar and cursor BASIC serialization in the supplied snapshot', async () => {
  const route = 0x6a20,
    owner = newId(route);
  const subjects = [newId(0x7b20), newId(0x7b21)];
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const ids = [
      await insert(client, route, owner, subjects[0]!, {
        total: '999999999999.123456',
        amount: '123.456789',
        revision: 7,
        versionSubjectId: newId(0x7b22),
        startedAt: '2026-10-01T12:34:56.123456+08:00',
      }),
      await insert(client, route, owner, subjects[1]!, {
        mode: 'cursor_position',
        unit: 'chapter',
        locator: 'epubcfi(/6/4!/4/2)',
        position: '0.123456',
      }),
    ];
    const got = await reader.sessions(client, route, owner, subjects);
    expect(got.size).toBe(2);
    for (const [index, id] of ids.entries()) {
      const { accountId: _account, transactionId: _transaction, ...basic } = (await readSession(client, route, id))!;
      expect(got.get(subjects[index]!)).toEqual(basic);
    }
    expect(got.get(subjects[0]!)!.amount).toBe('123.456789');
    expect(got.get(subjects[0]!)!.total).toBe('999999999999.123456');
    expect(got.get(subjects[0]!)!.startedAt).toBe('2026-10-01T04:34:56.123Z');
    expect(got.get(subjects[1]!)!.position).toBe('0.123456');
    expect((await reader.sessions(db.admin, route, owner, subjects)).size).toBe(0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('active probes bound distinct subjects, deduplicate and skip empty SQL', async () => {
  const route = 0x6a21,
    owner = newId(route);
  const subjects = Array.from({ length: 100 }, () => newId(0x7b20));
  await insert(db.admin, route, owner, subjects[0]!);
  const empty = await capture(db, () => reader.sessions(db.admin, route, owner, []));
  expect(empty.value.size).toBe(0);
  expect(empty.capture.statements).toEqual([]);
  const bounded = await capture(db, () =>
    withReadTransaction(db.pool, (client) => reader.sessions(client, route, owner, [...subjects, ...subjects])),
  );
  expect(bounded.value.size).toBe(1);
  expect(costOf(bounded.capture).statements).toBe(1);
  expect(
    bounded.capture.plans.flatMap(nodes).find((node) => node['Node Type'] === 'Function Scan')!['Actual Rows'],
  ).toBe(100);
  const overflow = await capture(db, async () => {
    await expect(reader.sessions(db.admin, route, owner, [...subjects, newId(0x7b20)])).rejects.toBeInstanceOf(
      RangeError,
    );
  });
  expect(overflow.capture.statements).toEqual([]);
});

test('active probes choose current activity, reveal the next active session and isolate route and owner', async () => {
  const route = 0x6a22,
    owner = newId(route),
    subject = newId(0x7b20);
  const older = await insert(db.admin, route, owner, subject, { startedAt: '2026-10-26', changed: '2026-10-26' });
  const current = await insert(db.admin, route, owner, subject, { startedAt: '2026-10-01', changed: '2026-10-27' });
  await insert(db.admin, route, newId(route), subject, { changed: '2026-10-29' });
  await insert(db.admin, route, owner, subject, {
    state: 'completed',
    completedAt: '2026-10-28',
    changed: '2026-10-28',
  });
  expect((await reader.sessions(db.admin, route + 1, owner, [subject])).size).toBe(0);
  expect((await reader.sessions(db.admin, route, owner, [subject])).get(subject)!.id).toBe(current);
  await db.admin.query("UPDATE library.progress_session SET state = 'abandoned' WHERE route = $1 AND session_id = $2", [
    route,
    current,
  ]);
  expect((await reader.sessions(db.admin, route, owner, [subject])).get(subject)!.id).toBe(older);
  const reread = await insert(db.admin, route, owner, subject, { changed: '2026-10-30' });
  expect((await reader.sessions(db.admin, route, owner, [subject])).get(subject)!.id).toBe(reread);
});

type Node = Record<string, unknown>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (value === null || typeof value !== 'object') return [];
  const record = value as Node;
  return [...(typeof record['Node Type'] === 'string' ? [record] : []), ...Object.values(record).flatMap(nodes)];
}

function expectPointProbes(plans: readonly unknown[], page: number): void {
  const all = plans.flatMap(nodes);
  const scans = all.filter((node) => node['Relation Name'] === 'progress_session');
  expect(scans.length).toBe(1);
  const scan = scans[0]!;
  expect(scan['Index Name']).toBe('progress_session_active');
  expect(scan['Actual Loops']).toBe(page);
  expect(scan['Actual Rows']).toBe(1);
  for (const key of ['route', 'account_id', 'subject_id']) expect(String(scan['Index Cond'])).toContain(key);
  expect(all.filter((node) => node['Node Type'] === 'Limit').some((node) => node['Actual Loops'] === page)).toBe(true);
  // This index matches the full order, so even the bounded lateral probes need no sort.
  expect(all.filter((node) => String(node['Node Type']).includes('Sort'))).toEqual([]);
  expect(all.filter((node) => ['progress_unit', 'progress_change'].includes(String(node['Relation Name'])))).toEqual(
    [],
  );
}

test('active probes stay bounded behind private session history', async () => {
  for (const page of [1, 48]) {
    const route = 0x6a30 + page,
      owner = newId(route),
      other = newId(route);
    const subjects = Array.from({ length: page }, () => newId(0x7b20));
    const winners = new Map<string, string>();
    for (const subject of subjects) winners.set(subject, await insert(db.admin, route, owner, subject));
    const operation = async () => {
      const got = await withReadTransaction(db.pool, (client) => reader.sessions(client, route, owner, subjects));
      expect([...got].map(([subject, session]) => [subject, session.id])).toEqual([...winners]);
    };
    const report = await checkGrowth(db, {
      name: `active probes, ${page} subjects`,
      scales: [256, 1024, 4096],
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (_db, scale, previous) => {
        // Each subject has both terminal histories plus another owner's active history. All are newer than the winner.
        await db.admin.query(
          `INSERT INTO library.progress_session
             (route, session_id, account_id, subject_id, mode, unit, completed_unit_count, state,
              revision, started_at, completed_at, transaction_id, last_changed_at)
           SELECT $1, ('10000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') ||
                       lpad(to_hex(((subject_no - 1) * 3 + kind_no) * 4096 + n), 8, '0'))::uuid,
                  CASE WHEN kind = 'active' THEN $3::uuid ELSE $2::uuid END,
                  subject_id, 'scalar_amount', 'page', 0, kind, 1, '2026-10-28',
                  CASE WHEN kind = 'completed' THEN '2026-10-29'::timestamptz END,
                  $2::uuid, '2026-10-29'
           FROM unnest($4::uuid[]) WITH ORDINALITY AS subjects(subject_id, subject_no)
           CROSS JOIN generate_series($5::int + 1, $6::int) AS history(n)
           CROSS JOIN unnest(ARRAY['completed','abandoned','active']) WITH ORDINALITY AS kinds(kind, kind_no)`,
          [route, owner, other, subjects, previous, scale],
        );
      },
      warmup: async () => {
        const measured = await capture(db, operation);
        expect(costOf(measured.capture).statements).toBe(1);
        expectPointProbes(measured.capture.plans, page);
      },
      operation,
    });
    for (const sample of report.samples) {
      for (const cost of sample.repetitions) {
        expect(cost.statements).toBe(1);
        expect(cost.rows).toBeLessThanOrEqual(page * 4);
        expect(cost.relations['library.progress_session']!.rows).toBe(page);
        expect(cost.relations['library.progress_session']!.sequentialScans).toBe(0);
      }
    }
  }
}, 240_000);
