import {
  archiveUploadBytes,
  type ArchiveConfirmation,
  type ArchiveRecoveryPort,
  type ArchiveReply,
  type ArchiveReviewItem,
  type ArchiveRow,
  type NativeArchivePreview,
  type NativeArchiveReview,
  type NativeArchiveStatus,
} from './native';
import { selectedArchiveRecoveryResults } from './results';
import { type RecoverySection } from './selection';
import { ArchiveRecoveryVisit, type RecoveryBinding, type RecoveryRequest } from './visit';

type ResultPage = ReturnType<typeof selectedArchiveRecoveryResults>;
type Confirmation = { uploadId: string; body: ArchiveConfirmation };
type Visit = ArchiveRecoveryVisit<NativeArchiveStatus, ArchiveRow, ArchiveReviewItem, Confirmation, ResultPage['rows'][number], Omit<NativeArchivePreview, 'records'>, ResultPage['context']>;
const sectionOf = (choice: ArchiveReviewItem): RecoverySection => choice.kind === 'entry' ? 'entries' : choice.kind === 'label' ? 'labels' : 'assignments';
export const supportedRecoverySection = (section: string): section is RecoverySection => ['entries', 'labels', 'assignments'].includes(section);

export class ArchiveEntryRecoveryJourney {
  readonly visit: Visit;
  #port: ArchiveRecoveryPort;
  #listeners = new Set<() => void>();
  #retired = false;
  #busy = false;
  #notice = '';
  #reviewed: NativeArchiveReview['reviewed'] = [];
  #readback: { ordinal: number; value: unknown } | null = null;
  #cancelRequest: RecoveryRequest | null = null;
  #cancelAcknowledged = false;
  #pendingUpload: { text: string; key: string; request: RecoveryRequest } | null = null;
  #evidenceId: string | null = null;
  #expiry: ReturnType<typeof setTimeout> | undefined;

  constructor(port: ArchiveRecoveryPort, current: () => RecoveryBinding | null, deadline: number, now = Date.now) {
    this.#port = port;
    this.visit = new ArchiveRecoveryVisit(current, deadline, now);
  }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #emit() { if (!this.#retired) for (const listener of this.#listeners) listener(); }
  snapshot() {
    const state = this.visit.state;
    return { state, busy: this.#busy, notice: this.#notice, reviewed: state?.review ? this.#reviewed : [], readback: state ? this.#readback : null, uploadUncertain: this.#pendingUpload !== null };
  }
  retire() {
    this.#retired = true;
    clearTimeout(this.#expiry);
    this.visit.retire();
    this.#pendingUpload = null;
    this.#reviewed = [];
    this.#readback = null;
    this.#listeners.clear();
  }
  #current() { return !this.#retired && this.visit.state !== null; }
  #feedback(reply: ArchiveReply<unknown>) {
    this.#notice = reply.kind === 'uncertain' ? 'uncertain' : reply.kind === 'refused' ? `${reply.status}:${reply.code}` : '';
  }
  async #run(action: () => Promise<void>) {
    this.#busy = true;
    this.#notice = '';
    this.#emit();
    try { await action(); }
    finally { this.#busy = false; this.#emit(); }
  }

  /** File size is checked before reading; the native decoder alone interprets the contents. */
  async upload(file: File) {
    if (file.size > archiveUploadBytes) { this.#notice = 'file_too_large'; this.#emit(); return; }
    const request = this.visit.startUpload();
    this.#cancelRequest = null;
    this.#cancelAcknowledged = false;
    this.#readback = null;
    this.#reviewed = [];
    await this.#run(async () => {
      const text = await file.text();
      if (request.signal.aborted || !this.#current()) return;
      this.#pendingUpload = { text, key: crypto.randomUUID(), request };
      await this.#sendUpload();
    });
  }
  async retryUpload() { await this.#run(() => this.#sendUpload()); }
  async #sendUpload() {
    const original = this.#pendingUpload!;
    const reply = await this.#port.upload(original.text, original.key, original.request.signal);
    if (!this.#current() || original !== this.#pendingUpload || original.request.signal.aborted) return;
    this.#feedback(reply);
    if (reply.kind === 'uncertain') return;
    this.#pendingUpload = null;
    if (reply.kind !== 'ok') return;
    const status = reply.value;
    this.#evidenceId = status.uploadId;
    if (!this.visit.admitUpload(original.request, status.uploadId, status, Date.parse(status.expiresAt))) return;
    clearTimeout(this.#expiry);
    this.#expiry = setTimeout(() => {
      void this.visit.state;
      this.#readback = null;
      this.#reviewed = [];
      this.#emit();
    }, Math.max(0, Date.parse(status.expiresAt) - Date.now()));
    await this.#page(-1);
  }
  async page(after = -1) { await this.#run(() => this.#page(after)); }
  async #page(after: number) {
    const request = this.visit.startPage();
    const reply = await this.#port.preview(this.visit.state!.upload!.id, after, request.signal);
    if (!this.#current() || request.signal.aborted) return;
    this.#feedback(reply);
    if (reply.kind === 'ok') {
      const { records, ...context } = reply.value;
      this.visit.admitPage(request, { rows: records, context });
    }
  }
  choose(choice: ArchiveReviewItem) {
    this.visit.choose(choice.ordinal, sectionOf(choice), choice);
    this.#reviewed = [];
    this.#emit();
  }
  unselect(ordinal: number) { this.visit.unselect(ordinal); this.#emit(); }
  async review() {
    const request = this.visit.startReview();
    const state = this.visit.state!;
    await this.#run(async () => {
      const reply = await this.#port.review(state.upload!.id, state.choices.map(({ choice }) => choice), request.signal);
      if (!this.#current() || request.signal.aborted) return;
      this.#feedback(reply);
      if (reply.kind !== 'ok') return;
      this.#reviewed = reply.value.reviewed;
      this.visit.admitReview(request, { uploadId: state.upload!.id, body: { items: reply.value.reviewed.map(({ ordinal, reviewRevision }) => ({ ordinal, reviewRevision })) } });
      // Replace only the displayed native page, including its exact immutable review and conflicts.
      const first = state.page?.rows[0]?.ordinal;
      if (first !== undefined) await this.#page(first - 1);
    });
  }
  async apply() {
    const replaying = ['uncertain', 'recoverable', 'cancelling'].includes(this.visit.state!.phase);
    const original = this.visit.startApply();
    await this.#run(async () => {
      const reply = await this.#port.apply(original.operand.uploadId, original.operand.body, original.request.signal);
      if (!this.#current() || original.request.signal.aborted) return;
      this.#feedback(reply);
      const cancelling = this.visit.state!.phase === 'cancelling';
      if (reply.kind !== 'ok') {
        const replay = replaying || cancelling || this.#notice === 'uncertain';
        this.visit.settleApply(original.request, replay ? 'uncertain' : reply.kind === 'refused' && reply.status === 409 ? 'stale' : 'failed');
        return;
      }
      const state = this.visit.state!;
      const results = selectedArchiveRecoveryResults({ uploadId: reply.value.uploadId, state: cancelling ? 'cancelled' : 'ready', results: reply.value.applied.map(row => ({ ...row, section: state.choices.find(choice => choice.ordinal === row.ordinal)!.section })), next: null }, state.choices);
      const unresolved = reply.value.applied.some(row => row.status === 'applying');
      const changed = reply.value.applied.some(row => ['current_conflict', 'unresolved', 'unsupported'].includes(row.status));
      this.visit.settleApply(original.request, unresolved ? 'recoverable' : changed && !cancelling ? 'stale' : 'complete', results);
      if (unresolved) this.#notice = 'uncertain';
      if (this.#cancelRequest && this.#cancelAcknowledged) this.visit.admitCancel(this.#cancelRequest);
    });
  }
  async results(after = -1) {
    const request = this.visit.startResults();
    const state = this.visit.state!;
    await this.#run(async () => {
      const reply = await this.#port.results(state.upload!.id, after, request.signal);
      if (!this.#current() || request.signal.aborted) return;
      this.#feedback(reply);
      if (reply.kind === 'ok') this.visit.admitResults(request, selectedArchiveRecoveryResults(reply.value, state.choices));
    });
  }
  async status() {
    const state = this.visit.state!;
    const id = state.upload!.id;
    await this.#run(async () => {
      const reply = await this.#port.status(id);
      if (!this.#current() || this.visit.state!.upload?.id !== id) return;
      this.#feedback(reply);
      if (reply.kind === 'ok') this.#notice = reply.value.state;
    });
  }
  async cancel() {
    const request = this.#cancelRequest ?? this.visit.startCancel();
    this.#cancelRequest = request;
    const id = this.visit.state!.upload!.id;
    // Cancellation can overlap an apply. It does not abort the claimed native command.
    const reply = await this.#port.cancel(id, request.signal);
    if (!this.#current() || request.signal.aborted) return;
    this.#feedback(reply);
    if (reply.kind === 'ok') { this.#cancelAcknowledged = true; this.visit.admitCancel(request); }
    this.#emit();
  }
  async readCurrent(ordinal: number) {
    const row = this.visit.state!.results!.rows.find(row => row.ordinal === ordinal)!;
    const uploadId = this.visit.state!.upload?.id;
    await this.#run(async () => {
      const reply = row.subjectId ? await this.#port.entry(row.subjectId) : await this.#port.label(row.labelId!);
      if (!this.#current() || this.visit.state!.upload?.id !== uploadId) return;
      this.#feedback(reply);
      if (reply.kind === 'ok') this.#readback = { ordinal, value: reply.value };
      // Current facts never checkpoint the original archive command.
    });
  }
  async prune() {
    const id = this.#evidenceId!;
    await this.#run(async () => {
      const reply = await this.#port.prune(id);
      if (!this.#current() || this.#evidenceId !== id) return;
      this.#feedback(reply);
      if (reply.kind === 'ok') this.#notice = reply.value.complete ? 'pruned' : 'prune_more';
    });
  }
}
