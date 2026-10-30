import type { Intent, Outcome } from './data';

/** In-memory exclusion and recovery for one immutable public effect. No automatic writes. */
export class ExposureOperation {
  intent: Intent | null = null;
  outcome: Outcome | null = null;
  busy = false;
  private unresolved = false;

  review(intent: Intent): boolean {
    if (this.busy || this.intent) return false;
    this.intent = intent;
    this.outcome = null;
    return true;
  }
  cancel(): boolean {
    if (this.busy || this.unresolved) return false;
    this.intent = null;
    return true;
  }
  async send(change: (intent: Intent) => Promise<Outcome>): Promise<Outcome | null> {
    if (this.busy || !this.intent || this.outcome?.status === 'recorded') return null;
    this.busy = true;
    const operation = this.intent;
    let result: Outcome;
    try {
      result = await change(operation);
    } catch {
      result = { status: 'uncertain', operation, current: { status: 'unavailable' } };
    }
    // A refusal after a lost response cannot settle the earlier command.
    if (this.unresolved && result.status === 'not-sent')
      result = { status: 'uncertain', operation, current: result.current };
    this.unresolved ||= result.status !== 'not-sent';
    this.outcome = result;
    if (!this.unresolved) this.intent = null;
    this.busy = false;
    return result;
  }
}
