import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { vndbReviewHref, vndbReviewSearch } from './address';
import { createVndbJourney } from './controller';
import type { VndbCommand, VndbPage, VndbPort, VndbRow } from './contract';
import { VndbPendingReview } from './pending';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { VndbRowReview } = await import('./row');

const uploadId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const reviewId = '00000000-0000-4000-8000-000000000003';
const address = { uploadId, offset: 0 };

// Authored native-format controls, not a real person's export or seeded acceptance.
function authoredRow(ordinal = 0): VndbRow {
  return {
    ordinal,
    kind: 'vn',
    identifier: { provider: 'vndb', kind: 'vn', value: 'v123' },
    title: 'Authored control',
    labels: ['Playing'],
    suggestedRole: 'active',
    fields: {},
    evidence: {},
    retainedReason: '',
    match: { status: 'unmatched', candidates: [] },
    target: null,
    decision: null,
    scoreDecision: null,
    consumptionDateReview: null,
    consumptionDateOutcome: null,
    nativeScore: {
      question: null,
      currentVote: { state: 'unavailable' },
      sourceReason: 'Retained source',
      exactUnits: null,
      admission: { status: 'unavailable', reason: 'native-question-unavailable' },
    },
    fieldsTreatment: { state: 'review', score: 'retained', other: 'retained' },
  };
}

function setup(rows: VndbRow[], overrides: Partial<VndbPort> = {}) {
  const calls: VndbCommand[] = [];
  const unavailable = async () => ({ kind: 'unavailable' as const, status: 503 });
  const page: VndbPage = {
    uploadId,
    state: 'active',
    expiresAt: '2099-01-01T00:00:00Z',
    total: rows.length,
    rows,
    next: null,
  };
  const controller = new AbortController();
  const journey = createVndbJourney({
    visit: {
      subject: targetId,
      csrfToken: 'authored',
      controller,
      current: () => !controller.signal.aborted,
      retire: () => controller.abort(),
    },
    port: {
      preview: async (command) => {
        calls.push(command);
        return unavailable();
      },
      page: async (command) => {
        calls.push(command);
        return { kind: 'page', value: page };
      },
      review: unavailable,
      apply: unavailable,
      source: unavailable,
      cancel: unavailable,
      delete: unavailable,
      ...overrides,
    },
  });
  return { journey, calls, page };
}

test('a bounded review address contains only the upload identity and page offset', () => {
  const href = new URL(vndbReviewHref({ uploadId, offset: 8 }), 'https://example.invalid');
  expect(vndbReviewSearch(Object.fromEntries(href.searchParams))).toEqual({ uploadId, offset: 8 });
  expect(vndbReviewSearch({})).toEqual({});
  for (const input of [
    { uploadId: 'v123' },
    { uploadId, offset: -1 },
    { uploadId, offset: 5000 },
    { uploadId, offset: 0.5 },
    { uploadId, offset: [] },
    { offset: 0 },
  ])
    expect(() => vndbReviewSearch(input)).toThrow('Invalid VNDB review address');
});

test('reopening reads retained decisions without another upload or mutation and restores known state results', async () => {
  const completed = authoredRow();
  completed.decision = {
    reviewId,
    status: 'applied',
    targetId,
    state: 'playing',
    baseline: null,
    replace: false,
    action: 'state',
    progress: null,
  };
  const { journey, calls } = setup([completed, authoredRow(1)]);
  const snap = await journey.reopen(address);
  expect(calls).toEqual([{ kind: 'page', ...address }]);
  expect(snap.outcomes).toEqual([{ ordinal: 0, reviewId, status: 'applied' }]);
  expect(snap.page?.rows[0]?.decision?.progress).toBeNull();
  expect(snap.settledEffects[0]?.targetId).toBe(targetId);
  expect(snap.selectedEffects).toBe(0);
  expect(snap.page?.rows[1]?.match.status).toBe('unmatched');
  expect(snap.reviewCurrent).toBe(true);
});

test('a reopened in-flight decision reconciles the original review and freezes an unknown apply retry', async () => {
  const source = authoredRow();
  source.decision = {
    reviewId,
    status: 'applying',
    targetId,
    state: 'playing',
    baseline: null,
    replace: true,
    action: 'state',
    progress: null,
  };
  const attempts: VndbCommand[] = [];
  const { journey } = setup([source], {
    apply: async (command) => {
      attempts.push(command);
      return attempts.length === 1
        ? { kind: 'unknown', command }
        : {
            kind: 'applied',
            value: { uploadId, outcomes: [{ ordinal: 0, reviewId, status: 'applied' }], stopped: null },
          };
    },
  });
  expect((await journey.reopen(address)).selectedEffects).toBe(1);
  journey.openConfirm();
  expect((await journey.confirm()).retryCommand).toBe('apply');
  expect((await journey.reopen({ uploadId, offset: 8 })).retryCommand).toBe('apply');
  const snap = await journey.retryUnknown();
  expect(attempts[0]).toBe(attempts[1]);
  expect(attempts[1]).toEqual({ kind: 'apply', uploadId, body: { rows: [{ ordinal: 0, reviewId }] } });
  expect(snap.applied).toBe(1);
});

test('current refusal and unavailable readback never restore private rows or create replacement uploads', async () => {
  for (const failure of [
    { kind: 'not-found', status: 404 },
    { kind: 'denied', status: 403 },
    { kind: 'unavailable', status: 503 },
  ] as const) {
    const { journey, calls } = setup([], { page: async () => failure });
    const snap = await journey.reopen(address);
    expect(snap.notice).toEqual(failure);
    expect(snap.page).toBeNull();
    expect(snap.rows).toEqual([]);
    expect(snap.reviewCurrent).toBe(false);
    expect(calls).toEqual([]);
  }
});

test('reopen reconciles deliberate zero votes and restores acknowledged score results', async () => {
  const source = authoredRow();
  source.scoreDecision = {
    reviewId,
    status: 'applying',
    targetId,
    action: 'vote',
    units: 0,
    question: {
      id: targetId,
      revision: 1,
      meaning: 'enjoyment',
      label: 'Enjoyment',
      grain: 'work',
      scale: { min: 0, max: 20, step: 1 },
      aggregateEffect: 'public-standard-aggregate',
    },
    currentVote: { state: 'absent' },
    consent: 'adopt-native-vote',
    sourceReason: 'deliberate units',
    nativeAdmission: 'conditional',
  };
  const commands: VndbCommand[] = [];
  const { journey } = setup([source], {
    apply: async (command) => {
      commands.push(command);
      return {
        kind: 'applied',
        value: { uploadId, outcomes: [{ ordinal: 0, scoreReviewId: reviewId, status: 'applied' }], stopped: null },
      };
    },
  });
  expect((await journey.reopen(address)).selectedEffects).toBe(1);
  journey.openConfirm();
  expect((await journey.confirm()).applied).toBe(1);
  expect(commands).toEqual([{ kind: 'apply', uploadId, body: { rows: [{ ordinal: 0, scoreReviewId: reviewId }] } }]);
  source.scoreDecision.status = 'applied';
  const restored = await setup([source]).journey.reopen(address);
  expect(restored.outcomes).toEqual([{ ordinal: 0, scoreReviewId: reviewId, status: 'applied' }]);
  expect(restored.settledEffects[0]?.targetId).toBe(targetId);
  expect(restored.selectedEffects).toBe(0);
});

test('journey propagates internal defects and releases busy state', async () => {
  for (const error of [new Error('internal defect'), new TypeError('internal defect')]) {
    const { journey } = setup([], {
      page: async () => {
        throw error;
      },
    });
    await expect(journey.reopen(address)).rejects.toBe(error);
    expect(journey.snapshot().busy).toBe(false);
    expect(journey.snapshot().retryCommand).toBeNull();
  }
});

test('review keeps an explicit unmatched target selectable only while native readback discloses it', async () => {
  const source = authoredRow();
  source.decision = {
    reviewId,
    status: 'reviewed',
    targetId,
    state: 'playing',
    baseline: null,
    replace: false,
    action: 'state',
    progress: null,
  };
  source.target = { targetId, states: [{ id: 'playing', labels: { en: 'Playing' } }], baseline: null };
  const render = () =>
    renderToStaticMarkup(
      createElement(VndbRowReview, {
        row: source,
        busy: false,
        onReview: () => {},
      }),
    );
  expect(render()).toContain('Use the previously reviewed work');
  expect(render()).toContain('v123');
  source.target = null;
  expect(render()).not.toContain('Use the previously reviewed work');
  const { journey, page } = setup([source, authoredRow(1)]);
  page.total = 10;
  page.next = 2;
  const snap = await journey.reopen(address);
  expect(renderToStaticMarkup(createElement(VndbPendingReview, { snap }))).toContain(
    '1 loaded entries still need review. 8 source rows have not been loaded',
  );
});

test('an explicit match refreshes the native target and vote without replacing the acknowledged review', async () => {
  const source = authoredRow();
  const decision = {
    reviewId,
    status: 'reviewed' as const,
    targetId,
    state: 'playing',
    baseline: null,
    replace: false,
    action: 'state' as const,
    progress: null,
  };
  const commands: VndbCommand[] = [];
  const { journey, page } = setup([source], {
    review: async (command) => {
      commands.push(command);
      page.rows = [
        {
          ...source,
          decision,
          target: { targetId, states: [{ id: 'playing', labels: { en: 'Playing' } }], baseline: null },
          nativeScore: {
            ...source.nativeScore,
            currentVote: { state: 'set', units: 0, revision: 2, at: '2026-11-06T00:00:00Z' },
          },
        },
      ];
      return { kind: 'reviewed', value: decision };
    },
  });
  await journey.reopen(address);
  const snap = await journey.review({ ordinal: 0, action: 'state', targetId, state: 'playing', replace: false });
  expect(commands).toHaveLength(1);
  expect(snap.page?.rows[0]?.target?.targetId).toBe(targetId);
  expect(snap.page?.rows[0]?.nativeScore.currentVote).toMatchObject({ state: 'set', units: 0 });
  expect(snap.page?.rows[0]?.match.status).toBe('unmatched');
  expect(snap.page?.rows[0]?.decision).toEqual(decision);
  expect(snap.page?.rows[0]?.decision?.progress).toBeNull();
  expect(snap.selectedEffects).toBe(1);
});
