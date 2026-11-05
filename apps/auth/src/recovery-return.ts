import type { AuthPostResult } from './api';
import { definitiveRecoveryRefusal } from './recovery';

export type RecoveryPhase = 'start' | 'complete';
export type RecoveryOutcome = 'dispatched' | 'acknowledged';
// A fixed pair of classifications, never an operation descriptor or a receipt.
export type RecoveryReturnSummary = Readonly<Partial<Record<RecoveryPhase, RecoveryOutcome>>>;

/** Owned only by the mounted page. No identity, payload, URL or storage is involved. */
export class RecoveryReturnController {
  #summary: RecoveryReturnSummary = {};

  get summary(): RecoveryReturnSummary {
    return this.#summary;
  }

  dispatch(phase: RecoveryPhase, exactRetry = false) {
    const previous = this.#summary[phase];
    this.#summary = { ...this.#summary, [phase]: 'dispatched' };
    return (result: AuthPostResult) => {
      if (result.ok) {
        // Another start acknowledgement cannot settle an earlier unknown send.
        if (previous !== 'dispatched' || exactRetry) this.#summary = { ...this.#summary, [phase]: 'acknowledged' };
      } else if (definitiveRecoveryRefusal(result)) {
        const next = { ...this.#summary };
        if (previous) next[phase] = previous;
        else delete next[phase];
        this.#summary = next;
      }
    };
  }
}

export function hasRecoveryHistory(summary: RecoveryReturnSummary): boolean {
  return Boolean(summary.start || summary.complete);
}

export function unresolvedRecoveryHistory(summary: RecoveryReturnSummary): boolean {
  return summary.start === 'dispatched' || summary.complete === 'dispatched';
}
