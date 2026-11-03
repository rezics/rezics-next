import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type {
  ProgressFailure,
  ProgressRecorded,
  ProgressRecordInput,
  ProgressSessionView,
} from '../src/library/progress-reads';
import {
  collectEdits,
  draftsFrom,
  projectIndependentMeasures,
  sessionHasIndependentMeasures,
} from '../src/library/independent-measures/contract';
import { editMeasure, readyVisit, stageIndependentReview } from '../src/library/independent-measures/controller';
import { loadIndependentMeasureVisit } from '../src/library/independent-measures/load';
import {
  INDEPENDENT_VISIT_READ_CALLS,
  observeIndependentWork,
  workWithinBound,
} from '../src/library/independent-measures/cost';
import { submitIndependentEdits, type MeasureSender } from '../src/library/independent-measures/commands';
import { independentActionClass } from '../src/library/independent-measures/recovery';
import { newCsrfToken } from '../src/session/csrf';

mock.module('../src/session/request', () => ({
  prepareSession: async () => {},
  viewerCredential: () => 'Bearer progress-owner',
}));

const sessionId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const stamp = '2026-04-02T15:04:05.000Z';
const chapter = {
  unit: 'chapter',
  amount: '10.5' as string | null,
  total: '24',
  primary: true,
  label: 'chapters',
  meaning: 'known' as const,
  recording: 'supported' as const,
  inputRules: { min: '0', max: '24', step: '0.5', total: 'optional' as const },
  kind: 'recorded' as const,
};
const volume = {
  unit: 'volume',
  amount: null as string | null,
  total: '12',
  primary: false,
  label: 'volumes',
  meaning: 'known' as const,
  recording: 'supported' as const,
  inputRules: { min: '0', max: '12', step: '1', total: 'optional' as const },
  kind: 'absent' as const,
};

function sessionView(overrides: Partial<ProgressSessionView> = {}): ProgressSessionView {
  return {
    id: sessionId,
    subjectId,
    versionSubjectId: null,
    mode: 'scalar_amount',
    unit: 'chapter',
    total: '24',
    amount: '10.5',
    locator: null,
    position: null,
    completedUnitCount: 0,
    state: 'active',
    revision: 3,
    startedAt: stamp,
    completedAt: null,
    subject: null,
    versionSubject: null,
    meaning: 'known',
    recordingState: 'supported',
    unitLabel: 'chapters',
    measures: [
      {
        unit: 'chapter',
        amount: '10.5',
        total: '24',
        primary: true,
        meaning: 'known',
        recordingState: 'supported',
        unitLabel: 'chapters',
      },
      {
        unit: 'volume',
        amount: null,
        total: '12',
        primary: false,
        meaning: 'known',
        recordingState: 'supported',
        unitLabel: 'volumes',
      },
    ],
    changes: [],
    changesNext: null,
    units: [],
    unitsNext: null,
    ...overrides,
  };
}

test('chapter and volume stay independent: zero, absent and a one-sided edit', () => {
  const measures = projectIndependentMeasures(sessionView());
  expect(sessionHasIndependentMeasures(sessionView())).toBe(true);
  expect(measures.map((measure) => [measure.unit, measure.kind, measure.amount])).toEqual([
    ['chapter', 'recorded', '10.5'],
    ['volume', 'absent', null],
  ]);
  const zero = projectIndependentMeasures(
    sessionView({
      amount: '0',
      measures: [
        { unit: 'chapter', amount: '0', total: '24', primary: true, meaning: 'known', recordingState: 'supported' },
        { unit: 'volume', amount: null, total: '12', primary: false, meaning: 'known', recordingState: 'supported' },
      ],
    }),
  );
  expect(zero[0]?.kind).toBe('zero');
  expect(zero[1]?.kind).toBe('absent');
  let visit = readyVisit(sessionId, 3, [chapter, volume], draftsFrom([chapter, volume]));
  visit = editMeasure(visit, 'volume', { text: '3.5' });
  expect(collectEdits(visit.measures, visit.drafts)).toEqual([{ unit: 'volume', kind: 'amount', amount: '3.5' }]);
  expect(visit.drafts.find((draft) => draft.unit === 'chapter')?.text).toBe('10.5');
  visit = editMeasure(visit, 'volume', { clear: true });
  expect(collectEdits(visit.measures, visit.drafts)).toEqual([]);
  visit = stageIndependentReview(
    editMeasure(readyVisit(sessionId, 3, [{ ...volume, amount: '2', kind: 'recorded' }]), 'volume', { clear: true }),
  );
  expect(visit.edits).toEqual([{ unit: 'volume', kind: 'clear' }]);
});

test('a dual save sequences native records on the shared returned revision and stops as partial', async () => {
  const calls: ProgressRecordInput[] = [];
  const sender: MeasureSender = async ({ data }) => {
    calls.push(data);
    if (data.measureId === 'volume') return { ok: false, reason: 'conflict' } satisfies ProgressFailure;
    return {
      ok: true,
      session: {
        id: sessionId,
        revision: data.revision + 1,
        amount: data.amount ?? '10.5',
        locator: null,
        position: null,
        completedUnitCount: 0,
        state: 'active',
        completedAt: null,
        total: '24',
        measures: [
          { unit: 'chapter', amount: data.amount ?? '11', total: '24' },
          { unit: 'volume', amount: null, total: '12' },
        ],
      },
    } satisfies ProgressRecorded;
  };
  const result = await submitIndependentEdits(
    sessionId,
    3,
    [
      { unit: 'chapter', kind: 'amount', amount: '11' },
      { unit: 'volume', kind: 'amount', amount: '4' },
    ],
    { 'X-CSRF-Token': newCsrfToken() },
    () => true,
    sender,
    ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
  );
  expect(calls).toEqual([
    {
      sessionId,
      revision: 3,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      measureId: 'chapter',
      amount: '11',
    },
    {
      sessionId,
      revision: 4,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      measureId: 'volume',
      amount: '4',
    },
  ]);
  expect(result.outcome.state).toBe('partial');
  if (result.outcome.state !== 'partial') throw new Error('expected partial');
  expect(result.outcome.revision).toBe(4);
  expect(result.outcome.remaining).toEqual([{ unit: 'volume', kind: 'amount', amount: '4' }]);
  expect(result.outcome.failed.key).toBe('22222222-2222-4222-8222-222222222222');
  expect(result.outcome.failed.operands.measureId).toBe('volume');
  expect(result.commands[1]?.operands).toBe(result.outcome.failed.operands);
});

test('uncertain retry keeps sender, credentials, key and operands', async () => {
  const credential = { 'X-CSRF-Token': 'csrf-original' };
  const sender: MeasureSender = async () => {
    throw new Error('transport');
  };
  const result = await submitIndependentEdits(
    sessionId,
    3,
    [{ unit: 'chapter', kind: 'amount', amount: '12' }],
    credential,
    () => true,
    sender,
    ['33333333-3333-4333-8333-333333333333'],
  );
  expect(result.outcome.state).toBe('uncertain');
  if (result.outcome.state !== 'uncertain') throw new Error('expected uncertain');
  expect(result.outcome.command.credential).toBe(credential);
  expect(result.outcome.command.key).toBe('33333333-3333-4333-8333-333333333333');
  expect(result.outcome.command.operands).toEqual({
    sessionId,
    revision: 3,
    idempotencyKey: '33333333-3333-4333-8333-333333333333',
    measureId: 'chapter',
    amount: '12',
  });
  expect(result.outcome.command.sender).toBe('recordProgressSession');
});

test('independent measure reads stay F-bounded across owner histories of 20, 200 and 2,000 sessions', async () => {
  for (const history of [20, 200, 2000]) {
    const calls: string[] = [];
    const client = observeIndependentWork(
      createKernelClient('https://kernel.example.test', {
        fetch: (async (input) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          expect(url.pathname.includes('progressSessions')).toBe(true);
          expect(url.pathname.endsWith(sessionId) || url.pathname.includes(`${sessionId}`)).toBe(true);
          expect(url.pathname.includes('/v1/progressSessions?')).toBe(false);
          expect(url.searchParams.get('presentation')).toBe('FULL');
          return Response.json({
            progressSession: {
              id: sessionId,
              subjectId,
              versionSubjectId: null,
              mode: 'scalar_amount',
              unit: 'chapter',
              total: '24',
              amount: '10.5',
              locator: null,
              position: null,
              completedUnitCount: 0,
              state: 'active',
              revision: 3,
              startedAt: stamp,
              completedAt: null,
              measures: [
                {
                  unit: 'chapter',
                  amount: '10.5',
                  total: '24',
                  presentation: {
                    meaning: 'known',
                    unitLabel: 'chapters',
                    structure: 'unverified',
                    recording: { state: 'supported', inputRules: { step: '0.5', total: 'optional' } },
                  },
                },
                {
                  unit: 'volume',
                  amount: null,
                  total: '12',
                  presentation: {
                    meaning: 'known',
                    unitLabel: 'volumes',
                    structure: 'unverified',
                    recording: { state: 'supported', inputRules: { step: '1', total: 'optional' } },
                  },
                },
              ],
            },
          });
        }) as typeof fetch,
      }),
      (name) => calls.push(name),
    );
    const loaded = await loadIndependentMeasureVisit(
      client,
      new Request('https://web.test/en/library/progress/' + sessionId),
      {},
      sessionId,
    );
    expect(loaded.state).toBe('ready');
    if (loaded.state !== 'ready') throw new Error('expected ready');
    expect(loaded.measures).toHaveLength(2);
    expect(loaded.work.nativeCallCount).toBe(INDEPENDENT_VISIT_READ_CALLS);
    expect(loaded.work.valuesProcessed).toBe(2);
    expect(loaded.work.admittedFields).toBe(2);
    expect(workWithinBound(loaded.work, history)).toBe(true);
    expect(calls.every((name) => name.startsWith('progressSessions'))).toBe(true);
    expect(calls.some((name) => name.includes('list'))).toBe(false);
  }
});

test('wrapping actions stay 44px and historical descriptors stay unlabeled guesses', () => {
  expect(independentActionClass).toContain('min-h-11');
  expect(independentActionClass).toContain('[overflow-wrap:anywhere]');
  const historical = projectIndependentMeasures(
    sessionView({
      measures: [
        { unit: 'chapter', amount: '10.5', total: '24', primary: true, meaning: 'unknown' },
        {
          unit: 'volume',
          amount: '1',
          total: '12',
          primary: false,
          meaning: 'unavailable',
          recordingState: 'unavailable',
        },
      ],
    }),
  );
  expect(historical[0]?.recording).toBe('historical');
  expect(historical[0]?.label).toBe('chapter');
  expect(historical[1]?.recording).toBe('historical');
});
