import { expect, test } from 'bun:test';
import { archiveRecoveryAdmission } from '../src/library/archive-entry-recovery/native';
import { RecoverySelection } from '../src/library/archive-entry-recovery/selection';
import { ArchiveRecoveryVisit, type RecoveryBinding } from '../src/library/archive-entry-recovery/visit';

test('Archive admission stays unavailable until exact reviewed selections can cross the native boundary', () => {
  // A mounted implementation or Eden runtime property alone must not enable file transfer.
  expect(archiveRecoveryAdmission()).toEqual({ available: false });
});

// Local state scenarios only: these are not native receipts or an admitted artifact fixture.
const binding: RecoveryBinding = {
  viewer: 'owner',
  credentialEpoch: 'credential-1',
  csrfEpoch: 'csrf-1',
  source: 'private-library',
  route: '/library/recover-archive',
};
type Choice = { action: 'preserve' | 'update'; stateId?: string; labelIds?: string[] };
type Confirm = { identity: string; operands: { ordinal: number; revision: number }[] };
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
    expire: () => {
      now = 9_000;
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
    expect(retry.request.signal.aborted).toBe(true);
    expect(visit.settleApply(retry.request, 'complete', page([]))).toBe(false);
    expect(visit.admitCancel(cancel)).toBe(true);
    expect(visit.state?.results).toEqual(acknowledged);
    expect(visit.state?.choices).toEqual([]);
    expect(() => visit.startApply()).toThrow('fresh_review_required');
    expect(() => visit.startPage()).toThrow('cancelled_visit');
  } finally {
    visit.retire();
  }
});

test('Account, credential, CSRF, source, route, deadline and upload replacement retire private callbacks', () => {
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
  const { visit, expire } = fixture();
  const pending = visit.startPage();
  const replacement = visit.startUpload();
  expect(visit.state?.upload).toBeNull();
  expect(visit.admitPage(pending, page([]))).toBe(false);
  visit.admitUpload(replacement, 'replacement', { unrelatedRows: 512 }, 9_000);
  expire();
  expect(visit.state).toBeNull();
  expect(() => visit.startUpload()).toThrow('retired_visit');
});
