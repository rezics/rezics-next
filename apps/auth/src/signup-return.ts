import type { SignupAttemptPhase } from './signup-attempt';

export type SignupReturnSummary = Readonly<{ kind: 'unresolved' | 'created' }>;
export type SignupReturnStatus = 'idle' | 'restoring' | 'ready' | 'unavailable';

export type SignupReturnState = Readonly<{
  summary: SignupReturnSummary | null;
  status: SignupReturnStatus;
  restorationRequired: boolean;
  currentViewerChanged: boolean;
}>;

export function summarizeSignupOutcome(phase: SignupAttemptPhase): SignupReturnSummary | null {
  if (phase.kind === 'dispatched' || phase.kind === 'uncertain') return { kind: 'unresolved' };
  if (phase.kind === 'created' || phase.kind === 'signing-in' || phase.kind === 'sign-in-failed')
    return { kind: 'created' };
  return null;
}

/** Keeps only a generic outcome while the mounted document reviews fresh native advice. */
export class SignupReturnController {
  #summary: SignupReturnSummary | null = null;
  #status: SignupReturnStatus = 'idle';
  #restorationRequired = false;
  #currentViewerChanged = false;
  #readId = 0;

  get state(): SignupReturnState {
    return {
      summary: this.#summary,
      status: this.#status,
      restorationRequired: this.#restorationRequired,
      currentViewerChanged: this.#currentViewerChanged,
    };
  }

  retain(phase: SignupAttemptPhase): SignupReturnState {
    const summary = summarizeSignupOutcome(phase);
    if (summary) this.#summary = summary;
    return this.state;
  }

  beginRestoration(): number | null {
    if (this.#restorationRequired || this.#status === 'restoring') return null;
    this.#restorationRequired = true;
    this.#status = 'restoring';
    return ++this.#readId;
  }

  beginRefresh(): number | null {
    if ((!this.#summary && !this.#restorationRequired) || this.#status === 'restoring') return null;
    this.#status = 'restoring';
    return ++this.#readId;
  }

  adviceReturned(readId: number): boolean {
    if (readId !== this.#readId) return false;
    this.#status = 'ready';
    return true;
  }

  adviceUnavailable(readId: number): boolean {
    if (readId !== this.#readId) return false;
    this.#status = 'unavailable';
    return true;
  }

  noteAuthorityChange(previous: string | null, current: string): SignupReturnState {
    if (
      this.#summary &&
      previous?.startsWith('account:') &&
      current.startsWith('account:') &&
      previous !== current
    )
      this.#currentViewerChanged = true;
    return this.state;
  }

  acknowledge(): boolean {
    if (!this.#summary) return false;
    this.#summary = null;
    this.#status = 'idle';
    this.#restorationRequired = false;
    this.#currentViewerChanged = false;
    this.#readId++;
    return true;
  }

  suspend(persisted: boolean): SignupReturnState {
    this.#status = 'idle';
    this.#restorationRequired = false;
    this.#currentViewerChanged = false;
    this.#readId++;
    if (!persisted) this.#summary = null;
    return this.state;
  }

  clear(): SignupReturnState {
    this.#summary = null;
    this.#status = 'idle';
    this.#restorationRequired = false;
    this.#currentViewerChanged = false;
    this.#readId++;
    return this.state;
  }
}
