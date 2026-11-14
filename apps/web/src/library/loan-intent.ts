import type { LoanWrite } from '@rezics/client';
import type { GatedOperation } from '../kernel/exposure';
import type { LoanWriteResult } from './loans-read';

export type LoansOrigin = {
  isCurrent: (operation?: GatedOperation) => boolean;
  headers: (operation?: GatedOperation) => HeadersInit | null;
};
export type LoanCommand =
  | { operation: 'create'; input: LoanWrite }
  | { operation: 'extend'; input: { loanId: string; revision: number; dueOn: string } }
  | { operation: 'return'; input: { loanId: string; revision: number; returnedOn: string } };
export type LoanIntent = LoanCommand & { idempotencyKey: string };
export type LoanDispatch = (
  intent: LoanIntent,
  headers: HeadersInit,
  current: () => boolean,
) => Promise<LoanWriteResult | null>;
export type LoanIntentState =
  | { phase: 'idle' | 'retired' }
  | { phase: 'pending'; intent: LoanIntent; uncertain: boolean }
  | { phase: 'uncertain'; intent: LoanIntent; refusal?: Extract<LoanWriteResult, { ok: false }> }
  | { phase: 'refused'; intent: LoanIntent; result: Extract<LoanWriteResult, { ok: false }> }
  | { phase: 'saved'; intent: LoanIntent; result: Extract<LoanWriteResult, { ok: true }> };

function sameHeaders(left: HeadersInit, right: HeadersInit) {
  const a = new Headers(left);
  const b = new Headers(right);
  return [...a].length === [...b].length && [...a].every(([name, value]) => b.get(name) === value);
}

/** One selected visit owns at most one command. Reads never settle a missing receipt. */
export class LoanCommandIntent {
  private state: LoanIntentState = { phase: 'idle' };
  private listeners = new Set<() => void>();
  private capturedHeaders: Headers | null = null;
  private operation: 'copy.create' | 'copy.update' | null = null;
  private users = 0;
  private mounted = false;

  constructor(
    private origin: LoansOrigin,
    private dispatch: LoanDispatch,
    private key: () => string = () => crypto.randomUUID(),
  ) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(state: LoanIntentState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  current = () => {
    if (this.state.phase === 'retired' || (this.mounted && !this.users) || !this.origin.isCurrent()) return false;
    if (!this.operation) return true;
    const headers = this.origin.headers(this.operation);
    return (
      this.origin.isCurrent(this.operation) &&
      !!headers &&
      !!this.capturedHeaders &&
      sameHeaders(headers, this.capturedHeaders)
    );
  };
  mount = () => {
    this.mounted = true;
    this.users++;
    return () => {
      this.users--;
      // Close late callbacks immediately, while allowing React's synchronous effect reconnect.
      queueMicrotask(() => {
        if (!this.users) this.retire();
      });
    };
  };
  retire = () => {
    this.capturedHeaders = null;
    this.operation = null;
    if (this.state.phase !== 'retired') this.publish({ phase: 'retired' });
  };
  correct = () => {
    if (!this.current()) {
      this.retire();
      return;
    }
    if (this.state.phase !== 'refused') return;
    this.capturedHeaders = null;
    this.operation = null;
    this.publish({ phase: 'idle' });
  };
  start = async (command: LoanCommand) => {
    if (!this.current()) {
      this.retire();
      return;
    }
    if (this.state.phase !== 'idle') return;
    const operation = command.operation === 'create' ? 'copy.create' : 'copy.update';
    const headers = this.origin.headers(operation);
    if (!this.origin.isCurrent(operation) || !headers) return;
    this.operation = operation;
    this.capturedHeaders = new Headers(headers);
    // The caller may keep editing its draft; the attempted input is independent of it.
    const intent: LoanIntent = { ...structuredClone(command), idempotencyKey: this.key() };
    await this.send(intent, false);
  };
  retry = async () => {
    if (!this.current()) {
      this.retire();
      return;
    }
    if (this.state.phase !== 'uncertain') return;
    await this.send(this.state.intent, true);
  };
  private async send(intent: LoanIntent, uncertain: boolean) {
    this.publish({ phase: 'pending', intent, uncertain });
    let result: LoanWriteResult | null;
    try {
      result = await this.dispatch(intent, new Headers(this.capturedHeaders!), this.current);
    } catch {
      if (!this.current()) {
        this.retire();
        return;
      }
      this.publish({ phase: 'uncertain', intent });
      return;
    }
    if (!this.current() || !result) {
      this.retire();
      return;
    }
    if (result.ok) this.publish({ phase: 'saved', intent, result });
    else if (uncertain || result.reason === 'unavailable')
      this.publish({ phase: 'uncertain', intent, refusal: result });
    else this.publish({ phase: 'refused', intent, result });
  }
}

export const dispatchLoan: LoanDispatch = async (intent, headers, current) => {
  const { createLoan, updateLoanDue, completeLoan } = await import('./loans-actions');
  if (!current()) return null;
  const data = { ...intent.input, idempotencyKey: intent.idempotencyKey };
  if (intent.operation === 'create') return createLoan({ data, headers });
  if (intent.operation === 'extend') return updateLoanDue({ data, headers });
  return completeLoan({ data, headers });
};
