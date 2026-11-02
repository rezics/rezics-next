import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import collection from '../src/kernel/recorded/library-collection.json';
import members from '../src/kernel/recorded/library-collection-members.json';
import {
  BulkOccurrenceRemoveJourney,
  bulkOccurrenceRemoveResultKind,
  bulkOccurrenceRemoveRestoreAvailable,
  bulkOccurrenceRemoveUndoReceipt,
  captureBulkOccurrenceRemove,
  createBulkOccurrenceRemoveManifest,
  type BulkOccurrenceRemoveSender,
} from '../src/library/bulk-occurrence-remove';
import {
  BulkOccurrenceRemoveJourneyControls,
  BulkOccurrenceRemoveReview,
} from '../src/library/bulk-occurrence-remove-review';
import type { BulkStatusOperation } from '../src/library/bulk-status';
import {
  receiveUndoEvidence,
  type BulkUndoOutcome,
  type BulkUndoRead,
} from '../src/library/bulk-operation-undo-evidence';
import type { BulkRead, OperationAddress } from '../src/library/bulk-operation-recovery-native';

const operation = (phase: BulkStatusOperation['phase'] = 'preview'): BulkStatusOperation => ({
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000010',
  route: 1,
  action: 'remove_from_collection',
  selectionKind: 'occurrences',
  state: null,
  collectionId: collection.collection.id,
  phase,
  selectionComplete: true,
  occurrencesComplete: true,
  cancelRequested: false,
  counts: {
    scannedCandidates: 0,
    selectedSubjects: 0,
    scannedOccurrences: 2,
    capturedOccurrences: 2,
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
  admittedAt: '2026-11-01T00:00:00.000Z',
  targetBoundAt: null,
  expiresAt: '2026-11-02T00:00:00.000Z',
  resultsExpireAt: '2026-11-03T00:00:00.000Z',
  finishedAt: null,
  reason: null,
});

function outcome(overrides: Partial<BulkUndoOutcome> = {}): BulkUndoOutcome {
  return {
    ordinal: '0',
    subjectId: members.members[0]!.subjectId,
    memberId: members.members[0]!.id,
    state: 'applied',
    reason: null,
    resultingMemberId: null,
    deletion: null,
    memberDeletion: null,
    ...overrides,
  };
}

function readyRead(outcomes: BulkUndoOutcome[] = []): BulkUndoRead {
  return { state: 'ready', operation: operation('completed'), page: { outcomes, next: null } };
}

function captureSelection() {
  const first = members.members[0]!;
  const second = { ...members.members[1]!, subject: first.subject, subjectId: first.subject.id };
  const captured = captureBulkOccurrenceRemove(collection.collection, [first, second], new Set([second.id, first.id]));
  if (!captured.ok) throw new Error('Expected selected occurrences to capture');
  return captured;
}

test('captures two selected occurrences of one Subject, retaining source and selection order without deletion', () => {
  const first = members.members[0]!;
  const second = { ...members.members[1]!, subject: first.subject, subjectId: first.subject.id };
  const source = { ...collection.collection };
  const loaded = [first, second];
  const before = JSON.stringify(loaded);
  const capture = captureBulkOccurrenceRemove(source, loaded, new Set([second.id, first.id]));
  expect(JSON.stringify(loaded)).toBe(before);
  if (!capture.ok) throw new Error('Expected an exact occurrence capture');
  expect(capture.targets).toEqual([
    { memberId: second.id, subjectId: first.subject.id },
    { memberId: first.id, subjectId: first.subject.id },
  ]);
  const review = renderToStaticMarkup(<BulkOccurrenceRemoveReview capture={capture} />);
  expect(review).toContain(first.id);
  expect(review).toContain(second.id);
  expect(review).toContain(source.id);
  expect(review).not.toContain('<button');
  source.id = 'later-source';
  source.title = 'Later title';
  loaded.reverse();
  expect(capture.source).toEqual({ id: collection.collection.id, title: collection.collection.title });
  expect(Object.isFrozen(capture.targets[0])).toBe(true);
  expect(Object.isFrozen(capture.targets)).toBe(true);
  expect(Object.isFrozen(capture.source)).toBe(true);
});

test('never adds an unselected duplicate or silently drops an unavailable selected occurrence', () => {
  const first = members.members[0]!;
  const duplicate = { ...first, id: members.members[1]!.id };
  const capture = captureBulkOccurrenceRemove(collection.collection, [first, duplicate], new Set([first.id]));
  expect(capture.ok && capture.targets.map((target) => target.memberId)).toEqual([first.id]);
  for (const loaded of [[], [{ ...first, subject: null }], [{ ...first, subjectId: 'different' }], [first, first]]) {
    expect(captureBulkOccurrenceRemove(collection.collection, loaded, new Set([first.id]))).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  }
  expect(captureBulkOccurrenceRemove(collection.collection, [first], new Set())).toEqual({
    ok: false,
    reason: 'empty',
  });
  expect(
    captureBulkOccurrenceRemove(collection.collection, [], new Set(Array.from({ length: 1001 }, (_, i) => `${i}`))),
  ).toEqual({ ok: false, reason: 'limit' });
});

test('native preview sends only the captured occurrence IDs and waits for a separate confirmation', async () => {
  const capture = captureSelection();
  const previewCalls: Parameters<BulkOccurrenceRemoveSender['preview']>[0][] = [];
  const confirmCalls: Parameters<BulkOccurrenceRemoveSender['confirm']>[0][] = [];
  const sender: BulkOccurrenceRemoveSender = {
    preview: async (call) => {
      previewCalls.push(call);
      return operation();
    },
    confirm: async (call) => {
      confirmCalls.push(call);
      return operation('queued');
    },
  };
  const manifest = createBulkOccurrenceRemoveManifest(capture, { 'x-csrf-token': 'captured' }, sender);
  expect(JSON.parse(manifest.preview.body)).toEqual({
    action: 'remove_from_collection',
    collectionId: collection.collection.id,
    selection: { kind: 'occurrences', memberIds: capture.targets.map((target) => target.memberId) },
  });
  const controls = renderToStaticMarkup(
    <BulkOccurrenceRemoveJourneyControls
      state={{ phase: 'review' }}
      canWrite
      onPreview={() => {}}
      onRetryPreview={() => {}}
      onConfirm={() => {}}
      onRetryConfirm={() => {}}
      onRead={() => {}}
      onReadMore={() => {}}
    />,
  );
  expect(controls).toContain('Create native preview');
  expect(controls).not.toContain('Remove these occurrences');
  const journey = new BulkOccurrenceRemoveJourney(
    capture,
    manifest,
    'viewer',
    { context: () => true, read: () => true, write: () => true },
    async () => readyRead(),
    () => {},
  );
  expect(await journey.preview()).toBe(true);
  expect(previewCalls).toEqual([manifest.preview]);
  expect(confirmCalls).toHaveLength(0);
  expect(journey.state.phase).toBe('previewed');
});

test('unknown confirmation retries its original command after read recovery', async () => {
  const capture = captureSelection();
  const previewCalls: Parameters<BulkOccurrenceRemoveSender['preview']>[0][] = [];
  const confirmCalls: Parameters<BulkOccurrenceRemoveSender['confirm']>[0][] = [];
  const addresses: OperationAddress[] = [];
  const sender: BulkOccurrenceRemoveSender = {
    preview: async (call) => {
      previewCalls.push(call);
      return operation();
    },
    confirm: async (call) => {
      confirmCalls.push(call);
      if (confirmCalls.length === 1) throw new Error('unknown response');
      return operation('queued');
    },
  };
  const manifest = createBulkOccurrenceRemoveManifest(capture, { 'x-csrf-token': 'original' }, sender);
  const journey = new BulkOccurrenceRemoveJourney(
    capture,
    manifest,
    'viewer',
    { context: () => true, read: () => true, write: () => true },
    async (address) => {
      addresses.push(address);
      return readyRead();
    },
    () => {},
  );
  expect(await journey.preview()).toBe(true);
  expect(await journey.confirm()).toBe(false);
  const original = confirmCalls[0]!;
  expect(await journey.read()).toBe(true);
  expect(await journey.confirm(true)).toBe(true);
  expect(previewCalls).toEqual([manifest.preview]);
  expect(confirmCalls).toHaveLength(2);
  expect(confirmCalls[1]).toBe(original);
  expect(confirmCalls[1]).toEqual({
    body: '{}',
    headers: { 'x-csrf-token': 'original' },
    idempotencyKey: manifest.confirm.idempotencyKey,
    operationId: operation().id,
  });
  expect(addresses).toEqual([{ id: operation().id, viewer: 'viewer' }]);
});

test('private result reads do not require write admission', async () => {
  const capture = captureSelection();
  let writeAdmitted = true;
  let confirms = 0;
  const sender: BulkOccurrenceRemoveSender = {
    preview: async () => operation(),
    confirm: async () => {
      confirms += 1;
      return operation('queued');
    },
  };
  const manifest = createBulkOccurrenceRemoveManifest(capture, { 'x-csrf-token': 'captured' }, sender);
  const journey = new BulkOccurrenceRemoveJourney(
    capture,
    manifest,
    'viewer',
    { context: () => true, read: () => true, write: () => writeAdmitted },
    async () => readyRead(),
    () => {},
  );
  expect(await journey.preview()).toBe(true);
  writeAdmitted = false;
  expect(await journey.read()).toBe(true);
  expect(await journey.confirm()).toBe(false);
  expect(confirms).toBe(0);
});

test('retirement prevents late preview responses from reviving the captured operation', async () => {
  const capture = captureSelection();
  let admitted = true;
  let resolvePreview!: (value: BulkStatusOperation) => void;
  let previewCount = 0;
  const sender: BulkOccurrenceRemoveSender = {
    preview: async () => {
      previewCount += 1;
      return await new Promise<BulkStatusOperation>((resolve) => {
        resolvePreview = resolve;
      });
    },
    confirm: async () => operation('queued'),
  };
  const manifest = createBulkOccurrenceRemoveManifest(capture, {}, sender);
  const journey = new BulkOccurrenceRemoveJourney(
    capture,
    manifest,
    'viewer',
    { context: () => admitted, read: () => admitted, write: () => admitted },
    async () => readyRead(),
    () => {},
  );
  const pending = journey.preview();
  admitted = false;
  expect(journey.retireIfStale()).toBe(true);
  resolvePreview(operation());
  expect(await pending).toBe(false);
  expect(journey.state).toEqual({ phase: 'retired' });
  expect(journey.capture).toBeUndefined();
  admitted = true;
  expect(await journey.preview(true)).toBe(false);
  expect(previewCount).toBe(1);
});

test('stored outcomes show removed, changed, missing and failed targets inline', () => {
  const changed = outcome({ ordinal: '1', state: 'conflict', reason: 'revision_mismatch' });
  const missing = outcome({ ordinal: '2', state: 'no_effect', reason: 'missing_target' });
  const failed = outcome({ ordinal: '3', state: 'failed', reason: 'dependency_unavailable' });
  const view = renderToStaticMarkup(
    <BulkOccurrenceRemoveJourneyControls
      state={{
        phase: 'confirmed',
        operation: operation('completed'),
        read: readyRead([outcome(), changed, missing, failed]),
      }}
      canWrite
      onPreview={() => {}}
      onRetryPreview={() => {}}
      onConfirm={() => {}}
      onRetryConfirm={() => {}}
      onRead={() => {}}
      onReadMore={() => {}}
    />,
  );
  expect(view).toContain('Removed');
  expect(view).toContain('Changed since preview; skipped');
  expect(view).toContain('Missing since preview; skipped');
  expect(view).toContain('Failed');
});

test('Undo requires an applied selected occurrence and its original unexpired native receipt', () => {
  const capture = captureSelection();
  const first = capture.targets[0]!;
  const native = outcome({
    memberId: first.memberId,
    subjectId: first.subjectId,
    memberDeletion: {
      deletionId: '0192f3a0-6c1e-7b2a-9d4e-000000000099',
      revision: 7,
      purgeAfter: '2099-11-03T00:00:00.000Z',
    },
  });
  expect(bulkOccurrenceRemoveUndoReceipt(capture, operation(), native, Date.parse('2099-11-02T00:00:00.000Z'))).toEqual(
    {
      collectionId: collection.collection.id,
      memberId: first.memberId,
      deletionId: '0192f3a0-6c1e-7b2a-9d4e-000000000099',
      revision: 7,
      purgeAfter: '2099-11-03T00:00:00.000Z',
    },
  );
  expect(
    bulkOccurrenceRemoveUndoReceipt(
      capture,
      operation(),
      { ...native, state: 'failed' },
      Date.parse('2099-11-02T00:00:00.000Z'),
    ),
  ).toBeUndefined();
  expect(bulkOccurrenceRemoveUndoReceipt(capture, operation(), { ...native, memberDeletion: null })).toBeUndefined();
  expect(bulkOccurrenceRemoveUndoReceipt(capture, operation(), { ...native, memberId: 'unselected' })).toBeUndefined();
  expect(
    bulkOccurrenceRemoveUndoReceipt(
      capture,
      operation(),
      { ...native, memberDeletion: { ...native.memberDeletion!, purgeAfter: '2026-11-02T00:00:00.000Z' } },
      Date.parse('2026-11-03T00:00:00.000Z'),
    ),
  ).toBeUndefined();
  expect(
    bulkOccurrenceRemoveRestoreAvailable(
      native.memberDeletion!.purgeAfter,
      true,
      Date.parse('2099-11-02T00:00:00.000Z'),
    ),
  ).toBe(true);
  expect(
    bulkOccurrenceRemoveRestoreAvailable(
      native.memberDeletion!.purgeAfter,
      false,
      Date.parse('2099-11-02T00:00:00.000Z'),
    ),
  ).toBe(false);
  expect(
    bulkOccurrenceRemoveRestoreAvailable(
      native.memberDeletion!.purgeAfter,
      true,
      Date.parse('2099-11-04T00:00:00.000Z'),
    ),
  ).toBe(false);
  expect(
    bulkOccurrenceRemoveRestoreAvailable(
      native.memberDeletion!.purgeAfter,
      true,
      Date.parse('2099-11-04T00:00:00.000Z'),
      true,
    ),
  ).toBe(true);
  expect(
    bulkOccurrenceRemoveRestoreAvailable(
      native.memberDeletion!.purgeAfter,
      false,
      Date.parse('2099-11-04T00:00:00.000Z'),
      true,
    ),
  ).toBe(false);
  expect(bulkOccurrenceRemoveResultKind({ ...native, reason: 'missing_target' })).toBe('removed');
});

test('the existing native result decoder preserves an installed member deletion receipt', () => {
  const memberDeletion = {
    deletionId: '0192f3a0-6c1e-7b2a-9d4e-000000000099',
    revision: 7,
    purgeAfter: '2099-11-03T00:00:00.000Z',
  };
  const wireOutcome = {
    ordinal: '0',
    subjectId: members.members[0]!.subjectId,
    memberId: members.members[0]!.id,
    state: 'applied' as const,
    reason: null,
    resultingMemberId: null,
    memberDeletion,
  };
  const read: BulkRead = {
    state: 'ready',
    operation: operation('completed'),
    page: { outcomes: [wireOutcome], next: null },
  };
  const decoded = receiveUndoEvidence(read);
  expect(decoded.state === 'ready' && decoded.page.outcomes[0]?.memberDeletion).toEqual(memberDeletion);
});
