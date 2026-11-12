import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readLibraryEntryTiles } from '../../src/library/library-entry-tiles.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  capture,
  catalogStatementBound,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  seed,
  type Capture,
  type GrowthDatabase,
} from '../support/growth.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let db: GrowthDatabase, f: NativeProfileFixture;
const scopes = [
  'subject:read',
  'library_entry:read',
  'library_entry:list',
  'library_entry:update',
  'progress_session:create',
  'progress_session:read',
  'progress_session:list',
  'progress_session:update',
];
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await createProfileEntryFixture({ pool: db.pool });
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await db?.close();
  }
});

type Node = Record<string, unknown>;
function nodes(value: unknown): Node[] {
  if (!value || typeof value !== 'object') return [];
  return [...('Node Type' in value ? [value as Node] : []), ...Object.values(value).flatMap(nodes)];
}
function assertPlans(raw: Capture, present: number, requested: number) {
  const catalogue = catalogStatementBound(raw);
  expect(catalogue.catalogStatements).toBeLessThanOrEqual(catalogue.allowedStatements);
  const all = raw.plans.flatMap(nodes);
  for (const [relation, probes] of [
    ['entry', requested],
    ['progress_session', present],
  ] as const) {
    const scans = all.filter((n) => n.Schema === 'library' && n['Relation Name'] === relation);
    expect(scans).toHaveLength(probes === 0 ? 0 : 1);
    for (const scan of scans) {
      expect(['Index Scan', 'Index Only Scan']).toContain(String(scan['Node Type']));
      expect(scan['Actual Loops']).toBe(probes);
      expect(Number(scan['Actual Rows']) + Number(scan['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(1);
      for (const key of ['route', 'account_id', 'subject_id']) expect(String(scan['Index Cond'])).toContain(key);
      if (relation === 'progress_session') expect(scan['Index Name']).toBe('progress_session_active');
    }
  }
  expect(all.some((n) => ['progress_unit', 'progress_change'].includes(String(n['Relation Name'])))).toBe(false);
  for (const sort of all.filter((node) => String(node['Node Type']).includes('Sort'))) {
    const children = (sort.Plans as Node[] | undefined) ?? [];
    expect(children).toHaveLength(1);
    const input = children[0]!;
    const inputRows = Number(input['Actual Rows']);
    const inputLoops = Number(input['Actual Loops']);
    expect(Number.isFinite(inputRows)).toBe(true);
    expect(Number.isFinite(inputLoops)).toBe(true);
    const libraryInput = nodes(input).some((node) => node.Schema === 'library');
    if (libraryInput) {
      // Library rows may only be sorted inside a one-row point probe per requested subject.
      expect(inputRows).toBeLessThanOrEqual(1);
      expect(inputLoops).toBeLessThanOrEqual(requested);
    } else {
      // Sorting request keys is bounded by the distinct, <=100 subject input.
      expect(nodes(input).filter((node) => typeof node['Relation Name'] === 'string')).toHaveLength(0);
      expect(inputRows * inputLoops).toBeLessThanOrEqual(requested);
    }
  }
  expect(costOf(raw).statements).toBe(requested === 0 ? 0 : present === 0 ? 1 : 2);
}

test('entry tile raw input bounds and absent entries perform no session probes', async () => {
  const owner = await f.identity(scopes),
    actor = owner.actor;
  const input = { route: routeOf(actor.accountId)!, accountId: actor.accountId, subjectIds: [] as string[] };
  const empty = await capture(db, () => readLibraryEntryTiles(db.pool, input));
  expect(empty.value.size).toBe(0);
  expect(empty.capture.statements).toEqual([]);
  for (const subjectIds of [Array(101).fill(newId(1)), ['invalid'], [newId(1), 'invalid']]) {
    const invalid = await capture(db, async () => {
      await expect(readLibraryEntryTiles(db.pool, { ...input, subjectIds })).rejects.toBeInstanceOf(
        subjectIds.length > 100 ? RangeError : TypeError,
      );
    });
    expect(invalid.capture.statements).toEqual([]);
  }
  const subject = await f.createSubject('record');
  const response = await f.send(owner.bearer, 'POST', '/v1/progressSessions', {
    subjectId: subject,
    mode: 'scalar_amount',
    unit: 'track',
    total: '10',
  });
  expect(response.status).toBe(201);
  const absent = await capture(db, () => readLibraryEntryTiles(db.pool, { ...input, subjectIds: [subject, subject] }));
  expect(absent.value.size).toBe(0);
  assertPlans(absent.capture, 0, 1);
}, 120000);

test('entry tile PK and active winner work stays bounded at 64 512 4096 entries and lifecycle histories across owners and partitions', async () => {
  const owner = await f.identity(scopes),
    route = routeOf(owner.actor.accountId)!;
  const neighbour = await f.identity(scopes, partitionOf(route));
  const distant = await f.identity(scopes, (partitionOf(route) + 1) % 4096);
  const subject = await f.createSubject('record'),
    noEntry = await f.createSubject('record');
  expect((await f.send(owner.bearer, 'PUT', '/v1/libraryEntries/' + subject, { state: 'listening' })).status).toBe(201);
  async function start(subjectId: string) {
    const r = await f.send(owner.bearer, 'POST', '/v1/progressSessions', {
      subjectId,
      mode: 'scalar_amount',
      unit: 'track',
      total: '10',
    });
    expect(r.status).toBe(201);
    return (await r.json()).progressSession;
  }
  const active = await start(subject);
  await start(noEntry);
  const entry = (
    await db.admin.query('SELECT * FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
      route,
      owner.actor.accountId,
      subject,
    ])
  ).rows[0]!;
  const session = (
    await db.admin.query('SELECT * FROM library.progress_session WHERE route=$1 AND session_id=$2', [route, active.id])
  ).rows[0]!;
  const readPool = db.openPool({ max: 1, options: '-c default_transaction_read_only=on' });
  async function operation() {
    const c = await readPool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const got = await readLibraryEntryTiles(c, {
        route,
        accountId: owner.actor.accountId,
        subjectIds: [subject, noEntry, subject],
      });
      expect(got.size).toBe(1);
      expect(got.get(subject)!.activeProgressSession).toEqual(active);
      expect(got.get(subject)!.state).toBe('listening');
      expect(got.get(subject)!.incarnationId).toBe(entry.incarnation_id);
      expect(got.has(noEntry)).toBe(false);
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }
  const evidence: unknown[] = [];
  const report = await checkGrowth(db, {
    name: 'entry tile bounded owner PK and active partial-index batch',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      await seed(
        database,
        {
          name: 'entry tile unrelated entries and all session lifecycles',
          hotPartition: partitionOf(route),
          hotShare: 1,
          rows() {
            const unrelated = newId(routeOf(subject)!);
            const entries = [owner, neighbour, distant].map((identity) => ({
              ...entry,
              route: routeOf(identity.actor.accountId)!,
              account_id: identity.actor.accountId,
              subject_id: unrelated,
            }));
            const sessions = [owner, neighbour, distant].flatMap((identity) =>
              [subject, noEntry, unrelated].flatMap((subjectId) =>
                ['active', 'completed', 'abandoned'].map((state) => ({
                  ...session,
                  route: routeOf(identity.actor.accountId)!,
                  account_id: identity.actor.accountId,
                  session_id: newId(routeOf(identity.actor.accountId)!),
                  subject_id: subjectId,
                  state,
                  last_changed_at: '2000-01-01T00:00:00Z',
                  started_at: '2000-01-01T00:00:00Z',
                  completed_at: state === 'completed' ? '2000-01-01T00:00:00Z' : null,
                })),
              ),
            );
            return { 'library.entry': entries, 'library.progress_session': sessions };
          },
        },
        { from: previous, to: scale },
      );
    },
    async warmup(_database, scale) {
      for (let i = 0; i < 6; i++) await operation();
      const measured = await capture(db, operation);
      assertPlans(measured.capture, 1, 2);
      evidence.push({ scale, capture: measured.capture });
    },
    operation,
  });
  console.info(JSON.stringify({ report, evidence }));
}, 1800000);
