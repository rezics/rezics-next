import type { KernelClient } from '@rezics/client';
import {
  consolidationClient,
  type Confirmation,
  type ConfirmationInput,
  type ConsolidationResult,
} from './client';
import { ConsolidationReview } from './review';

type Operation = 'review' | 'confirm' | 'apply' | 'retry' | 'cancel' | 'result';
export type ConsolidationEnvelope = {
  /** Capture the current owner, reader episode and this operation's exposure together. */
  capture(operation: Operation): { headers: Record<string, string>; isCurrent(): boolean } | null;
  /** Owner, address or reader retirement must notify synchronously, including A -> B -> A. */
  subscribeRetirement(retire: () => void): () => void;
};
type Transport = ReturnType<typeof consolidationClient>;
type Command =
  | { operation: 'confirm'; key: string; evidence: ConfirmationInput }
  | { operation: 'apply' | 'cancel'; key: string; confirmationId: string }
  | { operation: 'retry'; key: string; confirmationId: string; item: number };
export type VisitOutcome = 'accepted' | 'unknown' | 'rejected' | 'unavailable' | 'retired';

/** Visit-local evidence and immutable caller operands. Never put this object in a query cache. */
export class ConsolidationVisit {
  private retired = false;
  private busy = false;
  private unknown = false;
  private command: Command | null = null;
  private confirmationValue: Confirmation | null = null;
  private resultValue: ConsolidationResult | null = null;
  private release: (() => void) | undefined;

  constructor(
    readonly review: ConsolidationReview,
    private envelope: ConsolidationEnvelope,
    private transport: (headers: Record<string, string>) => Transport,
    private refreshAssignments: (sourceId: string, targetId: string) => void,
    private key: () => string = () => crypto.randomUUID(),
  ) {
    const release = envelope.subscribeRetirement(() => this.retire());
    if (this.retired) release();
    else this.release = release;
  }

  static native(
    client: KernelClient,
    review: ConsolidationReview,
    envelope: ConsolidationEnvelope,
    refreshAssignments: (sourceId: string, targetId: string) => void,
  ) {
    return new ConsolidationVisit(
      review,
      envelope,
      (headers) => consolidationClient(client, review.sourceLabelId, headers),
      refreshAssignments,
    );
  }

  get confirmation() {
    return structuredClone(this.confirmationValue);
  }
  get result() {
    return structuredClone(this.resultValue);
  }
  get acknowledgementUnknown() {
    return this.command !== null && !this.busy && this.unknown;
  }

  async nextPage(): Promise<VisitOutcome> {
    if (this.retired) return 'retired';
    if (this.busy || this.command || this.confirmationValue) return 'unavailable';
    const captured = this.envelope.capture('review');
    if (!captured || !captured.isCurrent()) return 'unavailable';
    const current = () => !this.retired && captured.isCurrent();
    const request = this.review.request(current);
    this.busy = true;
    try {
      const response = await this.transport(captured.headers).review(request.body);
      if (!current()) return this.discard();
      if (response.error || !response.data) {
        request.failed();
        return 'rejected';
      }
      if (!request.accept(response.data)) return this.discard();
      return 'accepted';
    } catch {
      request.failed();
      if (!current()) return this.discard();
      return 'unknown';
    } finally {
      this.busy = false;
    }
  }

  async confirm(): Promise<VisitOutcome> {
    if (this.retired) return 'retired';
    if (this.busy || this.command || this.confirmationValue) return 'unavailable';
    const evidence = this.review.confirmation();
    if (!evidence) return 'unavailable';
    // Save all evidence and the caller key before the transport can dispatch.
    return this.dispatch({ operation: 'confirm', key: this.key(), evidence });
  }

  async apply(): Promise<VisitOutcome> {
    return this.advance('apply');
  }
  async cancel(): Promise<VisitOutcome> {
    return this.advance('cancel');
  }
  async retry(item: number): Promise<VisitOutcome> {
    if (this.retired) return 'retired';
    if (this.busy || this.command || !this.confirmationValue) return 'unavailable';
    if (!this.resultValue?.items.some((value) => value.item === item && value.status === 'processing'))
      return 'unavailable';
    return this.dispatch({
      operation: 'retry',
      confirmationId: this.confirmationValue.confirmationId,
      item,
      key: this.key(),
    });
  }

  /** Unknown acknowledgements always replay the original addressed operation and key. */
  async recover(): Promise<VisitOutcome> {
    if (this.retired) return 'retired';
    if (this.busy || !this.command) return 'unavailable';
    return this.dispatch(this.command);
  }

  private async advance(operation: 'apply' | 'cancel'): Promise<VisitOutcome> {
    if (this.retired) return 'retired';
    if (this.busy || this.command || !this.confirmationValue) return 'unavailable';
    return this.dispatch({ operation, confirmationId: this.confirmationValue.confirmationId, key: this.key() });
  }

  async readResult(): Promise<VisitOutcome> {
    if (this.retired) return 'retired';
    if (this.busy || !this.confirmationValue) return 'unavailable';
    const captured = this.envelope.capture('result');
    if (!captured || !captured.isCurrent()) return 'unavailable';
    this.busy = true;
    try {
      const response = await this.transport(captured.headers).result(this.confirmationValue.confirmationId);
      if (this.retired || !captured.isCurrent()) return this.discard();
      if (response.error || !response.data) return 'rejected';
      this.acceptResult(response.data);
      return 'accepted';
    } catch {
      return this.retired || !captured.isCurrent() ? this.discard() : 'unknown';
    } finally {
      this.busy = false;
    }
  }

  private async dispatch(command: Command): Promise<VisitOutcome> {
    const captured = this.envelope.capture(command.operation);
    if (!captured || !captured.isCurrent()) return 'unavailable';
    this.command = structuredClone(command);
    this.unknown = false;
    this.busy = true;
    try {
      const transport = this.transport(captured.headers);
      if (command.operation === 'confirm') {
        const response = await transport.confirm(structuredClone(command.evidence), command.key);
        if (this.retired || !captured.isCurrent()) return this.discard();
        if (response.error || !response.data) return 'rejected';
        this.confirmationValue = structuredClone(response.data);
      } else {
        const response =
          command.operation === 'retry'
            ? await transport.retry(command.confirmationId, command.item, command.key)
            : await transport[command.operation](command.confirmationId, command.key);
        if (this.retired || !captured.isCurrent()) return this.discard();
        if (response.error || !response.data) return 'rejected';
        this.acceptResult(response.data);
      }
      this.command = null;
      return 'accepted';
    } catch {
      if (this.retired || !captured.isCurrent()) return this.discard();
      this.unknown = true;
      return 'unknown';
    } finally {
      // Definite rejection still retains original operands: expiry or drift must never rebase them.
      this.busy = false;
    }
  }

  private acceptResult(value: ConsolidationResult) {
    this.resultValue = structuredClone(value);
    if (value.items.some((item) => item.targetAssignment || item.sourceUnassignRevision !== undefined))
      this.refreshAssignments(this.review.sourceLabelId, this.review.targetLabelId);
  }

  private discard(): VisitOutcome {
    this.retire();
    return 'retired';
  }

  retire() {
    this.retired = true;
    this.review.retire();
    this.command = null;
    this.unknown = false;
    this.confirmationValue = null;
    this.resultValue = null;
    this.release?.();
    this.release = undefined;
  }
}
