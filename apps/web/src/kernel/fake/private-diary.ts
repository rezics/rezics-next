import type { DiaryOccurrence, DiaryPage } from '@rezics/client';
import type { ProgressSessionJournal, ProgressSessionJournalPatch } from '@rezics/progress';
import type { NativeProgressSession } from '../../library/progress-reads';
import type { ConsumptionSummary, ReportedYearSummary } from '../../library/private-diary/native';
import type { KernelRecording } from '../fake';
import type { FakeRoute } from '../fake-modules';

/** Opt-in constructed native shapes for manual actual-route review; no native acceptance claim. */
export type PrivateDiaryScenario =
  | 'reading'
  | 'first-use'
  | 'long-note'
  | 'subject-unavailable'
  | 'sparse'
  | 'failed-save'
  | 'conflict'
  | 'unavailable';
export const diarySessionId = '0192f3a0-6c1e-7b2a-9d4e-000000002001';
const secondId = '0192f3a0-6c1e-7b2a-9d4e-000000002002';
const thirdId = '0192f3a0-6c1e-7b2a-9d4e-000000002003';
const olderId = '0192f3a0-6c1e-7b2a-9d4e-000000002004';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000002101';
const versionId = '0192f3a0-6c1e-7b2a-9d4e-000000002102';
export const diarySparseCursor = 'private-history/sparse+window==';
export const diaryOlderCursor = 'private-history/older+window==';
export const diaryOriginalReflection = '雨の夜に読み終えた。\nThe quiet ending stayed with me longer than I expected.';
export const diaryLongReflection = [
  diaryOriginalReflection,
  '第一章を読み返すと、風景の描写が登場人物の気持ちと重なって見える。'.repeat(8),
  '讀到這裡才明白，原來那些看似平凡的對話，都留下了日後重讀的線索。'.repeat(8),
  'The final scene changes how I remember the first chapter. '.repeat(14),
  '마지막 장면을 떠올리며 첫 장을 다시 읽고 싶다. '.repeat(8),
  'تظل التفاصيل الصغيرة حاضرة بعد انتهاء القراءة.',
  '<em>This stays literal private text.</em>',
].join('\n\n');

const baseSession: NativeProgressSession = {
  id: diarySessionId,
  subjectId,
  versionSubjectId: versionId,
  mode: 'scalar_amount',
  unit: 'chapter',
  amount: '18',
  total: '24',
  locator: null,
  position: null,
  completedUnitCount: 0,
  state: 'completed',
  revision: 7,
  startedAt: '2026-11-13T18:30:00.000Z',
  completedAt: '2026-11-14T01:12:00.000Z',
  subject: { id: subjectId, type: 'schema:Book', label: '夜の図書館 — Notes from a quiet city' },
  versionSubject: { id: versionId, type: 'schema:Book', label: '文庫版 · 2024' },
  presentation: {
    meaning: 'known', unitLabel: 'chapters', unitLabelLanguage: 'en', structure: 'unverified',
    recording: { state: 'supported', inputRules: { min: '0', step: '1', total: 'optional' } },
  },
};

function initialJournal(id: string, scenario: PrivateDiaryScenario): ProgressSessionJournal {
  return {
    sessionId: id,
    revision: 3,
    startDate: { year: 2026, month: 11 },
    finishDate: { year: 2026, month: 11, day: 14 },
    reflection: scenario === 'first-use' ? null : scenario === 'long-note' ? diaryLongReflection : diaryOriginalReflection,
    assessment: { meaningRevision: 1, units: 17 },
  };
}

function occurrences(): DiaryOccurrence[] {
  return [
    {
      id: diarySessionId, subjectId, versionSubjectId: versionId, state: 'completed', revision: 7,
      recordedStartedAt: baseSession.startedAt, recordedCompletedAt: baseSession.completedAt,
      subject: { id: subjectId, label: '夜の図書館 — Notes from a quiet city', language: 'ja' },
      versionSubject: { id: versionId, label: '文庫版 · 2024', language: 'ja' },
      reportedDates: { availability: 'available', revision: 3, startDate: { year: 2026, month: 11 }, finishDate: { year: 2026, month: 11, day: 14 } },
      assessment: { meaningRevision: 1, units: 17 },
    },
    {
      id: secondId, subjectId, versionSubjectId: null, state: 'active', revision: 2,
      recordedStartedAt: '2026-11-13T08:20:00.000Z', recordedCompletedAt: null,
      subject: { id: subjectId, label: 'The listening room — a second visit', language: 'en' }, versionSubject: null,
      reportedDates: { availability: 'available', revision: 1, startDate: { year: 2026 }, finishDate: null },
      assessment: { meaningRevision: 1, units: null },
    },
    {
      id: thirdId, subjectId, versionSubjectId: null, state: 'abandoned', revision: 5,
      recordedStartedAt: '2026-11-02T09:00:00.000Z', recordedCompletedAt: null,
      subject: null, versionSubject: null, reportedDates: { availability: 'unavailable' },
    },
    {
      id: olderId, subjectId, versionSubjectId: null, state: 'completed', revision: 4,
      recordedStartedAt: '2026-10-21T20:10:00.000Z', recordedCompletedAt: '2026-10-30T21:00:00.000Z',
      subject: { id: subjectId, label: '再読：秋の余白', language: 'ja' }, versionSubject: null,
      reportedDates: { availability: 'available', revision: 2, startDate: null, finishDate: { year: 2026 } },
      assessment: { meaningRevision: 1, units: 0 },
    },
  ];
}

type State = {
  scenario: PrivateDiaryScenario;
  journals: Map<string, ProgressSessionJournal>;
  reads: number;
  patches: { key: string; body: string }[];
  replays: Map<string, { body: string; response: KernelRecording }>;
  failed: boolean;
  conflicted: boolean;
};
let state: State | undefined;
export function setPrivateDiaryScenario(scenario?: PrivateDiaryScenario) {
  state = scenario === undefined ? undefined : {
    scenario, journals: new Map(), reads: 0, patches: [], replays: new Map(), failed: false, conflicted: false,
  };
}
export function privateDiaryStoryActivity() {
  return { reads: state?.reads ?? 0, patches: state?.patches.slice() ?? [] };
}
function journal(current: State, id: string) {
  let value = current.journals.get(id);
  if (!value) {
    value = initialJournal(id, current.scenario);
    current.journals.set(id, value);
  }
  return value;
}
function rowFor(id: string) { return occurrences().find((row) => row.id === id); }
function sessionFor(id: string, scenario: PrivateDiaryScenario): NativeProgressSession {
  const row = rowFor(id)!;
  const unavailable = scenario === 'subject-unavailable' || row.subject === null;
  return {
    ...baseSession, id, state: row.state, revision: row.revision, startedAt: row.recordedStartedAt,
    completedAt: row.recordedCompletedAt, versionSubjectId: row.versionSubjectId,
    subject: unavailable ? null : { id: subjectId, type: 'schema:Book', label: row.subject!.label! },
    versionSubject: row.versionSubject ? baseSession.versionSubject : null,
    ...(id === thirdId ? {
      unit: 'historic-leaf-x', amount: '12.250001', total: null,
      presentation: { meaning: 'unknown', structure: 'unverified', recording: { state: 'unavailable' } },
    } as const : {}),
  };
}
const summary: ConsumptionSummary = {
  scope: 'retained_native_sessions', completedOccurrences: '2', distinctCompletedSubjects: '1', repeatOccurrences: '1',
  completedOccurrencesWithUnknownProfile: '0',
  coverage: { nativeSessions: 'complete', otherHistory: 'unavailable', unitMeaning: 'not_evaluated' },
  currentness: { state: 'snapshot', revision: 'diary-constructed-1' },
};
const counts = (count = '0') => ({
  completedOccurrences: count, distinctCompletedSubjects: count, repeatOccurrences: '0',
  completedOccurrencesWithUnknownProfile: '0', finishPrecision: { year: '0', month: '0', day: count },
});
function yearSummary(year: number): ReportedYearSummary {
  const selected = year === 2026 && state?.scenario !== 'first-use';
  return {
    ...counts(selected ? '2' : '0'), distinctCompletedSubjects: selected ? '1' : '0', repeatOccurrences: selected ? '1' : '0',
    finishPrecision: { year: selected ? '1' : '0', month: '0', day: selected ? '1' : '0' },
    scope: 'retained_native_sessions', year, calendar: 'gregorian', dateSource: 'explicitly_reported_journal_finish',
    months: Array.from({ length: 12 }, (_, i) => ({ ...counts(selected && i === 10 ? '1' : '0'), month: i + 1 })),
    monthUnallocated: { ...counts(selected ? '1' : '0'), finishPrecision: { year: selected ? '1' : '0', month: '0', day: '0' } },
    coverage: {
      nativeSessions: 'complete', initializedSessions: '4', retainedSessions: '4',
      completedOccurrencesWithMissingFinish: '0', completedOccurrencesWithUnsupportedFinish: '0',
      otherHistory: 'unavailable', unitMeaning: 'not_evaluated',
    },
    currentness: summary.currentness,
  };
}
const headers = { 'cache-control': 'private, no-store' };
export const routes: FakeRoute[] = [
  {
    method: 'GET', path: '/v1/libraryDiary',
    story: ({ request }) => {
      if (!state) return;
      state.reads++;
      if (state.scenario === 'unavailable' && state.reads === 1) return { status: 503, code: 'dependency_unavailable', headers };
      const query = new URL(request.url).searchParams;
      const cursor = query.get('cursor');
      let rows = state.scenario === 'first-use' ? [] : occurrences();
      if (query.has('year')) rows = rows.filter((row) => row.reportedDates.availability === 'available' && row.reportedDates.finishDate?.year === Number(query.get('year')));
      if (query.has('month')) rows = rows.filter((row) => row.reportedDates.availability === 'available' && (query.get('month') === 'unallocated' ? row.reportedDates.finishDate?.month === undefined : row.reportedDates.finishDate?.month === Number(query.get('month'))));
      const sparse = state.scenario === 'sparse' && !cursor;
      const page: DiaryPage = {
        occurrences: sparse ? [] : cursor === diaryOlderCursor ? rows.slice(3) : rows.slice(0, 3),
        order: 'recorded_started_desc_id_desc', currentness: summary.currentness,
        next: sparse ? diarySparseCursor : !cursor && rows.length > 3 ? diaryOlderCursor : cursor === diarySparseCursor ? diaryOlderCursor : null,
        continuation: 'diary-constructed-continuation', expiresAt: '2099-01-01T00:00:00.000Z',
      };
      return { status: 200, ...page, headers };
    },
  },
  { method: 'POST', path: '/v1/libraryDiary:cancel', story: () => state ? { status: 200, cancelled: true, headers } : undefined },
  { method: 'GET', path: '/v1/libraryConsumptionSummary', story: () => state ? {
    status: 200, ...summary,
    ...(state.scenario === 'first-use' ? { completedOccurrences: '0', distinctCompletedSubjects: '0', repeatOccurrences: '0' } : {}), headers,
  } : undefined },
  { method: 'GET', path: '/v1/libraryReportedYearSummary', story: ({ request }) => state ? {
    status: 200, ...yearSummary(Number(new URL(request.url).searchParams.get('year'))), headers,
  } : undefined },
  {
    method: 'GET', path: /^\/v1\/progressSessions\/([^/]+)$/,
    story: ({ match }) => state && rowFor(match![1]!) ? { status: 200, progressSession: sessionFor(match![1]!, state.scenario), headers } : undefined,
  },
  {
    method: 'GET', path: /^\/v1\/progressSessions\/([^/]+)\/changes$/,
    story: ({ match }) => state && rowFor(match![1]!) ? {
      status: 200, changes: [
        { id: `${match![1]}:6`, revision: 6, createdAt: '2026-11-14T01:00:00.000Z', intent: { amount: '18' } },
        { id: `${match![1]}:5`, revision: 5, createdAt: '2026-11-13T23:00:00.000Z', intent: { amount: '12' } },
        { id: `${match![1]}:4`, revision: 4, createdAt: '2026-11-13T21:00:00.000Z', intent: { clear: true } },
      ], next: null, headers,
    } : undefined,
  },
  { method: 'GET', path: /^\/v1\/progressSessions\/([^/]+)\/completedUnits$/, story: ({ match }) => state && rowFor(match![1]!) ? { status: 200, completedUnits: [], next: null, headers } : undefined },
  {
    method: 'GET', path: /^\/v1\/progressSessions\/([^/]+)\/journal$/,
    story: ({ match }) => state && rowFor(match![1]!) ? { status: 200, journal: structuredClone(journal(state, match![1]!)), headers } : undefined,
  },
  {
    method: 'PATCH', path: /^\/v1\/progressSessions\/([^/]+)\/journal$/,
    story: async ({ request, match }) => {
      const current = state;
      const id = match![1]!;
      if (!current || !rowFor(id)) return;
      const body = await request.text();
      const key = request.headers.get('idempotency-key')!;
      current.patches.push({ key, body });
      const replay = current.replays.get(key);
      if (replay) return replay.body === body ? structuredClone(replay.response) : { status: 409, code: 'idempotency_conflict', headers };
      const value = journal(current, id);
      if (current.scenario === 'conflict' && !current.conflicted) {
        current.conflicted = true;
        current.journals.set(id, { ...value, revision: value.revision + 1, reflection: 'A private correction from another device.', finishDate: { year: 2026 } });
        return { status: 409, code: 'conflict', headers };
      }
      const patch = JSON.parse(body) as ProgressSessionJournalPatch;
      if (patch.revision !== value.revision) return { status: 409, code: 'conflict', headers };
      const next: ProgressSessionJournal = { ...value, ...patch, revision: value.revision + 1, assessment: patch.assessment ?? value.assessment };
      if (patch.assessment === null) next.assessment = { meaningRevision: 1, units: null };
      current.journals.set(id, next);
      const response: KernelRecording = { status: 200, journal: structuredClone(next), headers };
      current.replays.set(key, { body, response });
      if (current.scenario === 'failed-save' && !current.failed) {
        current.failed = true;
        return { status: 503, code: 'dependency_unavailable', headers };
      }
      return response;
    },
  },
];
