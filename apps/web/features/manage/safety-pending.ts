import type { CommandFailure, Outcome } from './commands.ts';
import type { SafetyDecisionInput, SafetyDecisionResult, SafetyReasons } from './safety-types.ts';
import type { Decision } from './queue-state.ts';
import type { ModerationDecisionCommand, ModerationItem } from './types.ts';

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

export interface CommandAttempt<Input> {
  realm: string; actingSubject: string; key: string; input: Input;
  status: 'recorded' | 'pending';
  /** A dispatch lost its response, so a later access refusal cannot disprove that it committed. */
  uncertain?: boolean;
}
export type ReportInput = Omit<ModerationDecisionCommand, 'profile'> & {
  profile: 'moderation-decision-v1' | 'rights-restriction-v1';
};
export interface ReportAttempt extends CommandAttempt<ReportInput | null> {
  item: ModerationItem; decision: Decision;
}
export type AttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
const commandPrefix = (realm: string, actor: string) => `rezics:manage:command:${encodeURIComponent(realm)}:${encodeURIComponent(actor)}:`;
const commandKey = (realm: string, actor: string, operation: string) => `${commandPrefix(realm, actor)}${operation}`;

export function readCommand<Input>(realm: string, actor: string, operation: string,
  store: AttemptStorage | null = storage()): CommandAttempt<Input> | null {
  try {
    const found = JSON.parse(store?.getItem(commandKey(realm, actor, operation)) ?? 'null') as CommandAttempt<Input> | null;
    return found?.realm === realm && found.actingSubject === actor && typeof found.key === 'string'
      && (found.status === 'recorded' || found.status === 'pending') ? found : null;
  } catch { return null; }
}

/** Refuse dispatch if this device cannot retain the request for recovery. */
export function retainCommand<Input>(operation: string, attempt: CommandAttempt<Input>,
  store: AttemptStorage | null = storage()): boolean {
  try {
    if (!store) return false;
    store.setItem(commandKey(attempt.realm, attempt.actingSubject, operation), JSON.stringify(attempt));
    return true;
  } catch { return false; }
}

export function forgetCommand(realm: string, actor: string, operation: string, store: AttemptStorage | null = storage()) {
  try { store?.removeItem(commandKey(realm, actor, operation)); } catch { /* retain for recovery */ }
}

export const authoritativeRefusal = (failure: CommandFailure) => failure === 'stale' || failure === 'invalid'
  || failure === 'denied' || failure === 'missing' || failure === 'budget';

export const refusalProvesNoCommit = (attempt: CommandAttempt<unknown>, failure: CommandFailure) =>
  attempt.status !== 'pending' && authoritativeRefusal(failure)
  && (!attempt.uncertain || failure !== 'denied' && failure !== 'missing');

/** Retains a management write before dispatch; a lost response never creates a new intent. */
export async function performCommand<Input, Receipt>(operation: string, proposed: CommandAttempt<Input>,
  send: (attempt: CommandAttempt<Input>) => Promise<Outcome<Receipt>>,
  store: AttemptStorage | null = storage()): Promise<Outcome<Receipt>> {
  const attempt = readCommand<Input>(proposed.realm, proposed.actingSubject, operation, store) ?? proposed;
  // A reload may end the response handler without producing a network error.
  // Mark the dispatch unknown durably before starting it, while this live call
  // can still recognise its own first authoritative refusal.
  if (!retainCommand(operation, { ...attempt, uncertain: true }, store)) return { ok: false, failure: 'unavailable' };
  let result: Outcome<Receipt>;
  try { result = await send(attempt); } catch { result = { ok: false, failure: 'unavailable' }; }
  if (result.ok || refusalProvesNoCommit(attempt, result.failure))
    forgetCommand(attempt.realm, attempt.actingSubject, operation, store);
  else if (result.failure === 'pending') retainCommand(operation, { ...attempt, status: 'pending' }, store);
  else retainCommand(operation, { ...attempt, uncertain: true }, store);
  return result;
}

export function readReportAttempt(realm: string, actor: string, id: string, store: AttemptStorage | null = storage()): ReportAttempt | null {
  const found = readCommand<ReportInput | null>(realm, actor, `report:${id}`, store) as ReportAttempt | null;
  return found?.item?.id === id && found.decision ? found : null;
}

export function reportAttempts(realm: string, actor: string, store: AttemptStorage | null = storage()): ReportAttempt[] {
  const found: ReportAttempt[] = [];
  try {
    const prefix = `${commandPrefix(realm, actor)}report:`;
    for (let index = 0; index < (store?.length ?? 0); index++) {
      const key = store?.key(index);
      if (!key?.startsWith(prefix)) continue;
      const attempt = readReportAttempt(realm, actor, key.slice(prefix.length), store);
      if (attempt) found.push(attempt);
    }
  } catch { /* inaccessible storage */ }
  return found;
}

export function retainedCommands<Input>(realm: string, actor: string, family: string,
  store: AttemptStorage | null = storage()): { operation: string; attempt: CommandAttempt<Input> }[] {
  const found: { operation: string; attempt: CommandAttempt<Input> }[] = [];
  try {
    const prefix = commandPrefix(realm, actor);
    for (let index = 0; index < (store?.length ?? 0); index++) {
      const key = store?.key(index);
      if (!key?.startsWith(`${prefix}${family}:`)) continue;
      const operation = key.slice(prefix.length);
      const attempt = readCommand<Input>(realm, actor, operation, store);
      if (attempt) found.push({ operation, attempt });
    }
  } catch { /* inaccessible storage */ }
  return found;
}
