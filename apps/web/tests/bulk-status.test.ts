import { expect, test } from 'bun:test';
import type { ShelfSelectionCandidate } from '../src/library/shelf-selection';
import {
  bulkStatusReviewMatches,
  bulkStatusSelectionSignature,
  captureBulkStatusPreview,
  createBulkStatusManifest,
  groupBulkStatusOutcomes,
  type BulkStatusConfirmCall,
  type BulkStatusOperation,
  type BulkStatusSender,
  type BulkStatusTargetOutcome,
} from '../src/library/bulk-status';

const id = (value: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(value).padStart(12, '0')}`;
const completed = { id: 'completed', label: { text: 'Completed', lang: 'en' } };
const entry = (value: number, stateOptions = [completed]): ShelfSelectionCandidate & { state: string } => ({
  subjectId: id(value),
  subject: { id: id(value) },
  stateOptions,
  state: 'reading',
});

test('previews the selected loaded canonical subjects in order without changing their status', () => {
  const loaded = [entry(1), entry(2), entry(3)];
  const captured = captureBulkStatusPreview([loaded[1]!, loaded[0]!, loaded[1]!], 'completed');

  expect(captured).toMatchObject({
    ok: true,
    request: {
      action: 'set_status',
      state: 'completed',
      selection: {
        kind: 'explicit',
        targets: [{ subjectId: id(2) }, { subjectId: id(1) }],
      },
    },
  });
  expect(loaded.map(({ state }) => state)).toEqual(['reading', 'reading', 'reading']);
});

test('refuses an unsupported selected target or an oversized target set instead of omitting either', () => {
  expect(captureBulkStatusPreview([entry(1), entry(2, [])], 'completed')).toMatchObject({
    ok: false,
    reason: 'unsupported_selection',
  });
  expect(
    captureBulkStatusPreview(
      Array.from({ length: 1001 }, (_, index) => entry(index + 1)),
      'completed',
    ),
  ).toMatchObject({
    ok: false,
    reason: 'too_many_targets',
  });
});

test('a selection, loaded status, requested status, or locale change retires a review', () => {
  const snapshot = [{ subjectId: id(1), state: 'reading', revision: 2, changeKey: 'change-1' }];
  const signature = bulkStatusSelectionSignature(snapshot, 'completed');

  expect(bulkStatusReviewMatches(signature, snapshot, 'completed', 'en', 'en', true)).toBe(true);
  expect(bulkStatusReviewMatches(signature, snapshot, 'reading', 'en', 'en', true)).toBe(false);
  expect(
    bulkStatusReviewMatches(signature, [{ ...snapshot[0]!, subjectId: id(2) }], 'completed', 'en', 'en', true),
  ).toBe(false);
  expect(
    bulkStatusReviewMatches(signature, [{ ...snapshot[0]!, state: 'completed' }], 'completed', 'en', 'en', true),
  ).toBe(false);
  expect(bulkStatusReviewMatches(signature, snapshot, 'completed', 'en', 'fr', true)).toBe(false);
  expect(bulkStatusReviewMatches(signature, snapshot, 'completed', 'en', 'en', false)).toBe(false);
});

test('an uncertain confirmation reuses the retained sender, headers, body, and idempotency key', async () => {
  const captured = captureBulkStatusPreview([entry(1)], 'completed');
  if (!captured.ok) throw new Error('Expected a preview manifest');
  const nativeOperation = (phase: string) => ({ id: 'operation-1', phase }) as unknown as BulkStatusOperation;
  const calls: BulkStatusConfirmCall[] = [];
  let attempt = 0;
  const sender: BulkStatusSender = {
    preview: async () => nativeOperation('preview'),
    confirm: async (call) => {
      calls.push(call);
      if (++attempt === 1) throw new Error('response lost');
      return nativeOperation('queued');
    },
    read: async () => ({ operation: nativeOperation('queued'), outcomes: [] }),
  };
  const manifest = createBulkStatusManifest(
    captured,
    { authorization: 'Bearer owner', cookie: 'session=owner', 'x-csrf-token': 'csrf-owner' },
    sender,
  );
  const confirm = () => manifest.sender.confirm({ ...manifest.confirm, operationId: 'operation-1' });

  await expect(confirm()).rejects.toThrow('response lost');
  await confirm();

  expect(manifest.sender).toBe(sender);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.headers).toBe(manifest.confirm.headers);
  expect(calls[1]!.headers).toBe(manifest.confirm.headers);
  expect(calls.map(({ body }) => body)).toEqual([manifest.confirm.body, manifest.confirm.body]);
  expect(calls.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
    manifest.confirm.idempotencyKey,
    manifest.confirm.idempotencyKey,
  ]);
  expect(calls[0]!.headers).toEqual({
    authorization: 'Bearer owner',
    cookie: 'session=owner',
    'x-csrf-token': 'csrf-owner',
  });
});

test('authoritative conflicts and skips stay separate from applied targets', () => {
  const outcome = (ordinal: number, subjectId: string, state: BulkStatusTargetOutcome['state']) => ({
    ordinal: String(ordinal),
    subjectId,
    memberId: null,
    state,
    reason: null,
    resultingMemberId: null,
  });
  const groups = groupBulkStatusOutcomes([
    outcome(0, id(1), 'applied'),
    outcome(1, id(2), 'conflict'),
    outcome(2, id(3), 'denied'),
    outcome(3, id(4), 'no_effect'),
  ]);

  expect(groups.applied.map(({ subjectId }) => subjectId)).toEqual([id(1)]);
  expect(groups.conflicts.map(({ subjectId }) => subjectId)).toEqual([id(2)]);
  expect(groups.skipped.map(({ subjectId }) => subjectId)).toEqual([id(3)]);
  expect(groups.noChange.map(({ subjectId }) => subjectId)).toEqual([id(4)]);
});
