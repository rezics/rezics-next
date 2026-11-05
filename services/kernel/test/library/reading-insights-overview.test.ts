import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { sessionScopes } from './support/session-profile-fixture.ts';

let native: NativeProfileFixture;

beforeAll(async () => {
  native = await createProfileEntryFixture({ projectLinks: false });
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
}, 120_000);

afterAll(async () => {
  await native?.close();
});

test('overview keeps native panels identified and returns Diary-owned navigation', async () => {
  const owner = await native.identity(sessionScopes);
  const path = '/v1/libraryReadingInsights?year=2020';
  const response = await native.send(owner.bearer, 'GET', path);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const value = await response.json();
  expect(value).toMatchObject({
    scope: 'private_reading_insights',
    year: 2020,
    panels: {
      allTime: { status: 'received', value: { completedOccurrences: '0' } },
      reportedYear: { status: 'received', value: { year: 2020, completedOccurrences: '0' } },
      profiles: { status: 'received', value: { state: 'available', year: 2020 } },
      currentProgress: {
        status: 'received',
        value: {
          state: 'available',
          scope: 'active_and_backlog_sessions',
          coverage: {
            initializedSessions: '0',
            retainedSessions: '0',
            currentSessions: '0',
            activeSessions: '0',
            backlogSessions: '0',
            coveredSessions: '0',
            unsupportedSessions: '0',
          },
          active: {
            sessionCount: '0',
            coveredSessions: '0',
            groups: [],
            remainder: {
              groupCount: '0',
              occurrences: '0',
              currentValueCount: '0',
              missingCurrentValueCount: '0',
              totalValueCount: '0',
              missingTotalValueCount: '0',
            },
          },
          backlog: {
            sessionCount: '0',
            coveredSessions: '0',
            groups: [],
            remainder: {
              groupCount: '0',
              occurrences: '0',
              currentValueCount: '0',
              missingCurrentValueCount: '0',
              totalValueCount: '0',
              missingTotalValueCount: '0',
            },
          },
          limit: 8,
        },
      },
      assessments: { status: 'received', value: { state: 'available' } },
    },
    actions: {
      diary: { operationId: 'library_diary.list', query: { year: 2020 } },
      unallocatedMonth: { query: { year: 2020, month: 'unallocated' } },
    },
  });
  expect(value.actions.months).toHaveLength(12);
  expect(value.actions.months[0]).toEqual({
    month: 1,
    operationId: 'library_diary.list',
    query: { year: 2020, month: 1 },
  });
});

test('an absent assessment installation leaves the other overview panels usable', async () => {
  const owner = await native.identity(sessionScopes);
  await native.pool.query(
    'ALTER TABLE library.reading_insights_assessment_installation RENAME TO reading_insights_assessment_installation_hold',
  );
  try {
    const response = await native.send(owner.bearer, 'GET', '/v1/libraryReadingInsights?year=2020');
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value.panels).toMatchObject({
      allTime: { status: 'received' },
      reportedYear: { status: 'received' },
      profiles: { status: 'received' },
      assessments: { status: 'received', value: { state: 'unavailable', reason: 'not_installed' } },
    });
  } finally {
    await native.pool.query(
      'ALTER TABLE library.reading_insights_assessment_installation_hold RENAME TO reading_insights_assessment_installation',
    );
  }
}, 120_000);
