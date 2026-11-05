import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
} from '../support/growth.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

type Row = Record<string, unknown>;
type Identity = Awaited<ReturnType<NativeProfileFixture['identity']>>;
type GrowthAxis = 'same-owner entries' | 'same-owner sessions' | 'same-owner follows' | 'other owners';

const scopes = [
  'subject:read',
  'library_entry:read',
  'library_entry:list',
  'library_entry:update',
  'progress_session:create',
  'progress_session:read',
  'progress_session:update',
  'follow:create',
];
const entryLimit = 2;
const unitLimit = 2;
const depthPages = 8;

let db: GrowthDatabase, f: NativeProfileFixture;
let owner: Identity, neighbor: Identity, distant: Identity;
let route: number, hotPartition: number;
let entrySubject: string, followSubject: string, progressSubject: string, inProgressSubject: string;
let deepCursor: string;
let growthSubjects: string[];
let entryTemplate: Row, sessionTemplate: Row, unitTemplate: Row, followTemplate: Row;
let sessionId: string;

async function request(method: string, path: string, body?: unknown) {
  return f.send(owner.bearer, method, path, body);
}

async function createSubjects(count: number): Promise<string[]> {
  const subjects: string[] = [];
  for (let index = 0; index < count; index++) subjects.push(await f.createSubject('game'));
  return subjects;
}

async function refreshDeepCursor() {
  let cursor: string | null = null;
  for (let page = 0; page <= depthPages; page++) {
    const query = new URLSearchParams({ limit: String(entryLimit), ...(cursor ? { cursor } : {}) });
    const response = await request('GET', `/v1/libraryEntries?${query}`);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { libraryEntries: unknown[]; next: string | null };
    expect(result.libraryEntries).toHaveLength(entryLimit);
    cursor = result.next;
    if (!cursor) throw new Error('The fixed Library entries must provide a deep cursor');
  }
  if (!cursor) throw new Error('The fixed Library entries must provide a deep cursor');
  deepCursor = cursor;
}

async function resetFollowWrites() {
  await db.admin.query('DELETE FROM library.follow WHERE route=$1 AND account_id=$2 AND target_id=ANY($3::uuid[])', [
    route,
    owner.actor.accountId,
    [followSubject, inProgressSubject],
  ]);
  await db.admin.query('DELETE FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
    route,
    owner.actor.accountId,
    inProgressSubject,
  ]);
}

function followRow(template: Row, identity: Identity, targetId: string): Row {
  const row = {
    ...template,
    route: routeOf(identity.actor.accountId)!,
    account_id: identity.actor.accountId,
    target_id: targetId,
  };
  if ('transaction_id' in row) row.transaction_id = randomUUID();
  return row;
}

async function growAxis(axis: GrowthAxis, database: GrowthDatabase, scale: number, previous: number) {
  let index = previous;
  await seed(
    database,
    {
      name: `Library page and follow history: ${axis}`,
      hotPartition,
      hotShare: 1,
      rows() {
        if (axis === 'same-owner entries') {
          const subjectId = growthSubjects[index++]!;
          return {
            'library.entry': [{ ...entryTemplate, route, account_id: owner.actor.accountId, subject_id: subjectId }],
          };
        }
        if (axis === 'same-owner sessions') {
          const id = newId(route);
          return {
            'library.progress_session': [
              { ...sessionTemplate, route, account_id: owner.actor.accountId, session_id: id },
            ],
            'library.progress_unit': [{ ...unitTemplate, route, session_id: id }],
          };
        }
        if (axis === 'same-owner follows') {
          const targetId = growthSubjects[index++]!;
          return { 'library.follow': [followRow(followTemplate, owner, targetId)] };
        }

        const identities = [neighbor, distant];
        const entries: Row[] = [];
        const sessions: Row[] = [];
        const units: Row[] = [];
        const follows: Row[] = [];
        const subjectId = growthSubjects[index]!;
        for (const identity of identities) {
          const ownerRoute = routeOf(identity.actor.accountId)!;
          const id = newId(ownerRoute);
          entries.push({
            ...entryTemplate,
            route: ownerRoute,
            account_id: identity.actor.accountId,
            subject_id: subjectId,
          });
          sessions.push({
            ...sessionTemplate,
            route: ownerRoute,
            account_id: identity.actor.accountId,
            session_id: id,
          });
          units.push({ ...unitTemplate, route: ownerRoute, session_id: id });
          follows.push(followRow(followTemplate, identity, subjectId));
        }
        index++;
        return {
          'library.entry': entries,
          'library.progress_session': sessions,
          'library.progress_unit': units,
          'library.follow': follows,
        };
      },
    },
    { from: previous, to: scale },
  );
}

async function measuredPagesAndFollows() {
  const entryPage = await request(
    'GET',
    `/v1/libraryEntries?limit=${entryLimit}&cursor=${encodeURIComponent(deepCursor)}`,
  );
  expect(entryPage.status).toBe(200);
  const entries = (await entryPage.json()) as { libraryEntries: unknown[]; next: string | null };
  expect(entries.libraryEntries).toHaveLength(entryLimit);
  expect(entries.next).not.toBeNull();

  const unitPage = await request('GET', `/v1/progressSessions/${sessionId}/completedUnits?limit=${unitLimit}`);
  expect(unitPage.status).toBe(200);
  const units = (await unitPage.json()) as { completedUnits: string[]; next: string | null };
  expect(units.completedUnits).toHaveLength(unitLimit);
  expect(units.next).not.toBeNull();

  const follow = await request('PUT', `/v1/follows/${followSubject}`);
  expect(follow.status).toBe(200);
  expect(await follow.json()).toMatchObject({ follow: { targetId: followSubject, targetType: 'subject' } });

  const inProgress = await request('PUT', `/v1/libraryEntries/${inProgressSubject}`, { state: 'in_progress' });
  expect([200, 201]).toContain(inProgress.status);
  expect(await inProgress.json()).toMatchObject({
    libraryEntry: { subjectId: inProgressSubject, state: 'in_progress' },
  });
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await createProfileEntryFixture({ pool: db.pool, projectLinks: false });
  owner = await f.identity(scopes);
  route = routeOf(owner.actor.accountId)!;
  hotPartition = partitionOf(route);
  neighbor = await f.identity(scopes, hotPartition);
  distant = await f.identity(scopes, (hotPartition + 1) % 4096);

  const exposure = await f.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open');
  expect(exposure.status).toBe(200);

  entrySubject = await f.createSubject('game');
  followSubject = await f.createSubject('game');
  progressSubject = await f.createSubject('game');
  inProgressSubject = await f.createSubject('game');

  const initialEntry = await request('PUT', `/v1/libraryEntries/${entrySubject}`, { state: 'planned' });
  expect([200, 201]).toContain(initialEntry.status);
  const entryRows = await db.admin.query<Row>(
    'SELECT * FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3',
    [route, owner.actor.accountId, entrySubject],
  );
  entryTemplate = entryRows.rows[0]!;

  const fixedPageSubjects = await createSubjects(24);
  await seed(
    db,
    {
      name: 'Deep Library page fixture',
      hotPartition,
      hotShare: 1,
      rows: () => ({
        'library.entry': fixedPageSubjects.map((subject_id) => ({
          ...entryTemplate,
          route,
          account_id: owner.actor.accountId,
          subject_id,
        })),
      }),
    },
    { from: 0, to: 1 },
  );
  growthSubjects = await createSubjects(64);

  const followResponse = await request('PUT', `/v1/follows/${followSubject}`);
  expect(followResponse.status).toBe(200);
  const followRows = await db.admin.query<Row>(
    'SELECT * FROM library.follow WHERE route=$1 AND account_id=$2 AND target_id=$3',
    [route, owner.actor.accountId, followSubject],
  );
  followTemplate = followRows.rows[0]!;

  const started = await request('POST', '/v1/progressSessions', {
    subjectId: progressSubject,
    mode: 'completed_units',
    unit: 'chapter',
  });
  expect(started.status).toBe(201);
  const startedBody = (await started.json()) as { progressSession: { id: string; revision: number } };
  sessionId = startedBody.progressSession.id;
  const unitIds = Array.from({ length: 8 }, (_, index) => `unit-${String(index).padStart(2, '0')}`);
  const recorded = await request('POST', `/v1/progressSessions/${sessionId}:record`, {
    revision: startedBody.progressSession.revision,
    add: unitIds,
  });
  expect(recorded.status).toBe(200);
  const sessionRows = await db.admin.query<Row>(
    'SELECT * FROM library.progress_session WHERE route=$1 AND session_id=$2',
    [route, sessionId],
  );
  sessionTemplate = sessionRows.rows[0]!;
  const unitRows = await db.admin.query<Row>(
    'SELECT * FROM library.progress_unit WHERE route=$1 AND session_id=$2 ORDER BY unit_id LIMIT 1',
    [route, sessionId],
  );
  unitTemplate = unitRows.rows[0]!;
}, 900_000);

afterAll(async () => {
  await f?.close();
  await db?.close();
});

test('Library pages and follows stay bounded across independently growing owner histories', async () => {
  for (const axis of ['same-owner entries', 'same-owner sessions', 'same-owner follows', 'other owners'] as const) {
    const report = await checkGrowth(db, {
      name: `tracked entries, progress units and Library follows with growing ${axis}`,
      scales: [1, 8, 64],
      bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
      includeBackends: true,
      repetitions: 1,
      async grow(database, scale, previous) {
        await growAxis(axis, database, scale, previous);
      },
      async warmup() {
        await resetFollowWrites();
        await refreshDeepCursor();
        await measuredPagesAndFollows();
      },
      async prepare() {
        await resetFollowWrites();
        await refreshDeepCursor();
      },
      operation: measuredPagesAndFollows,
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
    expect(report.verdicts.statements.outcome).toBe('compatible');
    expect(report.verdicts.rows.outcome).toBe('compatible');
    expect(report.verdicts.blocks.outcome).toBe('compatible');
    const relations = [
      ...new Set(
        report.samples.flatMap(({ repetitions }) => repetitions.flatMap(({ relations }) => Object.keys(relations))),
      ),
    ];
    assertGrowthAccessPaths(report.name, report.samples, relations);
  }
}, 1_800_000);
