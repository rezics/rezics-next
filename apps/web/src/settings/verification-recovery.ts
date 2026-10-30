import type { AgentVerificationRequest, VerificationCommandResult, VerificationInput } from './verification-core';

export type VerificationSnapshot = {
  accountId: string;
  verificationRequest: AgentVerificationRequest | null;
  subjectTitle: string | null;
};
export type VerificationAttempt = Readonly<
  {
    requestId: string | null;
    receipt: AgentVerificationRequest | null;
  } & ({ kind: 'request'; input: VerificationInput } | { kind: 'withdraw'; input: { idempotencyKey: string } })
>;
export type VerificationRecoveryState = {
  current: VerificationSnapshot | null;
  attempt: VerificationAttempt | null;
  phase: 'loading' | 'idle' | 'sending' | 'reading' | 'uncertain' | 'refused' | 'review' | 'unavailable';
  failure?: { status: number; message: string } | undefined;
};
export type VerificationRecoveryIO = {
  read: (accountId: string) => Promise<VerificationSnapshot>;
  request: (accountId: string, input: VerificationInput) => Promise<VerificationCommandResult>;
  withdraw: (accountId: string, input: { idempotencyKey: string }) => Promise<VerificationCommandResult>;
};

export function verificationQueryKey(accountId: string | null | undefined) {
  return ['settings', 'verification', accountId ?? null] as const;
}
export function canRequestVerification(current: VerificationSnapshot | null): boolean {
  const request = current?.verificationRequest;
  return !!current && (!request || ['withdrawn', 'failed', 'rejected'].includes(request.state));
}
export function canWithdrawVerification(current: VerificationSnapshot | null): boolean {
  // The native withdrawal command accepts pending requests only.
  return current?.verificationRequest?.state === 'pending';
}
function frozen<T extends object>(value: T): T {
  Object.values(value).forEach((part) => {
    if (part && typeof part === 'object') frozen(part);
  });
  return Object.freeze(value);
}

/** One viewer, one immutable unresolved command, and one explicit read per action. No persistence or polling. */
export class VerificationRecovery {
  private state: VerificationRecoveryState = { current: null, attempt: null, phase: 'loading' };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private active = true;
  constructor(
    readonly accountId: string,
    private io: VerificationRecoveryIO,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  activate() {
    this.active = true;
    if (this.busy()) this.update({ phase: this.state.attempt ? 'uncertain' : 'loading' });
  }
  deactivate() {
    this.active = false;
    this.epoch++;
  }
  private live(epoch: number) {
    return this.active && epoch === this.epoch;
  }
  private update(patch: Partial<VerificationRecoveryState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private busy() {
    return this.state.phase === 'sending' || this.state.phase === 'reading';
  }
  async submit(draft: Omit<VerificationInput, 'idempotencyKey'>) {
    if (!this.active || this.busy() || this.state.attempt || !canRequestVerification(this.state.current)) return;
    const input = frozen({
      ...draft,
      links: draft.links.map((link) => ({ ...link })),
      idempotencyKey: crypto.randomUUID(),
    });
    this.update({ attempt: frozen({ kind: 'request' as const, input, requestId: null, receipt: null }) });
    await this.send(false);
  }
  async withdraw(confirmed: boolean) {
    if (!confirmed || !this.active || this.busy() || this.state.attempt || !canWithdrawVerification(this.state.current))
      return;
    this.update({
      attempt: frozen({
        kind: 'withdraw' as const,
        input: { idempotencyKey: crypto.randomUUID() },
        requestId: this.state.current!.verificationRequest!.id,
        receipt: null,
      }),
    });
    await this.send(false);
  }
  async retry() {
    if (!this.active || !this.state.attempt || this.busy()) return;
    await this.send(true);
  }
  private async send(recovering: boolean) {
    const attempt = this.state.attempt;
    if (!attempt) return;
    const epoch = this.epoch;
    this.update({ phase: 'sending', current: null, failure: undefined });
    let result: VerificationCommandResult;
    try {
      result =
        attempt.kind === 'request'
          ? await this.io.request(this.accountId, attempt.input)
          : await this.io.withdraw(this.accountId, attempt.input);
    } catch {
      if (this.live(epoch)) this.update({ phase: 'uncertain' });
      return;
    }
    if (!this.live(epoch)) return;
    if (!result.ok) {
      // A later refusal cannot prove that an earlier lost response did not commit.
      const uncertain =
        recovering ||
        (result.outcome !== 'refused' &&
          (result.status === 0 || result.status === 408 || result.status >= 500 || result.status < 400));
      this.update({
        phase: uncertain ? 'uncertain' : 'refused',
        attempt: uncertain ? attempt : null,
        failure: { status: result.status, message: result.message },
      });
      return;
    }
    const receipt = result.verificationRequest;
    if (
      receipt.accountId !== this.accountId ||
      (attempt.kind === 'request' && !this.matchesInput(receipt, attempt.input)) ||
      (attempt.kind === 'withdraw' && (receipt.id !== attempt.requestId || receipt.state !== 'withdrawn'))
    ) {
      this.update({ phase: 'uncertain' });
      return;
    }
    this.update({ attempt: frozen({ ...attempt, receipt }) });
    await this.readCurrent(epoch);
  }
  private matchesInput(request: AgentVerificationRequest, input: VerificationInput) {
    return (
      request.catalogueSubjectId === input.subject &&
      request.statement === input.statement &&
      request.links.length === input.links.length &&
      request.links.every(
        (link, index) => link.label === input.links[index]!.label && link.url === input.links[index]!.url,
      )
    );
  }
  async reload() {
    if (!this.active || this.busy()) return;
    await this.readCurrent(this.epoch);
  }
  private async readCurrent(epoch: number) {
    this.update({ phase: 'reading', current: null, failure: undefined });
    let current: VerificationSnapshot;
    try {
      current = await this.io.read(this.accountId);
      if (
        current.accountId !== this.accountId ||
        (current.verificationRequest && current.verificationRequest.accountId !== this.accountId)
      )
        throw new Error('Verification account changed');
    } catch (error) {
      if (this.live(epoch))
        this.update({
          phase: this.state.attempt ? 'uncertain' : 'unavailable',
          failure:
            error instanceof Error && error.message === 'rezics-platform-closed'
              ? { status: 403, message: error.message }
              : undefined,
        });
      return;
    }
    if (!this.live(epoch)) return;
    const attempt = this.state.attempt;
    const request = current.verificationRequest;
    // A latest status or identical payload cannot identify a lost request command. Its receipt supplies the ID.
    const resolved =
      attempt &&
      request &&
      (attempt.kind === 'withdraw'
        ? request.id === attempt.requestId && request.state === 'withdrawn'
        : attempt.receipt && request.id === attempt.receipt.id && this.matchesInput(request, attempt.input));
    this.update({
      current,
      attempt: resolved ? null : attempt,
      phase: attempt ? (resolved ? 'review' : 'uncertain') : 'idle',
    });
  }
}
