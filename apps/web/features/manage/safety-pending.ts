import type { CommandFailure, Outcome } from './commands.ts';
import { admitted } from '../api/command.ts';
import type { SafetyDecisionInput, SafetyDecisionResult, SafetyReasons } from './safety-types.ts';
import type { Decision } from './queue-state.ts';
import { object, validDecision, validItem, validRecoveryInput } from './recovery-input.ts';
import type { SubmissionDecision, ModerationDecisionCommand, ModerationItem } from './types.ts';

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
    if (!sent.ok) return { kind: 'failed', failure: sent.failure, recorded: last !== null || sent.failure === 'pending' };
    last = sent.data;
    if (sent.data.operation.status === 'completed') return { kind: 'completed', result: sent.data };
  }
  return { kind: 'pending', result: last! };
}

/** A refusal that proves nothing was recorded under this key, so the kept request can go. */
export const refusedForGood = (failure: CommandFailure) => failure !== 'unavailable' && failure !== 'pending'
  && failure !== 'sign-in';

export interface CommandAttempt<Input> {
  principal?: string; realm: string; actingSubject: string; key: string; input: Input;
  status: 'recorded' | 'pending'; uncertain?: boolean;
  item?: ModerationItem; decision?: Decision;
}
export type ReportInput = Omit<ModerationDecisionCommand, 'profile'> & {
  profile: 'moderation-decision-v1' | 'rights-restriction-v1';
};
export interface QueueAttempt<Input = unknown> extends CommandAttempt<Input> { item: ModerationItem; decision: Decision }
export type ReportAttempt = QueueAttempt<ReportInput>;
export type SubmissionAttempt = QueueAttempt<SubmissionDecision>;
export interface AttemptStorage extends Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  readonly principal: string;
  lock<T>(name: string, action: () => T): Promise<T>;
}

/** A server-supplied principal owns this browser store. No principal means no recovery read or dispatch. */
export function attemptStorage(principal: string, backing = storage()): AttemptStorage | null {
  const locks = globalThis.navigator?.locks;
  if (!principal || !backing || !locks) return null;
  return { principal, getItem: key => backing.getItem(key), setItem: (key, value) => backing.setItem(key, value),
    removeItem: key => backing.removeItem(key), lock: (name, action) => locks.request(name, action) };
}

const MAX_ENTRIES = 64;
const MAX_BYTES = 512 * 1024;
export const recoveryIndexKey = (principal: string, realm: string) => `rezics:manage:recovery:v1:${encodeURIComponent(principal)}:${encodeURIComponent(realm)}`;
const slotKey = (actor: string, operation: string) => JSON.stringify([actor, operation]);
interface Entry { operation: string; attempt: CommandAttempt<unknown> }
interface Index { version: 1; entries: Record<string, Entry> }
const emptyIndex = (): Index => ({ version: 1, entries: {} });

function validEntry(entry: unknown, principal: string, realm: string): entry is Entry {
  if (!object(entry) || typeof entry.operation !== 'string' || !object(entry.attempt)) return false;
  const attempt = entry.attempt;
  return attempt.principal === principal && attempt.realm === realm && typeof attempt.actingSubject === 'string'
    && typeof attempt.key === 'string' && attempt.key.length > 0 && (attempt.status === 'recorded' || attempt.status === 'pending')
    && validRecoveryInput(entry.operation, attempt.input, attempt.actingSubject, attempt.key)
    && (entry.operation === 'settings' || entry.operation.startsWith('role:')
      ? attempt.item === undefined && attempt.decision === undefined
      : object(attempt.item) && validItem(attempt.item) && validDecision(attempt.decision) && attempt.item.id === entry.operation.split(':')[1]
      && (entry.operation.startsWith('report:') ? attempt.item.kind === 'content_report' || attempt.item.kind === 'rights_complaint'
        : typeof attempt.item.kind === 'string' && attempt.item.kind.endsWith('_submission')));
}
function readIndex(store: AttemptStorage | null, realm: string): Index {
  if (!store?.principal) return emptyIndex();
  try {
    const raw = store.getItem(recoveryIndexKey(store.principal, realm));
    if (!raw || raw.length > MAX_BYTES) return emptyIndex();
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed) || parsed.version !== 1 || !object(parsed.entries) || Object.keys(parsed.entries).length > MAX_ENTRIES) return emptyIndex();
    const entries = Object.fromEntries(Object.entries(parsed.entries).filter(([slot, entry]) => validEntry(entry, store.principal, realm)
      && slot === slotKey(entry.attempt.actingSubject, entry.operation)));
    return { version: 1, entries } as Index;
  } catch { return emptyIndex(); }
}
function writeIndex(store: AttemptStorage, realm: string, index: Index): boolean {
  const encoded = JSON.stringify(index);
  if (Object.keys(index.entries).length > MAX_ENTRIES || encoded.length > MAX_BYTES) return false;
  if (Object.keys(index.entries).length) store.setItem(recoveryIndexKey(store.principal, realm), encoded);
  else store.removeItem(recoveryIndexKey(store.principal, realm));
  return true;
}
export function readCommand<Input>(realm: string, actor: string, operation: string,
  store: AttemptStorage | null = null): CommandAttempt<Input> | null {
  return readIndex(store, realm).entries[slotKey(actor, operation)]?.attempt as CommandAttempt<Input> | undefined ?? null;
}

/** Preparation is serialized across tabs. The first valid payload is immutable, including its key and basis. */
export async function retainCommand<Input>(operation: string, proposed: CommandAttempt<Input>,
  store: AttemptStorage | null = null, dispatch = false): Promise<CommandAttempt<Input> | null> {
  if (!store?.principal || proposed.principal && proposed.principal !== store.principal) return null;
  try {
    return await store.lock(recoveryIndexKey(store.principal, proposed.realm), () => {
      const index = readIndex(store, proposed.realm);
      const slot = slotKey(proposed.actingSubject, operation);
      const attempt = index.entries[slot]?.attempt as CommandAttempt<Input> | undefined
        ?? { ...proposed, principal: store.principal };
      if (!validEntry({ operation, attempt }, store.principal, proposed.realm)) return null;
      index.entries[slot] = { operation, attempt: dispatch ? { ...attempt, uncertain: true } : attempt };
      return writeIndex(store, proposed.realm, index) ? attempt : null;
    });
  } catch { return null; }
}
const ownsSlot = (current: CommandAttempt<unknown>, attempt: CommandAttempt<unknown>) => current.key === attempt.key
  && JSON.stringify(current.input) === JSON.stringify(attempt.input);

/** Late receipts for K cannot change or delete a later intent L. */
async function changeSlot(operation: string, attempt: CommandAttempt<unknown>, store: AttemptStorage | null,
  patch: Pick<CommandAttempt<unknown>, 'status' | 'uncertain'> | null): Promise<boolean> {
  if (!store?.principal || attempt.principal !== store.principal) return false;
  try {
    return await store.lock(recoveryIndexKey(store.principal, attempt.realm), () => {
      const index = readIndex(store, attempt.realm);
      const slot = slotKey(attempt.actingSubject, operation);
      const current = index.entries[slot]?.attempt;
      if (!current || !ownsSlot(current, attempt)) return false;
      if (patch) index.entries[slot] = { operation, attempt: { ...current, ...patch } };
      else delete index.entries[slot];
      return writeIndex(store, attempt.realm, index);
    });
  } catch { return false; }
}
export const updateCommand = (operation: string, attempt: CommandAttempt<unknown>,
  patch: Pick<CommandAttempt<unknown>, 'status' | 'uncertain'>, store: AttemptStorage | null = null) => changeSlot(operation, attempt, store, patch);
export const forgetCommand = (operation: string, attempt: CommandAttempt<unknown>, store: AttemptStorage | null = null) => changeSlot(operation, attempt, store, null);

export const authoritativeRefusal = (failure: CommandFailure) => failure === 'stale' || failure === 'invalid'
  || failure === 'denied' || failure === 'missing' || failure === 'budget';
export const refusalProvesNoCommit = (attempt: CommandAttempt<unknown>, failure: CommandFailure) =>
  attempt.status !== 'pending' && authoritativeRefusal(failure)
  && (!attempt.uncertain || failure !== 'denied' && failure !== 'missing');
export async function performCommand<Input, Receipt>(operation: string, proposed: CommandAttempt<Input>,
  send: (attempt: CommandAttempt<Input>) => Promise<Outcome<Receipt>>, store: AttemptStorage | null = null): Promise<Outcome<Receipt>> {
  const attempt = await retainCommand(operation, proposed, store, true);
  if (!attempt) return { ok: false, failure: 'unavailable' };
  let result: Outcome<Receipt>;
  try { result = await send(attempt); } catch { result = { ok: false, failure: 'unavailable' }; }
  if (result.ok && admitted(result.data)) result = { ok: false, failure: 'pending' };
  if (result.ok || refusalProvesNoCommit(attempt, result.failure)) await forgetCommand(operation, attempt, store);
  else await updateCommand(operation, attempt, { status: result.failure === 'pending' ? 'pending' : attempt.status, uncertain: true }, store);
  return result;
}
export function retainedCommands<Input>(realm: string, actor: string, family: string, store: AttemptStorage | null = null):
  { operation: string; attempt: CommandAttempt<Input> }[] {
  return Object.values(readIndex(store, realm).entries).filter(entry => entry.attempt.actingSubject === actor
    && entry.operation.startsWith(`${family}:`)) as { operation: string; attempt: CommandAttempt<Input> }[];
}
export function readReportAttempt(realm: string, actor: string, id: string, store: AttemptStorage | null = null): ReportAttempt | null {
  const found = readCommand<ReportInput>(realm, actor, `report:${id}`, store);
  return found?.item?.id === id && found.decision ? found as ReportAttempt : null;
}
export function readQueueAttempt(realm: string, actor: string, id: string, store: AttemptStorage | null = null): QueueAttempt | null {
  const found = readCommand(realm, actor, `report:${id}`, store) ?? readCommand(realm, actor, `submission:${id}`, store);
  return found?.item?.id === id && found.decision ? found as QueueAttempt : null;
}
export function queueAttempts(realm: string, actor: string, store: AttemptStorage | null = null): QueueAttempt[] {
  return [...retainedCommands(realm, actor, 'report', store), ...retainedCommands(realm, actor, 'submission', store)]
    .flatMap(entry => entry.attempt.item && entry.attempt.decision ? [entry.attempt as QueueAttempt] : []);
}
export function reportAttempts(realm: string, actor: string, store: AttemptStorage | null = null): ReportAttempt[] {
  return queueAttempts(realm, actor, store).filter(attempt => !attempt.item.kind.endsWith('_submission')) as ReportAttempt[];
}
