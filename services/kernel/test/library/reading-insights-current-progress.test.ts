import { afterAll, beforeAll, expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture, libraryProfile, unitData } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { sessionScopes } from './support/session-profile-fixture.ts';

type Session = { id: string; revision: number };
type ValueRow = {
  scope: 'active' | 'backlog';
  mode: string;
  unit: string;
  locator: string | null;
  current_value: string | null;
  total_value: string | null;
};

let native: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let subjectId: string;

async function insightsRelease() {
  const profile = libraryProfile('fixture.reading-insights');
  profile.progress.allowed = [
    {
      mode: 'scalar_amount',
      units: [
        {
          ...unitData('page'),
          minimum: '0',
          maximum: '999999999999999999999999999.999999',
          precision: 6,
          totalPolicy: 'required',
        },
      ],
    },
    {
      mode: 'cursor_position',
      units: [
        { ...unitData('chapter', 'cursor_position'), maximum: '999999999999999999999999999.999999', precision: 6 },
      ],
    },
    { mode: 'completed_units', units: [unitData('episode', 'completed_units')] },
  ];
  return compileCatalogue(fixture(profile));
}

async function start(mode: string, unit: string, extra: Record<string, unknown> = {}): Promise<Session> {
  const response = await native.send(
    owner.bearer,
    'POST',
    '/v1/progressSessions',
    { subjectId, mode, unit, ...extra },
    entryKey(),
  );
  expect(response.status).toBe(201);
  return (await response.json()).progressSession as Session;
}

async function transition(session: Session, action: string, revision: number, key = entryKey(), body = {}) {
  const response = await native.send(
    owner.bearer,
    'POST',
    `/v1/progressSessions/${session.id}:${action}`,
    { revision, ...body },
    key,
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function values(): Promise<ValueRow[]> {
  return (
    await native.pool.query<ValueRow>(
      `SELECT scope,meaning->>'mode' AS mode,meaning->>'unit' AS unit,meaning->>'locator' AS locator,
        current_value::text,total_value::text FROM library.reading_insights_current_progress_value
       WHERE account_id=$1 ORDER BY mode,unit,scope,current_value NULLS FIRST`,
      [owner.actor.accountId],
    )
  ).rows;
}

beforeAll(async () => {
  native = await createProfileEntryFixture({ projectLinks: false });
  await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open');
  await native.activate(await native.publish(await insightsRelease()));
  owner = await native.identity(sessionScopes);
  subjectId = await native.createSubject('game');
}, 120_000);

afterAll(async () => {
  await native?.close();
});

test('native receiving keeps exact heterogeneous values, replay, backlog movement, restoration and retirement cleanup', async () => {
  const first = await start('scalar_amount', 'page', { total: '900719925474099312345.999999' });
  const firstKey = entryKey();
  const firstRecord = await native.send(
    owner.bearer,
    'POST',
    `/v1/progressSessions/${first.id}:record`,
    { revision: first.revision, amount: '900719925474099312345.123456' },
    firstKey,
  );
  expect(firstRecord.status).toBe(200);
  const firstReply = await firstRecord.json();
  expect(
    await native.send(
      owner.bearer,
      'POST',
      `/v1/progressSessions/${first.id}:record`,
      { revision: first.revision, amount: '900719925474099312345.123456' },
      firstKey,
    ),
  ).toMatchObject({ status: 200 });

  const second = await start('scalar_amount', 'page', { total: '2' });
  await transition(second, 'record', second.revision, entryKey(), { amount: '0.000001' });
  const cursor = await start('cursor_position', 'chapter');
  await transition(cursor, 'record', cursor.revision, entryKey(), {
    locator: 'chapter:three',
    position: '900719925474099312345.123456',
  });
  for (let index = 0; index < 8; index += 1) {
    const distinctCursor = await start('cursor_position', 'chapter');
    await transition(distinctCursor, 'record', distinctCursor.revision, entryKey(), {
      locator: `chapter:${index}`,
      position: `${index + 1}`,
    });
  }
  const units = await start('completed_units', 'episode');
  await transition(units, 'record', units.revision, entryKey(), { add: ['one', 'two'] });

  const received = await values();
  expect(received).toHaveLength(12);
  expect(received).toContainEqual({
    scope: 'active',
    mode: 'completed_units',
    unit: 'episode',
    locator: null,
    current_value: '2',
    total_value: null,
  });
  expect(received).toContainEqual({
    scope: 'active',
    mode: 'cursor_position',
    unit: 'chapter',
    locator: 'chapter:three',
    current_value: '900719925474099312345.123456',
    total_value: null,
  });
  expect(received).toContainEqual({
    scope: 'active',
    mode: 'scalar_amount',
    unit: 'page',
    locator: null,
    current_value: '0.000001',
    total_value: '2',
  });
  expect(received).toContainEqual({
    scope: 'active',
    mode: 'scalar_amount',
    unit: 'page',
    locator: null,
    current_value: '900719925474099312345.123456',
    total_value: '900719925474099312345.999999',
  });

  const accountRoute = routeOf(owner.actor.accountId)!;
  const aggregate = await native.pool.query<{ occurrences: string; current_sum: string; total_sum: string }>(
    `SELECT occurrences::text,current_sum::text,total_sum::text FROM library.reading_insights_current_progress_group
      WHERE route=$1 AND scope='active' AND meaning->>'mode'='scalar_amount' AND meaning->>'unit'='page'`,
    [accountRoute],
  );
  expect(aggregate.rows).toEqual([
    { occurrences: '2', current_sum: '900719925474099312345.123457', total_sum: '900719925474099312347.999999' },
  ]);
  const overview = await native.send(owner.bearer, 'GET', '/v1/libraryReadingInsights?year=2020');
  expect(overview.status).toBe(200);
  expect((await overview.json()).panels.currentProgress).toMatchObject({
    status: 'received',
    value: {
      state: 'available',
      coverage: {
        initializedSessions: '12',
        retainedSessions: '12',
        currentSessions: '12',
        activeSessions: '12',
        backlogSessions: '0',
        coveredSessions: '12',
        unsupportedSessions: '0',
      },
      active: {
        groups: expect.arrayContaining([
          expect.objectContaining({
            meaning: expect.objectContaining({ mode: 'scalar_amount', unit: 'page' }),
            occurrences: '2',
            currentValue: '900719925474099312345.123457',
            totalValue: '900719925474099312347.999999',
          }),
        ]),
        remainder: {
          groupCount: '3',
          occurrences: '3',
          currentValueCount: '3',
          missingCurrentValueCount: '0',
          totalValueCount: '0',
          missingTotalValueCount: '3',
        },
      },
    },
  });

  const abandoned = await transition(first, 'abandon', firstReply.progressSession.revision);
  expect(await values()).toContainEqual({
    scope: 'backlog',
    mode: 'scalar_amount',
    unit: 'page',
    locator: null,
    current_value: '900719925474099312345.123456',
    total_value: '900719925474099312345.999999',
  });
  const reopened = await transition(first, 'reopen', abandoned.progressSession.revision);
  expect(
    (await values()).filter(
      (row) => row.mode === 'scalar_amount' && row.current_value === '900719925474099312345.123456',
    ),
  ).toHaveLength(1);
  const retired = await transition(first, 'retire', reopened.progressSession.revision);
  expect((await values()).filter((row) => row.current_value === '900719925474099312345.123456')).toHaveLength(0);
  await native.pool.query(
    "UPDATE library.progress_session SET state='active',completed_at=NULL,revision=revision+1 WHERE route=$1 AND session_id=$2",
    [routeOf(owner.actor.accountId)!, first.id],
  );
  expect(await values()).toContainEqual({
    scope: 'active',
    mode: 'scalar_amount',
    unit: 'page',
    locator: null,
    current_value: '900719925474099312345.123456',
    total_value: '900719925474099312345.999999',
  });
  await native.pool.query('DELETE FROM library.progress_session WHERE route=$1 AND session_id=$2', [
    routeOf(owner.actor.accountId)!,
    first.id,
  ]);
  expect((await values()).some((row) => row.current_value === '900719925474099312345.123456')).toBe(false);
  expect(retired.progressSession.revision).toBe(reopened.progressSession.revision + 1);
  await native.pool.query('DELETE FROM library.progress_session WHERE route=$1 AND account_id=$2', [
    routeOf(owner.actor.accountId)!,
    owner.actor.accountId,
  ]);
  expect(
    await native.pool.query('SELECT 1 FROM library.reading_insights_current_progress_owner WHERE account_id=$1', [
      owner.actor.accountId,
    ]),
  ).toMatchObject({ rowCount: 0 });
});
