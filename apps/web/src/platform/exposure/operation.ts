import { parseIntent, type Intent, type Outcome, type Page } from './data';

const unavailable: Page = { status: 'unavailable', discovery: { status: 'unavailable' } };

/** In-memory exclusion and recovery for one immutable public effect. No automatic writes. */
export class ExposureOperation {
  intent: Intent | null = null;
  outcome: Outcome | null = null;
  busy = false;
  private unresolved = false;
  private retired = false;
  private generation = 0;
  private continuationCaptured = false;
  private continuation: string | null = null;

  review(intent: Intent): boolean {
    if (this.retired || this.busy || this.intent) return false;
    this.intent = parseIntent(intent);
    this.outcome = null;
    return true;
  }
  cancel(): boolean {
    if (this.retired || this.busy || this.unresolved) return false;
    this.intent = null;
    return true;
  }
  /** Retire this continuation while keeping its immutable intent and any uncertainty as history. */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.generation++;
    if (this.busy && this.intent) {
      this.unresolved = true;
      this.outcome ??= { status: 'uncertain', operation: this.intent, current: unavailable };
    }
    this.busy = false;
  }

  async send(
    change: (intent: Intent, csrfToken?: string) => Promise<Outcome>,
    csrfToken?: string,
  ): Promise<Outcome | null> {
    if (this.retired || this.busy || !this.intent || this.outcome?.status === 'recorded') return null;
    this.busy = true;
    const operation = this.intent;
    if (!this.continuationCaptured) {
      this.continuationCaptured = true;
      this.continuation = csrfToken ?? null;
    }
    const continuation = this.continuation;
    const generation = this.generation;
    let result: Outcome;
    try {
      result = await change(operation, continuation ?? undefined);
    } catch {
      result = { status: 'uncertain', operation, current: unavailable };
    }
    // A refusal after a lost response cannot settle the earlier command.
    if (this.unresolved && result.status === 'not-sent')
      result = { status: 'uncertain', operation, current: result.current };

    // A retired attempt is retained as source history, but cannot settle or publish into its successor.
    if (this.retired || generation !== this.generation) {
      this.unresolved ||= result.status !== 'not-sent';
      this.outcome = result;
      return null;
    }

    this.unresolved ||= result.status !== 'not-sent';
    this.outcome = result;
    if (!this.unresolved) {
      this.intent = null;
      this.continuationCaptured = false;
      this.continuation = null;
    }
    this.busy = false;
    return result;
  }
}
