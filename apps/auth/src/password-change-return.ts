import type { PasswordChangePhase } from './password-change-attempt';

export type PasswordChangeReturnHistory = Readonly<{
  unknownPhase: PasswordChangePhase | null;
  applicationConfirmed: boolean;
}>;

export type RetiredPasswordOperation = {
  status: 'sending' | 'unknown' | 'paused';
  attempt: { phase: PasswordChangePhase; uncertain: boolean };
};

const phaseOrder: Record<PasswordChangePhase, number> = { stage: 0, approve: 1, apply: 2 };

/** Keeps only nonsecret outcome facts while this mounted Security page remains alive. */
export class PasswordChangeReturnController {
  private history: PasswordChangeReturnHistory | null = null;

  snapshot() {
    return this.history;
  }

  capture(operation: RetiredPasswordOperation) {
    if (operation.status === 'paused' && !operation.attempt.uncertain) return false;
    const previous = this.history?.unknownPhase ?? null;
    const unknownPhase =
      previous && phaseOrder[previous] >= phaseOrder[operation.attempt.phase] ? previous : operation.attempt.phase;
    if (unknownPhase !== previous || !this.history) {
      this.history = { unknownPhase, applicationConfirmed: this.history?.applicationConfirmed ?? false };
    }
    return true;
  }

  confirmApplication() {
    this.history = { unknownPhase: this.history?.unknownPhase ?? null, applicationConfirmed: true };
  }
}
