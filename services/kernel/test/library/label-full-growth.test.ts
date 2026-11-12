import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accountToken } from '../support/admitted-access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  capture,
  captureWithFoldedCost,
  catalogStatementBound,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  seed,
  type Capture,
  type Cost,
  type GrowthDatabase,
} from '../support/growth.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { executableSqlOffsets } from '../support/growth-sql-kind.ts';

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
  f = await createProfileEntryFixture({ pool: db.pool, projectLinks: false });
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await db?.close();
  }
});
async function json(bearer: string, method: string, path: string, status: number, body?: unknown) {
  const response = await f.send(bearer, method, path, body);
  expect(response.status).toBe(status);
  return response.json();
}
async function label(bearer: string, name: string) {
  return (await json(bearer, 'POST', '/v1/libraryLabels', 201, { name })).label;
}
async function start(bearer: string, subjectId: string) {
  return (
    await json(bearer, 'POST', '/v1/progressSessions', 201, {
      subjectId,
      mode: 'scalar_amount',
      unit: 'track',
      total: '10',
    })
  ).progressSession;
}
function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  return [...('Node Type' in value ? [value as Record<string, unknown>] : []), ...Object.values(value).flatMap(nodes)];
}
function privateScans(raw: Capture) {
  return raw.plans
    .flatMap(nodes)
    .filter(
      (n) =>
        n.Schema === 'library' &&
        ['entry', 'progress_session', 'personal_label', 'label_assignment'].includes(String(n['Relation Name'])),
    );
}
function libraryRelation(cost: Cost, name: string) {
  return Object.values(cost.relations).find(
    (relation) =>
      relation.identity?.kind === 'relation' &&
      relation.identity.schema === 'library' &&
      relation.identity.name === name,
  );
}

test('An owner opens a label shelf with current label headings and bounded profiled entry/progress tiles through the FULL HTTP caller', async () => {
  const owner = await f.identity(scopes),
    other = await f.identity(scopes);
  const l = await label(owner.bearer, 'Current full heading');
  const empty = await label(owner.bearer, 'Empty full heading');
  const subject = await f.createSubject('record'),
    unprofiled = await f.createSubject('unprofiled');
  for (const subjectId of [subject, unprofiled])
    await json(owner.bearer, 'POST', `/v1/libraryLabels/${l.id}:assign`, 200, { subjectId });
  await json(owner.bearer, 'PUT', '/v1/libraryEntries/' + subject, 201, { state: 'listening' });
  const active = await start(owner.bearer, subject);
  await json(owner.bearer, 'PATCH', '/v1/libraryLabels/' + l.id, 200, {
    revision: l.revision,
    name: 'Renamed full heading',
  });
  const path = '/v1/libraryLabelAssignments?labelId=' + l.id;
  const basic = await json(owner.bearer, 'GET', path + '&limit=1', 200);
  const continued = await json(
    owner.bearer,
    'GET',
    path + '&limit=1&view=FULL&cursor=' + encodeURIComponent(basic.next),
    200,
  );
  expect(continued.label).toEqual({ id: l.id, name: 'Renamed full heading', revision: 2 });
  const bySubject = await json(owner.bearer, 'GET', `/v1/libraryLabelAssignments?subjectId=${subject}&view=FULL`, 200);
  expect(Object.keys(bySubject.assignments[0]).sort()).toEqual(
    ['id', 'labelId', 'subjectId', 'revision', 'label'].sort(),
  );
  expect(bySubject.assignments[0].label).toEqual({ name: 'Renamed full heading' });
  expect(bySubject).not.toHaveProperty('label');
  let full = await json(owner.bearer, 'GET', path + '&view=FULL', 200);
  expect(full.label).toEqual({ id: l.id, name: 'Renamed full heading', revision: 2 });
  expect(full.assignments.find((r: { subjectId: string }) => r.subjectId === subject)).toMatchObject({
    subject: { id: subject },
    libraryEntry: { state: 'listening', activeProgressSession: active },
  });
  expect(full.assignments.find((r: { subjectId: string }) => r.subjectId === unprofiled)).toMatchObject({
    subject: { id: unprofiled },
    libraryEntry: null,
  });
  await f.activate(f.replacementDigest);
  await json('steward', 'POST', `/v1/subjects/${subject}:hide`, 200, { reason: 'Native FULL source concealment' });
  const before = await f.inspect(owner.actor.accountId);
  full = await json(owner.bearer, 'GET', path + '&view=FULL', 200);
  const row = full.assignments.find((r: { subjectId: string }) => r.subjectId === subject);
  expect(row.subject).toBeNull();
  expect(row.libraryEntry.state).toBe('listening');
  expect(row.libraryEntry.activeProgressSession).toEqual(active);
  expect(await f.inspect(owner.actor.accountId)).toEqual(before);
  for (const persona of [other.bearer, 'anonymous']) {
    const denied = await json(persona, 'GET', path + '&view=FULL', persona === 'anonymous' ? 401 : 404);
    expect(denied).not.toHaveProperty('assignments');
    expect(denied).not.toHaveProperty('label');
  }
  const restricted = await accountToken({
    accountId: owner.actor.accountId,
    clientId: owner.actor.clientId,
    scopes: ['library_entry:read'],
  });
  const denied = await capture(db, () =>
    json(restricted, 'GET', `/v1/libraryLabelAssignments?labelId=${empty.id}&view=FULL`, 403),
  );
  expect(privateScans(denied.capture)).toEqual([]);
  for (const missing of [[], ['library_entry:list'], ['progress_session:list']]) {
    const bearer = await accountToken({
      accountId: owner.actor.accountId,
      clientId: owner.actor.clientId,
      scopes: ['library_entry:read', ...missing],
    });
    const r = await capture(db, () => json(bearer, 'GET', path + '&view=FULL', 403));
    expect(privateScans(r.capture)).toEqual([]);
  }
  await json(owner.bearer, 'DELETE', `/v1/libraryLabels/${l.id}?revision=2`, 200);
  await json(owner.bearer, 'GET', path + '&view=FULL', 404);
  await f.suspend(owner.actor.accountId);
  await json(owner.bearer, 'GET', `/v1/libraryLabelAssignments?labelId=${empty.id}&view=FULL`, 401);
  await f.activate(f.originalDigest);
}, 120000);

test('FULL empty shelves enforce both gates before private reads and HTTP prefix accepts scalar-length literal names', async () => {
  const owner = await f.identity(scopes);
  const empty = await label(owner.bearer, 'Gate empty heading');
  const longName = '😀'.repeat(100);
  const long = await label(owner.bearer, longName);
  const literal = await label(owner.bearer, 'Literal%_\\tail');
  for (const [q, expected] of [
    [longName, long.id],
    [' Literal%_\\ ', literal.id],
  ]) {
    const page = await json(owner.bearer, 'GET', '/v1/libraryLabels?q=' + encodeURIComponent(q!), 200);
    expect(page.labels.map((row: { id: string }) => row.id)).toEqual([expected]);
  }
  const path = `/v1/libraryLabelAssignments?labelId=${empty.id}&view=FULL`;
  await json('steward', 'POST', '/v1/platform/exposure/reading_progress:close', 200);
  const closed = await capture(db, () => json(owner.bearer, 'GET', path, 403));
  expect(closed.value.code).toBe('platform_closed');
  expect(privateScans(closed.capture)).toEqual([]);
  await json(owner.bearer, 'GET', `/v1/libraryLabelAssignments?labelId=${empty.id}`, 200);
  await json('steward', 'POST', '/v1/platform/exposure/reading_progress:open', 200);
  await f.setLibraryOpen(false);
  const libraryClosed = await capture(db, () => json(owner.bearer, 'GET', path, 403));
  expect(libraryClosed.value.code).toBe('platform_closed');
  expect(privateScans(libraryClosed.capture)).toEqual([]);
  await f.setLibraryOpen(true);
  expect(await json(owner.bearer, 'GET', path, 200)).toEqual({
    assignments: [],
    next: null,
    label: { ...empty, name: 'Gate empty heading' },
  });
}, 120000);

test('FULL label HTTP charges all native pools at 64 512 4096 catalogue entries session lifecycles and same-subject retained assignments', async () => {
  const owner = await f.identity(scopes),
    route = routeOf(owner.actor.accountId)!;
  const neighbour = await f.identity(scopes, partitionOf(route));
  const distant = await f.identity(scopes, (partitionOf(route) + 1) % 4096);
  const l = await label(owner.bearer, 'FULL growth target'),
    empty = await label(owner.bearer, 'FULL growth empty');
  const subjects = [
    await f.createSubject('record'),
    await f.createSubject('record'),
    await f.createSubject('unprofiled'),
    await f.createSubject('record'),
  ];
  for (const subjectId of subjects)
    await json(owner.bearer, 'POST', `/v1/libraryLabels/${l.id}:assign`, 200, { subjectId });
  for (const subjectId of [subjects[0]!, subjects[3]!])
    await json(owner.bearer, 'PUT', '/v1/libraryEntries/' + subjectId, 201, { state: 'listening' });
  const active = await start(owner.bearer, subjects[0]!);
  await start(owner.bearer, subjects[1]!); // Session-only subjects must not acquire a tile.
  await json('steward', 'POST', `/v1/subjects/${subjects[3]}:hide`, 200, { reason: 'FULL growth hidden summary' });
  // Fill the independent bounded subject source with current-but-deleted parents, not inactive history.
  for (let i = 0; i < 31; i++) {
    const p = await label(owner.bearer, 'Reserved deleted parent ' + i);
    await json(owner.bearer, 'POST', `/v1/libraryLabels/${p.id}:assign`, 200, { subjectId: subjects[0] });
    await json(owner.bearer, 'DELETE', `/v1/libraryLabels/${p.id}?revision=1`, 200);
  }
  const old = await label(owner.bearer, 'Unassigned template');
  const assignment = (
    await json(owner.bearer, 'POST', `/v1/libraryLabels/${old.id}:assign`, 200, { subjectId: subjects[1] })
  ).assignment;
  await json(owner.bearer, 'POST', `/v1/libraryLabels/${old.id}:unassign`, 200, {
    subjectId: subjects[1],
    assignmentId: assignment.id,
    revision: assignment.revision,
  });
  const entry = (
    await db.admin.query('SELECT * FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
      route,
      owner.actor.accountId,
      subjects[0],
    ])
  ).rows[0]!;
  const session = (
    await db.admin.query('SELECT * FROM library.progress_session WHERE route=$1 AND session_id=$2', [route, active.id])
  ).rows[0]!;
  const parent = (
    await db.admin.query('SELECT * FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3', [
      route,
      owner.actor.accountId,
      old.id,
    ])
  ).rows[0]!;
  const retained = (
    await db.admin.query('SELECT * FROM library.label_assignment WHERE route=$1 AND assignment_id=$2', [
      route,
      assignment.id,
    ])
  ).rows[0]!;
  async function operation() {
    const page = await json(owner.bearer, 'GET', `/v1/libraryLabelAssignments?labelId=${l.id}&view=FULL&limit=4`, 200);
    expect(page.label).toEqual({ id: l.id, name: 'FULL growth target', revision: 1 });
    expect(page.assignments).toHaveLength(4);
    expect(
      page.assignments.find((r: { subjectId: string }) => r.subjectId === subjects[0]).libraryEntry
        .activeProgressSession,
    ).toEqual(active);
    expect(page.assignments.find((r: { subjectId: string }) => r.subjectId === subjects[1]).libraryEntry).toBeNull();
    expect(page.assignments.find((r: { subjectId: string }) => r.subjectId === subjects[3]).subject).toBeNull();
    const named = await json(
      owner.bearer,
      'GET',
      `/v1/libraryLabelAssignments?subjectId=${subjects[0]}&view=FULL&limit=100`,
      200,
    );
    expect(named.assignments).toHaveLength(1);
    expect(named.assignments[0].label).toEqual({ name: 'FULL growth target' });
    const zero = await json(owner.bearer, 'GET', `/v1/libraryLabelAssignments?labelId=${empty.id}&view=FULL`, 200);
    expect(zero).toEqual({ assignments: [], next: null, label: { ...empty, name: 'FULL growth empty' } });
  }
  const evidence: unknown[] = [];
  const report = await checkGrowth(db, {
    name: 'FULL HTTP complete owner and public-source work',
    captureMode: 'cost-folded',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      await seed(
        database,
        {
          name: 'FULL all native population axes',
          hotPartition: partitionOf(route),
          hotShare: 1,
          rows(p) {
            const subject = newId(routeOf(subjects[0]!)!),
              labelId = newId(route);
            return {
              'library.personal_label': [owner, neighbour, distant].map((o) => ({
                ...parent,
                route: routeOf(o.actor.accountId)!,
                account_id: o.actor.accountId,
                label_id: labelId,
                normalized_name: 'Unrelated FULL ' + p.ordinal,
              })),
              'library.label_assignment': [
                { ...retained, assignment_id: newId(route), label_id: labelId },
                { ...retained, assignment_id: newId(route), label_id: l.id, subject_id: subject },
              ],
              'library.entry': [owner, neighbour, distant].map((o) => ({
                ...entry,
                route: routeOf(o.actor.accountId)!,
                account_id: o.actor.accountId,
                subject_id: subject,
              })),
              'library.progress_session': [owner, neighbour, distant].flatMap((o) =>
                [...subjects, subject].flatMap((subjectId) =>
                  ['active', 'completed', 'abandoned'].map((state) => ({
                    ...session,
                    route: routeOf(o.actor.accountId)!,
                    account_id: o.actor.accountId,
                    subject_id: subjectId,
                    session_id: newId(routeOf(o.actor.accountId)!),
                    state,
                    last_changed_at: '2000-01-01T00:00:00Z',
                    started_at: '2000-01-01T00:00:00Z',
                    completed_at: state === 'completed' ? '2000-01-01T00:00:00Z' : null,
                  })),
                ),
              ),
            };
          },
        },
        { from: previous, to: scale },
      );
    },
    async warmup(_database, scale) {
      // Seeding and the checker's settlement happen after this bearer is minted. Refresh the same account
      // outside the measured HTTP operations so its five-minute test credential and auth observation stay live.
      await f.refresh(owner);
      for (let i = 0; i < 6; i++) await operation();
      const measured = await captureWithFoldedCost(db, operation);
      const folded = measured.capture;
      const cost = costOf(folded);
      const catalogue = catalogStatementBound(folded);
      const labels = libraryRelation(cost, 'personal_label');
      const assignments = libraryRelation(cost, 'label_assignment');
      const entries = libraryRelation(cost, 'entry');
      const sessions = libraryRelation(cost, 'progress_session');
      const subjectPage = await capture(db, () =>
        json(owner.bearer, 'GET', `/v1/libraryLabelAssignments?subjectId=${subjects[0]}&view=FULL&limit=100`, 200),
      );
      const subjectPagePlans = subjectPage.capture.plans.flatMap(nodes);
      const reservationPlans = subjectPagePlans.filter(
        (node) => node['Index Name'] === 'label_assignment_reserved_source',
      );
      const invalidOffsets = folded.statements.flatMap((statement, index) =>
        executableSqlOffsets(statement)
          .filter(({ bareZero }) => !bareZero)
          .map(({ operand }) => ({ index, operand, statement: statement.slice(0, 1200) })),
      );
      try {
        expect(catalogue.catalogStatements).toBeLessThanOrEqual(catalogue.allowedStatements);
        expect(labels?.nodes).toBe(34); // 32 existing subject observations + one parent for each label page.
        expect(labels?.sequentialScans).toBe(0);
        expect(assignments?.sequentialScans).toBe(0);
        expect(entries?.sequentialScans).toBe(0);
        expect(sessions?.sequentialScans).toBe(0);
        expect(reservationPlans.length).toBeGreaterThan(0);
        for (const node of reservationPlans) {
          const examined =
            (Number(node['Actual Rows']) +
              Number(node['Rows Removed by Filter'] ?? 0) +
              Number(node['Rows Removed by Index Recheck'] ?? 0)) *
            Number(node['Actual Loops']);
          expect(examined).toBeLessThanOrEqual(32);
        }
        expect(folded.statements.some((s) => /\bLIKE\b/i.test(s))).toBe(false);
        expect(invalidOffsets).toEqual([]);
      } catch (error) {
        // Keep failed producers attributable without replaying a page whose complete native
        // access-plan notices can exceed the shared 32 MiB raw telemetry cap.
        const assignmentOccurrences = folded.foregroundOccurrences.filter((occurrence) =>
          occurrence.relationIdentities.some(
            (identity) => identity.schema === 'library' && identity.name === 'label_assignment',
          ),
        );
        const entryOccurrences = folded.foregroundOccurrences.filter((occurrence) =>
          occurrence.relationIdentities.some((identity) => identity.schema === 'library' && identity.name === 'entry'),
        );
        throw new Error(
          `FULL label growth failed at scale ${scale}: ${JSON.stringify({
            assertion: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
            reservationPlans: reservationPlans.map((node) => ({
              node: node['Node Type'],
              actualRows: node['Actual Rows'],
              loops: node['Actual Loops'],
              indexCondition: node['Index Cond'],
            })),
            invalidOffsets,
            assignmentOccurrences,
            assignmentStatements: [...new Set(assignmentOccurrences.map(({ index }) => folded.statements[index]))],
            entryOccurrences,
            entryStatements: [...new Set(entryOccurrences.map(({ index }) => folded.statements[index]))],
          })}`,
          { cause: error },
        );
      }
      evidence.push({ scale, capture: folded, cost });
    },
    operation,
  });
  console.info(JSON.stringify({ report, evidence }));
}, 1800000);
