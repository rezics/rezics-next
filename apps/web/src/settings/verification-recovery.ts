import type { QueryClient } from '@tanstack/react-query';
import { withVerificationDeadline } from './verification-request-deadline';
import {
  VerificationReadError,
  type AgentVerificationRequest,
  type VerificationCommandResult,
  type VerificationFailure,
  type VerificationInput,
} from './verification-core';
import { preferenceRetryDeadline } from './preference-failure-retry';

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
  readStatus: 'idle' | 'reading' | 'success' | 'error';
  failure?: VerificationFailure | undefined;
  /** Captured once per failure, shared by the IO guards and the controls' passive timer. */
  retryAt: number;
};
export type VerificationRecoveryIO = {
  read: (accountId: string, signal?: AbortSignal) => Promise<VerificationSnapshot>;
  request: (accountId: string, input: VerificationInput, signal?: AbortSignal) => Promise<VerificationCommandResult>;
  withdraw: (
    accountId: string,
    input: { idempotencyKey: string },
    signal?: AbortSignal,
  ) => Promise<VerificationCommandResult>;
};

export function verificationQueryKey(accountId: string | null | undefined) {
  return ['settings', 'verification', accountId ?? null] as const;
}

/** Observe only this viewer's installed read; never create a query or replace its producer's options. */
export function observeVerificationRead(
  client: QueryClient,
  accountId: string | null | undefined,
  changed: () => void,
) {
  const key = verificationQueryKey(accountId);
  return client.getQueryCache().subscribe(({ query }) => {
    if (
      accountId &&
      query.queryKey.length === key.length &&
      query.queryKey.every((part: unknown, index: number) => part === key[index])
    )
      changed();
  });
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
  private state: VerificationRecoveryState = {
    current: null,
    attempt: null,
    phase: 'loading',
    readStatus: 'idle',
    retryAt: 0,
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private active = true;
  private lifetime = new AbortController();
  // Keep only ordering metadata while a fresh read hides the previous private snapshot.
  private latest: Pick<AgentVerificationRequest, 'id' | 'createdAt' | 'updatedAt'> | null = null;
  constructor(
    readonly accountId: string,
    private io: VerificationRecoveryIO,
    private isCurrent: () => boolean = () => true,
    private canWrite: () => boolean = isCurrent,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  activate() {
    if (this.active) return;
    if (!this.isCurrent()) return;
    this.active = true;
    this.lifetime = new AbortController();
    if (this.busy()) this.update({ phase: this.state.attempt ? 'uncertain' : 'loading', readStatus: 'idle' });
  }
  deactivate() {
    this.active = false;
    this.epoch++;
    this.lifetime.abort();
  }
  private live(epoch: number) {
    return this.active && this.isCurrent() && epoch === this.epoch;
  }
  private update(patch: Partial<VerificationRecoveryState>) {
    if (!this.active || !this.isCurrent()) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private busy() {
    return this.state.phase === 'sending' || this.state.phase === 'reading';
  }
  private waiting() {
    return this.state.retryAt > Date.now();
  }
  private older(request: AgentVerificationRequest) {
    if (!this.latest) return false;
    if (request.id === this.latest.id) return Date.parse(request.updatedAt) < Date.parse(this.latest.updatedAt);
    // A different identity must be newer, even when an earlier request reused the same evidence.
    return Date.parse(request.createdAt) < Date.parse(this.latest.createdAt);
  }
  private remember(request: AgentVerificationRequest) {
    this.latest = { id: request.id, createdAt: request.createdAt, updatedAt: request.updatedAt };
  }
  async submit(draft: Omit<VerificationInput, 'idempotencyKey'>) {
    if (
      !this.active ||
      !this.isCurrent() ||
      !this.canWrite() ||
      this.busy() ||
      this.state.attempt ||
      !canRequestVerification(this.state.current)
    )
      return;
    const input = frozen({
      ...draft,
      links: draft.links.map((link) => ({ ...link })),
      idempotencyKey: crypto.randomUUID(),
    });
    this.update({ attempt: frozen({ kind: 'request' as const, input, requestId: null, receipt: null }) });
    await this.send(false);
  }
  async withdraw(confirmed: boolean) {
    if (
      !confirmed ||
      !this.active ||
      !this.isCurrent() ||
      !this.canWrite() ||
      this.busy() ||
      this.state.attempt ||
      !canWithdrawVerification(this.state.current)
    )
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
    if (!this.active || !this.isCurrent() || !this.canWrite() || !this.state.attempt || this.busy() || this.waiting())
      return;
    await this.send(true);
  }
  private async send(recovering: boolean) {
    const attempt = this.state.attempt;
    if (!attempt || !this.active || !this.isCurrent() || !this.canWrite()) return;
    const epoch = this.epoch;
    this.update({ phase: 'sending', readStatus: 'idle', current: null, failure: undefined, retryAt: 0 });
    let result: VerificationCommandResult;
    try {
      result = await withVerificationDeadline(
        (signal) =>
          attempt.kind === 'request'
            ? this.io.request(this.accountId, attempt.input, signal)
            : this.io.withdraw(this.accountId, attempt.input, signal),
        this.lifetime.signal,
      );
    } catch {
      if (this.live(epoch)) this.update({ phase: 'uncertain' });
      return;
    }
    if (!this.live(epoch) || !this.canWrite()) return;
    if (!result.ok) {
      const { ok: _ok, outcome: _outcome, ...failure } = result;
      // A later refusal cannot prove that an earlier lost response did not commit.
      const uncertain =
        recovering ||
        (result.outcome !== 'refused' &&
          (result.status === 0 || result.status === 408 || result.status >= 500 || result.status < 400));
      this.update({
        phase: uncertain ? 'uncertain' : 'refused',
        attempt: uncertain ? attempt : null,
        failure,
        retryAt: preferenceRetryDeadline(failure.retryAfter),
      });
      return;
    }
    const receipt = result.verificationRequest;
    if (
      receipt.accountId !== this.accountId ||
      (attempt.receipt && receipt.id !== attempt.receipt.id) ||
      this.older(receipt) ||
      (attempt.kind === 'request' && !this.matchesInput(receipt, attempt.input)) ||
      (attempt.kind === 'withdraw' && (receipt.id !== attempt.requestId || receipt.state !== 'withdrawn'))
    ) {
      this.update({ phase: 'uncertain' });
      return;
    }
    this.remember(receipt);
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
    if (!this.active || !this.isCurrent() || this.busy() || this.waiting()) return;
    await this.readCurrent(this.epoch);
  }
  private async readCurrent(epoch: number) {
    if (!this.live(epoch)) return;
    this.update({ phase: 'reading', readStatus: 'reading', current: null, failure: undefined, retryAt: 0 });
    let current: VerificationSnapshot;
    try {
      current = await withVerificationDeadline((signal) => this.io.read(this.accountId, signal), this.lifetime.signal);
      if (
        current.accountId !== this.accountId ||
        (current.verificationRequest && current.verificationRequest.accountId !== this.accountId)
      )
        throw new Error('Verification account changed');
      if (current.verificationRequest && this.older(current.verificationRequest))
        throw new Error('Verification status predates the current request');
    } catch (error) {
      const failure: VerificationFailure | undefined =
        error instanceof VerificationReadError
          ? error.failure
          : error instanceof Error && error.message === 'rezics-platform-closed'
            ? { status: 403, message: error.message }
            : undefined;
      if (this.live(epoch))
        this.update({
          phase: this.state.attempt ? 'uncertain' : 'unavailable',
          readStatus: 'error',
          failure,
          retryAt: preferenceRetryDeadline(failure?.retryAfter),
        });
      return;
    }
    if (!this.live(epoch)) return;
    const attempt = this.state.attempt;
    const request = current.verificationRequest;
    if (request) this.remember(request);
    // A latest status or identical payload cannot identify a lost request command. Its receipt supplies the ID.
    const resolved =
      attempt &&
      request &&
      (attempt.kind === 'withdraw'
        ? request.id === attempt.requestId && request.state === 'withdrawn'
        : attempt.receipt && request.id === attempt.receipt.id && this.matchesInput(request, attempt.input));
    this.update({
      current,
      readStatus: 'success',
      attempt: resolved ? null : attempt,
      phase: attempt ? (resolved ? 'review' : 'uncertain') : 'idle',
    });
  }
}
