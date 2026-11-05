import { expect, test } from 'bun:test';
import {
  bulkLibraryRemovalReviewMatches,
  captureBulkLibraryRemovalPreview,
  createBulkLibraryRemovalManifest,
  landedBulkLibraryRemovalEntries,
  outcomesForBulkLibraryRemovalTargets,
  readCapturedBulkLibraryRemoval,
  sendCapturedBulkLibraryRemovalConfirmation,
  type BulkLibraryRemovalCandidate,
  type BulkLibraryRemovalConfirmCall,
  type BulkLibraryRemovalOperation,
  type BulkLibraryRemovalSender,
  type BulkLibraryRemovalTargetOutcome,
} from '../src/library/bulk-library-removal';

const id = (value: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(value).padStart(12, '0')}`;
const entry = (value: number, revision = 1, incarnationId = `incarnation-${value}`): BulkLibraryRemovalCandidate => ({
  subjectId: id(value),
  subject: { id: id(value) },
  revision,
  incarnationId,
  removeKey: `remove-${value}`,
});

function operation(phase: BulkLibraryRemovalOperation['phase'] = 'preview'): BulkLibraryRemovalOperation {
  return {
    id: '01b5b3de-6ad2-7fc8-a604-e058df922001',
    route: 1,
    action: 'remove_from_library',
    selectionKind: 'explicit',
    state: null,
    collectionId: null,
    phase,
    selectionComplete: true,
    occurrencesComplete: true,
    cancelRequested: false,
    counts: {
      scannedCandidates: 0,
      selectedSubjects: 2,
      scannedOccurrences: 0,
      capturedOccurrences: 0,
      targets: 2,
      pending: 0,
      reconciling: 0,
      applied: 0,
      no_effect: 0,
      conflict: 0,
      denied: 0,
      failed: 0,
      cancelled: 0,
    },
    summary: null,
    admittedAt: '2026-11-03T01:00:00.000Z',
    targetBoundAt: null,
    expiresAt: '2026-11-04T01:00:00.000Z',
    resultsExpireAt: '2026-11-05T01:00:00.000Z',
    finishedAt: null,
    reason: null,
  };
}

function outcome(
  ordinal: number,
  subjectId: string,
  state: BulkLibraryRemovalTargetOutcome['state'],
  reason: BulkLibraryRemovalTargetOutcome['reason'] = null,
): BulkLibraryRemovalTargetOutcome {
  return { ordinal: String(ordinal), subjectId, memberId: null, state, reason, resultingMemberId: null };
}

test('previews the exact loaded subjects and binds review to revision and incarnation', () => {
  const loaded = [entry(1), entry(2)];
  const captured = captureBulkLibraryRemovalPreview(loaded);

  expect(captured).toMatchObject({
    ok: true,
    request: {
      action: 'remove_from_library',
      selection: { kind: 'explicit', targets: [{ subjectId: id(1) }, { subjectId: id(2) }] },
    },
  });
  if (!captured.ok) throw new Error('Expected an explicit native preview');
  expect(JSON.parse(captured.body)).toEqual(captured.request);
  expect(bulkLibraryRemovalReviewMatches(captured.signature, loaded, 'en', 'en', true)).toBe(true);
  expect(bulkLibraryRemovalReviewMatches(captured.signature, [entry(1, 2), loaded[1]!], 'en', 'en', true)).toBe(false);
  expect(
    bulkLibraryRemovalReviewMatches(captured.signature, [entry(1, 1, 'recreated'), loaded[1]!], 'en', 'en', true),
  ).toBe(false);
  expect(bulkLibraryRemovalReviewMatches(captured.signature, loaded, 'en', 'fr', true)).toBe(false);
  expect(bulkLibraryRemovalReviewMatches(captured.signature, loaded, 'en', 'en', false)).toBe(false);
});

test('keeps a 1,000-target request whole and rejects excess targets or bytes without truncation', () => {
  const maximum = Array.from({ length: 1_000 }, (_, index) => ({
    ...entry(index + 1),
    subjectId: `loaded-${index}`,
    subject: { id: `loaded-${index}` },
  }));
  const capturedMaximum = captureBulkLibraryRemovalPreview(maximum);
  expect(capturedMaximum.ok && capturedMaximum.request.selection.targets).toHaveLength(1_000);

  expect(
    captureBulkLibraryRemovalPreview([
      ...maximum,
      { ...entry(1_001), subjectId: 'loaded-1000', subject: { id: 'loaded-1000' } },
    ]),
  ).toMatchObject({ ok: false, reason: 'too_many_targets' });

  const oversized = Array.from({ length: 1_000 }, (_, index) => {
    const subjectId = `${index}-`.padEnd(100, 'x');
    return { ...entry(index + 1), subjectId, subject: { id: subjectId } };
  });
  expect(captureBulkLibraryRemovalPreview(oversized)).toMatchObject({ ok: false, reason: 'command_too_large' });
});

test('keeps preview effect-free and replays uncertain confirmation with the same body and key', async () => {
  const captured = captureBulkLibraryRemovalPreview([entry(1), entry(2)]);
  if (!captured.ok) throw new Error('Expected an explicit native preview');
  const calls: BulkLibraryRemovalConfirmCall[] = [];
  let previewCalls = 0;
  let readCalls = 0;
  let applied = 0;
  let attempts = 0;
  const sender: BulkLibraryRemovalSender = {
    preview: async () => {
      previewCalls += 1;
      return operation('preview');
    },
    confirm: async (call) => {
      calls.push(call);
      if (++attempts === 1) throw new Error('response lost');
      applied += 1;
      return operation('queued');
    },
    read: async () => {
      readCalls += 1;
      return { operation: operation('queued'), outcomes: [] };
    },
  };
  const manifest = createBulkLibraryRemovalManifest(captured, { 'x-csrf-token': 'csrf-viewer' }, sender);

  expect(previewCalls).toBe(0);
  expect(applied).toBe(0);
  await manifest.sender.preview(manifest.preview);
  expect(previewCalls).toBe(1);
  expect(applied).toBe(0);

  const confirm = () => manifest.sender.confirm({ ...manifest.confirm, operationId: operation().id });
  await expect(confirm()).rejects.toThrow('response lost');
  await confirm();

  expect(applied).toBe(1);
  expect(calls.map(({ body }) => body)).toEqual([manifest.confirm.body, manifest.confirm.body]);
  expect(calls.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
    manifest.confirm.idempotencyKey,
    manifest.confirm.idempotencyKey,
  ]);
  expect(calls.every(({ headers }) => headers === manifest.confirm.headers)).toBe(true);

  const confirmCount = calls.length;
  expect(await sendCapturedBulkLibraryRemovalConfirmation(manifest, operation().id, () => false)).toBeNull();
  expect(await readCapturedBulkLibraryRemoval(manifest, operation().id, () => false)).toBeNull();
  expect(calls).toHaveLength(confirmCount);
  expect(readCalls).toBe(0);
});

test('lands only authentic removal outcomes and keeps conflicts for changed or recreated entries', () => {
  const targets = [1, 2, 3, 4].map((value) => ({ subjectId: id(value) }));
  const outcomes = [
    outcome(0, id(1), 'applied'),
    outcome(1, id(2), 'conflict', 'revision_mismatch'),
    outcome(2, id(3), 'conflict', 'incarnation_mismatch'),
    outcome(3, id(4), 'no_effect', 'missing_target'),
    outcome(4, id(5), 'applied'),
  ];

  expect(outcomesForBulkLibraryRemovalTargets(targets, outcomes).map(({ subjectId }) => subjectId)).toEqual([
    id(1),
    id(2),
    id(3),
    id(4),
  ]);
  expect(
    landedBulkLibraryRemovalEntries(
      targets.map((target, index) => ({
        ...target,
        revision: 1,
        removeKey: `remove-${index}`,
      })),
      outcomes,
    ).map(({ subjectId }) => subjectId),
  ).toEqual([id(1), id(4)]);
});
