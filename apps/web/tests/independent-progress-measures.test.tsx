import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import { createKernelClient } from '@rezics/client';
import { supportedProgressState } from '../src/library/progress-reads';
import type {
  ProgressFailure,
  ProgressRecorded,
  ProgressRecordInput,
  ProgressSnapshot,
  ProgressSessionPage,
  ProgressSessionView,
} from '../src/library/progress-reads';
import {
  collectEdits,
  draftsFrom,
  projectIndependentMeasures,
  sessionHasIndependentMeasures,
} from '../src/library/independent-measures/contract';
import {
  acknowledgeIndependentRetry,
  editMeasure,
  readyVisit,
  refreshIndependentVisit,
  stageIndependentReview,
} from '../src/library/independent-measures/controller';
import { loadIndependentMeasureVisit } from '../src/library/independent-measures/load';
import {
  INDEPENDENT_VISIT_READ_CALLS,
  observeIndependentWork,
  workWithinBound,
} from '../src/library/independent-measures/cost';
import { retryOriginal, submitIndependentEdits, type MeasureSender } from '../src/library/independent-measures/commands';
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

test('refresh reconciles amount and clear intent by measure identity against the previous baseline', () => {
  const saved = [
    { ...chapter, amount: '10', kind: 'recorded' as const },
    { ...volume, amount: '2', kind: 'recorded' as const },
  ];
  const next = [
    { ...volume, amount: '3', kind: 'recorded' as const },
    { ...chapter, amount: '11', kind: 'recorded' as const },
  ];
  const pristine = refreshIndependentVisit(readyVisit(sessionId, 3, saved), 4, next);
  expect(pristine.drafts.map(({ unit, text }) => [unit, text])).toEqual([
    ['volume', '3'],
    ['chapter', '11'],
  ]);
  expect(pristine.edits).toEqual([]);
  expect(stageIndependentReview(pristine).kind).toBe('ready');

  const changed = editMeasure(readyVisit(sessionId, 3, saved), 'volume', { text: '7' });
  const merged = refreshIndependentVisit(changed, 4, next);
  expect(merged.drafts.map(({ unit, text }) => [unit, text])).toEqual([
    ['volume', '7'],
    ['chapter', '11'],
  ]);
  expect(merged.edits).toEqual([{ unit: 'volume', kind: 'amount', amount: '7' }]);

  const cleared = editMeasure(readyVisit(sessionId, 3, saved), 'chapter', { clear: true });
  const clearRefresh = refreshIndependentVisit(cleared, 4, next);
  expect(clearRefresh.drafts.find((draft) => draft.unit === 'chapter')?.clear).toBe(true);
  expect(clearRefresh.edits).toContainEqual({ unit: 'chapter', kind: 'clear' });
});

test('new, withdrawn and unsupported measures keep their own saved values without inherited writes', () => {
  const oldMeasures = [
    { ...chapter, amount: '10', kind: 'recorded' as const },
    { ...volume, amount: '2', kind: 'recorded' as const },
  ];
  const page = { ...volume, unit: 'page', label: 'pages', amount: '4', kind: 'recorded' as const };
  const edited = editMeasure(readyVisit(sessionId, 3, oldMeasures), 'volume', { text: '8' });
  const replaced = refreshIndependentVisit(
    edited,
    4,
    [{ ...chapter, amount: '11', kind: 'recorded' as const }, page],
  );
  expect(replaced.drafts.map(({ unit, text }) => [unit, text])).toEqual([
    ['chapter', '11'],
    ['page', '4'],
  ]);
  expect(replaced.edits).toEqual([]);

  const unsupported = refreshIndependentVisit(replaced, 5, [
    { ...chapter, amount: '12', kind: 'recorded' as const },
    { ...page, amount: '6', recording: 'unsupported' as const },
  ]);
  expect(unsupported.drafts.map(({ unit, text }) => [unit, text])).toEqual([
    ['chapter', '12'],
    ['page', '6'],
  ]);
  expect(unsupported.edits).toEqual([]);
});

test('an acknowledged original retry resets its unit while preserving other measure intent', () => {
  const beforeRetry = [
    { ...chapter, amount: '11', kind: 'recorded' as const },
    { ...volume, amount: '2', kind: 'recorded' as const, inputRules: { ...volume.inputRules, step: '0.1' } },
  ];
  const changed = editMeasure(readyVisit(sessionId, 4, beforeRetry), 'volume', { text: '7' });
  const waiting = {
    ...changed,
    kind: 'review' as const,
    retry: {
      sender: 'recordProgressSession' as const,
      credential: { 'X-CSRF-Token': 'original' },
      key: '44444444-4444-4444-8444-444444444444',
      operands: {
        sessionId,
        revision: 4,
        idempotencyKey: '44444444-4444-4444-8444-444444444444',
        measureId: 'volume',
        amount: '7',
      },
    },
  };
  const snapshot: ProgressSnapshot = {
    id: sessionId,
    revision: 5,
    amount: '11',
    locator: null,
    position: null,
    completedUnitCount: 0,
    state: 'active',
    completedAt: null,
    total: '24',
    measures: [
      { unit: 'chapter', amount: '11', total: '24' },
      { unit: 'volume', amount: '7.0', total: '12' },
    ],
  };
  const acknowledgedRetry = acknowledgeIndependentRetry(waiting, 'volume', snapshot);
  expect(acknowledgedRetry.drafts.map(({ unit, text }) => [unit, text])).toEqual([
    ['chapter', '11'],
    ['volume', '7.0'],
  ]);
  expect(acknowledgedRetry.edits).toEqual([]);
  expect(acknowledgedRetry.retry).toBeNull();
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
  const calls: { data: ProgressRecordInput; headers: HeadersInit }[] = [];
  let attempt = 0;
  const sender: MeasureSender = async ({ data, headers }) => {
    calls.push({ data, headers });
    if (attempt++ === 0) throw new Error('transport');
    return {
      ok: true,
      session: {
        id: sessionId,
        revision: 4,
        amount: '12',
        locator: null,
        position: null,
        completedUnitCount: 0,
        state: 'active',
        completedAt: null,
        total: '24',
        measures: [{ unit: 'chapter', amount: '12', total: '24' }],
      },
    } satisfies ProgressRecorded;
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
  expect(await retryOriginal(result.commands[0]!, () => true)).toMatchObject({ ok: true });
  expect(calls).toHaveLength(2);
  expect(calls[1]?.data).toBe(calls[0]?.data);
  expect(calls[1]?.headers).toBe(credential);
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

// The installed native union also contains retirement; the existing consumer cannot present it as active.
test('native retirement remains unavailable while existing progress states retain their meaning', () => {
  for (const state of ['active', 'completed', 'abandoned'] as const) expect(supportedProgressState(state)).toBe(state);
  expect(() => supportedProgressState('retired')).toThrow('Retired progress sessions are unavailable');
});

test('mounted visit refreshes pristine props and preserves a later field edit through delayed refresh and retirement', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library/progress/' + sessionId });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { IndependentMeasuresVisit } = await import('../src/library/independent-measures/visit');
  const { m } = await import('../src/paraglide/messages.js');
  const host = document.createElement('main');
  document.body.append(host);
  let root: ReturnType<typeof createRoot> | undefined;
  let updateSession!: (session: ProgressSessionView) => void;
  let finishRefresh!: (page: ProgressSessionPage) => void;
  let finishRecord!: (result: ProgressRecorded | ProgressFailure) => void;
  const calls: ProgressRecordInput[] = [];
  const acknowledged: unknown[] = [];
  const saved = (revision: number, chapterAmount: string, volumeAmount: string): ProgressSessionView =>
    sessionView({
      revision,
      amount: chapterAmount,
      measures: [
        {
          unit: 'chapter',
          amount: chapterAmount,
          total: '24',
          primary: true,
          meaning: 'known',
          recordingState: 'supported',
          unitLabel: 'chapters',
          inputRules: { min: '0', max: '24', step: '1', total: 'optional' },
        },
        {
          unit: 'volume',
          amount: volumeAmount,
          total: '12',
          primary: false,
          meaning: 'known',
          recordingState: 'supported',
          unitLabel: 'volumes',
          inputRules: { min: '0', max: '12', step: '1', total: 'optional' },
        },
      ],
    });
  const onRefresh = () =>
    new Promise<ProgressSessionPage>((resolve) => {
      finishRefresh = resolve;
    });
  const sender: MeasureSender = ({ data }) => {
    calls.push(data);
    return new Promise((resolve) => {
      finishRecord = resolve;
    });
  };
  function Host() {
    const [session, setSession] = useState(() => saved(3, '10', '2'));
    updateSession = setSession;
    return (
      <IndependentMeasuresVisit
        session={session}
        credential={() => ({ 'X-CSRF-Token': 'csrf' })}
        isCurrent={() => true}
        onAcknowledged={(snapshot) => acknowledged.push(snapshot)}
        onRefresh={onRefresh}
        sender={sender}
      />
    );
  }
  try {
    const route = createRootRoute({ component: Host });
    const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
    root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));
    await act(async () => updateSession(saved(4, '11', '3')));
    const inputs = () => [...host.querySelectorAll<HTMLInputElement>('input')];
    expect(inputs().map((input) => input.value)).toEqual(['11', '3']);
    const click = async (name: string) => {
      const button = [...host.querySelectorAll('button')].find((item) => item.textContent === name);
      expect(button).toBeTruthy();
      await act(async () => button!.click());
    };
    await click(m.library_progress_measure_save());
    expect(calls).toHaveLength(0);
    expect(
      [...host.querySelectorAll('section')].some(
        (section) => section.getAttribute('aria-label') === m.library_progress_measures_review(),
      ),
    ).toBe(false);

    await click(m.library_progress_measures_refresh());
    const volumeInput = inputs()[1]!;
    const propsKey = Object.keys(volumeInput).find((key) => key.startsWith('__reactProps$'))!;
    Reflect.get(volumeInput, propsKey).onChange({ target: { value: '7' } });
    await act(async () => {
      finishRefresh({ signedIn: true, idempotencyKey: 'read', session: saved(5, '12', '1') });
    });
    expect(inputs().map((input) => input.value)).toEqual(['12', '7']);

    await click(m.library_progress_measure_save());
    const review = [...host.querySelectorAll('section')].find(
      (section) => section.getAttribute('aria-label') === m.library_progress_measures_review(),
    );
    expect(review?.textContent).toContain(m.library_progress_measures_review_unchanged({ unit: 'chapter' }));
    expect(review?.textContent).toContain(m.library_progress_measures_review_amount({ unit: 'volume', amount: '7' }));
    await click(m.library_progress_confirm_correction());
    expect(calls.map(({ sessionId: id, revision, measureId, amount }) => ({ id, revision, measureId, amount }))).toEqual([
      { id: sessionId, revision: 5, measureId: 'volume', amount: '7' },
    ]);

    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => {
      finishRecord({
        ok: true,
        session: {
          id: sessionId,
          revision: 6,
          amount: '12',
          locator: null,
          position: null,
          completedUnitCount: 0,
          state: 'active',
          completedAt: null,
          total: '24',
          measures: [
            { unit: 'chapter', amount: '12', total: '24' },
            { unit: 'volume', amount: '7', total: '12' },
          ],
        },
      });
    });
    expect(acknowledged).toHaveLength(0);
    expect(host.textContent).toBe('');
  } finally {
    if (root) await act(async () => root!.unmount());
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
