import {
  VERIFICATION_REQUEST_TIMEOUT_MS,
  VERIFICATION_SEARCH_DEBOUNCE_MS,
  type AgentVerificationRequest,
  type VerificationAmbient,
  type VerificationAttempt,
  type VerificationCommandResult,
  type VerificationEligibleSearchCopy,
  type VerificationFailure,
  type VerificationInput,
  type VerificationOperations,
  type VerificationRecoveryIO,
  type VerificationRecoveryState,
  type VerificationSearchCopy,
  type VerificationSearchFailure,
  type VerificationSearchResult,
  type VerificationSubject,
  type VerificationSubjectSearchFn,
} from '../contract/verification';
import {
  canRequestVerification,
  canRetryVerification,
  canWithdrawVerification,
  commandResultIsUncertain,
  eligibleVerificationSubjects,
  isCurrentVerificationSubject,
  matchesVerificationInput,
  portableVerificationFailure,
  truncateVerificationQuery,
  verificationCommandRetryAt,
  verificationSearchRetryAt,
} from '../core/verification';

export {
  canRequestVerification,
  canRetryVerification,
  canWithdrawVerification,
  verificationWithdrawalObservation,
} from '../core/verification';
export { verificationQueryKey } from '../contract/verification';

const defaultSearchCopy: VerificationSearchCopy = {
  unavailable: () => 'Subject search is unavailable.',
};

/** Observation ends after ten seconds; aborting a command never establishes its outcome. */
export async function withVerificationDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  caller: AbortSignal | undefined,
  timer: VerificationAmbient['timer'],
  timeout = VERIFICATION_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(caller?.reason);
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const scheduled = timer.schedule(
    () => controller.abort(new DOMException('Verification request timed out', 'TimeoutError')),
    timeout,
  );
  caller?.addEventListener('abort', cancel, { once: true });
  if (caller?.aborted) cancel();
  try {
    // Include body decoding and settle even a transport that ignores cancellation.
    return await Promise.race([interrupted, ...(controller.signal.aborted ? [] : [request(controller.signal)])]);
  } finally {
    scheduled.cancel();
    caller?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
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
    readRetryAt: 0,
    commandRetryAt: 0,
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private active = true;
  private lifetime = new AbortController();
  // Keep only ordering metadata while a fresh read hides the previous private snapshot.
  private latest: Pick<AgentVerificationRequest, 'id' | 'createdAt' | 'updatedAt'> | null = null;
  private readonly classify: (error: unknown) => VerificationFailure | undefined;
  constructor(
    readonly accountId: string,
    private io: VerificationRecoveryIO,
    private ambient: VerificationAmbient,
    private isCurrent: () => boolean = () => true,
    private canWrite: () => boolean = isCurrent,
    classify: (error: unknown) => VerificationFailure | undefined = portableVerificationFailure,
  ) {
    this.classify = classify;
  }
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
  private readWaiting() {
    return this.state.readRetryAt > this.ambient.now();
  }
  private commandWaiting() {
    return this.state.commandRetryAt > this.ambient.now();
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
      this.commandWaiting() ||
      this.state.attempt ||
      !canRequestVerification(this.state.current)
    )
      return;
    const input = frozen({
      ...draft,
      links: draft.links.map((link) => ({ ...link })),
      idempotencyKey: this.ambient.id(),
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
      this.commandWaiting() ||
      this.state.attempt ||
      !canWithdrawVerification(this.state.current) ||
      !this.state.current?.verificationRequest
    )
      return;
    this.update({
      attempt: frozen({
        kind: 'withdraw' as const,
        input: { idempotencyKey: this.ambient.id() },
        requestId: this.state.current!.verificationRequest!.id,
        receipt: null,
      }),
    });
    await this.send(false);
  }
  async retry() {
    const attempt = this.state.attempt;
    if (
      !this.active ||
      !this.isCurrent() ||
      !this.canWrite() ||
      !attempt ||
      this.busy() ||
      this.commandWaiting() ||
      !canRetryVerification(attempt, this.state.current)
    )
      return;
    await this.send(true);
  }
  private async send(recovering: boolean) {
    const attempt = this.state.attempt;
    if (
      !attempt ||
      !this.active ||
      !this.isCurrent() ||
      !this.canWrite() ||
      this.commandWaiting() ||
      (recovering && !canRetryVerification(attempt, this.state.current))
    )
      return;
    const epoch = this.epoch;
    this.update({ phase: 'sending', readStatus: 'idle', current: null, failure: undefined });
    let result: VerificationCommandResult;
    try {
      result = await withVerificationDeadline(
        (signal) =>
          attempt.kind === 'request'
            ? this.io.request(this.accountId, attempt.input, signal)
            : this.io.withdraw(this.accountId, attempt.input, signal),
        this.lifetime.signal,
        this.ambient.timer,
      );
    } catch (error) {
      const failure = this.classify(error);
      if (this.live(epoch))
        this.update({
          phase: 'uncertain',
          ...(failure === undefined
            ? {}
            : { failure, commandRetryAt: verificationCommandRetryAt(failure.retryAfter, this.ambient.now()) }),
        });
      return;
    }
    if (!this.live(epoch) || !this.canWrite()) return;
    if (!result.ok) {
      const { ok: _ok, outcome: _outcome, ...failure } = result;
      // A later refusal cannot prove that an earlier lost response did not commit.
      const uncertain = commandResultIsUncertain(recovering, result.outcome, result.status);
      this.update({
        phase: uncertain ? 'uncertain' : 'refused',
        attempt: uncertain ? attempt : null,
        failure,
        commandRetryAt: verificationCommandRetryAt(failure.retryAfter, this.ambient.now()),
      });
      return;
    }
    const receipt = result.verificationRequest;
    if (
      receipt.accountId !== this.accountId ||
      (attempt.receipt && receipt.id !== attempt.receipt.id) ||
      this.older(receipt) ||
      (attempt.kind === 'request' && !matchesVerificationInput(receipt, attempt.input)) ||
      (attempt.kind === 'withdraw' && (receipt.id !== attempt.requestId || receipt.state !== 'withdrawn'))
    ) {
      this.update({ phase: 'uncertain' });
      return;
    }
    this.remember(receipt);
    this.update({ attempt: frozen({ ...attempt, receipt }) });
    await this.readCurrent(epoch);
  }
  async reload() {
    if (!this.active || !this.isCurrent() || this.busy() || this.readWaiting()) return;
    await this.readCurrent(this.epoch);
  }
  private async readCurrent(epoch: number) {
    if (!this.live(epoch)) return;
    if (this.readWaiting()) {
      if (this.state.attempt?.receipt) this.update({ phase: 'uncertain', readStatus: 'idle' });
      return;
    }
    this.update({ phase: 'reading', readStatus: 'reading', current: null, failure: undefined, readRetryAt: 0 });
    let current: VerificationRecoveryState['current'];
    try {
      current = await withVerificationDeadline(
        (signal) => this.io.read(this.accountId, signal),
        this.lifetime.signal,
        this.ambient.timer,
      );
      if (
        current.accountId !== this.accountId ||
        (current.verificationRequest && current.verificationRequest.accountId !== this.accountId)
      )
        throw new Error('Verification account changed');
      if (current.verificationRequest && this.older(current.verificationRequest))
        throw new Error('Verification status predates the current request');
    } catch (error) {
      const failure = this.classify(error);
      if (this.live(epoch))
        this.update({
          phase: this.state.attempt ? 'uncertain' : 'unavailable',
          readStatus: 'error',
          failure,
          readRetryAt: verificationCommandRetryAt(failure?.retryAfter, this.ambient.now()),
        });
      return;
    }
    if (!this.live(epoch)) return;
    const attempt = this.state.attempt;
    const request = current.verificationRequest;
    if (request) this.remember(request);
    // A validated receipt acknowledges the command; a readable current snapshot retires it at the ordering floor.
    // Without a receipt, only withdrawal's exact request identity and terminal state can resolve an attempt.
    const resolved =
      attempt &&
      (attempt.receipt ||
        (request && attempt.kind === 'withdraw' && request.id === attempt.requestId && request.state === 'withdrawn'));
    this.update({
      current,
      readStatus: 'success',
      attempt: resolved ? null : attempt,
      phase: attempt ? (resolved ? 'review' : 'uncertain') : 'idle',
      failure: undefined,
      readRetryAt: 0,
    });
  }
}

type SearchState = {
  query: string;
  phase: 'idle' | 'pending' | 'loading' | 'ready' | 'failed';
  subjects: VerificationSubject[];
  failure?: VerificationSearchFailure;
  retryAt?: number;
};
const idle: SearchState = { query: '', phase: 'idle', subjects: [] };

/** One current term and request, with no cache shared across human sessions. */
export class VerificationSubjectSearch {
  private state = idle;
  private enabled = false;
  private composing = false;
  private timer: ReturnType<VerificationAmbient['timer']['schedule']> | undefined;
  private request: AbortController | undefined;
  private episode = 0;
  private revision = 0;
  private listeners = new Set<() => void>();
  private readonly copy: VerificationSearchCopy;
  constructor(
    private load: VerificationSubjectSearchFn,
    private ambient: VerificationAmbient,
    copy: VerificationSearchCopy = defaultSearchCopy,
  ) {
    this.copy = copy;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: SearchState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private cancel() {
    this.revision++;
    this.timer?.cancel();
    this.timer = undefined;
    const request = this.request;
    this.request = undefined;
    request?.abort();
  }
  clear = () => {
    this.cancel();
    this.composing = false;
    this.update(idle);
  };
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.episode++;
    if (!enabled) this.clear();
    else this.update(this.state);
  }
  currentEpisode = () => this.episode;
  edit = (value: string, episode = this.episode) => {
    if (!this.enabled || episode !== this.episode) return;
    const retryAt = this.state.retryAt;
    const failure = this.state.failure;
    this.cancel();
    const query = truncateVerificationQuery(value);
    if (retryAt !== undefined) {
      this.update({
        query,
        phase: 'failed',
        subjects: [],
        ...(failure === undefined ? {} : { failure }),
        retryAt,
      });
      return;
    }
    this.update({ query, phase: !this.composing && query.trim() ? 'pending' : 'idle', subjects: [] });
    if (!this.composing && query.trim()) {
      const revision = this.revision;
      this.timer = this.ambient.timer.schedule(() => {
        if (revision !== this.revision) return;
        this.timer = undefined;
        void this.send(episode, revision, false);
      }, VERIFICATION_SEARCH_DEBOUNCE_MS);
    }
  };
  isComposing = (episode = this.episode) => episode !== this.episode || this.composing;
  startComposition = (episode = this.episode) => {
    if (!this.enabled || episode !== this.episode) return;
    this.cancel();
    this.composing = true;
    if (this.state.retryAt !== undefined) this.update({ ...this.state, subjects: [] });
    else this.update({ query: this.state.query, phase: 'idle', subjects: [] });
  };
  endComposition = (value: string, episode = this.episode) => {
    if (!this.enabled || episode !== this.episode || !this.composing) return;
    this.composing = false;
    this.edit(value, episode);
  };
  retry = (episode = this.episode) => {
    if (
      !this.enabled ||
      episode !== this.episode ||
      this.state.phase !== 'failed' ||
      !this.state.query.trim() ||
      this.state.failure?.retryable === false ||
      (this.state.retryAt !== undefined && this.ambient.now() < this.state.retryAt)
    )
      return;
    this.cancel();
    void this.send(episode, this.revision, true);
  };
  current(subject: VerificationSubject, episode = this.episode) {
    return (
      episode === this.episode &&
      isCurrentVerificationSubject(this.enabled, this.composing, this.state.phase, this.state.subjects, subject)
    );
  }
  private async send(episode: number, revision: number, deliberate: boolean) {
    const query = this.state.query;
    if (
      !this.enabled ||
      episode !== this.episode ||
      revision !== this.revision ||
      this.composing ||
      !query.trim() ||
      (!deliberate && this.state.retryAt !== undefined)
    )
      return;
    const request = new AbortController();
    this.request = request;
    this.update({ query, phase: 'loading', subjects: [] });
    try {
      const result = await withVerificationDeadline(
        (signal) => this.load(query.trim(), signal),
        request.signal,
        this.ambient.timer,
      );
      if (this.request !== request || request.signal.aborted || episode !== this.episode || revision !== this.revision)
        return;
      if (result.ok) this.update({ query, phase: 'ready', subjects: result.value });
      else {
        const retryAt = verificationSearchRetryAt(result.failure.retryAfter ?? null, this.ambient.now());
        this.update({
          query,
          phase: 'failed',
          subjects: [],
          failure: result.failure,
          ...(retryAt === undefined ? {} : { retryAt }),
        });
      }
    } catch {
      if (this.request === request && !request.signal.aborted && episode === this.episode && revision === this.revision)
        this.update({
          query,
          phase: 'failed',
          subjects: [],
          failure: {
            kind: 'unavailable',
            status: 0,
            message: this.copy.unavailable(),
          },
        });
    } finally {
      if (this.request === request) this.request = undefined;
    }
  }
}

export async function searchEligibleVerificationSubjects(
  query: string,
  operations: Pick<VerificationOperations, 'suggest' | 'eligibility'>,
  copy: VerificationEligibleSearchCopy,
  languages: string[],
  signal: AbortSignal,
): Promise<VerificationSubject[]> {
  const hits = await operations.suggest(query, languages, signal);
  if (hits.length === 0) return [];
  const release = await operations.eligibility(signal);
  return eligibleVerificationSubjects(hits, release, copy);
}

/** Typed applicant verification over supplied status, request, withdrawal, eligibility, title and suggestion operations. */
export function createVerificationApplication(
  operations: VerificationOperations,
  copy: VerificationEligibleSearchCopy,
  ambient: VerificationAmbient,
) {
  return {
    operations,
    recover(
      accountId: string,
      io: VerificationRecoveryIO,
      isCurrent?: () => boolean,
      canWrite?: () => boolean,
    ): VerificationRecovery {
      return new VerificationRecovery(accountId, io, ambient, isCurrent, canWrite);
    },
    searchSubjects(load: VerificationSubjectSearchFn, searchCopy?: VerificationSearchCopy): VerificationSubjectSearch {
      return new VerificationSubjectSearch(load, ambient, searchCopy);
    },
    searchEligible(query: string, languages: string[], signal: AbortSignal): Promise<VerificationSubject[]> {
      return searchEligibleVerificationSubjects(query, operations, copy, languages, signal);
    },
    title(subjectId: string, languages: string[], signal?: AbortSignal): Promise<string | null> {
      return operations.title(subjectId, languages, signal);
    },
    status(accountId: string, signal?: AbortSignal) {
      return operations.status(accountId, signal);
    },
    request(accountId: string, input: VerificationInput, signal?: AbortSignal) {
      return operations.request(accountId, input, signal);
    },
    withdraw(accountId: string, idempotencyKey: string, signal?: AbortSignal) {
      return operations.withdraw(accountId, idempotencyKey, signal);
    },
  };
}

export type VerificationApplication = ReturnType<typeof createVerificationApplication>;
export type { VerificationAttempt };
