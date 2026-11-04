import {
  createSignupKey,
  normalizeSignupHandle,
  type SignupBody,
  type SignupFailure,
  type SignupSubmission,
} from './signup';

export type SignupDraft = { handle: string; email: string; password: string; confirmation: string };

export type SignupAttempt = Readonly<{
  id: number;
  journeyId: number;
  key: string;
  handle: string;
  email: string;
  password: string;
  retry: number;
}>;

type SignupFailureAfterDispatch = Exclude<SignupFailure, { kind: 'local-password' }>;

export type SignupAttemptPhase =
  | { kind: 'draft'; key: string; values: SignupDraft }
  | { kind: 'dispatched'; attempt: SignupAttempt; source: 'draft' | 'retry'; values: SignupDraft }
  | {
      kind: 'uncertain';
      attempt: SignupAttempt;
      failure: SignupFailureAfterDispatch;
      retryAt: number | null;
      verificationFailed: boolean;
    }
  | { kind: 'handle-unavailable'; attempt: SignupAttempt; values: SignupDraft; message: string }
  | { kind: 'refused'; message: string }
  | { kind: 'created' }
  | { kind: 'signing-in' }
  | { kind: 'sign-in-failed'; message: string }
  | { kind: 'signed-in' }
  | { kind: 'retired' };

export type SignupDispatch = { attempt: SignupAttempt; body: SignupBody; source: 'draft' | 'retry' };

export type SignupResolution =
  | { kind: 'created'; credentials: { email: string; password: string } }
  | { kind: 'request-rejected'; failure: Extract<SignupFailureAfterDispatch, { kind: 'request-rejected' }> }
  | { kind: 'handle-unavailable'; failure: Extract<SignupFailureAfterDispatch, { kind: 'handle-unavailable' }> }
  | { kind: 'refused'; failure: Extract<SignupFailureAfterDispatch, { kind: 'conflict' }> }
  | { kind: 'uncertain'; failure: SignupFailureAfterDispatch }
  | { kind: 'ignored' };

const emptyDraft = (): SignupDraft => ({ handle: '', email: '', password: '', confirmation: '' });

/** Owns one mounted registration journey, including the immutable business input for an uncertain write. */
export class SignupAttemptController {
  #nextAttemptId = 0;
  #active = true;
  #phase: SignupAttemptPhase;
  #listeners = new Set<(phase: SignupAttemptPhase) => void>();

  constructor(
    readonly journeyId: number,
    key = createSignupKey(),
  ) {
    this.#phase = { kind: 'draft', key, values: emptyDraft() };
  }

  get phase(): SignupAttemptPhase {
    return this.#phase;
  }

  subscribe(listener: (phase: SignupAttemptPhase) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#phase);
    return () => this.#listeners.delete(listener);
  }

  #set(phase: SignupAttemptPhase) {
    this.#phase = phase;
    for (const listener of this.#listeners) listener(phase);
  }

  updateDraft(field: keyof SignupDraft, value: string): void {
    if (!this.#active) return;
    if (this.#phase.kind === 'draft' || this.#phase.kind === 'handle-unavailable') {
      const values = { ...this.#phase.values, [field]: value };
      this.#set({ ...this.#phase, values });
    }
  }

  dispatch(token: string): SignupDispatch | null {
    if (!this.#active || !token) return null;
    let source: SignupDispatch['source'];
    let key: string;
    let handle: string;
    let email: string;
    let password: string;
    let values: SignupDraft;
    let retry: number;

    if (this.#phase.kind === 'draft') {
      source = 'draft';
      ({ key, values } = this.#phase);
      const normalizedHandle = normalizeSignupHandle(values.handle);
      if (!normalizedHandle) return null;
      handle = normalizedHandle;
      email = values.email.trim().toLowerCase();
      password = values.password;
      retry = 0;
    } else if (this.#phase.kind === 'uncertain') {
      if (this.#phase.retryAt !== null && Date.now() < this.#phase.retryAt) return null;
      source = 'retry';
      const prior = this.#phase.attempt;
      ({ key, handle, email, password } = prior);
      retry = prior.retry + 1;
      values = { handle, email, password, confirmation: '' };
    } else {
      return null;
    }

    const attempt = Object.freeze({
      id: ++this.#nextAttemptId,
      journeyId: this.journeyId,
      key,
      handle,
      email,
      password,
      retry,
    });
    this.#set({ kind: 'dispatched', attempt, source, values });
    return {
      attempt,
      source,
      body: { key, handle, email, password, turnstile_token: token },
    };
  }

  resolve(attempt: SignupAttempt, result: SignupSubmission): SignupResolution {
    return this.#resolve(attempt, result);
  }

  /** Resolve by a non-secret id so an async callback need not retain the credential-bearing attempt. */
  resolveAttempt(attemptId: number, result: SignupSubmission): SignupResolution {
    const current = this.#phase;
    if (current.kind !== 'dispatched' || current.attempt.id !== attemptId) return { kind: 'ignored' };
    return this.#resolve(current.attempt, result);
  }

  #resolve(attempt: SignupAttempt, result: SignupSubmission): SignupResolution {
    const current = this.#phase;
    if (
      !this.#active ||
      current.kind !== 'dispatched' ||
      current.attempt.id !== attempt.id ||
      current.attempt.journeyId !== attempt.journeyId
    )
      return { kind: 'ignored' };

    if (result.ok) {
      const credentials = { email: attempt.email, password: attempt.password };
      this.#set({ kind: 'created' });
      return { kind: 'created', credentials };
    }

    const failure = result.failure;
    if (failure.kind === 'local-password') return { kind: 'ignored' };
    if (current.source === 'draft' && failure.kind === 'request-rejected') {
      this.#set({ kind: 'draft', key: attempt.key, values: current.values });
      return { kind: 'request-rejected', failure };
    }
    if (current.source === 'draft' && failure.kind === 'handle-unavailable') {
      this.#set({ kind: 'handle-unavailable', attempt, values: current.values, message: failure.message });
      return { kind: 'handle-unavailable', failure };
    }
    if (current.source === 'draft' && failure.kind === 'conflict') {
      this.#set({ kind: 'refused', message: failure.message });
      return { kind: 'refused', failure };
    }

    const retrySeconds =
      failure.kind === 'rate-limited' && failure.retryAfter !== null ? Number(failure.retryAfter) : Number.NaN;
    const retryAt =
      Number.isSafeInteger(retrySeconds) && retrySeconds >= 0
        ? Math.min(Number.MAX_SAFE_INTEGER, Date.now() + retrySeconds * 1000)
        : null;
    this.#set({
      kind: 'uncertain',
      attempt,
      failure,
      retryAt,
      verificationFailed: failure.status === 400 && failure.code === 'registration_denied',
    });
    return { kind: 'uncertain', failure };
  }

  useDifferentHandle(key = createSignupKey()): boolean {
    const current = this.#phase;
    if (!this.#active || current.kind !== 'handle-unavailable') return false;
    const handle = normalizeSignupHandle(current.values.handle);
    if (!handle || handle === current.attempt.handle) return false;
    this.#set({ kind: 'draft', key, values: current.values });
    return true;
  }

  beginSignIn(): boolean {
    if (!this.#active || this.#phase.kind !== 'created') return false;
    this.#set({ kind: 'signing-in' });
    return true;
  }

  finishSignIn(success: boolean, message = ''): void {
    if (!this.#active || this.#phase.kind !== 'signing-in') return;
    this.#set(success ? { kind: 'signed-in' } : { kind: 'sign-in-failed', message });
  }

  retire(): void {
    this.#active = false;
    this.#set({ kind: 'retired' });
    this.#listeners.clear();
  }
}

export function signupAttemptHasPrivateInput(phase: SignupAttemptPhase): boolean {
  if (phase.kind === 'draft') {
    const { handle, email, password, confirmation } = phase.values;
    return Boolean(handle.trim() || email.trim() || password || confirmation);
  }
  return phase.kind === 'dispatched' || phase.kind === 'uncertain' || phase.kind === 'handle-unavailable';
}
