import type { Decision } from './queue-state.ts';
import { automationOf } from './reason-presets.ts';
import { readDecisionBasis, readMembers, readRoles, readSettings, readSubmission } from './read.ts';
import { type DecisionBasis, type InvitationCommand, type MainClient, type MemberCommand, type ModerationDecisionCommand,
  type ModerationItem, problemCode, type ReadFailure, type RoleCommand, type SettingsView, uuidOf } from './types.ts';

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
 * contribution expects the one Main reports now (none, the first time). A
 * whole Work or an exact publication has its own slot in the Realm, whose
 * head the Realm's submitted publications list (none, the first time).
 */
async function acceptBasis(main: MainClient, realm: string, item: ModerationItem, actingSubject: string):
  Promise<Outcome<string | null>> {
  if (item.submission?.correctionOf) return { ok: true, data: item.submission.correctionOf };
  if (item.kind === 'work_submission' || item.kind === 'content-publication_submission') {
    const slots = await send(() => main.v1.realms({ realm })['submitted-publications'].get({
      query: { work: item.target.resource, actingSubject } }));
    if (!slots.ok) return slots;
    const kind = item.kind === 'work_submission' ? 'work' : 'content-publication';
    const slot = slots.data.items.find(entry => entry.kind === kind && entry.resource === item.target.resource
      && (kind === 'work' || entry.variant === item.target.component));
    return { ok: true, data: slot?.selection ?? null };
  }
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

type DecisionTarget = ModerationDecisionCommand['targets'][number];
// The basis reports evidence owners and components as plain strings; a decision may name only these.
const owners = ['graph', 'content', 'source', 'media', 'review'] as const satisfies readonly DecisionTarget['owner'][];
const components = ['name', 'title', 'body', 'structure', 'media_use', 'synopsis', 'cover', 'publication',
  'record'] as const satisfies readonly DecisionTarget['component'][];
const isOwner = (value: string): value is DecisionTarget['owner'] => (owners as readonly string[]).includes(value);
const isComponent = (value: string): value is DecisionTarget['component'] =>
  (components as readonly string[]).includes(value);

/**
 * Main's keep or remove decision for a report, from its decision basis.
 * Keeping records the decision and changes nothing; Main keeps the case open
 * so it can still be reversed (`isDecidedReport`). Removing hides each reported
 * revision still available (`disclosure` fence on exactly that revision, so
 * an author's later fix shows) and compares each target's head with the one
 * the basis read. Both cite the Realm's published rules and a retained
 * evidence set; null when there is nothing to cite or nothing left to remove.
 */
export function reportDecision(basis: DecisionBasis, action: 'keep' | 'remove' | 'interim-restrict' | 'final-restrict', rationale: string | null,
  actingSubject: string, key: string): Omit<ModerationDecisionCommand, 'reasons'> | null {
  const rule = basis.ruleBasis;
  const evidenceDigest = basis.reports[0]?.evidenceDigest;
  if (!rule || !evidenceDigest) return null;
  const targets = new Map<string, DecisionTarget>();
  if (action !== 'keep') {
    for (const evidence of basis.reports.flatMap(report => report.evidence)) {
      const { owner, component } = evidence;
      if (evidence.state !== 'available' || !isOwner(owner) || !isComponent(component)) continue;
      targets.set(JSON.stringify([owner, evidence.resource, component, evidence.locator, evidence.revision]), {
        owner, resource: evidence.resource, component, locator: evidence.locator,
        scopeKind: evidence.revision === null ? 'component' : 'exact_revision', revision: evidence.revision,
        expectedHead: evidence.expectedHead, effect: 'disclosure' });
    }
    if (!targets.size) return null;
  }
  return { profile: 'moderation-decision-v1', caseId: basis.caseId, expectedGeneration: basis.generation, actingSubject,
    outcome: action === 'remove' ? 'restrict' : action === 'interim-restrict' ? 'interim_restrict'
      : action === 'final-restrict' ? 'final_restrict' : 'dismiss', targets: [...targets.values()],
    rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest }, evidenceDigest,
    reversesDecisionId: null, answersStepId: null, rationale: rationale?.trim() || null,
    // The reporter and the author learn the outcome, including this rationale.
    // It is not published on the Realm's page. A moderator's private note must not be put here.
    disclosure: 'parties', idempotencyKey: key };
}

/** A basis Main could not read, as the decision's failure: a moved basis means the case changed. */
const basisFailure = (failure: ReadFailure): CommandFailure => failure === 'moved' ? 'stale' : failure;

/**
 * Whether this case's retained evidence records automation. Main checks the
 * whole case and refuses a statement that denies it, so every report page is
 * read before saying there is none. Main does not cap how many reports one
 * case can hold, and that size does not refuse the decision. A case that
 * changed between pages is stale. A cursor offered again has stopped advancing,
 * so nothing is stated from an incomplete read.
 */
async function caseAutomation(main: MainClient, realm: string, caseId: string, actingSubject: string,
  first: DecisionBasis): Promise<Outcome<boolean>> {
  let page = first;
  const seen = new Set<string>();
  for (;;) {
    const found = automationOf(page);
    if (found !== null) return { ok: true, data: found };
    const cursor = page.nextCursor;
    if (!cursor || seen.has(cursor)) return { ok: false, failure: 'unavailable' };
    seen.add(cursor);
    const next = await readDecisionBasis(main, realm, caseId, actingSubject, cursor);
    if (!next.ok) return { ok: false, failure: basisFailure(next.failure) };
    if (next.data.generation !== first.generation) return { ok: false, failure: 'stale' };
    // Pages read before this one showed none, or the answer would already be true.
    page = next.data;
  }
}

/**
 * Keeps or removes one report's content. The basis is read again when the
 * decision is sent, so it cites what is true then; Main compares the case
 * generation, rule revision and target heads and answers stale if any moved.
 */
export async function decideReport(main: MainClient, realm: string, item: ModerationItem, decision: Decision,
  actingSubject: string, key: string): Promise<Outcome<unknown>> {
  if (!['keep', 'remove', 'interim-restrict', 'final-restrict'].includes(decision.action))
    return { ok: false, failure: 'invalid' };
  if (item.kind === 'rights_complaint' && decision.action === 'remove'
    || item.kind !== 'rights_complaint' && (decision.action === 'interim-restrict' || decision.action === 'final-restrict'))
    return { ok: false, failure: 'invalid' };
  const given = decision.reasons;
  if (!given) return { ok: false, failure: 'invalid', code: 'statement_of_reasons_required' };
  const basis = await readDecisionBasis(main, realm, item.id, actingSubject);
  if (!basis.ok) return { ok: false, failure: basisFailure(basis.failure) };
  const automated = await caseAutomation(main, realm, item.id, actingSubject, basis.data);
  if (!automated.ok) return automated;
  // Automation is a fact of this case's evidence, read now; one statement shared by a batch cannot state it for every case.
  const reasons = { ...given, automation: automated.data };
  if (!basis.data.ruleBasis) return { ok: false, failure: 'invalid', code: 'rules_unpublished' };
  // Parties read `reasons` and this rationale. The private note is never either;
  // only the details written for the affected people may be the rationale.
  const command = reportDecision(basis.data, decision.action as 'keep' | 'remove' | 'interim-restrict' | 'final-restrict',
    decision.details ?? null, actingSubject, key);
  // Everything reported is already hidden: another decision got there first.
  if (!command) return { ok: false, failure: 'stale' };
  return item.kind === 'rights_complaint'
    ? send(() => main.v1.rights.restrictions.post({ ...command, reasons, profile: 'rights-restriction-v1',
      // Main's `literals()` helper currently reads as `never` through Eden.
      outcome: command.outcome as never }, keyed(key)))
    : send(() => main.v1.moderation.decisions.post({ ...command, reasons }, keyed(key)));
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
  if (decision.action === 'escalate') return escalate(main, realm, item, decision.reason ?? '', actingSubject, key);
  if (decision.action === 'keep' || decision.action === 'remove'
    || decision.action === 'interim-restrict' || decision.action === 'final-restrict') {
    return decideReport(main, realm, item, decision, actingSubject, key);
  }
  return decideSubmission(main, realm, item, decision, actingSubject, key);
}

/** Invites someone to join; they join when they accept it from their notifications (G-314). */
export function invite(main: MainClient, realm: string, command: InvitationCommand, key: string) {
  return send(() => main.v1.realms({ realm }).invitations.post(command, keyed(key)));
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
