import type { Application, Holdings, Occurrences, Reply, Result, Review, ReviewInput, Units, Upload } from './native';
import { UPLOAD_BYTES } from './native';
import type { ProgressRecoveryPort, NativePort } from './native';

export type Occurrence = Occurrences['occurrences'][number]['evidence'];
export type Snapshot<Choices = unknown> = {
  upload: Upload | null;
  holdings: Holdings | null;
  occurrences: Occurrences | null;
  units: Units | null;
  unitSupport: Review['completedUnits'];
  selected: Occurrence | null;
  choices: Choices | undefined;
  mappedSubject: string | null;
  review: Review | null;
  operands: ReviewInput | null;
  application: Application | null;
  result: Result | null;
  busy: boolean;
  pending: boolean;
  cancelled: boolean;
  removing: boolean;
  removed: number;
  notice: 'ready' | 'uncertain' | 'recoverable' | 'refused' | 'expired' | 'oversize' | 'cancelled' | 'removed';
  refusal: number | null;
  hasOriginalArchive: boolean;
};
type Sender = Omit<NativePort, 'subject'>;
type Pending = { port: Sender; upload: Upload | null } & (
  | { kind: 'upload'; base64: string; key: string }
  | { kind: 'review'; body: ReviewInput; key: string; inspection: boolean }
  | { kind: 'apply'; review: Review; body: ReviewInput; key: string }
);
/** Protected unresolved commands outlive a React visit. Only an identical private binding can recover them. */
const unresolved = new Map<string, Pending>();
const cancellations = new Map<string, { port: Sender; upload: Upload }>();
const empty = <Choices>(): Snapshot<Choices> => ({
  upload: null,
  holdings: null,
  occurrences: null,
  units: null,
  selected: null,
  choices: undefined,
  mappedSubject: null,
  unitSupport: [],
  review: null,
  operands: null,
  application: null,
  result: null,
  busy: false,
  pending: false,
  cancelled: false,
  removing: false,
  removed: 0,
  notice: 'ready',
  refusal: null,
  hasOriginalArchive: false,
});
export function archiveBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export class ProgressRecoveryJourney<Choices = unknown> {
  #state = empty<Choices>();
  #retired = false;
  #working = false;
  #selection = 0;
  #original: { bytes: Uint8Array; name: string } | null = null;
  constructor(
    readonly port: ProgressRecoveryPort<Choices>,
    readonly binding: string,
    readonly current: () => boolean,
    readonly changed: () => void = () => {},
  ) {
    const pending = unresolved.get(binding),
      cancellation = cancellations.get(binding);
    if (pending) {
      this.#state.upload = pending.upload;
      this.#state.pending = true;
      this.#state.notice = 'uncertain';
      if (pending.kind === 'apply') {
        this.#state.review = pending.review;
        this.#state.operands = pending.body;
      }
    }
    if (cancellation) {
      this.#state.pending = true;
      this.#state.upload = cancellation.upload;
      this.#state.notice = 'uncertain';
    }
  }
  #live() {
    return !this.#retired && this.current();
  }
  snapshot(): Snapshot<Choices> {
    if (!this.#live()) return empty<Choices>();
    if (this.#state.upload && Date.now() >= Date.parse(this.#state.upload.expiresAt)) this.#expire();
    return { ...this.#state, hasOriginalArchive: this.#original !== null };
  }
  #expire() {
    Object.assign(this.#state, {
      holdings: null,
      occurrences: null,
      units: null,
      unitSupport: [],
      selected: null,
      choices: undefined,
      mappedSubject: null,
      review: null,
      operands: null,
      application: null,
      result: null,
      notice: 'expired',
    });
  }
  expire() {
    if (this.#live()) {
      this.#expire();
      this.#emit();
    }
  }
  #emit() {
    if (this.#live()) this.changed();
  }
  retire() {
    this.#retired = true;
    this.#selection++;
    this.#state = empty<Choices>();
  }
  #accept<T>(reply: Reply<T>): T | null {
    if (!this.#live()) return null;
    if (reply.kind === 'ok') {
      this.#state.refusal = null;
      this.#state.notice = this.#state.cancelled ? 'cancelled' : 'ready';
      return reply.value;
    }
    this.#state.notice = reply.kind === 'uncertain' ? 'uncertain' : reply.status === 404 ? 'expired' : 'refused';
    this.#state.refusal = reply.kind === 'refused' ? reply.status : null;
    return null;
  }
  #editable() {
    return (
      this.#live() &&
      !this.#working &&
      !unresolved.has(this.binding) &&
      !cancellations.has(this.binding) &&
      !this.#state.removing
    );
  }
  async #work(run: () => Promise<void>) {
    this.#working = true;
    this.#state.busy = true;
    this.#emit();
    try {
      await run();
    } finally {
      this.#working = false;
      this.#state.busy = false;
      this.#emit();
    }
  }
  async upload(file: File) {
    if (!this.#editable() || this.#state.upload) return;
    if (file.size > UPLOAD_BYTES) {
      this.#state.notice = 'oversize';
      this.#emit();
      return;
    }
    await this.#work(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.#original = { bytes: new Uint8Array(bytes), name: file.name };
      const base64 = archiveBase64(bytes);
      if (!this.#live()) return;
      // Store the exact request and original sender before delivery. No JSON parse/re-encode occurs.
      unresolved.set(this.binding, { kind: 'upload', base64, key: crypto.randomUUID(), port: this.port, upload: null });
      await this.#deliver();
      if (this.#state.upload && !unresolved.has(this.binding) && !cancellations.has(this.binding))
        await this.#inspect();
    });
  }
  async #inspect() {
    const id = this.#state.upload!.uploadId;
    const [holdings, occurrences] = await Promise.all([this.port.holdings(id), this.port.occurrences(id)]);
    const h = this.#accept(holdings),
      p = this.#accept(occurrences);
    if (h) this.#state.holdings = h;
    if (p) {
      this.#state.occurrences = p;
      this.#state.cancelled = p.state === 'cancelled';
    }
  }
  async inspect() {
    if (this.#editable() && this.#state.upload) await this.#work(() => this.#inspect());
  }
  async page(kind: 'holdings' | 'occurrences' | 'units', after = -1) {
    if (!this.#editable() || !this.#state.upload) return;
    await this.#work(async () => {
      const id = this.#state.upload!.uploadId;
      switch (kind) {
        case 'holdings': {
          const page = this.#accept(await this.port.holdings(id, after));
          if (page) this.#state.holdings = page;
          break;
        }
        case 'occurrences': {
          const page = this.#accept(await this.port.occurrences(id, after));
          if (page) this.#state.occurrences = page;
          break;
        }
        case 'units': {
          const page = this.#accept(await this.port.units(id, this.#state.selected!.session_id, after));
          if (page) {
            this.#state.units = page;
            this.#state.unitSupport = [];
          }
        }
      }
    });
  }
  async select(occurrence: Occurrence) {
    if (!this.#editable() || this.#state.cancelled) return;
    this.#selection++;
    Object.assign(this.#state, {
      selected: occurrence,
      units: null,
      unitSupport: [],
      review: null,
      operands: null,
      choices: undefined,
      mappedSubject: null,
      application: null,
      result: null,
      notice: 'ready',
    });
    await this.page('units');
  }
  async mapSubject(subjectId: string) {
    if (!this.#editable() || this.#state.cancelled) return;
    const epoch = ++this.#selection;
    this.#state.review = null;
    this.#state.operands = null;
    this.#state.choices = undefined;
    this.#state.mappedSubject = null;
    this.#state.unitSupport = [];
    await this.#work(async () => {
      const reply = await this.port.choices(subjectId);
      if (!this.#live() || epoch !== this.#selection) return;
      const value = this.#accept(reply);
      if (!value) return;
      this.#state.choices = value.choices;
      this.#state.mappedSubject = value.subjectId;
    });
  }
  invalidateReview() {
    if (!this.#editable()) return;
    this.#state.review = null;
    this.#state.operands = null;
    this.#state.result = null;
    this.#emit();
  }
  async review(body: ReviewInput, inspection = false) {
    if (!this.#editable() || this.#state.cancelled) return;
    this.#state.review = null;
    this.#state.result = null;
    this.#state.application = null;
    await this.#work(async () => {
      const normalized = structuredClone(body);
      normalized.additionalMeasures.sort((left, right) =>
        left.sourceUnit < right.sourceUnit ? -1 : left.sourceUnit > right.sourceUnit ? 1 : 0,
      );
      unresolved.set(this.binding, {
        kind: 'review',
        inspection,
        body: normalized,
        key: crypto.randomUUID(),
        port: this.port,
        upload: this.#state.upload,
      });
      await this.#deliver();
    });
  }
  async confirm(reviewId: string) {
    if (
      !this.#editable() ||
      this.#state.cancelled ||
      this.#state.review?.reviewId !== reviewId ||
      !this.#state.review.applicable
    )
      return;
    const review = this.#state.review,
      body = this.#state.operands!;
    await this.#work(async () => {
      unresolved.set(this.binding, {
        kind: 'apply',
        review,
        body,
        key: crypto.randomUUID(),
        port: this.port,
        upload: this.#state.upload,
      });
      this.#state.result = null;
      await this.#deliver();
    });
  }
  async #deliver() {
    const command = unresolved.get(this.binding)!;
    this.#state.pending = true;
    switch (command.kind) {
      case 'upload': {
        const value = this.#accept(await command.port.upload(command.base64, command.key));
        if (!value) break;
        this.#state.upload = value;
        unresolved.delete(this.binding);
        break;
      }
      case 'review': {
        const value = this.#accept(await command.port.review(command.upload!.uploadId, command.body, command.key));
        if (!value) break;
        if (command.inspection) {
          this.#state.unitSupport = value.completedUnits;
          this.#state.review = null;
        } else {
          this.#state.review = value;
          this.#state.operands = command.body;
        }
        unresolved.delete(this.binding);
        break;
      }
      case 'apply': {
        const value = this.#accept(
          await command.port.apply(command.upload!.uploadId, command.review.reviewId, command.key),
        );
        if (!value) break;
        this.#state.application = value;
        if (value.state === 'recoverable' || value.state === 'applying') {
          this.#state.result = null;
          this.#state.notice = 'recoverable';
        } else {
          unresolved.delete(this.binding);
          await this.#result(command.port, command.upload!.uploadId, command.review.reviewId);
        }
      }
    }
    if (!this.#live()) return;
    // A later authorization/expiry refusal cannot acknowledge an earlier lost native apply.
    if (command.kind !== 'apply' && (this.#state.notice === 'refused' || this.#state.notice === 'expired'))
      unresolved.delete(this.binding);
    this.#state.pending = unresolved.has(this.binding) || cancellations.has(this.binding);
    if (cancellations.has(this.binding)) this.#state.notice = 'uncertain';
    if (!this.#state.pending && !['refused', 'expired'].includes(this.#state.notice))
      this.#state.notice = this.#state.cancelled ? 'cancelled' : 'ready';
  }
  async #result(port: Sender, id: string, reviewId: string) {
    const value = this.#accept(await port.result(id, reviewId));
    if (value) this.#state.result = value;
  }
  async readResult() {
    if (!this.#editable() || !this.#state.review) return;
    await this.#work(() => this.#result(this.port, this.#state.upload!.uploadId, this.#state.review!.reviewId));
  }
  async retry() {
    if (!this.#live() || this.#working) return;
    await this.#work(async () => {
      if (cancellations.has(this.binding)) await this.#cancel();
      if (unresolved.has(this.binding)) await this.#deliver();
      if (this.#state.upload && !unresolved.has(this.binding) && !cancellations.has(this.binding))
        await this.#inspect();
    });
  }
  async #cancel() {
    const command = cancellations.get(this.binding)!;
    const reply = this.#accept(await command.port.cancel(command.upload.uploadId));
    if (reply) {
      cancellations.delete(this.binding);
      this.#state.cancelled = true;
      this.#state.notice = 'cancelled';
      this.#state.result = null;
    }
    this.#state.pending = unresolved.has(this.binding) || cancellations.has(this.binding);
  }
  async cancel() {
    if (!this.#live() || !this.#state.upload || this.#state.removing) return;
    cancellations.set(this.binding, { port: this.port, upload: this.#state.upload });
    this.#state.pending = true;
    this.#emit();
    await this.#cancel();
    this.#emit();
    // An in-flight original apply is allowed to finish its receipt. No replacement command is started.
    if (!this.#working && unresolved.has(this.binding)) await this.retry();
  }
  restart() {
    if (!this.#live() || this.#working || unresolved.has(this.binding) || cancellations.has(this.binding)) return;
    const original = this.#original;
    this.#state = empty<Choices>();
    this.#original = original;
    this.#emit();
  }
  async adoptOriginal() {
    if (!this.#original || !this.#editable() || this.#state.upload) return;
    const copy = new Uint8Array(this.#original.bytes.byteLength);
    copy.set(this.#original.bytes);
    await this.upload(new File([copy.buffer as ArrayBuffer], this.#original.name, { type: 'application/json' }));
  }
  async remove() {
    if (!this.#editable() || !this.#state.upload) return;
    const id = this.#state.upload.uploadId;
    await this.#work(async () => {
      this.#state.removing = true;
      Object.assign(this.#state, {
        holdings: null,
        occurrences: null,
        units: null,
        unitSupport: [],
        selected: null,
        choices: undefined,
        mappedSubject: null,
        review: null,
        operands: null,
        application: null,
        result: null,
      });
      this.#emit();
      let complete = false;
      while (this.#live() && !complete) {
        const reply = await this.port.remove(id);
        // A lost final DELETE response may leave only the already-removed root.
        if (reply.kind === 'refused' && reply.status === 404) complete = true;
        else {
          const value = this.#accept(reply);
          if (!value) break;
          this.#state.removed += value.removed;
          complete = value.complete;
        }
        this.#emit();
      }
      if (this.#live() && complete) {
        this.#state = { ...empty<Choices>(), notice: 'removed' };
      } else this.#state.removing = false;
    });
  }
}
