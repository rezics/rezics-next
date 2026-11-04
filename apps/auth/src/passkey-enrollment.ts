export type PasskeyEnrollmentObservation =
  | 'options'
  | 'prompt'
  | 'registration-dispatched'
  | 'confirmed'
  | 'unknown'
  | 'cancelled'
  | 'failure';

export type PasskeyEnrollmentPhase =
  | 'options'
  | 'prompt'
  | 'saving'
  | 'confirmed'
  | 'unknown'
  | 'reviewing'
  | 'reviewed'
  | 'changed-account'
  | 'authority-unavailable';

export type PasskeyEnrollmentSnapshot = {
  attemptId: number | null;
  accountId: string | null;
  phase: PasskeyEnrollmentPhase;
  possibleEffect: boolean;
  reviewRequired: boolean;
};

type CurrentAttempt = PasskeyEnrollmentSnapshot & { callbacksLive: boolean };

/** Keeps only mounted-page phase and uncertainty; credential material never enters this controller. */
export class PasskeyEnrollmentController {
  private nextAttemptId = 0;
  private current: CurrentAttempt | null = null;

  snapshot(): PasskeyEnrollmentSnapshot | null {
    if (!this.current) return null;
    const { callbacksLive: _callbacksLive, ...snapshot } = this.current;
    return { ...snapshot };
  }

  begin(accountId: string): number | null {
    if (
      !accountId ||
      (this.current && this.current.phase !== 'changed-account' && this.current.phase !== 'authority-unavailable')
    )
      return null;
    const attemptId = ++this.nextAttemptId;
    this.current = {
      attemptId,
      accountId,
      phase: 'options',
      possibleEffect: false,
      reviewRequired: false,
      callbacksLive: true,
    };
    return attemptId;
  }

  owns(attemptId: number): boolean {
    return this.current?.attemptId === attemptId;
  }

  observe(attemptId: number, observation: PasskeyEnrollmentObservation): boolean {
    const current = this.current;
    if (!current || current.attemptId !== attemptId || !current.callbacksLive) return false;
    if (observation === 'options' || observation === 'prompt') {
      current.phase = observation;
    } else if (observation === 'registration-dispatched') {
      current.phase = 'saving';
      current.possibleEffect = true;
    } else if (observation === 'confirmed') {
      current.phase = 'confirmed';
      current.callbacksLive = false;
    } else if (observation === 'unknown') {
      current.phase = 'unknown';
      current.possibleEffect = true;
      current.reviewRequired = true;
      current.callbacksLive = false;
    } else {
      this.current = null;
    }
    return true;
  }

  pagehide(): void {
    const current = this.current;
    if (!current) return;
    current.callbacksLive = false;
    if (current.phase === 'changed-account' || current.phase === 'authority-unavailable') return;
    if (!current.possibleEffect) {
      this.current = null;
      return;
    }
    if (current.phase !== 'confirmed') current.phase = 'unknown';
    current.reviewRequired = current.phase !== 'confirmed';
  }

  restoreFor(accountId: string): PasskeyEnrollmentSnapshot | null {
    const current = this.current;
    if (!current) return null;
    if (current.phase === 'authority-unavailable') return this.snapshot();
    if (!current.accountId || current.accountId !== accountId) {
      current.accountId = null;
      current.phase = 'changed-account';
      current.reviewRequired = false;
      current.callbacksLive = false;
    } else if (current.reviewRequired) {
      current.phase = 'unknown';
      current.callbacksLive = false;
    }
    return this.snapshot();
  }

  beginReview(attemptId: number): boolean {
    const current = this.current;
    if (
      !current ||
      current.attemptId !== attemptId ||
      !current.reviewRequired ||
      (current.phase !== 'unknown' && current.phase !== 'reviewed')
    )
      return false;
    current.phase = 'reviewing';
    return true;
  }

  reviewUnavailable(attemptId: number): boolean {
    const current = this.current;
    if (!current || current.attemptId !== attemptId || !current.reviewRequired) return false;
    current.phase = 'unknown';
    return true;
  }

  reviewReady(attemptId: number): boolean {
    const current = this.current;
    if (!current || current.attemptId !== attemptId || !current.reviewRequired) return false;
    current.phase = 'reviewed';
    return true;
  }

  finishReview(attemptId: number): boolean {
    if (!this.current || this.current.attemptId !== attemptId || this.current.phase !== 'reviewed') return false;
    this.current = null;
    return true;
  }

  retireAuthority(): void {
    if (!this.current?.possibleEffect) {
      this.current = null;
      return;
    }
    this.current.accountId = null;
    this.current.phase = 'authority-unavailable';
    this.current.reviewRequired = false;
    this.current.callbacksLive = false;
  }

  clearConfirmed(attemptId: number): boolean {
    if (!this.current || this.current.attemptId !== attemptId || this.current.phase !== 'confirmed') return false;
    this.current = null;
    return true;
  }
}
