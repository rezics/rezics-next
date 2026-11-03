import { expect, test } from 'bun:test';
import {
  aniListDateSource,
  applyImportConsumptionDateRows,
  executeImportConsumptionDateIntent,
  reviewImportConsumptionDates,
  vndbDateSource,
  type ImportConsumptionDateIntent,
  type ImportConsumptionDateReview,
} from '../../src/library/import-consumption.ts';

const journal = {
  sessionId: 'session',
  revision: 3,
  startDate: { year: 2020 },
  finishDate: null,
  reflection: null,
};
const review = (start: ReturnType<typeof aniListDateSource>, finish = aniListDateSource({}, 'completedAt')) =>
  reviewImportConsumptionDates({
    version: 'date-review',
    sourceReviewToken: 'provider-review',
    sourceFingerprint: 'source-fingerprint',
    matchFingerprint: 'match-fingerprint',
    subjectId: 'subject',
    profileDigest: 'profile-digest',
    profileBinding: { epoch: '1' },
    occurrenceProfileBinding: { releaseDigest: 'profile@1' },
    occurrence: {
      sessionId: 'session',
      subjectId: 'subject',
      versionSubjectId: null,
      startedAt: '2024-01-02T03:04:05.000Z',
      transactionId: 'creation-transaction',
    },
    journal,
    start,
    finish,
    actions: { startDate: 'adopt' },
    profileCurrent: true,
  });

test('AniList keeps fuzzy absence, unknown precision, leap dates, invalid gaps and unsupported years distinct', () => {
  expect(aniListDateSource({}, 'startedAt').state).toBe('missing');
  expect(aniListDateSource({ startedAt: null }, 'startedAt').state).toBe('unknown');
  expect(aniListDateSource({ startedAt: { year: 2024, month: null, day: null } }, 'startedAt')).toMatchObject({
    state: 'value',
    precision: 'year',
    date: { year: 2024 },
  });
  expect(aniListDateSource({ startedAt: { year: 2024, month: 2, day: null } }, 'startedAt').precision).toBe('month');
  expect(aniListDateSource({ completedAt: { year: 2024, month: 2, day: 29 } }, 'completedAt').date).toEqual({
    year: 2024,
    month: 2,
    day: 29,
  });
  expect(aniListDateSource({ startedAt: { year: 2023, month: 2, day: 29 } }, 'startedAt').state).toBe('invalid');
  expect(aniListDateSource({ startedAt: { year: 2024, day: 4 } }, 'startedAt').state).toBe('invalid');
  expect(aniListDateSource({ startedAt: { year: 10_000 } }, 'startedAt').state).toBe('unsupported');
  expect(aniListDateSource({ startedAt: { year: 1e20 } }, 'startedAt').state).toBe('unsupported');
  expect(aniListDateSource({ createdAt: 1, updatedAt: 2 }, 'startedAt').state).toBe('missing');
});

test('VNDB trailing unknown components preserve year and month while invalid and source times stay excluded', () => {
  expect(vndbDateSource({ kind: 'value', raw: '2024-00-00' })).toMatchObject({
    state: 'value',
    precision: 'year',
    date: { year: 2024 },
  });
  expect(vndbDateSource({ kind: 'value', raw: '2024-02-00' })).toMatchObject({
    state: 'value',
    precision: 'month',
    date: { year: 2024, month: 2 },
  });
  expect(vndbDateSource({ kind: 'value', raw: '2024-00-02' }).state).toBe('invalid');
  expect(vndbDateSource({ kind: 'value', raw: '2024-00-12' }).state).toBe('invalid');
  expect(vndbDateSource({ kind: 'value', raw: '2023-02-29' }).state).toBe('invalid');
  expect(vndbDateSource({ kind: 'invalid', raw: '10000-01-01' }).state).toBe('unsupported');
  expect(vndbDateSource({ kind: 'unknown', raw: 'unknown' }).state).toBe('unknown');
  expect(vndbDateSource(undefined).state).toBe('missing');
  expect(vndbDateSource({ kind: 'value', raw: '2024-04-09T10:00:00Z' }).state).toBe('invalid');
});

test('review requires independent adoption or clear consent and keeps unknown dates unchanged', () => {
  const source = aniListDateSource({ startedAt: null }, 'startedAt');
  const reviewed = reviewImportConsumptionDates({
    version: 'version',
    sourceReviewToken: 'provider',
    sourceFingerprint: 'source',
    matchFingerprint: 'match',
    subjectId: 'subject',
    profileDigest: 'profile',
    profileBinding: null,
    occurrenceProfileBinding: null,
    occurrence: {
      sessionId: 'session',
      subjectId: 'subject',
      versionSubjectId: null,
      startedAt: '2024-01-02T03:04:05Z',
      transactionId: 'created-once',
    },
    journal: { ...journal, finishDate: { year: 2000 } },
    start: source,
    finish: aniListDateSource({}, 'completedAt'),
    actions: { startDate: 'adopt', finishDate: 'clear' },
    profileCurrent: true,
  });
  expect(reviewed.fields.startDate).toMatchObject({ sourceState: 'unknown', status: 'unknown' });
  expect(reviewed.fields.finishDate).toMatchObject({
    sourceState: 'missing',
    current: { year: 2000 },
    status: 'clear',
  });
  const omitted = reviewImportConsumptionDates({
    ...reviewed,
    version: 'omitted',
    journal,
    start: source,
    finish: source,
    actions: {},
    profileCurrent: true,
  });
  expect(omitted.fields.startDate.status).toBe('not-selected');
  expect(omitted.fields.finishDate.status).toBe('not-selected');
});

test('lost acknowledgement replays the stored patch, key and attribution without rereading the journal', async () => {
  const reviewed = review(
    aniListDateSource({ startedAt: { year: 2024, month: 2 } }, 'startedAt'),
  ) as ImportConsumptionDateReview;
  let stored: ImportConsumptionDateIntent | undefined;
  let receipt: { value: { sessionId: string; revision: number; changed: boolean } } | undefined;
  let loseFirstReply = true;
  const writes: { patch: unknown; key: string; admission: unknown }[] = [];
  const call = (existing?: ImportConsumptionDateIntent, isCurrent = true) =>
    executeImportConsumptionDateIntent({
      review: reviewed,
      fields: ['startDate'],
      ...(existing ? { existing } : {}),
      nativeRequestKey: 'original-native-key',
      admissionIdentity: { clientId: 'original-client', source: 'source-fingerprint' },
      admission: { identity: { clientId: 'original-client' }, assert: async () => undefined },
      isCurrent: async () => isCurrent,
      persist: async (intent) => {
        stored = structuredClone(intent);
        return true;
      },
      patch: async (_sessionId, patch, key, admission) => {
        writes.push({ patch: structuredClone(patch), key, admission: admission.identity });
        receipt ??= { value: { sessionId: 'session', revision: 4, changed: true } };
        if (loseFirstReply) {
          loseFirstReply = false;
          throw new Error('acknowledgement lost');
        }
        return receipt;
      },
      isStaleError: (error) => error instanceof Error && error.message === 'stale',
    });
  const first = await call();
  expect(first.outcome?.status).toBe('failed');
  const replay = await call(stored);
  expect(replay.outcome).toMatchObject({ status: 'applied', receipt: { revision: 4, changed: true } });
  expect(writes[0]).toEqual(writes[1]);
  expect(writes[0]!.patch).toEqual({ revision: 3, startDate: { year: 2024, month: 2 } });
});

test('stale journal binding refuses new writes and later cancellation keeps earlier acknowledged rows', async () => {
  const reviewed = review(aniListDateSource({ startedAt: { year: 2024 } }, 'startedAt'));
  let writes = 0;
  const stale = await executeImportConsumptionDateIntent({
    review: reviewed,
    fields: ['startDate'],
    nativeRequestKey: 'unused',
    admissionIdentity: {},
    admission: { identity: {}, assert: async () => undefined },
    isCurrent: async () => false,
    persist: async () => true,
    patch: async () => {
      writes++;
      return { value: { sessionId: 'session', revision: 4, changed: true } };
    },
    isStaleError: () => false,
  });
  expect(stale.outcome?.status).toBe('stale');
  expect(stale.outcome?.fields).toMatchObject([{ field: 'startDate', status: 'stale' }]);
  expect(writes).toBe(0);

  const controller = new AbortController();
  const rows = await applyImportConsumptionDateRows(
    [1, 2],
    controller.signal,
    async (row) => {
      if (row === 1) controller.abort();
      return {
        version: String(row),
        status: 'applied',
        fields: [{ field: 'startDate', status: 'applied' }],
        receipt: null,
      };
    },
    (row) => ({
      version: String(row),
      status: 'unattempted',
      fields: [{ field: 'startDate', status: 'unattempted' }],
      receipt: null,
    }),
  );
  expect(rows).toMatchObject({ complete: false, outcomes: [{ status: 'applied' }, { status: 'unattempted' }] });
});
