import type { AccountDeletionAttempt } from './account-deletion-attempt';

export type AccountDeletionReturnKind = 'unsent' | 'unknown' | 'acknowledged';
export type AccountDeletionReturnHistory = { kind: AccountDeletionReturnKind; dismissed: boolean };

function classify(
  attempt: AccountDeletionAttempt | null,
  acknowledged: boolean,
  currentReview: boolean,
): AccountDeletionReturnKind | null {
  if (acknowledged || attempt?.phase === 'committed') return 'acknowledged';
  if (!attempt) return currentReview ? 'unsent' : null;
  if (attempt.uncertain || attempt.submitted || attempt.phase === 'execution' || attempt.phase === 'unknown')
    return 'unknown';
  return 'unsent';
}

export type AccountDeletionReadGeneration = {
  generation: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
};

/** Mounted, non-persistent browser return state; the native continuation remains the only retry descriptor. */
export class AccountDeletionReturnController {
  private revision = 0;
  private lifetime: AbortController | null = null;
  private historyValue: AccountDeletionReturnHistory | null = null;

  get generation(): number {
    return this.revision;
  }

  get history(): AccountDeletionReturnHistory | null {
    return this.historyValue;
  }

  isCurrent(generation: number): boolean {
    return this.revision === generation;
  }

  beginRead(): AccountDeletionReadGeneration {
    const generation = ++this.revision;
    this.lifetime?.abort();
    const lifetime = new AbortController();
    this.lifetime = lifetime;
    return {
      generation,
      signal: lifetime.signal,
      isCurrent: () => this.revision === generation && this.lifetime === lifetime && !lifetime.signal.aborted,
    };
  }

  remember(
    attempt: AccountDeletionAttempt | null,
    acknowledged = false,
    currentReview = false,
  ): AccountDeletionReturnHistory | null {
    const kind = classify(attempt, acknowledged, currentReview);
    if (kind && kind !== this.historyValue?.kind) this.historyValue = { kind, dismissed: false };
    return this.historyValue;
  }

  retire(
    attempt: AccountDeletionAttempt | null,
    acknowledged = false,
    currentReview = false,
  ): AccountDeletionReturnHistory | null {
    this.remember(attempt, acknowledged, currentReview);
    this.invalidate();
    return this.historyValue;
  }

  dismiss(): AccountDeletionReturnHistory | null {
    if (this.historyValue && !this.historyValue.dismissed)
      this.historyValue = { ...this.historyValue, dismissed: true };
    return this.historyValue;
  }

  invalidate(): void {
    this.revision++;
    this.lifetime?.abort();
    this.lifetime = null;
  }
}
