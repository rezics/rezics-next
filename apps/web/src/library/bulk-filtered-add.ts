import type { CollectionDestination } from './collection-read';
import type {
  FilteredAddCommand,
  FilteredAddOperation,
  FilteredAddRequest,
  FilteredAddResult,
  FilteredAddRead,
} from './bulk-filtered-add-native';

export type FilteredAddSource = Readonly<{ id: string; filter?: unknown }>;
export type FilteredAddCapture = Readonly<{
  ok: true;
  request: FilteredAddRequest;
  body: string;
  destination: Readonly<CollectionDestination>;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Stable JSON retains array order and every predicate; native admission still owns filter semantics. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : item,
  );
}

export function captureFilteredAdd(
  source: FilteredAddSource,
  destination: CollectionDestination,
): FilteredAddCapture | { ok: false; reason: 'unsupported' | 'limit' } {
  if (
    !uuid.test(source.id) ||
    !uuid.test(destination.id) ||
    !Number.isSafeInteger(destination.revision) ||
    destination.revision < 1
  )
    return { ok: false, reason: 'unsupported' };
  if (
    source.filter !== undefined &&
    (!source.filter || typeof source.filter !== 'object' || Array.isArray(source.filter))
  )
    return { ok: false, reason: 'unsupported' };
  const filter = source.filter === undefined ? undefined : stable(source.filter);
  const request: FilteredAddRequest = {
    action: 'add_to_collection',
    collectionId: destination.id.toLowerCase(),
    selection: { kind: 'query', sourceId: source.id.toLowerCase(), ...(filter === undefined ? {} : { filter }) },
  };
  const body = JSON.stringify(request);
  if (new TextEncoder().encode(body).byteLength > 64 * 1024) return { ok: false, reason: 'limit' };
  Object.freeze(request.selection);
  return Object.freeze({
    ok: true,
    request: Object.freeze(request),
    body,
    destination: Object.freeze({ ...destination }),
  });
}

export type FilteredAddPort = Readonly<{
  capture: (
    capture: FilteredAddCapture,
    csrf: string,
  ) => Promise<{ state: 'captured'; command: FilteredAddCommand } | { state: 'changed' | 'forbidden' | 'unavailable' }>;
  preview: (command: FilteredAddCommand) => Promise<FilteredAddResult>;
  confirm: (command: FilteredAddCommand, operationId: string) => Promise<FilteredAddResult>;
  read: (operationId: string, cursor?: string) => Promise<FilteredAddRead>;
}>;
export type FilteredAddState = {
  phase:
    | 'review'
    | 'previewing'
    | 'previewed'
    | 'confirming'
    | 'confirmed'
    | 'retired'
    | 'preparing'
    | 'unsupported'
    | 'limit'
    | 'changed'
    | 'forbidden'
    | 'unavailable'
    | 'preview_uncertain'
    | 'confirmation_uncertain';
  operation?: FilteredAddOperation;
  read?: FilteredAddRead;
  reading?: boolean;
};

function matches(capture: FilteredAddCapture, operation: FilteredAddOperation) {
  const source = operation.selectionSource;
  return (
    operation.action === 'add_to_collection' &&
    operation.collectionId === capture.request.collectionId &&
    operation.selectionKind === 'query' &&
    source?.id === capture.request.selection.sourceId &&
    source.sort === null &&
    source.filter === (capture.request.selection.filter ?? null) &&
    operation.selectionComplete &&
    operation.occurrencesComplete &&
    source.selectedSubjects === operation.counts.targets &&
    source.selectedSubjects === operation.counts.selectedSubjects &&
    /^[0-9a-f]{64}$/.test(source.sourceDigest)
  );
}

/** Mounted command ownership; reading progress never changes either original command or its capture. */
export class FilteredAddJourney {
  state: FilteredAddState = { phase: 'review' };
  private command: FilteredAddCommand | undefined;
  private busy = false;
  constructor(
    readonly capture: FilteredAddCapture,
    private current: () => boolean,
    private write: () => boolean,
    private port: FilteredAddPort,
    private changed: () => void,
    private reviewCurrent = current,
  ) {}
  retire() {
    this.state = { phase: 'retired' };
    this.command = undefined;
  }
  private active() {
    if (!this.current()) this.retire();
    return this.state.phase !== 'retired';
  }
  async preview(csrf: string) {
    if (
      !this.active() ||
      !this.write() ||
      !csrf ||
      this.busy ||
      !['review', 'preparing', 'unavailable', 'preview_uncertain'].includes(this.state.phase)
    )
      return;
    this.busy = true;
    this.state = { phase: 'previewing' };
    this.changed();
    try {
      if (!this.command) {
        const result = await this.port.capture(this.capture, csrf);
        if (!this.active()) return;
        if (result.state !== 'captured') {
          this.state = { phase: result.state };
          return;
        }
        this.command = Object.freeze(result.command);
      }
      const result = await this.port.preview(this.command);
      if (!this.active()) return;
      if (result.state !== 'ready') {
        this.state = { phase: result.state === 'uncertain' ? 'preview_uncertain' : result.state };
      } else if (result.operation.counts.targets > 1000) this.state = { phase: 'limit' };
      else if (
        !matches(this.capture, result.operation) ||
        result.operation.phase !== 'preview' ||
        !this.reviewCurrent()
      )
        this.state = { phase: 'changed' };
      else this.state = { phase: 'previewed', operation: result.operation };
    } catch {
      if (this.active()) this.state = { phase: 'preview_uncertain' };
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async confirm() {
    if (
      !this.active() ||
      !this.write() ||
      this.busy ||
      !this.command ||
      !['previewed', 'confirmation_uncertain'].includes(this.state.phase) ||
      !this.state.operation
    )
      return;
    if (this.state.phase === 'previewed' && !this.reviewCurrent()) {
      this.state = { phase: 'changed' };
      this.changed();
      return;
    }
    const operation = this.state.operation;
    this.busy = true;
    this.state = { phase: 'confirming', operation };
    this.changed();
    try {
      const result = await this.port.confirm(this.command, operation.id);
      if (!this.active()) return;
      if (
        result.state === 'ready' &&
        result.operation.id === operation.id &&
        matches(this.capture, result.operation) &&
        result.operation.selectionSource?.sourceDigest === operation.selectionSource?.sourceDigest
      )
        this.state = { phase: 'confirmed', operation: result.operation };
      else
        this.state = {
          phase: result.state === 'ready' || result.state === 'uncertain' ? 'confirmation_uncertain' : result.state,
          operation,
        };
    } catch {
      if (this.active()) this.state = { phase: 'confirmation_uncertain', operation };
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async read(cursor?: string) {
    if (!this.active() || this.busy || !this.state.operation) return;
    const original = this.state.operation;
    this.busy = true;
    this.state = { ...this.state, reading: true };
    this.changed();
    try {
      const result = await this.port.read(original.id, cursor);
      if (!this.active()) return;
      if (
        result.state === 'ready' &&
        (result.operation.id !== original.id ||
          !matches(this.capture, result.operation) ||
          result.operation.selectionSource?.sourceDigest !== original.selectionSource?.sourceDigest)
      )
        this.state = { ...this.state, read: { state: 'unavailable' } };
      else
        this.state = {
          ...this.state,
          read: result,
          ...(result.state === 'ready' ? { operation: result.operation } : {}),
        };
    } catch {
      if (this.active()) this.state = { ...this.state, read: { state: 'unavailable' } };
    } finally {
      this.busy = false;
      this.state = { ...this.state, reading: false };
      this.changed();
    }
  }
}
