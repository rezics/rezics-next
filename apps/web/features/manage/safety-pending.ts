import type { CommandFailure, Outcome } from './commands.ts';
import type { SafetyDecisionInput, SafetyDecisionResult, SafetyReasons } from './safety-types.ts';

// A platform decision with targets is answered 202 and its effects run only when the same key and body are sent
// again. The request is therefore kept until the API reports every effect confirmed: written down before it is sent,
// replayed a few times at once, and offered as Resume afterwards, even after the dialog closes or the page reloads.

/** One decision request exactly as it was sent, with the words it carried. */
export interface Attempt { caseId: string; input: SafetyDecisionInput; reasons: SafetyReasons }

const keyOf = (caseId: string) => `rezics:manage:safety-attempt:${caseId}`;
const storage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

export function saveAttempt(attempt: Attempt, store: Pick<Storage, 'setItem'> | null = storage()) {
  try { store?.setItem(keyOf(attempt.caseId), JSON.stringify(attempt)); } catch { /* private mode */ }
}

export function clearAttempt(caseId: string, store: Pick<Storage, 'removeItem'> | null = storage()) {
  try { store?.removeItem(keyOf(caseId)); } catch { /* private mode */ }
}

export function loadAttempt(caseId: string, store: Pick<Storage, 'getItem'> | null = storage()): Attempt | null {
  try {
    const found = JSON.parse(store?.getItem(keyOf(caseId)) ?? 'null') as Attempt | null;
    return found && found.caseId === caseId && found.input?.caseId === caseId && typeof found.input.idempotencyKey === 'string'
      && found.reasons ? found : null;
  } catch { return null; }
}

export type Settled =
  | { kind: 'completed'; result: SafetyDecisionResult }
  /** Recorded, but not every effect is confirmed yet. */
  | { kind: 'pending'; result: SafetyDecisionResult }
  /** `recorded` is true once the API has answered this request, so the attempt must be kept for Resume. */
  | { kind: 'failed'; failure: CommandFailure; recorded: boolean };

/**
 * Sends the request and replays it (same key, same body) until the API reports `completed`, at most `tries` times with
 * a growing pause. It never builds a new request, so it can never record a second decision.
 */
export async function settleDecision(decide: (input: SafetyDecisionInput) => Promise<Outcome<SafetyDecisionResult>>,
  input: SafetyDecisionInput, options: { tries?: number; wait?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<Settled> {
  const { tries = 4, wait = 400, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) } = options;
  let last: SafetyDecisionResult | null = null;
  for (let round = 0; round < tries; round++) {
    if (round > 0) await sleep(wait * round);
    const sent = await decide(input);
    if (!sent.ok) return { kind: 'failed', failure: sent.failure, recorded: last !== null };
    last = sent.data;
    if (sent.data.operation.status === 'completed') return { kind: 'completed', result: sent.data };
  }
  return { kind: 'pending', result: last! };
}

/** A refusal that proves nothing was recorded under this key, so the kept request can go. */
export const refusedForGood = (failure: CommandFailure) => failure !== 'unavailable' && failure !== 'pending'
  && failure !== 'sign-in';
