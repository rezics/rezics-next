import {
  ownRecoveryPage,
  ownRecoveryValue,
  RecoverySelection,
  type RecoveryPage,
  type RecoverySection,
} from './selection';

export type RecoveryBinding = Readonly<{
  viewer: string;
  credentialEpoch: string;
  csrfEpoch: string;
  source: string;
  route: string;
}>;

type Channel = 'upload' | 'page' | 'review' | 'apply' | 'results' | 'cancel';
export type RecoveryRequest = Readonly<{ signal: AbortSignal }>;
type Pending = { request: RecoveryRequest; abort: AbortController; selectionRevision: number };
type Phase = 'idle' | 'reviewed' | 'applying' | 'uncertain' | 'stale' | 'complete' | 'cancelling' | 'cancelled';

const sameBinding = (left: RecoveryBinding, right: RecoveryBinding | null) =>
  right !== null &&
  left.viewer === right.viewer &&
  left.credentialEpoch === right.credentialEpoch &&
  left.csrfEpoch === right.csrfEpoch &&
  left.source === right.source &&
  left.route === right.route;

/**
 * Transport-neutral private custody. The future adapter must supply generated DTOs for these generics,
 * fresh owner admission and the native immutable review operand. This class does not enable upload.
 * The mounted owner must retire on unmount/session events; every access also checks the live binding.
 */
export class ArchiveRecoveryVisit<Upload, Row, Choice, Confirm, Result, PageContext = null, ResultContext = null> {
  #binding: RecoveryBinding;
  #currentBinding: () => RecoveryBinding | null;
  #now: () => number;
  #deadline: number;
  #visitDeadline: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #retired = false;
  #pending = new Map<Channel, Pending>();
  #selection = new RecoverySelection<Choice>();
  #upload: Readonly<{ id: string; metadata: Upload }> | null = null;
  #page: RecoveryPage<Row, PageContext> | null = null;
  #results: RecoveryPage<Result, ResultContext> | null = null;
  #review: Readonly<{ revision: number; operand: Confirm }> | null = null;
  #original: Confirm | null = null;
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
    // Native retention is seven days. Longer credential deadlines need bounded timer slices.
    this.#timer = setTimeout(
      () => {
        if (this.#now() >= this.#deadline) this.retire();
        else this.#armDeadline();
      },
      Math.min(this.#deadline - this.#now(), 2_147_483_647),
    );
  }

  #live() {
    if (!this.#retired && (!sameBinding(this.#binding, this.#currentBinding()) || this.#now() >= this.#deadline))
      this.retire();
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

  #clearPrivate() {
    this.#abortAll();
    this.#upload = null;
    this.#page = null;
    this.#results = null;
    this.#selection.clear();
    this.#review = null;
    this.#original = null;
    this.#phase = 'idle';
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
    if (!this.#upload) throw new Error('upload_required');
  }

  startPage(): RecoveryRequest {
    this.#requireUpload();
    if (['cancelling', 'cancelled'].includes(this.#phase)) throw new Error('cancelled_visit');
    return this.#begin('page');
  }

  admitPage(request: RecoveryRequest, page: RecoveryPage<Row, PageContext>): boolean {
    if (!this.#accept('page', request)) return false;
    this.#page = ownRecoveryPage(page);
    return true;
  }

  #edit() {
    this.#requireUpload();
    if (['applying', 'uncertain', 'cancelling', 'cancelled'].includes(this.#phase)) throw new Error('selection_locked');
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

  /** Call only on explicit confirmation, or explicit retry of an uncertain original request. */
  startApply(): Readonly<{ request: RecoveryRequest; operand: Confirm }> {
    this.#requireUpload();
    if (this.#phase === 'reviewed' && this.#review?.revision === this.#selection.revision) {
      this.#original = this.#review.operand;
    } else if (this.#phase !== 'uncertain') {
      throw new Error('fresh_review_required');
    }
    if (this.#original === null) throw new Error('fresh_review_required');
    this.#abort('results');
    this.#phase = 'applying';
    return Object.freeze({ request: this.#begin('apply'), operand: this.#original });
  }

  settleApply(
    request: RecoveryRequest,
    outcome: 'complete' | 'uncertain' | 'stale',
    results?: RecoveryPage<Result, ResultContext>,
  ): boolean {
    if (!this.#accept('apply', request)) return false;
    this.#abort('results');
    let admitted: RecoveryPage<Result, ResultContext> | undefined;
    try {
      admitted = results === undefined ? undefined : ownRecoveryPage(results);
    } catch {
      // An unusable acknowledgement cannot release the original uncertain command identity.
      this.#phase = 'uncertain';
      throw new Error('invalid_result_page');
    }
    this.#phase = outcome;
    if (admitted !== undefined) this.#results = admitted;
    if (outcome !== 'uncertain') {
      this.#original = null;
      this.#review = null;
    }
    // Stale admission keeps choices as context, but cannot confirm them again without fresh review.
    return true;
  }

  startResults(): RecoveryRequest {
    this.#requireUpload();
    return this.#begin('results');
  }

  admitResults(request: RecoveryRequest, results: RecoveryPage<Result, ResultContext>): boolean {
    if (!this.#accept('results', request)) return false;
    this.#results = ownRecoveryPage(results);
    return true;
  }

  startCancel(): RecoveryRequest {
    this.#requireUpload();
    this.#abortAll();
    this.#selection.clear();
    this.#review = null;
    this.#original = null;
    this.#page = null;
    this.#phase = 'cancelling';
    // Native receipts already displayed stay visible; cancellation never rolls effects back.
    return this.#begin('cancel');
  }

  admitCancel(request: RecoveryRequest): boolean {
    if (!this.#accept('cancel', request)) return false;
    this.#phase = 'cancelled';
    return true;
  }

  get state() {
    if (!this.#live()) return null;
    return Object.freeze({
      upload: this.#upload,
      page: this.#page,
      choices: this.#selection.choices,
      results: this.#results,
      phase: this.#phase,
      review: this.#review?.operand ?? null,
    });
  }
}
