import type { ReportActionInput } from './actions';
import { createModerationIntent } from './command-intent';
import type { ReportActionFailure, ReportActionResult } from './report-actions';

export type ReportQueueAction = (input: ReportActionInput) => Promise<ReportActionResult | void>;
export type ReportReviewResult = { ok: true } | { ok: false; state: ReportActionFailure | 'uncertain' };
type Intent = ReportActionInput extends infer Input
  ? Input extends ReportActionInput
    ? Omit<Input, 'idempotencyKey'>
    : never
  : never;

/** A definitive refusal requires a fresh read; only a lost response can replay the exact command. */
export function createReportReviewAction(
  isCurrent: () => boolean = () => true,
  generation: () => unknown = () => undefined,
) {
  const identity = createModerationIntent();
  let last: ReportActionInput | undefined;
  let result: ReportReviewResult | undefined;
  let pending = false;
  let sending = false;
  let retired = false;
  const current = () => !retired && isCurrent();
  async function send(input: ReportActionInput, action: ReportQueueAction): Promise<ReportReviewResult | undefined> {
    if (!current()) return;
    const expected = generation();
    pending = true;
    sending = true;
    last = input;
    try {
      result = (await action(input)) ?? { ok: false, state: 'error' };
    } catch (error) {
      const lost =
        error instanceof TypeError &&
        /^(Failed to fetch|fetch failed|Load failed|NetworkError.*)$/u.test(error.message);
      result = { ok: false, state: lost ? 'uncertain' : 'error' };
    } finally {
      pending = false;
      sending = false;
    }
    return current() && generation() === expected ? result : undefined;
  }
  return {
    changed: identity.changed,
    retire() {
      retired = true;
    },
    get receipt() {
      return result?.ok === true;
    },
    get unresolved() {
      return !retired && (sending || (result?.ok === false && result.state === 'uncertain'));
    },
    async submit(intent: Intent, action: ReportQueueAction): Promise<ReportReviewResult | undefined> {
      if (!current()) return;
      if (pending || result) return result;
      return send(Object.freeze({ ...intent, idempotencyKey: identity.keyFor(intent) }), action);
    },
    async retry(action: ReportQueueAction): Promise<ReportReviewResult | undefined> {
      if (!current()) return;
      if (pending || !last || !result || result.ok || result.state !== 'uncertain') return result;
      return send(last, action);
    },
    async refresh(read: () => Promise<void>): Promise<void> {
      if (!current() || pending) return;
      const expected = generation();
      pending = true;
      try {
        await read();
        if (!current() || generation() !== expected) return;
        identity.changed();
        last = undefined;
        result = undefined;
      } finally {
        pending = false;
      }
    },
    get input() {
      return last;
    },
  };
}
