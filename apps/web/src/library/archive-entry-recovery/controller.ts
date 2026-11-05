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
import { ArchiveRecoveryVisit, type RecoveryBinding, type RecoveryReadDirection, type RecoveryRequest } from './visit';
import { recoveryArchiveText } from '../private-export/supported-recovery-artifact';

type ResultPage = ReturnType<typeof selectedArchiveRecoveryResults>;
type Confirmation = { uploadId: string; body: ArchiveConfirmation };
type Visit = ArchiveRecoveryVisit<
  NativeArchiveStatus,
  ArchiveRow,
  ArchiveReviewItem,
  Confirmation,
  ResultPage['rows'][number],
  Omit<NativeArchivePreview, 'records'>,
  ResultPage['context']
>;
const sectionOf = (choice: ArchiveReviewItem): RecoverySection => {
  switch (choice.kind) {
    case 'entry':
      return 'entries';
    case 'label':
      return 'labels';
    case 'assignment':
      return 'assignments';
    case 'annotation':
      return 'annotations';
    case 'journal':
      return 'journals';
  }
};
export const supportedRecoverySection = (section: string): section is RecoverySection =>
  ['entries', 'labels', 'assignments', 'annotations', 'journals'].includes(section);

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
  #cancelNeedsReconcile = false;
  #pendingUpload: { text: string; key: string; request: RecoveryRequest } | null = null;
  #originalText: string | null = null;
  #originalName = 'library.json';
  #evidenceId: string | null = null;
  #expiry: ReturnType<typeof setTimeout> | undefined;

  constructor(port: ArchiveRecoveryPort, current: () => RecoveryBinding | null, deadline: number, now = Date.now) {
    this.#port = port;
    this.visit = new ArchiveRecoveryVisit(current, deadline, now);
  }
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #emit() {
    if (!this.#retired) for (const listener of this.#listeners) listener();
  }
  snapshot() {
    const state = this.visit.state;
    return {
      state,
      busy: this.#busy,
      notice: this.#notice,
      reviewed: state?.review ? this.#reviewed : [],
      readback: state ? this.#readback : null,
      uploadUncertain: this.#pendingUpload !== null,
      hasOriginalArchive: this.#originalText !== null,
      retryOriginal:
        !!state &&
        (['uncertain', 'recoverable'].includes(state.phase) ||
          (state.phase === 'cancelling' && this.#cancelNeedsReconcile)),
    };
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
  #current() {
    return !this.#retired && this.visit.state !== null;
  }
  #feedback(reply: ArchiveReply<unknown>) {
    this.#notice =
      reply.kind === 'uncertain' ? 'uncertain' : reply.kind === 'refused' ? `${reply.status}:${reply.code}` : '';
  }
  #retainAcknowledged(
    page: ResultPage,
    selection: readonly Readonly<{ ordinal: number; section: RecoverySection }>[] = this.visit.state!.resultSelection,
  ): ResultPage {
    const state = this.visit.state!;
    const previous = state.results?.context.uploadId === page.context.uploadId ? state.results.rows : [];
    const accepted = previous.filter(
      (row) =>
        row.status === 'acknowledged' &&
        selection.some((choice) => choice.ordinal === row.ordinal && choice.section === row.section),
    );
    const rows = new Map(page.rows.map((row) => [row.ordinal, row]));
    // A later supplied page cannot erase matching receipts already acknowledged for this selection.
    for (const row of accepted) rows.set(row.ordinal, row);
    return { rows: [...rows.values()], context: page.context };
  }
  async #run(action: () => Promise<void>) {
    this.#busy = true;
    this.#notice = '';
    this.#emit();
    try {
      await action();
    } finally {
      this.#busy = false;
      this.#emit();
    }
  }

  /** File size is checked before reading. V4 captures are projected to the installed V3 envelope before upload. */
  async upload(file: File) {
    if (file.size > archiveUploadBytes) {
      this.#notice = 'file_too_large';
      this.#emit();
      return;
    }
    const request = this.visit.startUpload();
    this.#cancelRequest = null;
    this.#cancelAcknowledged = false;
    this.#cancelNeedsReconcile = false;
    this.#readback = null;
    this.#reviewed = [];
    await this.#run(async () => {
      const text = recoveryArchiveText(await file.text(), 'entries');
      if (request.signal.aborted || !this.#current()) return;
      this.#originalText = text;
      this.#originalName = file.name;
      this.#pendingUpload = { text, key: crypto.randomUUID(), request };
      await this.#sendUpload();
    });
  }
  async retryUpload() {
    await this.#run(() => this.#sendUpload());
  }
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
    this.#expiry = setTimeout(
      () => {
        void this.visit.state;
        this.#readback = null;
        this.#reviewed = [];
        this.#emit();
      },
      Math.max(0, Date.parse(status.expiresAt) - Date.now()),
    );
    await this.#page(-1, 'first');
  }
  async page(action: RecoveryReadDirection | 'retry' = 'first') {
    const path = this.visit.state!.pageNavigation;
    const state = this.visit.state!;
    if (action === 'retry') {
      const target = path.staged!;
      await this.#run(() => this.#page(target.after, target.direction));
      return;
    }
    const after =
      action === 'first'
        ? -1
        : action === 'previous'
          ? path.previous.at(-1)!
          : action === 'next'
            ? state.page!.context.next!
            : (path.current ?? -1);
    const direction = action === 'refresh' && path.current === null ? 'first' : action;
    await this.#run(() => this.#page(after, direction));
  }
  async #page(after: number, direction: RecoveryReadDirection) {
    const uploadId = this.visit.state!.upload!.id;
    const request = this.visit.startPage(after, direction);
    const reply = await this.#port.preview(uploadId, after, request.signal);
    if (!this.#current() || this.visit.state?.upload?.id !== uploadId || request.signal.aborted) return;
    this.#feedback(reply);
    if (reply.kind === 'ok') {
      const { records, ...context } = reply.value;
      this.visit.admitPage(request, { rows: records, context });
    } else this.visit.failPage(request);
  }
  choose(choice: ArchiveReviewItem) {
    this.visit.choose(choice.ordinal, sectionOf(choice), choice);
    this.#reviewed = [];
    this.#emit();
  }
  unselect(ordinal: number) {
    this.visit.unselect(ordinal);
    this.#emit();
  }
  async review() {
    const request = this.visit.startReview();
    const state = this.visit.state!;
    await this.#run(async () => {
      const reply = await this.#port.review(
        state.upload!.id,
        state.choices.map(({ choice }) => choice),
        request.signal,
      );
      if (!this.#current() || request.signal.aborted) return;
      this.#feedback(reply);
      if (reply.kind !== 'ok') return;
      this.#reviewed = reply.value.reviewed;
      this.visit.admitReview(request, {
        uploadId: state.upload!.id,
        body: { items: reply.value.reviewed.map(({ ordinal, reviewRevision }) => ({ ordinal, reviewRevision })) },
      });
      // Replace only the displayed native page, including its exact immutable review and conflicts.
      const currentAfter = state.pageNavigation.current;
      if (currentAfter !== null) await this.#page(currentAfter, 'refresh');
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
        this.visit.settleApply(
          original.request,
          replay ? 'uncertain' : reply.kind === 'refused' && reply.status === 409 ? 'stale' : 'failed',
        );
        return;
      }
      const state = this.visit.state!;
      const results = selectedArchiveRecoveryResults(
        {
          uploadId: reply.value.uploadId,
          state: cancelling ? 'cancelled' : 'ready',
          results: reply.value.applied.map((row) => ({
            ...row,
            section: state.choices.find((choice) => choice.ordinal === row.ordinal)!.section,
          })),
          next: null,
        },
        state.choices,
      );
      const unresolved = reply.value.applied.some((row) => row.status === 'applying');
      const changed = reply.value.applied.some((row) =>
        ['current_conflict', 'unresolved', 'unsupported'].includes(row.status),
      );
      if (cancelling && !unresolved) this.#cancelNeedsReconcile = false;
      this.visit.settleApply(
        original.request,
        unresolved ? 'recoverable' : changed && !cancelling ? 'stale' : 'complete',
        this.#retainAcknowledged(
          results,
          state.choices.map(({ ordinal, section }) => ({ ordinal, section })),
        ),
      );
      if (unresolved) this.#notice = 'uncertain';
      if (this.#cancelRequest && this.#cancelAcknowledged) this.visit.admitCancel(this.#cancelRequest);
    });
  }
  async results(action: RecoveryReadDirection | 'retry' = 'refresh') {
    const state = this.visit.state!;
    const path = state.resultsNavigation;
    if (action === 'retry') {
      const target = path.staged!;
      await this.#readResults(target.after, target.direction, state.upload!.id);
      return;
    }
    const after =
      action === 'first'
        ? -1
        : action === 'previous'
          ? path.previous.at(-1)!
          : action === 'next'
            ? state.results!.context.next!
            : (path.current ?? -1);
    const direction = action === 'refresh' && path.current === null ? 'first' : action;
    await this.#readResults(after, direction, state.upload!.id);
  }
  async #readResults(after: number, direction: RecoveryReadDirection, uploadId: string) {
    const request = this.visit.startResults(after, direction);
    await this.#run(async () => {
      const reply = await this.#port.results(uploadId, after, request.signal);
      if (!this.#current() || this.visit.state?.upload?.id !== uploadId || request.signal.aborted) return;
      this.#feedback(reply);
      if (reply.kind === 'ok')
        this.visit.admitResults(
          request,
          this.#retainAcknowledged(selectedArchiveRecoveryResults(reply.value, this.visit.state!.resultSelection)),
        );
      else this.visit.failResults(request);
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
    if (!this.#cancelRequest)
      this.#cancelNeedsReconcile = ['applying', 'uncertain', 'recoverable'].includes(this.visit.state!.phase);
    const request = this.#cancelRequest ?? this.visit.startCancel();
    this.#cancelRequest = request;
    const id = this.visit.state!.upload!.id;
    // Cancellation can overlap an apply. It does not abort the claimed native command.
    const reply = await this.#port.cancel(id, request.signal);
    if (!this.#current() || request.signal.aborted) return;
    this.#feedback(reply);
    if (reply.kind === 'ok') {
      this.#cancelAcknowledged = true;
      this.visit.admitCancel(request);
    }
    this.#emit();
  }
  async readCurrent(ordinal: number) {
    const row = this.visit.state!.results!.rows.find((row) => row.ordinal === ordinal)!;
    const uploadId = this.visit.state!.upload?.id;
    await this.#run(async () => {
      const accept = async <T>(replyPromise: Promise<ArchiveReply<T>>, select: (value: T) => unknown) => {
        const reply = await replyPromise;
        if (!this.#current() || this.visit.state!.upload?.id !== uploadId) return;
        this.#feedback(reply);
        if (reply.kind === 'ok') this.#readback = { ordinal, value: select(reply.value) };
      };
      switch (row.section) {
        case 'entries':
        case 'assignments':
          await accept(this.#port.entry(row.subjectId!), (value) => value);
          break;
        case 'annotations':
          await accept(this.#port.personal(row.subjectId!), (value) => value.personalEntry);
          break;
        case 'provenance':
          await accept(
            this.#port.personal(row.subjectId!),
            (value) =>
              value.personalEntry.sourceObservations.find(
                (observation) => observation.provider === row.provider && observation.recordId === row.recordId,
              ) ?? null,
          );
          break;
        case 'journals':
          await accept(this.#port.journal(row.sessionId!), (value) => value.journal);
          break;
        default:
          await accept(this.#port.label(row.labelId!), (value) => value);
      }
      // Current facts never checkpoint the original archive command.
    });
  }
  restart() {
    if (this.#busy || this.snapshot().retryOriginal) return;
    this.#reviewed = [];
    this.#readback = null;
    this.#pendingUpload = null;
    this.#notice = '';
    this.#evidenceId = null;
    this.visit.restart();
    this.#emit();
  }
  async adoptOriginal() {
    if (!this.#originalText || this.#busy || this.snapshot().retryOriginal) return;
    const file = new File([this.#originalText], this.#originalName, { type: 'application/json' });
    await this.upload(file);
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
