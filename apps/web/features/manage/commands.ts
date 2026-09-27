import type { Decision } from './queue-state.ts';
import { readMembers, readRoles, readSettings, readSubmission } from './read.ts';
import { type MainClient, type MemberCommand, type ModerationItem, problemCode, type RoleCommand,
  type SettingsView, uuidOf } from './types.ts';

// Commands from the browser through the BFF. Each intent carries one
// Idempotency-Key, so a retry after a lost response replays the same receipt
// instead of deciding twice. Outcomes are data, never exceptions.

export type CommandFailure =
  /** The item, member, role or rules changed since they were read. */
  | 'stale'
  /** The same key was used for a different intent. */
  | 'conflict'
  | 'denied' | 'invalid' | 'missing' | 'sign-in' | 'budget'
  /** Main accepted the intent and is still applying it; retry later with the same key. */
  | 'pending'
  | 'unavailable';

export type Outcome<T> = { ok: true; data: T } | { ok: false; failure: CommandFailure; code?: string };

type Answer<T> = { data: T | null; error: { status: number; value: unknown } | null };

export function commandFailure(status: number, code: string | undefined): CommandFailure {
  if (status === 409) return code === 'idempotency_conflict' ? 'conflict' : 'stale';
  if (status === 403) return 'denied';
  if (status === 400) return 'invalid';
  if (status === 401) return 'sign-in';
  if (status === 404) return 'missing';
  if (status === 422) return 'budget';
  if (status === 503 && code?.endsWith('_pending')) return 'pending';
  return 'unavailable';
}

export async function send<T>(call: () => Promise<Answer<T>>): Promise<Outcome<T>> {
  try {
    const { data, error } = await call();
    if (error) {
      const code = problemCode(error.value);
      return { ok: false, failure: commandFailure(error.status, code), ...code ? { code } : {} };
    }
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

export const newKey = () => crypto.randomUUID();
const keyed = (key: string) => ({ headers: { 'idempotency-key': key } });

/**
 * Accepting adopts the submitted version, compare-and-set on the Realm's
 * current selection: a correction names the selection it replaces, and a new
 * contribution expects the one Main reports now (none, the first time).
 */
async function acceptBasis(main: MainClient, realm: string, item: ModerationItem, actingSubject: string):
  Promise<Outcome<string | null>> {
  if (item.submission?.correctionOf) return { ok: true, data: item.submission.correctionOf };
  const review = await readSubmission(main, realm, item.id, actingSubject);
  if (!review.ok) return { ok: false, failure: review.failure === 'moved' ? 'stale' : review.failure === 'sign-in'
    ? 'sign-in' : review.failure === 'missing' || review.failure === 'denied' ? 'missing' : 'unavailable' };
  const selection = await send(() => main.v1.me.realms({ realm })['main-versions']({
    mainVersion: uuidOf(review.data.submission.mainVersion) }).selection.get({ query: {} }));
  if (!selection.ok) return selection.failure === 'missing' ? { ok: true, data: null } : selection;
  return { ok: true, data: 'realmSelection' in selection.data ? selection.data.realmSelection ?? null : null };
}

/** One submission decision. `key` stays the same for every retry of this decision. */
export async function decideSubmission(main: MainClient, realm: string, item: ModerationItem, decision: Decision,
  actingSubject: string, key: string): Promise<Outcome<unknown>> {
  if (!item.submission) return { ok: false, failure: 'invalid' };
  const outcome = decision.action === 'approve' ? 'accept' as const
    : decision.action === 'reject' ? 'reject' as const : 'request-changes' as const;
  let expectedSelectionHead: string | null = null;
  if (outcome === 'accept') {
    const basis = await acceptBasis(main, realm, item, actingSubject);
    if (!basis.ok) return basis;
    expectedSelectionHead = basis.data;
  }
  return send(() => main.v1.realms({ realm }).submissions({ submission: item.id }).decisions.post({
    actingSubject, expectedRevision: item.submission!.revision, outcome, expectedSelectionHead,
    publicReason: decision.reason?.trim() || null, internalNote: decision.note?.trim() || null }, keyed(key)));
}

/**
 * The Realm management generation every management write compares against.
 * Any one of the three management reads returns it; a moderator may hold only
 * one of their permissions.
 */
export async function managementGeneration(main: MainClient, realm: string, actingSubject: string):
  Promise<Outcome<string>> {
  for (const read of [() => readMembers(main, realm, { actingSubject }), () => readRoles(main, realm, actingSubject),
    () => readSettings(main, realm, actingSubject)]) {
    const result = await read();
    if (result.ok) return { ok: true, data: result.data.generation };
    if (result.failure !== 'denied') return { ok: false, failure: result.failure === 'moved' ? 'stale' : 'unavailable' };
  }
  return { ok: false, failure: 'denied' };
}

/**
 * Escalates one queue item to the Realm owners. The item itself is compared by
 * its own generation; the Realm-wide generation also moves with unrelated
 * management changes, so a stale Realm generation is read again once with a
 * new key (the first attempt was refused, so nothing is duplicated).
 */
export async function escalate(main: MainClient, realm: string, item: ModerationItem, reason: string,
  actingSubject: string, key: string): Promise<Outcome<unknown>> {
  const itemKind = item.kind.endsWith('_submission') ? 'submission' as const : 'report' as const;
  let attemptKey = key;
  for (let attempt = 0; attempt < 2; attempt++) {
    const generation = await managementGeneration(main, realm, actingSubject);
    if (!generation.ok) return generation;
    const result = await send(() => main.v1.realms({ realm }).escalations.post({ actingSubject,
      expectedGeneration: generation.data, reason: reason.trim(), expectedItemGeneration: item.generation,
      itemKind, itemId: item.id }, keyed(attemptKey)));
    if (result.ok || result.failure !== 'stale' || result.code !== 'stale_realm_management_basis') return result;
    attemptKey = newKey();
  }
  return { ok: false, failure: 'stale' };
}

export function commitDecision(main: MainClient, realm: string, item: ModerationItem, decision: Decision,
  actingSubject: string, key: string) {
  return decision.action === 'escalate'
    ? escalate(main, realm, item, decision.reason ?? '', actingSubject, key)
    : decideSubmission(main, realm, item, decision, actingSubject, key);
}

export function changeMember(main: MainClient, realm: string, command: MemberCommand, key: string) {
  return send(() => main.v1.realms({ realm }).members.post(command, keyed(key)));
}

export function previewRole(main: MainClient, realm: string, command: RoleCommand) {
  return send(() => main.v1.realms({ realm })['role-impact'].post(command));
}

export function changeRole(main: MainClient, realm: string, command: RoleCommand, impactDigest: string, key: string) {
  return send(() => main.v1.realms({ realm })['role-changes'].post({ ...command, impactDigest }, keyed(key)));
}

export function saveSettings(main: MainClient, realm: string, command: {
  actingSubject: string; expectedGeneration: string; reason: string;
  settings: SettingsView['settings']; expectedRulesRevision: string | null }, key: string) {
  return send(() => main.v1.realms({ realm }).settings.put(command, keyed(key)));
}
