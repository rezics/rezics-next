export type PaymentAttestationInput = {
  statementId: string;
  subject: string;
  paidReference: string;
  idempotencyKey: string;
};
export type PaymentEvidence = {
  id: string;
  state: 'paid';
  paidAt: string;
  paidReference: string;
  revision: number;
};
export type PaymentAttestationResult =
  | { kind: 'saved'; statement: PaymentEvidence }
  | { kind: 'uncertain' | 'denied' | 'conflict' | 'rejected' };

export const validPaymentReference = (value: string) => value.length <= 256 && value.trim().length > 0;
// One native write + the reader's one detail and one bounded line-page refresh.
export const PAYMENT_ATTESTATION_REQUEST_BOUND = 1 + 2;

/** A captured original survives a read refresh and authority gaps in the reader's workspace. */
export class CreatorPaymentAttempt {
  request: Readonly<PaymentAttestationInput> | null = null;
  result: PaymentAttestationResult | null = null;
  busy = false;
  correctionAvailable = false;
  correctionEditing = false;
  correctionDraft = '';
  private dispatches = 0;
  private uncertainDispatch = false;
  private version = 0;
  private listeners = new Set<() => void>();
  snapshot = () => this.version;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }

  constructor(
    readonly statementId: string,
    readonly subject: string,
  ) {}

  get canRetry() {
    return !!this.result && !['saved', 'conflict'].includes(this.result.kind) && !this.correctionAvailable;
  }

  beginCorrection() {
    if (this.busy || !this.request || !this.correctionAvailable || this.result?.kind !== 'rejected') return false;
    this.correctionEditing = true;
    this.correctionDraft = this.request.paidReference;
    this.publish();
    return true;
  }

  setCorrectionDraft(value: string) {
    if (this.correctionEditing) this.correctionDraft = value;
  }

  canSubmitCorrection(value: string) {
    return (
      this.correctionEditing &&
      this.correctionAvailable &&
      this.result?.kind === 'rejected' &&
      this.request !== null &&
      value !== this.request.paidReference &&
      validPaymentReference(value)
    );
  }

  async submit(
    reference: string,
    execute: (input: PaymentAttestationInput) => Promise<PaymentAttestationResult>,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (this.busy || !isCurrent() || this.result?.kind === 'saved' || this.result?.kind === 'conflict') return;
    if (!this.request || this.correctionEditing) {
      if (!validPaymentReference(reference)) return;
      if (this.correctionEditing && !this.canSubmitCorrection(reference)) return;
      this.request = Object.freeze({
        statementId: this.statementId,
        subject: this.subject,
        paidReference: reference,
        idempotencyKey: crypto.randomUUID(),
      });
      this.correctionDraft = reference;
      this.correctionEditing = false;
      this.correctionAvailable = false;
      this.dispatches = 0;
      this.uncertainDispatch = false;
    }
    const captured = this.request;
    const dispatch = ++this.dispatches;
    if (dispatch > 1) this.correctionAvailable = false;
    this.busy = true;
    // A lost completion or an obsolete authority leaves this exact original unresolved.
    this.result = { kind: 'uncertain' };
    this.publish();
    try {
      const result = await execute(captured);
      if (!isCurrent()) {
        this.uncertainDispatch = true;
        this.correctionAvailable = false;
      } else if (result.kind === 'uncertain') {
        this.uncertainDispatch = true;
        this.correctionAvailable = false;
        this.result = result;
      } else if (this.uncertainDispatch && result.kind !== 'saved') {
        this.correctionAvailable = false;
        this.result = result.kind === 'conflict' ? result : { kind: 'uncertain' };
      } else {
        this.result = result;
        this.correctionAvailable = dispatch === 1 && result.kind === 'rejected';
      }
    } catch {
      // Retain the captured request; only an explicit retry can resolve it.
      this.uncertainDispatch = true;
      this.correctionAvailable = false;
    } finally {
      this.busy = false;
      this.publish();
    }
  }
}
