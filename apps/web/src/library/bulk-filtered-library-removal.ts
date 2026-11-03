import type { Kernel } from '@rezics/client';
import type { FilterDocument } from '@rezics/filter';
import type { BulkUndoRead, BulkUndoOutcome } from './bulk-operation-undo-evidence';

type Routes = Kernel['~Routes']['v1']['libraryOperations'];
export type FilteredRemovalOperation = Routes[':operationId']['get']['response'][200]['operation'];
type NativeRemoval = Extract<Routes['post']['body'], { action: 'remove_from_library' }>;
export type FilteredRemovalRequest = NativeRemoval & {
  selection: Extract<NativeRemoval['selection'], { kind: 'query' }>;
};
export type FilteredRemovalSource = { id: string; filter?: FilterDocument };

/** No loaded members, browser revisions or entry expectations enter native complete capture. */
export function filteredRemovalRequest(source: FilteredRemovalSource): FilteredRemovalRequest {
  const request: FilteredRemovalRequest = {
    action: 'remove_from_library',
    selection: {
      kind: 'query',
      sourceId: source.id,
      ...(source.filter === undefined ? {} : { filter: JSON.stringify(source.filter) }),
      sort: 'id',
    },
  };
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 64 * 1024)
    throw new RangeError('Bulk command exceeds 64 KiB');
  Object.freeze(request.selection);
  return Object.freeze(request);
}

export type FilteredRemovalCall = Readonly<{ capture: string; headers: Readonly<Record<string, string>> }>;
export type FilteredRemovalPreview =
  | { state: 'ready'; operation: FilteredRemovalOperation; confirmation: string }
  | { state: 'preparing' | 'unavailable' | 'unsupported' | 'refused' | 'uncertain' };
export type FilteredRemovalConfirmation =
  | { state: 'ready'; operation: FilteredRemovalOperation }
  | { state: 'refused' | 'uncertain' };
export type FilteredRemovalTransport = {
  capture: (input: {
    request: FilteredRemovalRequest;
    viewer: string;
    locale: string;
    headers: Readonly<Record<string, string>>;
  }) => Promise<string>;
  preview: (call: FilteredRemovalCall) => Promise<FilteredRemovalPreview>;
  confirm: (call: FilteredRemovalCall) => Promise<FilteredRemovalConfirmation>;
  read: (address: { id: string; viewer: string; cursor?: string }) => Promise<BulkUndoRead>;
};
type AdmissionKind = 'preview' | 'confirm' | 'read';
type Admission = {
  context: () => boolean;
  allowed: (kind: AdmissionKind) => boolean;
  capture: (kind: AdmissionKind) => () => boolean;
};
type Phase =
  | 'idle'
  | 'capturing'
  | 'previewing'
  | 'preview_uncertain'
  | 'preparing'
  | 'unavailable'
  | 'unsupported'
  | 'refused'
  | 'review'
  | 'confirming'
  | 'confirmation_uncertain'
  | 'running'
  | 'retired';
export type FilteredRemovalState = {
  phase: Phase;
  operation?: FilteredRemovalOperation;
  observedOperation?: FilteredRemovalOperation;
  page?: { outcomes: BulkUndoOutcome[]; next: string | null } | undefined;
  reading?: boolean;
  readFailure?: BulkUndoRead['state'] | undefined;
};

/** One mounted intent. Reads replace one result page and never replace either command. */
export class FilteredLibraryRemoval {
  state: FilteredRemovalState = { phase: 'idle' };
  private previewCall: FilteredRemovalCall | undefined;
  private confirmationCall: FilteredRemovalCall | undefined;
  private live = true;
  private reading = false;
  private headers: Readonly<Record<string, string>>;
  constructor(
    readonly request: FilteredRemovalRequest,
    readonly viewer: string,
    readonly locale: string,
    headers: Readonly<Record<string, string>>,
    readonly transport: FilteredRemovalTransport,
    private admission: Admission,
    private changed: () => void,
  ) {
    this.headers = Object.freeze({ ...headers });
  }
  get busy() {
    return ['capturing', 'previewing', 'confirming'].includes(this.state.phase) || this.reading;
  }
  private current(kind: AdmissionKind) {
    if (!this.live) return false;
    if (!this.admission.context()) {
      this.retire();
      return false;
    }
    return this.admission.allowed(kind);
  }
  retire() {
    this.live = false;
    this.previewCall = undefined;
    this.confirmationCall = undefined;
    this.state = { phase: 'retired' };
  }
  private publish(state: FilteredRemovalState) {
    if (!this.live || !this.admission.context()) {
      this.retire();
      return;
    }
    this.state = state;
    this.changed();
  }
  private matches(operation: FilteredRemovalOperation) {
    return (
      operation.action === 'remove_from_library' &&
      operation.selectionKind === 'query' &&
      operation.collectionId === null &&
      operation.selectionSource?.id === this.request.selection.sourceId &&
      operation.selectionComplete &&
      operation.counts.targets <= 1000
    );
  }
  async preview() {
    if (
      !this.current('preview') ||
      this.busy ||
      ['review', 'running', 'confirmation_uncertain'].includes(this.state.phase)
    )
      return;
    const admitted = this.admission.capture('preview');
    try {
      if (!this.previewCall) {
        this.publish({ phase: 'capturing' });
        const capture = await this.transport.capture({
          request: this.request,
          viewer: this.viewer,
          locale: this.locale,
          headers: this.headers,
        });
        if (!this.current('preview') || !admitted()) {
          this.publish({ phase: 'idle' });
          return;
        }
        this.previewCall = Object.freeze({ capture, headers: this.headers });
      }
      this.publish({ phase: 'previewing' });
      const result = await this.transport.preview(this.previewCall);
      if (!this.current('preview') || !admitted()) {
        this.publish({ phase: 'preview_uncertain' });
        return;
      }
      if (result.state !== 'ready') {
        this.publish({ phase: result.state === 'uncertain' ? 'preview_uncertain' : result.state });
        return;
      }
      if (!this.matches(result.operation)) {
        this.publish({ phase: 'preview_uncertain' });
        return;
      }
      this.confirmationCall = Object.freeze({ capture: result.confirmation, headers: this.headers });
      this.publish({ phase: result.operation.phase === 'preview' ? 'review' : 'running', operation: result.operation });
    } catch {
      this.publish({ phase: this.previewCall ? 'preview_uncertain' : 'unavailable' });
    }
  }
  async confirm(retry = false) {
    if (
      !this.current('confirm') ||
      this.busy ||
      !this.confirmationCall ||
      !this.state.operation ||
      this.state.phase !== (retry ? 'confirmation_uncertain' : 'review')
    )
      return;
    const operation = this.state.operation;
    const admitted = this.admission.capture('confirm');
    this.publish({ ...this.state, phase: 'confirming' });
    try {
      const result = await this.transport.confirm(this.confirmationCall);
      if (
        !this.current('confirm') ||
        !admitted() ||
        result.state !== 'ready' ||
        result.operation.id !== operation.id ||
        !this.matches(result.operation)
      ) {
        this.publish({ ...this.state, phase: 'confirmation_uncertain' });
        return;
      }
      this.publish({ ...this.state, phase: 'running', operation: result.operation });
    } catch {
      this.publish({ ...this.state, phase: 'confirmation_uncertain' });
    }
  }
  async read(cursor?: string) {
    if (!this.current('read') || this.busy || !this.state.operation) return;
    const id = this.state.operation.id;
    const admitted = this.admission.capture('read');
    this.reading = true;
    this.publish({ ...this.state, reading: true, page: undefined, readFailure: undefined });
    let result: BulkUndoRead;
    try {
      result = await this.transport.read({ id, viewer: this.viewer, ...(cursor === undefined ? {} : { cursor }) });
    } catch {
      result = { state: 'unavailable' };
    }
    this.reading = false;
    if (!this.current('read') || !admitted()) {
      this.publish({ ...this.state, reading: false, page: undefined, readFailure: 'unavailable' });
      return;
    }
    if (result.state !== 'ready') {
      this.publish({ ...this.state, reading: false, readFailure: result.state });
      return;
    }
    if (result.operation.id !== id || !this.matches(result.operation)) {
      this.publish({ ...this.state, reading: false, readFailure: 'unavailable' });
      return;
    }
    // Keep the reviewed operation and exact uncertain confirmation; recovery cannot rebase them.
    this.publish({
      ...this.state,
      reading: false,
      page: result.page,
      readFailure: undefined,
      observedOperation: result.operation,
    });
  }
}
