import type { KernelClient } from '@rezics/client';
import type { FilterDocument } from '@rezics/filter';
import type { BulkOperation, BulkOutcomes, BulkRead, OperationAddress } from './bulk-operation-recovery-native';

export type RemovalOperation = BulkOperation;
export type RemovalOutcome = BulkOutcomes['outcomes'][number];
type NativeRequest = Parameters<KernelClient['libraryOperations']['post']>[0];
export type RemovalRequest = Extract<NativeRequest, { action: 'remove_from_collection' }> & {
  selection: { kind: 'query'; sourceId: string; filter?: string };
};
export type RemovalResult =
  | { state: 'ready'; operation: RemovalOperation }
  | { state: 'preparing' | 'unavailable' | 'refused' | 'uncertain' };
export type RemovalCall = Readonly<{
  viewer: string;
  body: string;
  headers: Readonly<Record<string, string>>;
  idempotencyKey: string;
  credential: string;
}>;
export type RemovalSender = {
  prepare: (input: { viewer: string; headers: Readonly<Record<string, string>> }) => Promise<string | null>;
  preview: (call: RemovalCall) => Promise<RemovalResult>;
  confirm: (call: RemovalCall & Readonly<{ operationId: string }>) => Promise<RemovalResult>;
};
export function filteredOccurrenceRemovalManifest(
  source: Readonly<{ id: string; title: string }>,
  filter: FilterDocument | undefined,
  viewer: string,
  headers: Readonly<Record<string, string>>,
  sender: RemovalSender,
) {
  const request: RemovalRequest = { action: 'remove_from_collection', collectionId: source.id,
    selection: { kind: 'query', sourceId: source.id, ...(filter ? { filter: JSON.stringify(filter) } : {}) } };
  const body = JSON.stringify(request);
  if (new TextEncoder().encode(body).byteLength > 64 * 1024) throw new Error('Bulk command exceeds 64 KiB');
  const capturedHeaders = Object.freeze({ ...headers });
  const basis = { viewer, headers: capturedHeaders };
  return Object.freeze({
    source: Object.freeze({ ...source }),
    preview: Object.freeze({ ...basis, body, idempotencyKey: crypto.randomUUID() }),
    confirm: Object.freeze({ ...basis, body: '{}', idempotencyKey: crypto.randomUUID() }),
    sender: Object.freeze({ ...sender }),
  });
}
type Manifest = ReturnType<typeof filteredOccurrenceRemovalManifest>;
type Phase = 'review' | 'previewing' | 'previewed' | 'preparing' | 'unavailable' | 'refused' |
  'preview_uncertain' | 'confirming' | 'confirmation_uncertain' | 'confirmed' | 'retired';
export type RemovalState = Readonly<{
  phase: Phase;
  operation?: RemovalOperation;
  read?: BulkRead;
  reading?: boolean;
}>;
type Admission = { context: () => boolean; read: () => boolean; preview: () => boolean; confirm: () => boolean };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/** Only native admission captures the population. Recovery reads one stored page and never renews a command. */
export class FilteredOccurrenceRemoval {
  state: RemovalState = { phase: 'review' };
  private manifest?: Manifest;
  private previewCall?: RemovalCall;
  private confirmCall?: RemovalCall & Readonly<{ operationId: string }>;
  private credential?: string;
  constructor(manifest: Manifest, private admission: Admission,
    private reader: (address: OperationAddress) => Promise<BulkRead>, private changed: () => void) {
    this.manifest = manifest;
  }
  get source() { return this.manifest?.source; }
  get busy() { return !!this.state.reading || this.state.phase === 'previewing' || this.state.phase === 'confirming'; }
  private current(kind: keyof Admission) {
    if (!this.manifest) return false;
    if (!this.admission.context()) { this.retire(); return false; }
    return this.admission[kind]();
  }
  retire() {
    this.manifest = undefined;
    this.previewCall = undefined;
    this.confirmCall = undefined;
    this.credential = undefined;
    this.state = { phase: 'retired' };
  }
  retireIfStale() { if (!this.admission.context()) this.retire(); return !this.manifest; }
  private publish(state: RemovalState) { this.state = state; this.changed(); }
  private matches(operation: RemovalOperation) {
    const manifest = this.manifest;
    const source = operation.selectionSource;
    if (!manifest || operation.action !== 'remove_from_collection' || operation.selectionKind !== 'query' ||
      operation.collectionId !== manifest.source.id || !source || source.id !== manifest.source.id ||
      source.membershipKind !== 'curated' || !source.sourceDigest || !operation.selectionComplete ||
      !operation.occurrencesComplete || !Number.isSafeInteger(operation.counts.targets) ||
      operation.counts.targets < 0 || operation.counts.targets > 1000 ||
      operation.counts.capturedOccurrences !== operation.counts.targets) return false;
    try {
      const request: RemovalRequest = JSON.parse(manifest.preview.body);
      return canonical(source.filter === null ? null : JSON.parse(source.filter)) ===
        canonical(request.selection.filter === undefined ? null : JSON.parse(request.selection.filter));
    } catch { return false; }
  }
  async preview(retry = false) {
    if (!this.current('preview') || this.busy || !this.manifest ||
      (retry ? !['preparing', 'unavailable', 'preview_uncertain'].includes(this.state.phase) : this.state.phase !== 'review'))
      return false;
    const manifest = this.manifest;
    this.publish({ phase: 'previewing' });
    let result: RemovalResult;
    try {
      // Credential capture precedes the first native dispatch; a lost response cannot cause recapture.
      if (!this.credential) {
        const credential = await manifest.sender.prepare(manifest.preview);
        if (!this.current('context')) return false;
        if (!credential) { this.publish({ phase: 'unavailable' }); return false; }
        this.credential = credential;
      }
      if (!this.current('preview')) { this.publish({ phase: 'unavailable' }); return false; }
      this.previewCall ??= Object.freeze({ ...manifest.preview, credential: this.credential });
      result = await manifest.sender.preview(this.previewCall);
    } catch { result = { state: 'uncertain' }; }
    if (!this.current('context')) return false;
    if (result.state !== 'ready') {
      this.publish({ phase: result.state === 'uncertain' ? 'preview_uncertain' : result.state });
      return false;
    }
    if (!this.matches(result.operation) || result.operation.phase !== 'preview') {
      this.publish({ phase: 'preview_uncertain' }); return false;
    }
    this.publish({ phase: 'previewed', operation: result.operation });
    return true;
  }
  async confirm(retry = false) {
    if (!this.current('confirm') || this.busy || !this.manifest || !this.credential) return false;
    if (retry) {
      if (this.state.phase !== 'confirmation_uncertain' || !this.confirmCall) return false;
    } else {
      const operation = this.state.operation;
      if (this.state.phase !== 'previewed' || !operation || !this.matches(operation) ||
        operation.counts.targets === 0 || !(Date.parse(operation.expiresAt) > Date.now())) return false;
      this.confirmCall = Object.freeze({ ...this.manifest.confirm, operationId: operation.id, credential: this.credential });
    }
    const manifest = this.manifest;
    const call = this.confirmCall!;
    this.publish({ ...this.state, phase: 'confirming' });
    let result: RemovalResult;
    try { result = await manifest.sender.confirm(call); } catch { result = { state: 'uncertain' }; }
    if (!this.current('context')) return false;
    if (result.state !== 'ready' || result.operation.id !== call.operationId || !this.matches(result.operation)) {
      this.publish({ ...this.state, phase: 'confirmation_uncertain' }); return false;
    }
    this.publish({ ...this.state, phase: 'confirmed', operation: result.operation });
    return true;
  }
  async read(cursor?: string) {
    if (!this.current('read') || this.busy || !this.state.operation || !this.manifest) return false;
    const id = this.state.operation.id;
    const viewer = this.manifest.preview.viewer;
    this.publish({ ...this.state, reading: true });
    let read: BulkRead;
    try { read = await this.reader({ id, viewer, ...(cursor === undefined ? {} : { cursor }) }); }
    catch { read = { state: 'unavailable' }; }
    if (!this.current('context')) return false;
    if (!this.current('read')) { this.publish({ ...this.state, reading: false }); return false; }
    if (read.state === 'ready' && (read.operation.id !== id || !this.matches(read.operation))) read = { state: 'unavailable' };
    // A read cannot turn a lost confirmation into a newly prepared command or change its original deadline.
    this.publish({ ...this.state, reading: false, read });
    return read.state === 'ready';
  }
}
