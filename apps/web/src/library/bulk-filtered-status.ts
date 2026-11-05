import type { FilterDocument } from '@rezics/filter';
import type { Kernel } from '@rezics/client';
import { libraryEntryStateWrite } from './shelf-params';
import { collectionFilterQuery } from './collection-filter-params';
import type { BulkRead, OperationAddress } from './bulk-operation-recovery-native';

export type FilteredStatusOperation =
  Kernel['~Routes']['v1']['libraryOperations'][':operationId']['get']['response'][200]['operation'];
type Admission = Extract<Kernel['~Routes']['v1']['libraryOperations']['post']['body'], { action: 'set_status' }>;
export type FilteredStatusCapture = Readonly<{ body: string; sourceId: string; filter: string | null; state: string }>;
export type FilteredStatusFailure = 'preparing' | 'unsupported' | 'denied' | 'limit' | 'unavailable';
export type FilteredStatusResult =
  | { kind: 'ready'; operation: FilteredStatusOperation; confirmation?: string }
  | { kind: FilteredStatusFailure };
export type FilteredStatusCall = Readonly<{ token: string; headers: Readonly<Record<string, string>> }>;
export type FilteredStatusCaptureCall = Readonly<{
  body: string;
  viewer: string;
  previewKey: string;
  confirmKey: string;
  headers: Readonly<Record<string, string>>;
}>;
export type FilteredStatusSender = Readonly<{
  capture: (call: FilteredStatusCaptureCall) => Promise<string>;
  preview: (call: FilteredStatusCall) => Promise<FilteredStatusResult>;
  confirm: (call: FilteredStatusCall) => Promise<FilteredStatusResult>;
  read: (address: OperationAddress) => Promise<BulkRead>;
}>;

/** Send the exact admitted Members predicate; native capture alone follows the population. */
export function captureFilteredStatus(
  sourceId: string,
  filter: FilterDocument | undefined,
  state: string,
): FilteredStatusCapture {
  if (!sourceId || !libraryEntryStateWrite(state)) throw new TypeError('Invalid filtered status request');
  const query = collectionFilterQuery(filter);
  const request: Admission = { action: 'set_status', state, selection: { kind: 'query', sourceId, ...query } };
  const body = JSON.stringify(request);
  if (new TextEncoder().encode(body).byteLength > 64 * 1024)
    throw new RangeError('Filtered status request exceeds limit');
  return Object.freeze({ body, sourceId, filter: query.filter ?? null, state });
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
function sameFilter(left: string | null, right: string | null) {
  try {
    return canonical(left === null ? null : JSON.parse(left)) === canonical(right === null ? null : JSON.parse(right));
  } catch {
    return false;
  }
}
function matches(operation: FilteredStatusOperation, capture: FilteredStatusCapture) {
  const source = operation.selectionSource;
  return (
    operation.action === 'set_status' &&
    operation.selectionKind === 'query' &&
    operation.state === capture.state &&
    source?.id === capture.sourceId &&
    !!source.sourceDigest &&
    source.sort === null &&
    sameFilter(source.filter, capture.filter)
  );
}
export type FilteredStatusState = {
  phase:
    | 'review'
    | 'previewing'
    | 'preview_uncertain'
    | 'previewed'
    | 'confirming'
    | 'confirmation_uncertain'
    | 'confirmed'
    | 'retired'
    | FilteredStatusFailure;
  operation?: FilteredStatusOperation;
  read?: BulkRead;
  reading?: boolean;
};

/** One mounted intent. Reads cannot replace either original command or extend its deadlines. */
export class FilteredStatusJourney {
  state: FilteredStatusState = { phase: 'review' };
  private original: FilteredStatusCaptureCall;
  private previewCall: FilteredStatusCall | undefined;
  private confirmCall: FilteredStatusCall | undefined;
  private busy = false;
  private delivery: (() => boolean) | undefined;
  get visible() {
    return this.context() && this.delivery?.() === true;
  }
  constructor(
    readonly capture: FilteredStatusCapture,
    private viewer: string,
    headers: Readonly<Record<string, string>>,
    private sender: FilteredStatusSender,
    private context: () => boolean,
    private admitted: (kind: 'preview' | 'confirm' | 'read') => boolean,
    private changed: () => void,
    private episode: () => () => boolean = () => () => true,
  ) {
    this.original = Object.freeze({
      body: capture.body,
      viewer,
      headers: Object.freeze({ ...headers }),
      previewKey: crypto.randomUUID(),
      confirmKey: crypto.randomUUID(),
    });
  }
  retire() {
    this.state = { phase: 'retired' };
    this.previewCall = undefined;
    this.confirmCall = undefined;
  }
  private current(kind: 'preview' | 'confirm' | 'read') {
    if (!this.context()) this.retire();
    return this.state.phase !== 'retired' && this.admitted(kind);
  }
  get canConfirm() {
    const op = this.state.operation;
    return (
      this.visible &&
      this.state.phase === 'previewed' &&
      !!this.confirmCall &&
      !!op &&
      op.phase === 'preview' &&
      matches(op, this.capture) &&
      op.selectionComplete &&
      op.occurrencesComplete &&
      Number.isSafeInteger(op.counts.targets) &&
      op.counts.targets >= 0 &&
      op.counts.targets <= 1000 &&
      op.counts.targets === op.selectionSource?.selectedSubjects &&
      Date.parse(op.expiresAt) > Date.now()
    );
  }
  async preview() {
    if (
      !this.current('preview') ||
      this.busy ||
      !['review', 'preview_uncertain', 'preparing', 'unavailable'].includes(this.state.phase)
    )
      return;
    this.busy = true;
    const episode = this.episode();
    this.state = { phase: 'previewing' };
    this.changed();
    try {
      if (!this.previewCall) {
        const token = await this.sender.capture(this.original);
        if (!this.current('preview') || !episode()) return;
        this.previewCall = Object.freeze({ token, headers: this.original.headers });
      }
      const result = await this.sender.preview(this.previewCall);
      if (!this.current('preview') || !episode()) return;
      if (result.kind !== 'ready') this.state = { phase: result.kind };
      else if (!matches(result.operation, this.capture) || !result.confirmation) this.state = { phase: 'unavailable' };
      else {
        this.confirmCall = Object.freeze({ token: result.confirmation, headers: this.original.headers });
        this.delivery = episode;
        this.state = { phase: 'previewed', operation: result.operation };
        if (!this.canConfirm) this.state = { phase: 'unavailable' };
      }
    } catch {
      if (!this.context()) this.retire();
      else this.state = { phase: this.previewCall ? 'preview_uncertain' : 'unavailable' };
    } finally {
      if (this.state.phase === 'previewing') this.state = { phase: 'preview_uncertain' };
      this.busy = false;
      this.changed();
    }
  }
  async confirm() {
    if (
      !this.current('confirm') ||
      this.busy ||
      !this.confirmCall ||
      !(this.canConfirm || this.state.phase === 'confirmation_uncertain')
    )
      return;
    const episode = this.episode();
    this.busy = true;
    this.state = { ...this.state, phase: 'confirming' };
    this.changed();
    try {
      const result = await this.sender.confirm(this.confirmCall);
      if (!this.current('confirm') || !episode()) return;
      if (
        result.kind === 'ready' &&
        result.operation.id === this.state.operation?.id &&
        matches(result.operation, this.capture) &&
        result.operation.expiresAt === this.state.operation.expiresAt &&
        result.operation.resultsExpireAt === this.state.operation.resultsExpireAt &&
        JSON.stringify(result.operation.selectionSource) === JSON.stringify(this.state.operation.selectionSource)
      ) {
        this.delivery = episode;
        this.state = { ...this.state, phase: 'confirmed', operation: result.operation };
      } else this.state = { ...this.state, phase: 'confirmation_uncertain' };
    } catch {
      if (!this.context()) this.retire();
      else this.state = { ...this.state, phase: 'confirmation_uncertain' };
    } finally {
      if (this.state.phase === 'confirming') this.state = { ...this.state, phase: 'confirmation_uncertain' };
      this.busy = false;
      this.changed();
    }
  }
  async read(cursor?: string) {
    if (!this.current('read') || this.busy || !this.state.operation) return;
    const original = this.state.operation;
    const episode = this.episode();
    this.busy = true;
    this.state = { ...this.state, reading: true };
    this.changed();
    try {
      let read = await this.sender.read({
        id: original.id,
        viewer: this.viewer,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!this.current('read') || !episode()) return;
      if (
        read.state === 'ready' &&
        (!matches(read.operation, this.capture) ||
          read.operation.id !== original.id ||
          JSON.stringify(read.operation.selectionSource) !== JSON.stringify(original.selectionSource) ||
          read.operation.expiresAt !== original.expiresAt ||
          read.operation.resultsExpireAt !== original.resultsExpireAt)
      )
        read = { state: 'unavailable' };
      this.delivery = read.state === 'ready' ? episode : undefined;
      this.state = { ...this.state, read, ...(read.state === 'ready' ? { operation: read.operation } : {}) };
    } catch {
      if (!this.context()) this.retire();
      else this.state = { ...this.state, read: { state: 'unavailable' } };
    } finally {
      this.busy = false;
      this.state = { ...this.state, reading: false };
      this.changed();
    }
  }
}
