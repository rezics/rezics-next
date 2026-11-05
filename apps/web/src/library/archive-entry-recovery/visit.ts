import {
  ownRecoveryPage,
  ownRecoveryValue,
  RecoverySelection,
  type RecoveryChoice,
  type RecoveryPage,
  type RecoverySection,
} from './selection';

export type RecoveryBinding = Readonly<{
  viewer: string;
  credentialEpoch: string;
  csrfEpoch: string;
  admission: string;
  source: string;
  route: string;
  locale: string;
  exposure: string;
}>;

type Channel = 'upload' | 'page' | 'review' | 'apply' | 'results' | 'cancel';
export type RecoveryReadDirection = 'first' | 'previous' | 'next' | 'refresh';
export type RecoveryReadTarget = Readonly<{
  after: number;
  direction: RecoveryReadDirection;
  failed: boolean;
}>;
export type RecoveryReaderPath = Readonly<{
  current: number | null;
  previous: readonly number[];
  staged: RecoveryReadTarget | null;
  generation: number;
}>;
type MutableReaderPath = {
  current: number | null;
  previous: number[];
  staged: RecoveryReadTarget | null;
  generation: number;
};
export type RecoveryRequest = Readonly<{ signal: AbortSignal }>;
type Pending = { request: RecoveryRequest; abort: AbortController; selectionRevision: number };
type Phase =
  | 'idle'
  | 'reviewed'
  | 'applying'
  | 'uncertain'
  | 'recoverable'
  | 'stale'
  | 'failed'
  | 'complete'
  | 'expired'
  | 'cancelling'
  | 'cancelled';
export type RecoveryApplyOutcome = 'complete' | 'uncertain' | 'recoverable' | 'stale' | 'failed';

const retainsOriginal = (phase: Phase) => phase === 'uncertain' || phase === 'recoverable';
const predecessorLimit = 8;
const emptyReaderPath = (): MutableReaderPath => ({ current: null, previous: [], staged: null, generation: 0 });

function readerPathSnapshot(path: MutableReaderPath): RecoveryReaderPath {
  return Object.freeze({
    current: path.current,
    previous: Object.freeze([...path.previous]),
    staged: path.staged === null ? null : Object.freeze({ ...path.staged }),
    generation: path.generation,
  });
}

function samePage<Result, Context>(left: RecoveryPage<Result, Context> | null, right: RecoveryPage<Result, Context>) {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

const sameBinding = (left: RecoveryBinding, right: RecoveryBinding | null) =>
  right !== null &&
  left.viewer === right.viewer &&
  left.credentialEpoch === right.credentialEpoch &&
  left.csrfEpoch === right.csrfEpoch &&
  left.admission === right.admission &&
  left.source === right.source &&
  left.route === right.route &&
  left.locale === right.locale &&
  left.exposure === right.exposure;

/**
 * Transport-neutral private custody for the mounted archive visit. The Web adapter supplies generated DTOs,
 * fresh owner admission and the immutable native review operand; this class fences their private state and reads.
 * The mounted owner retires it on unmount/session events, and every access also checks the live binding.
 */
export class ArchiveRecoveryVisit<Upload, Row, Choice, Confirm, Result, PageContext = null, ResultContext = null> {
  #binding: RecoveryBinding;
  #currentBinding: () => RecoveryBinding | null;
  #now: () => number;
  #deadline: number;
  #visitDeadline: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #retired = false;
  #evidenceExpired = false;
  #pending = new Map<Channel, Pending>();
  #selection = new RecoverySelection<Choice>();
  #upload: Readonly<{ id: string; metadata: Upload }> | null = null;
  #page: RecoveryPage<Row, PageContext> | null = null;
  #results: RecoveryPage<Result, ResultContext> | null = null;
  #pagePath = emptyReaderPath();
  #resultsPath = emptyReaderPath();
  #originalSelection: readonly RecoveryChoice<Choice>[] | null = null;
  #resultSelection: readonly RecoveryChoice<Choice>[] = [];
  #review: Readonly<{ revision: number; operand: Confirm }> | null = null;
  #original: Confirm | null = null;
  #cancelNeedsCheckpoint = false;
  #cancelCheckpointed = false;
  #phase: Phase = 'idle';

  constructor(currentBinding: () => RecoveryBinding | null, deadline: number, now = Date.now) {
    const binding = currentBinding();
    if (!binding || !Number.isFinite(deadline) || deadline <= now()) throw new Error('retired_visit');
    this.#binding = { ...binding };
    this.#currentBinding = currentBinding;
    this.#now = now;
    this.#deadline = deadline;
    this.#visitDeadline = deadline;
    this.#armDeadline();
  }

  #armDeadline() {
    clearTimeout(this.#timer);
    const deadline = this.#evidenceExpired ? this.#visitDeadline : this.#deadline;
    // Native retention is seven days. Longer credential deadlines need bounded timer slices.
    this.#timer = setTimeout(
      () => {
        if (this.#live()) this.#armDeadline();
      },
      Math.min(deadline - this.#now(), 2_147_483_647),
    );
  }

  #live() {
    if (!this.#retired && (!sameBinding(this.#binding, this.#currentBinding()) || this.#now() >= this.#visitDeadline))
      this.retire();
    if (!this.#retired && !this.#evidenceExpired && this.#now() >= this.#deadline) this.#expireEvidence();
    return !this.#retired;
  }

  #requireLive() {
    if (!this.#live()) throw new Error('retired_visit');
  }

  #abort(channel: Channel) {
    this.#pending.get(channel)?.abort.abort();
    this.#pending.delete(channel);
  }

  #abortAll() {
    for (const channel of this.#pending.keys()) this.#abort(channel);
  }

  #begin(channel: Channel): RecoveryRequest {
    this.#requireLive();
    this.#abort(channel);
    const abort = new AbortController();
    const request = Object.freeze({ signal: abort.signal });
    this.#pending.set(channel, { request, abort, selectionRevision: this.#selection.revision });
    return request;
  }

  #accept(channel: Channel, request: RecoveryRequest) {
    if (!this.#live()) return false;
    const pending = this.#pending.get(channel);
    if (!pending || pending.request !== request || request.signal.aborted) return false;
    if (channel === 'review' && pending.selectionRevision !== this.#selection.revision) return false;
    this.#pending.delete(channel);
    return true;
  }

  #clearEvidence() {
    this.#abortAll();
    this.#upload = null;
    this.#page = null;
    this.#selection.clear();
    this.#pagePath = emptyReaderPath();
    this.#resultsPath = emptyReaderPath();
    this.#originalSelection = null;
    this.#resultSelection = [];
    this.#review = null;
    this.#original = null;
    this.#cancelNeedsCheckpoint = false;
    this.#cancelCheckpointed = false;
  }

  #clearPrivate() {
    this.#clearEvidence();
    this.#results = null;
    this.#phase = 'idle';
  }

  #expireEvidence() {
    this.#clearEvidence();
    this.#evidenceExpired = true;
    this.#phase = 'expired';
    // Accepted native outcomes survive evidence expiry, but never the session binding.
    this.#armDeadline();
  }

  retire(): void {
    this.#retired = true;
    clearTimeout(this.#timer);
    this.#clearPrivate();
  }

  /** Replacement retires the old upload before a new asynchronous transfer begins. */
  startUpload(): RecoveryRequest {
    this.#requireLive();
    this.#clearPrivate();
    this.#evidenceExpired = false;
    this.#deadline = this.#visitDeadline;
    this.#armDeadline();
    return this.#begin('upload');
  }

  admitUpload(request: RecoveryRequest, id: string, metadata: Upload, expiresAt: number): boolean {
    if (!this.#accept('upload', request)) return false;
    if (!id || !Number.isFinite(expiresAt) || expiresAt <= this.#now()) {
      this.retire();
      return false;
    }
    this.#deadline = Math.min(this.#deadline, expiresAt);
    this.#armDeadline();
    this.#upload = ownRecoveryValue({ id, metadata });
    return true;
  }

  #requireUpload() {
    this.#requireLive();
    if (this.#evidenceExpired) throw new Error('evidence_expired');
    if (!this.#upload) throw new Error('upload_required');
  }

  startPage(after = -1, direction: RecoveryReadDirection = 'first'): RecoveryRequest {
    this.#requireUpload();
    if (['cancelling', 'cancelled'].includes(this.#phase)) throw new Error('cancelled_visit');
    const request = this.#begin('page');
    this.#pagePath.staged = { after, direction, failed: false };
    return request;
  }

  admitPage(request: RecoveryRequest, page: RecoveryPage<Row, PageContext>): boolean {
    if (!this.#accept('page', request)) return false;
    this.#page = ownRecoveryPage(page);
    this.#admitRead(this.#pagePath);
    return true;
  }

  failPage(request: RecoveryRequest): boolean {
    if (!this.#accept('page', request)) return false;
    this.#failRead(this.#pagePath);
    return true;
  }

  #admitRead(path: MutableReaderPath) {
    const target = path.staged!;
    if (target.direction === 'first') path.previous = [];
    else if (target.direction === 'next' && path.current !== null)
      path.previous = [...path.previous, path.current].slice(-predecessorLimit);
    else if (target.direction === 'previous') path.previous = path.previous.slice(0, -1);
    path.current = target.after;
    path.staged = null;
    path.generation++;
  }

  #failRead(path: MutableReaderPath) {
    const target = path.staged!;
    path.staged = { ...target, failed: true };
  }

  #discardRead(path: MutableReaderPath) {
    path.staged = null;
  }

  #resetResultsPath(after: number | null) {
    this.#resultsPath = {
      current: after,
      previous: [],
      staged: null,
      generation: this.#resultsPath.generation + 1,
    };
  }

  #edit() {
    this.#requireUpload();
    if (retainsOriginal(this.#phase) || ['applying', 'cancelling', 'cancelled'].includes(this.#phase))
      throw new Error('selection_locked');
  }

  #invalidateReview() {
    this.#abort('review');
    this.#review = null;
    this.#phase = 'idle';
  }

  choose(ordinal: number, section: RecoverySection, choice: Choice): void {
    this.#edit();
    this.#selection.set(ordinal, section, choice);
    this.#invalidateReview();
  }

  unselect(ordinal: number): void {
    this.#edit();
    this.#selection.remove(ordinal);
    this.#invalidateReview();
  }

  startReview(): RecoveryRequest {
    this.#edit();
    if (this.#selection.choices.length === 0) throw new Error('selection_required');
    this.#review = null;
    this.#phase = 'idle';
    return this.#begin('review');
  }

  admitReview(request: RecoveryRequest, operand: Confirm): boolean {
    if (!this.#accept('review', request)) return false;
    this.#review = ownRecoveryValue({ revision: this.#selection.revision, operand });
    this.#phase = 'reviewed';
    return true;
  }

  /** Explicit confirmation or original replay; recoverable/failed outcomes come from the native owner. */
  startApply(): Readonly<{ request: RecoveryRequest; operand: Confirm }> {
    this.#requireUpload();
    const reconcilingCancellation =
      this.#phase === 'cancelling' && this.#cancelNeedsCheckpoint && !this.#cancelCheckpointed;
    if (this.#phase === 'reviewed' && this.#review?.revision === this.#selection.revision) {
      this.#original = this.#review.operand;
      const selection =
        this.#originalSelection === null ? null : this.#originalSelection.map((choice) => ({ ...choice }));
