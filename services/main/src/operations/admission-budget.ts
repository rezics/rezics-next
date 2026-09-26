export type LaneName = 'worker' | 'broker' | 'object';

/** A lane refused a new intent before any owner effect; the caller may retry. */
export class BackpressureSaturated extends Error {
  constructor(readonly lane: LaneName, readonly retryAfterSeconds: number) {
    super(`${lane} budget is saturated`);
  }
}

/** The lane cannot prove it has room, so admission fails closed. */
export class BackpressureUnavailable extends Error {
  constructor(readonly lane: LaneName) {
    super(`${lane} budget is unavailable`);
  }
}

export interface InFlightBudget {
  maxInFlight: number;
  maxBytes: number;
  retryAfterSeconds: number;
}

export type LeaseOutcome = 'completed' | 'refused' | 'failed';

export interface AdmissionLease {
  readonly bytes: number;
  settle(outcome: LeaseOutcome): void;
}

export interface InFlightCounters {
  inFlight: number;
  bytesInFlight: number;
  admitted: number;
  rejected: number;
  completed: number;
  refused: number;
  failed: number;
}

/**
 * Bounded in-process admission with no waiting queue: a request that does not
 * fit is refused immediately instead of being buffered. Every admitted lease is
 * settled exactly once, so admitted = completed + refused + failed + inFlight.
 * O(1) time and memory per admission and settlement.
 */
export class InFlightAdmission {
  private inFlight = 0;
  private bytesInFlight = 0;
  private admitted = 0;
  private rejected = 0;
  private settled: Record<LeaseOutcome, number> = { completed: 0, refused: 0, failed: 0 };

  constructor(readonly lane: LaneName, readonly budget: InFlightBudget) {
    if (!Number.isSafeInteger(budget.maxInFlight) || budget.maxInFlight < 1
      || !Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1
      || !Number.isSafeInteger(budget.retryAfterSeconds) || budget.retryAfterSeconds < 1) {
      throw new Error(`${lane} admission budget is invalid`);
    }
  }

  admit(bytes: number): AdmissionLease {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('admission bytes are invalid');
    if (this.inFlight >= this.budget.maxInFlight
      || this.bytesInFlight + bytes > this.budget.maxBytes) {
      this.rejected += 1;
      throw new BackpressureSaturated(this.lane, this.budget.retryAfterSeconds);
    }
    this.inFlight += 1;
    this.bytesInFlight += bytes;
    this.admitted += 1;
    let open = true;
    return {
      bytes,
      settle: (outcome) => {
        if (!open) throw new Error('admission lease is already settled');
        open = false;
        this.inFlight -= 1;
        this.bytesInFlight -= bytes;
        this.settled[outcome] += 1;
      },
    };
  }

  saturated(): boolean {
    return this.inFlight >= this.budget.maxInFlight || this.bytesInFlight >= this.budget.maxBytes;
  }

  counters(): InFlightCounters {
    return { inFlight: this.inFlight, bytesInFlight: this.bytesInFlight,
      admitted: this.admitted, rejected: this.rejected, ...this.settled };
  }
}
