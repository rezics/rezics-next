import type { BulkOperation, OperationAddress } from './bulk-operation-recovery-native';
import type { BulkUndoOutcome, BulkUndoRead } from './bulk-operation-undo-evidence';
import type {
  BulkStatusConfirmCall,
  BulkStatusOperation,
  BulkStatusPreviewCall,
  BulkStatusSender,
} from './bulk-status';

type LoadedOccurrence = Readonly<{
  id: string;
  subjectId?: string;
  subject: Readonly<{ id: string }> | null;
}>;

export type BulkOccurrenceRemoveCapture = Readonly<{
  ok: true;
  source: Readonly<{ id: string; title: string }>;
  targets: readonly Readonly<{ memberId: string; subjectId: string }>[];
}>;

export type BulkOccurrenceRemoveSelection =
  | BulkOccurrenceRemoveCapture
  | Readonly<{ ok: false; reason: 'empty' | 'limit' | 'unavailable' }>;

/** Capture loaded selection only. Native preview owns persistence, expectations and admission. */
export function captureBulkOccurrenceRemove(
  source: Readonly<{ id: string; title: string }>,
  loaded: readonly LoadedOccurrence[],
  selectedIds: ReadonlySet<string>,
): BulkOccurrenceRemoveSelection {
  if (!selectedIds.size) return { ok: false, reason: 'empty' };
  if (selectedIds.size > 1_000) return { ok: false, reason: 'limit' };

  // Index only selected occurrences. An unavailable unselected row cannot broaden this capture.
  const selected = new Map<string, LoadedOccurrence>();
  for (const member of loaded) {
    if (!selectedIds.has(member.id)) continue;
    if (selected.has(member.id)) return { ok: false, reason: 'unavailable' };
    selected.set(member.id, member);
  }
  const targets: { readonly memberId: string; readonly subjectId: string }[] = [];
  for (const memberId of selectedIds) {
    const member = selected.get(memberId);
    const subjectId = member?.subject?.id;
    if (!member || !subjectId || (member.subjectId !== undefined && member.subjectId !== subjectId))
      return { ok: false, reason: 'unavailable' };
    // Distinct member IDs remain distinct even when their Subject is the same.
    targets.push(Object.freeze({ memberId, subjectId }));
  }
  return Object.freeze({
    ok: true,
    source: Object.freeze({ id: source.id, title: source.title }),
    targets: Object.freeze(targets),
  });
}

export type BulkOccurrenceRemovePreviewRequest = Readonly<{
  action: 'remove_from_collection';
  collectionId: string;
  selection: Readonly<{ kind: 'occurrences'; memberIds: readonly string[] }>;
}>;

export type BulkOccurrenceRemoveSender = Pick<BulkStatusSender, 'preview' | 'confirm'>;
export type BulkOccurrenceRemoveManifest = Readonly<{
  preview: BulkStatusPreviewCall;
  confirm: Omit<BulkStatusConfirmCall, 'operationId'>;
  sender: BulkOccurrenceRemoveSender;
}>;

/** Freeze the detached source and selected occurrence IDs before native admission. */
export function createBulkOccurrenceRemoveManifest(
  capture: BulkOccurrenceRemoveCapture,
  headers: Readonly<Record<string, string>>,
  sender: BulkOccurrenceRemoveSender,
): BulkOccurrenceRemoveManifest {
  const capturedHeaders = Object.freeze({ ...headers });
  const request: BulkOccurrenceRemovePreviewRequest = Object.freeze({
    action: 'remove_from_collection',
    collectionId: capture.source.id,
    selection: Object.freeze({
      kind: 'occurrences',
      memberIds: Object.freeze(capture.targets.map(({ memberId }) => memberId)),
    }),
  });
  return Object.freeze({
    preview: Object.freeze({
      body: JSON.stringify(request),
      headers: capturedHeaders,
      idempotencyKey: crypto.randomUUID(),
    }),
    confirm: Object.freeze({
      body: '{}',
      headers: capturedHeaders,
      idempotencyKey: crypto.randomUUID(),
    }),
    sender,
  });
}

export type BulkOccurrenceRemovePhase =
  | 'review'
  | 'previewing'
  | 'preview_uncertain'
  | 'previewed'
  | 'confirming'
  | 'confirmation_uncertain'
  | 'confirmed'
  | 'retired';

type BulkOperationSnapshot = BulkStatusOperation | BulkOperation;
export type BulkOccurrenceRemoveJourneyState = Readonly<{
  phase: BulkOccurrenceRemovePhase;
  operation?: BulkOperationSnapshot;
  read?: BulkUndoRead;
  reading?: boolean;
}>;
export type BulkOccurrenceRemoveReader = (address: OperationAddress) => Promise<BulkUndoRead>;

type CurrentAdmission = {
  context: () => boolean;
  read: () => boolean;
  write: () => boolean;
};

/** Mounted memory only; result recovery never replaces the captured preview or confirmation command. */
export class BulkOccurrenceRemoveJourney {
  state: BulkOccurrenceRemoveJourneyState = { phase: 'review' };
  private captureValue: BulkOccurrenceRemoveCapture | undefined;
  private manifestValue: BulkOccurrenceRemoveManifest | undefined;
  private confirmCall: BulkStatusConfirmCall | undefined;
  private retired = false;
  private reading = false;

  constructor(
    capture: BulkOccurrenceRemoveCapture,
    manifest: BulkOccurrenceRemoveManifest,
    private viewer: string,
    private admission: CurrentAdmission,
    private reader: BulkOccurrenceRemoveReader,
    private changed: () => void,
  ) {
    this.captureValue = capture;
    this.manifestValue = manifest;
  }

  get capture() {
    return this.captureValue;
  }

  get busy() {
    return this.reading || this.state.phase === 'previewing' || this.state.phase === 'confirming';
  }

  private current(kind: keyof CurrentAdmission) {
    if (this.retired) return false;
    if (!this.admission.context()) {
      this.retire();
      return false;
    }
    return this.admission[kind]();
  }

  retire() {
    if (this.retired) return;
    this.retired = true;
    this.captureValue = undefined;
    this.manifestValue = undefined;
    this.confirmCall = undefined;
    this.state = { phase: 'retired' };
  }

  retireIfStale() {
    if (this.retired) return true;
    if (this.admission.context()) return false;
    this.retire();
    return true;
  }

  async preview(retry = false) {
    const expected = retry ? 'preview_uncertain' : 'review';
    if (!this.current('write') || this.state.phase !== expected || !this.manifestValue) return false;
    const manifest = this.manifestValue;
    this.state = { phase: 'previewing' };
    this.changed();
    try {
      const operation = await manifest.sender.preview(manifest.preview);
      if (!this.current('write')) return false;
      const capture = this.captureValue;
      if (
        !capture ||
        operation.action !== 'remove_from_collection' ||
        operation.selectionKind !== 'occurrences' ||
        operation.collectionId !== capture.source.id
      ) {
        this.state = { phase: 'preview_uncertain' };
        this.changed();
        return false;
      }
      this.state = { phase: 'previewed', operation };
      this.changed();
      return true;
    } catch {
      if (!this.current('write')) return false;
      this.state = { phase: 'preview_uncertain' };
      this.changed();
      return false;
    }
  }

  async confirm(retry = false) {
    if (!this.current('write') || !this.manifestValue) return false;
    if (retry) {
      if (this.state.phase !== 'confirmation_uncertain' || !this.confirmCall) return false;
    } else {
      if (this.state.phase !== 'previewed' || !this.state.operation) return false;
      this.confirmCall = Object.freeze({
        ...this.manifestValue.confirm,
        operationId: this.state.operation.id,
      });
    }
    const manifest = this.manifestValue;
    const call = this.confirmCall!;
    this.state = { ...this.state, phase: 'confirming' };
    this.changed();
    try {
      const operation = await manifest.sender.confirm(call);
      if (!this.current('write')) return false;
      if (operation.id !== call.operationId || operation.action !== 'remove_from_collection') {
        this.state = { ...this.state, phase: 'confirmation_uncertain' };
        this.changed();
        return false;
      }
      this.state = { ...this.state, phase: 'confirmed', operation };
      this.changed();
      return true;
    } catch {
      if (!this.current('write')) return false;
      this.state = { ...this.state, phase: 'confirmation_uncertain' };
      this.changed();
      return false;
    }
  }

  async read(cursor?: string) {
    if (!this.current('read') || this.reading || !this.state.operation) return false;
    const operationId = this.state.operation.id;
    const address: OperationAddress = {
      id: operationId,
      viewer: this.viewer,
      ...(cursor === undefined ? {} : { cursor }),
    };
    this.reading = true;
    this.state = { ...this.state, reading: true };
    this.changed();
    let result: BulkUndoRead;
    try {
      result = await this.reader(address);
    } catch {
      result = { state: 'unavailable' };
    }
    this.reading = false;
    if (!this.current('read')) return false;
    if (result.state === 'ready' && result.operation.id !== operationId) result = { state: 'unavailable' };
    this.state = { ...this.state, reading: false, read: result };
    this.changed();
    return result.state === 'ready';
  }
}

export type BulkOccurrenceRemoveResultKind = 'removed' | 'changed' | 'missing' | 'skipped' | 'failed' | 'pending';

export function bulkOccurrenceRemoveResultKind(outcome: BulkUndoOutcome): BulkOccurrenceRemoveResultKind {
  if (outcome.state === 'applied') return 'removed';
  if (outcome.state === 'pending' || outcome.state === 'reconciling') return 'pending';
  if (outcome.state === 'failed' || outcome.state === 'denied') return 'failed';
  if (outcome.reason === 'revision_mismatch' || outcome.reason === 'incarnation_mismatch') return 'changed';
  if (outcome.reason === 'missing_target') return 'missing';
  if (outcome.state === 'conflict' || outcome.state === 'no_effect' || outcome.state === 'cancelled') return 'skipped';
  return 'failed';
}

export type BulkOccurrenceRemoveUndoReceipt = Readonly<{
  collectionId: string;
  memberId: string;
  deletionId: string;
  revision: number;
  purgeAfter: string;
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function bulkOccurrenceRemoveRestoreAvailable(
  purgeAfter: string | undefined,
  currentRestoreAdmission: boolean,
  now = Date.now(),
  uncertainRetry = false,
): boolean {
  return (
    currentRestoreAdmission &&
    (uncertainRetry ||
      purgeAfter === undefined ||
      (Number.isFinite(Date.parse(purgeAfter)) && Date.parse(purgeAfter) > now))
  );
}

/** Accept only the exact stored receipt for a selected occurrence and its original live deadline. */
export function bulkOccurrenceRemoveUndoReceipt(
  capture: BulkOccurrenceRemoveCapture,
  operation: BulkOperationSnapshot,
  outcome: BulkUndoOutcome,
  now = Date.now(),
): BulkOccurrenceRemoveUndoReceipt | undefined {
  const receipt = outcome.memberDeletion;
  const target = outcome.memberId && capture.targets.find((item) => item.memberId === outcome.memberId);
  if (
    operation.action !== 'remove_from_collection' ||
    operation.selectionKind !== 'occurrences' ||
    operation.collectionId !== capture.source.id ||
    outcome.state !== 'applied' ||
    !target ||
    target.subjectId !== outcome.subjectId ||
    !receipt ||
    !uuid.test(receipt.deletionId) ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision < 1 ||
    !Number.isFinite(Date.parse(receipt.purgeAfter)) ||
    Date.parse(receipt.purgeAfter) <= now
  )
    return;
  return Object.freeze({
    collectionId: capture.source.id,
    memberId: target.memberId,
    deletionId: receipt.deletionId,
    revision: receipt.revision,
    purgeAfter: receipt.purgeAfter,
  });
}
