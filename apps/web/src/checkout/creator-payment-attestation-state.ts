export type PaymentAttestationInput = {
  statementId: string;
  subject: string;
  paidReference: string;
  idempotencyKey: string;
};
export type PaymentEvidence = {
  id: string;
  state: "paid";
  paidAt: string;
  paidReference: string;
  revision: number;
};
export type PaymentAttestationResult =
  | { kind: "saved"; statement: PaymentEvidence }
  | { kind: "uncertain" | "denied" | "conflict" | "rejected" };

export const validPaymentReference = (value: string) =>
  value.length <= 256 && value.trim().length > 0;
// One native write + the reader's one detail and one bounded line-page refresh.
export const PAYMENT_ATTESTATION_REQUEST_BOUND = 1 + 2;

/** A captured original survives a read refresh and authority gaps in the reader's workspace. */
export class CreatorPaymentAttempt {
  request: Readonly<PaymentAttestationInput> | null = null;
  result: PaymentAttestationResult | null = null;
  busy = false;
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

  async submit(
    reference: string,
    execute: (
      input: PaymentAttestationInput,
    ) => Promise<PaymentAttestationResult>,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (
      this.busy ||
      !isCurrent() ||
      this.result?.kind === "saved" ||
      this.result?.kind === "conflict"
    )
      return;
    if (!this.request) {
      if (!validPaymentReference(reference)) return;
      this.request = Object.freeze({
        statementId: this.statementId,
        subject: this.subject,
        paidReference: reference,
        idempotencyKey: crypto.randomUUID(),
      });
    }
    this.busy = true;
    // A lost completion or an obsolete authority leaves this exact original unresolved.
    this.result = { kind: "uncertain" };
    this.publish();
    try {
      const result = await execute(this.request);
      if (isCurrent()) this.result = result;
    } catch {
      // Retain the captured request; only an explicit retry can resolve it.
    } finally {
      this.busy = false;
      this.publish();
    }
  }
}
