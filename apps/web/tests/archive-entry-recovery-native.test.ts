import { expect, test } from 'bun:test';
import { archiveRecoveryAdmission, type NativeArchiveResults } from '../src/library/archive-entry-recovery/native';
import { selectedArchiveRecoveryResults } from '../src/library/archive-entry-recovery/results';
import { RecoverySelection } from '../src/library/archive-entry-recovery/selection';
import { ArchiveRecoveryVisit, type RecoveryBinding } from '../src/library/archive-entry-recovery/visit';

test('Archive admission uses the installed exact review contract', () => {
  expect(archiveRecoveryAdmission()).toEqual({ available: true });
});

// Local state scenarios only: these are not native receipts or an admitted artifact fixture.
const binding: RecoveryBinding = {
  viewer: 'owner',
  credentialEpoch: 'credential-1',
  csrfEpoch: 'csrf-1',
  admission: 'admission-1',
  source: 'private-library',
  route: '/library/recover-archive',
  locale: 'en',
  exposure: 'original-exposure',
};
type Choice = { action: 'preserve' | 'update'; stateId?: string; labelIds?: string[] };
type Confirm = { identity: string; key?: string; operands: { ordinal: number; revision: number }[] };
type Row = { ordinal: number; status: string };
type Visit = ArchiveRecoveryVisit<{ unrelatedRows: number }, Row, Choice, Confirm, Row>;
const page = (rows: Row[]) => ({ rows, context: null });

function fixture(unrelatedRows = 64) {
  let current: RecoveryBinding | null = { ...binding };
  let now = 1_000;
  const visit: Visit = new ArchiveRecoveryVisit(
    () => current,
    10_000,
    () => now,
  );
  visit.admitUpload(visit.startUpload(), 'upload', { unrelatedRows }, 9_000);
  return {
    visit,
    replace: (value: RecoveryBinding | null) => {
      current = value;
    },
    expire: (deadline = 9_000) => {
      now = deadline;
    },
  };
}

test('Selection is explicit, bounded and independent of unsupported archive evidence', () => {
  const selection = new RecoverySelection<Choice>();
  expect(selection.choices).toEqual([]);
  for (let ordinal = 0; ordinal < 20; ordinal++) selection.set(ordinal, 'entries', { action: 'preserve' });
  expect(() => selection.set(20, 'entries', { action: 'update' })).toThrow('selection_limit');
  selection.set(0, 'entries', { action: 'update', stateId: 'current-state', labelIds: ['current-label'] });
  selection.remove(19);
  selection.set(20, 'labels', { action: 'preserve' });
  expect(() => selection.set(21, 'annotations', { action: 'preserve' })).toThrow('selection_limit');
  // @ts-expect-error Unsupported sections must also be refused at runtime.
  expect(() => selection.set(21, 'history', { action: 'preserve' })).toThrow('invalid_selection');
  expect(selection.choices).toHaveLength(20);
});

test('Only one supplied page and twenty choices survive first, deep and terminal navigation at every scale', () => {
  for (const supplied of [1, 50, 100])
    for (const unrelated of [64, 512, 4096]) {
      const { visit } = fixture(unrelated);
      try {
        for (const start of [0, 200, 400]) {
          const old = visit.startPage();
          const latest = visit.startPage();
          const rows = Array.from({ length: supplied }, (_, index) => ({
            ordinal: start + index,
            status: 'unresolved',
          }));
          expect(visit.admitPage(old, page(rows))).toBe(false);
          expect(visit.admitPage(latest, page(rows))).toBe(true);
          expect(visit.state?.page?.rows).toEqual(rows);
          expect(visit.state?.page?.rows).toHaveLength(supplied);
        }
        visit.choose(400, 'entries', { action: 'preserve' });
        expect(visit.state?.choices).toHaveLength(1);
        expect(() =>
          visit.admitPage(
            visit.startPage(),
            page(Array.from({ length: 101 }, () => ({ ordinal: 0, status: 'unresolved' }))),
          ),
        ).toThrow('page_limit');
        expect(visit.state?.page?.rows).toHaveLength(supplied);
      } finally {
        visit.retire();
      }
    }
});

test('Replacing choices refuses a late review; stale native admission requires a new exact review', () => {
  const { visit } = fixture();
  try {
    expect(() => visit.startApply()).toThrow('fresh_review_required');
    visit.choose(1, 'entries', { action: 'preserve' });
    const old = visit.startReview();
    visit.choose(1, 'entries', { action: 'update', stateId: 'current-state' });
    expect(old.signal.aborted).toBe(true);
    const operand: Confirm = { identity: 'review-a', operands: [{ ordinal: 1, revision: 2 }] };
    expect(visit.admitReview(old, operand)).toBe(false);
    expect(() => visit.startApply()).toThrow('fresh_review_required');
    expect(visit.admitReview(visit.startReview(), operand)).toBe(true);
    operand.operands[0]!.revision = 999;
    const apply = visit.startApply();
    expect(apply.operand.operands[0]?.revision).toBe(2);
    expect(Object.isFrozen(apply.operand.operands[0])).toBe(true);
    visit.settleApply(apply.request, 'stale');
    expect(visit.state?.choices[0]?.choice.stateId).toBe('current-state');
    expect(() => visit.startApply()).toThrow('fresh_review_required');
    expect(visit.admitReview(visit.startReview(), { ...operand, identity: 'review-b' })).toBe(true);
    expect(visit.startApply().operand.identity).toBe('review-b');
  } finally {
    visit.retire();
  }
});

test('Independent reader paths commit empty successes, retry exact failures and cap predecessor offsets at eight', () => {
  const { visit } = fixture();
  try {
    const first = visit.startPage(-1, 'first');
    expect(visit.admitPage(first, page([{ ordinal: 0, status: 'unresolved' }]))).toBe(true);
    for (let after = 0; after < 10; after++) {
      const request = visit.startPage(after, 'next');
      expect(visit.admitPage(request, page(after === 9 ? [] : [{ ordinal: after + 1, status: 'unresolved' }]))).toBe(
        true,
      );
    }
    expect(visit.state?.pageNavigation).toMatchObject({
      current: 9,
      previous: [1, 2, 3, 4, 5, 6, 7, 8],
      staged: null,
    });
    const failed = visit.startPage(10, 'next');
    expect(visit.failPage(failed)).toBe(true);
    expect(visit.state?.pageNavigation).toMatchObject({
      current: 9,
      previous: [1, 2, 3, 4, 5, 6, 7, 8],
      staged: { after: 10, direction: 'next', failed: true },
    });
    const retryTarget = visit.state!.pageNavigation.staged!;
    const retry = visit.startPage(retryTarget.after, retryTarget.direction);
    expect(visit.admitPage(retry, page([]))).toBe(true);
    expect(visit.state?.page?.rows).toEqual([]);
    expect(visit.state?.pageNavigation).toMatchObject({ current: 10, previous: [2, 3, 4, 5, 6, 7, 8, 9] });

    const previewPath = visit.state?.pageNavigation;
    const resultFirst = visit.startResults(-1, 'first');
    expect(visit.admitResults(resultFirst, page([]))).toBe(true);
    expect(visit.state?.resultsNavigation).toMatchObject({ current: -1, previous: [] });
    expect(visit.state?.pageNavigation).toEqual(previewPath);
    const resultNext = visit.startResults(0, 'next');
    expect(visit.admitResults(resultNext, page([]))).toBe(true);
    expect(visit.state?.resultsNavigation).toMatchObject({ current: 0, previous: [-1] });
    expect(visit.state?.pageNavigation).toEqual(previewPath);
  } finally {
    visit.retire();
  }
});

test('Uncertain retry keeps the original immutable intent; cancellation retains acknowledged effects', () => {
  const { visit } = fixture();
  try {
    visit.choose(1, 'entries', { action: 'update', stateId: 'current-state' });
    visit.choose(2, 'entries', { action: 'preserve' });
    visit.admitReview(visit.startReview(), {
      identity: 'original',
      operands: [
        { ordinal: 1, revision: 2 },
        { ordinal: 2, revision: 3 },
      ],
    });
    const oldResults = visit.startResults();
    const first = visit.startApply();
    expect(visit.admitResults(oldResults, page([]))).toBe(false);
    const acknowledged = page([{ ordinal: 1, status: 'acknowledged' }]);
    visit.settleApply(first.request, 'uncertain', acknowledged);
    expect(() => visit.choose(1, 'entries', { action: 'preserve' })).toThrow('selection_locked');
    const retry = visit.startApply();
    expect(retry.operand).toBe(first.operand);
    expect(visit.settleApply(first.request, 'complete', page([]))).toBe(false);
    const cancel = visit.startCancel();
    expect(retry.request.signal.aborted).toBe(false);
    expect(visit.admitCancel(cancel)).toBe(false);
    expect(visit.settleApply(retry.request, 'complete')).toBe(true);
    expect(visit.admitCancel(cancel)).toBe(false);
    const checkpoint = visit.startResults();
    expect(visit.admitResults(checkpoint, acknowledged, true)).toBe(true);
    expect(visit.admitCancel(cancel)).toBe(true);
    expect(visit.state?.results).toEqual(acknowledged);
    expect(visit.state?.choices).toEqual([]);
    expect(() => visit.startApply()).toThrow('fresh_review_required');
    expect(() => visit.startPage()).toThrow('cancelled_visit');
  } finally {
    visit.retire();
  }
});

test('Native recoverable effects keep original operands; terminal failure requires fresh confirmation', () => {
  const { visit } = fixture();
  try {
    visit.choose(1, 'entries', { action: 'preserve' });
    visit.admitReview(visit.startReview(), {
      identity: 'original',
      key: 'original-apply-key',
      operands: [{ ordinal: 1, revision: 2 }],
    });
    const first = visit.startApply();
    visit.settleApply(first.request, 'recoverable', page([{ ordinal: 1, status: 'recoverable' }]));
    expect(visit.state?.phase).toBe('recoverable');
    expect(() => visit.startReview()).toThrow('selection_locked');
    const replay = visit.startApply();
    expect(replay.operand).toBe(first.operand);
    expect(replay.operand.key).toBe('original-apply-key');
    visit.settleApply(replay.request, 'recoverable');
    expect(visit.state?.phase).toBe('recoverable');
    const repeated = visit.startApply();
    expect(repeated.operand).toBe(first.operand);
    visit.settleApply(repeated.request, 'failed', page([{ ordinal: 1, status: 'failed' }]));
    expect(visit.state?.phase).toBe('failed');
    expect(visit.state?.results?.rows[0]?.status).toBe('failed');
    expect(() => visit.startApply()).toThrow('fresh_review_required');
    visit.admitReview(visit.startReview(), { identity: 'fresh', operands: [{ ordinal: 1, revision: 3 }] });
    expect(visit.startApply().operand.identity).toBe('fresh');
  } finally {
    visit.retire();
  }
});

test('Account, credential, CSRF, source, route, locale, admission, expiry and upload replacement retire callbacks', () => {
  for (const changed of [null, ...Object.keys(binding).map((key) => ({ ...binding, [key]: 'replacement' }))]) {
    const { visit, replace } = fixture();
    const pending = visit.startPage();
    visit.choose(1, 'entries', { action: 'preserve' });
    replace(changed);
    expect(visit.admitPage(pending, page([{ ordinal: 1, status: 'private' }]))).toBe(false);
    expect(pending.signal.aborted).toBe(true);
    expect(visit.state).toBeNull();
    replace(binding);
    expect(visit.state).toBeNull();
  }
  const { visit, replace } = fixture();
  const pending = visit.startPage();
  replace({ ...binding, admission: 'admission-b' });
  replace({ ...binding, admission: 'admission-a-after-b' });
  expect(visit.admitPage(pending, page([]))).toBe(false);
  expect(visit.state).toBeNull();
  const { visit, expire } = fixture();
  const pending = visit.startPage();
  const replacement = visit.startUpload();
  expect(visit.state?.upload).toBeNull();
  expect(visit.admitPage(pending, page([]))).toBe(false);
  visit.admitUpload(replacement, 'replacement', { unrelatedRows: 512 }, 9_000);
  expire();
  expect(visit.state?.phase).toBe('expired');
  expect(visit.state?.upload).toBeNull();
  expect(() => visit.startPage()).toThrow('evidence_expired');
  visit.retire();
});

test('Evidence expiry keeps accepted outcomes, refuses replay and clears receipts on session retirement', () => {
  for (const retire of ['account', 'deadline', 'unmount'] as const) {
    const { visit, expire, replace } = fixture();
    visit.choose(1, 'entries', { action: 'preserve' });
    visit.admitReview(visit.startReview(), { identity: 'original', operands: [{ ordinal: 1, revision: 2 }] });
    const apply = visit.startApply();
    const acknowledged = page([{ ordinal: 1, status: 'acknowledged' }]);
    visit.settleApply(apply.request, 'recoverable', acknowledged);
    const pending = visit.startResults();
    expire();
    expect(visit.state).toMatchObject({
      phase: 'expired',
      upload: null,
      page: null,
      pageNavigation: { current: null, previous: [], staged: null },
      resultsNavigation: { current: null, previous: [], staged: null },
      choices: [],
      review: null,
    });
    expect(visit.state?.results).toEqual(acknowledged);
    expect(visit.admitResults(pending, page([]))).toBe(false);
    expect(pending.signal.aborted).toBe(true);
    expect(() => visit.startApply()).toThrow('evidence_expired');
    if (retire === 'account') replace(null);
    if (retire === 'deadline') expire(10_000);
    if (retire === 'unmount') visit.retire();
    expect(visit.state).toBeNull();
  }
});

test('Cancellation with a recoverable partial page retains the exact original command until checkpoint', () => {
  const { visit } = fixture();
  try {
    visit.choose(1, 'entries', { action: 'preserve' });
    visit.admitReview(visit.startReview(), {
      identity: 'original',
      key: 'apply-key',
      operands: [{ ordinal: 1, revision: 2 }],
    });
    const first = visit.startApply();
    const cancel = visit.startCancel();
    visit.admitResults(visit.startResults(), page([]), true);
    expect(visit.admitCancel(cancel)).toBe(false);
    visit.settleApply(first.request, 'recoverable', page([{ ordinal: 1, status: 'recoverable' }]));
    expect(visit.admitCancel(cancel)).toBe(false);
    const replay = visit.startApply();
    expect(replay.operand).toBe(first.operand);
    visit.settleApply(replay.request, 'stale', page([]));
    expect(visit.admitCancel(cancel)).toBe(false);
    const checkpoint = visit.startApply();
    expect(checkpoint.operand).toBe(first.operand);
    visit.settleApply(checkpoint.request, 'complete', page([{ ordinal: 1, status: 'acknowledged' }]));
    expect(visit.admitCancel(cancel)).toBe(true);
  } finally {
    visit.retire();
  }
});

test('Supplied native results expose only selected supported outcomes and checkpointed destinations', () => {
  const id = '019a1b2c-3d4e-7f00-8a00-000000000001';
  for (const supplied of [1, 50, 100]) {
    const result = { effect: 'entry.put', subjectId: id, progressSession: { private: true }, completedEpisodes: [1] };
    const native: NativeArchiveResults = {
      uploadId: id,
      state: 'ready',
      next: 400,
      results: Array.from({ length: supplied }, (_, ordinal) => ({
        ordinal,
        section: 'entries',
        status: 'recoverable',
        result,
      })),
    };
    const selected = [
      {
        ordinal: 0,
        section: 'entries' as const,
        choice: { ordinal: 0, kind: 'entry', subjectId: id, action: 'preserve' } as const,
      },
    ];
    expect(selectedArchiveRecoveryResults(native, selected)).toEqual({
      rows: [{ ordinal: 0, section: 'entries', status: 'recoverable', subjectId: null }],
      context: { uploadId: id, state: 'ready', next: 400 },
    });
    native.results[0]!.status = 'acknowledged';
    const accepted = selectedArchiveRecoveryResults(native, selected);
    expect(accepted.rows[0]?.subjectId).toBe(id);
    expect(JSON.stringify(accepted)).not.toMatch(/progressSession|completedEpisodes/);
    expect(Object.isFrozen(accepted.rows[0])).toBe(true);
    native.results[0]!.section = 'sessions';
    expect(selectedArchiveRecoveryResults(native, selected).rows).toEqual([]);
  }
});
