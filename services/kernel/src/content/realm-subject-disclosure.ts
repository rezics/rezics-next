import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Access, Actor, AccessCheck, AccessClient } from '../request/access.ts';
import { accessCheck } from '../request/access.ts';
import type { AccessWorkAccounting } from '../access/work.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { realmReadEligibility } from '../community/realm.ts';
import { spaceReadEligibility } from '../community/space.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { routeOf } from '../route/route.ts';
import { ProblemError } from '../http/problem-error.ts';
import { ContentNotFoundError, prepareRealmSubjectThreadDisclosure, snapshot } from './reads.ts';
import type { AnchoredPosition } from './model.ts';
import { realmSubjectPoint } from './realm-subject-disclosure-work.ts';
import bindingRead from '../community/container-lifecycle-binding.sql';
import referenceRead from '../semantic/read-subject-reference.sql';
import subjectState from '../semantic/scope-leaf-evidence-eligibility.sql';
import bansRead from '../community/read-ban-current.sql';
import { realmReadBanAccounts } from '../community/eligibility-access-work.ts';

export const REALM_SUBJECT_DISCLOSURE_BATCH = 8;
export const REALM_SUBJECT_DISCLOSURE_FRESH_MS = 1000;

export type RealmSubjectCandidate = Readonly<{
  threadId: string;
  openingPostId: string;
  subjectId: string;
}>;
export type RealmSubjectDisclosureInput = Readonly<{
  realmId: string;
  candidates: readonly RealmSubjectCandidate[];
}>;
export type RealmSubjectDisclosureDependencies = Readonly<{ pool: Pool; access: Access }>;
export type RealmSubjectDisclosureContext = Readonly<{
  actor: Actor;
  deadline: number;
  work: AccessWorkAccounting;
}>;
export type RealmSubjectFreshness = Readonly<{
  before: string;
  final: string;
  expiresAt: number;
  anchors: readonly AnchoredPosition[];
}>;
export type RealmSubjectEvidence =
  | Readonly<{ state: 'positive'; freshness: RealmSubjectFreshness }>
  | Readonly<{ state: 'absent' | 'withheld' | 'unknown' }>;
export type RealmSubjectDisclosure = Readonly<{
  finish(): Promise<readonly RealmSubjectEvidence[]>;
}>;

type Observation = Readonly<{ signature: string; anchors: readonly AnchoredPosition[] }>;
type PreparedSource = Awaited<ReturnType<typeof prepareRealmSubjectThreadDisclosure>>;
type Prepared = Readonly<{
  source: PreparedSource;
  parent: Observation;
  subject: Observation;
}>;
type Binding = NonNullable<(typeof bindingRead)['~reylo']['element']>;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A reanchored home must retain its epoch and move only forward. Unrelated
 * commits may advance position without changing any of the exact observations.
 * A new epoch needs a new census attempt, never reuse of this prepared evidence.
 */
function currentHome(before: Observation, after: Observation): boolean {
  return before.anchors.every((previous) =>
    after.anchors.some(
      (current) =>
        current.partition.partitionNo === previous.partition.partitionNo &&
        current.epoch === previous.epoch &&
        current.position >= previous.position,
    ),
  );
}

/** Authentication binds the original actor object inside Access. Keep that
 * object rather than reconstructing an account-shaped substitute. The closed
 * principal fingerprint additionally detects mutation across released homes.
 */
function principalSignature(actor: Actor): string {
  return actor.kind === 'anonymous'
    ? hash(['anonymous'])
    : hash([actor.kind, actor.accountId, actor.clientId, actor.requestedBy, actor.authnEpoch, actor.scopes]);
}

function route(id: string): number {
  const value = typeof id === 'string' && uuid.test(id) ? routeOf(id) : null;
  if (value === null) throw new TypeError('Invalid Realm Subject candidate identity');
  return value;
}

function denied(error: unknown): boolean {
  return error instanceof ContentNotFoundError || (error instanceof ProblemError && error.code === 'not_found');
}

/** Native original read eligibility supplies all permissions. This helper only
 * constructs exact resources; it never derives authority from role names.
 */
async function prepareAccess(
  dependencies: RealmSubjectDisclosureDependencies,
  context: RealmSubjectDisclosureContext,
  id: string,
  action: 'realm:read' | 'space:read' | 'subject:read',
): Promise<AccessCheck> {
  const identity = { id, route: route(id) };
  const eligibility =
    action === 'realm:read'
      ? realmReadEligibility(identity)
      : action === 'space:read'
        ? spaceReadEligibility(identity)
        : subjectReadEligibility(identity);
  if (!dependencies.access.prepare) context.work.unavailable('Content Realm Subject native Access preparation');
  const check = await accessCheck(
    dependencies.access,
    context.actor,
    action,
    { ...identity, eligibility },
    {
      pool: dependencies.pool,
      deadline: context.deadline,
      work: context.work,
    },
  );
  if (!check.work) context.work.unavailable(`Content Realm Subject ${action} native work producer`);
  return check;
}

/** Raw typed plans retain native original/terminal semantics without generated
 * run() catalogue IO. Every invocation is one explicitly declared indexed point.
 */
async function nativePoint<I extends Record<string, unknown>, R extends Record<string, unknown>>(
  client: AccessClient,
  operation: string,
  statement: { sql: string; params: readonly string[]; '~reylo': { input: I; element: R } },
  input: I,
  keys = 1,
): Promise<R | null> {
  const values = statement.params.map((name) => input[name]);
  const result = await realmSubjectPoint(
    client,
    `content.realmSubject.${operation}`,
    values,
    () => client.query<R>(statement.sql, values),
    { keys, rows: 4 * keys + 2, bytes: 65536 },
  );
  if (result.rows.length > 1) throw new Error('Native exact point returned multiple rows');
  return result.rows[0] ?? null;
}

/** The native lifecycle binding pins the current Realm and Space heads and both
 * lifecycle revisions. Public Realm bans are a hard guard independent of floor
 * or grants, using the same fixed identities and native current-ban plan.
 */
async function observeParent(
  dependencies: RealmSubjectDisclosureDependencies,
  realmId: string,
  context: RealmSubjectDisclosureContext,
): Promise<Observation | null> {
  const realm = await prepareAccess(dependencies, context, realmId, 'realm:read');
  const parameters = { route: route(realmId), id: realmId, at: 'infinity', subject: null };
  const initial = await snapshot(dependencies, realmId, context, (client) =>
    nativePoint(client, 'parent.binding', bindingRead, parameters, 3),
  );
  if (!initial.value) return null;
  const parent: Binding = initial.value;
  const space = await prepareAccess(dependencies, context, parent.space_id, 'space:read');
  const accounts = context.actor.kind === 'account' ? realmReadBanAccounts(context.actor) : [];
  const checked = await snapshot(dependencies, realmId, context, async (client) => {
    const current = await nativePoint(client, 'parent.binding', bindingRead, parameters, 3);
    if (!current || hash(current) !== hash(parent) || !(await realm(client))) return false;
    if (accounts.length) {
      // The clock observation belongs to this native snapshot; no caller time can
      // move a ban interval. Access independently mints its ordinary live T.
      const at = await realmSubjectPoint<{ at: string }>(
        client,
        'content.realmSubject.time',
        [],
        () => client.query('SELECT clock_timestamp()::text AS at'),
        { keys: 0, rows: 1, bytes: 128 },
      );
      if (
        await nativePoint(
          client,
          'parent.ban',
          bansRead,
          {
            route: route(realmId),
            realm_id: realmId,
            account_ids: accounts,
            at: at.rows[0]!.at,
          },
          accounts.length,
        )
      )
        return false;
    }
    return true;
  });
  if (!checked.value) return null;
  // Release the Realm home before the Space read, even when co-located.
  const spaceChecked = await snapshot(dependencies, parent.space_id, context, (client) => space(client));
  if (!spaceChecked.value) return null;
  return { signature: hash(parent), anchors: [initial.anchor, checked.anchor, spaceChecked.anchor] };
}

/** The native reference plan reads the original identity and its latest single
 * redirect target. It does not walk history or redirect chains. A terminality
 * change cannot be mistaken for a reference to a replacement Subject.
 */
async function observeSubject(
  dependencies: RealmSubjectDisclosureDependencies,
  subjectId: string,
  context: RealmSubjectDisclosureContext,
): Promise<Observation | null> {
  const check = await prepareAccess(dependencies, context, subjectId, 'subject:read');
  const observed = await snapshot(dependencies, subjectId, context, async (client) => {
    const input = { route: route(subjectId), subject_id: subjectId };
    const reference = await nativePoint(client, 'subject.reference', referenceRead, input, 2);
    const state = await nativePoint(client, 'subject.state', subjectState, input);
    if (!reference || !state || !(await check(client))) return null;
    return { reference, state };
  });
  const value = observed.value;
  if (!value || value.reference.id !== subjectId || value.reference.redirect !== null) return null;
  return { signature: hash(value), anchors: [observed.anchor] };
}

function validate(input: RealmSubjectDisclosureInput): RealmSubjectDisclosureInput {
  route(input.realmId);
  if (
    !Array.isArray(input.candidates) ||
    input.candidates.length < 1 ||
    input.candidates.length > REALM_SUBJECT_DISCLOSURE_BATCH
  )
    throw new RangeError('Realm Subject disclosure accepts 1 to 8 candidates');
  const candidates = Array.from(input.candidates, ({ threadId, openingPostId, subjectId }) => {
    if (route(threadId) !== route(openingPostId)) throw new TypeError('Opening must share the original thread route');
    route(subjectId);
    return Object.freeze({ threadId, openingPostId, subjectId });
  });
  return { realmId: input.realmId, candidates };
}

/** Server-only two-round exact-candidate evaluator. Neither positive nor absent
 * evidence says anything about candidates the population owner did not supply.
 * No observation or denial from a concealed candidate is returned to the caller.
 */
export async function prepareRealmSubjectDisclosure(
  dependencies: RealmSubjectDisclosureDependencies,
  input: RealmSubjectDisclosureInput,
  supplied: RealmSubjectDisclosureContext,
): Promise<RealmSubjectDisclosure> {
  const request = validate(input);
  const started = Date.now();
  const context: RealmSubjectDisclosureContext = {
    actor: supplied.actor,
    deadline: Math.min(supplied.deadline, supplied.work.deadline, started + REALM_SUBJECT_DISCLOSURE_FRESH_MS),
    work: supplied.work,
  };
  if (!Number.isFinite(context.deadline)) throw new TypeError('A fixed disclosure deadline is required');
  const principal = principalSignature(context.actor);
  const requirePrincipal = () => {
    if (principalSignature(context.actor) !== principal)
      context.work.unavailable('Content Realm Subject original principal changed');
    requireAccessDeadline(context.deadline);
  };
  const prepared: (Prepared | RealmSubjectEvidence)[] = [];
  let parent: Observation | null = null;
  try {
    requirePrincipal();
    parent = await observeParent(dependencies, request.realmId, context);
    for (const candidate of request.candidates) {
      requirePrincipal();
      if (!parent) {
        prepared.push({ state: 'withheld' });
        continue;
      }
      const subject = await observeSubject(dependencies, candidate.subjectId, context);
      if (!subject) {
        prepared.push({ state: 'withheld' });
        continue;
      }
      const source = await prepareRealmSubjectThreadDisclosure(dependencies, candidate, request.realmId, context);
      prepared.push(source.state === 'withheld' ? { state: 'withheld' } : { source, parent, subject });
    }
  } catch (error) {
    const state = denied(error) ? 'withheld' : 'unknown';
    prepared.splice(0, prepared.length, ...request.candidates.map(() => ({ state }) as RealmSubjectEvidence));
  }
  // A consumed handle cannot be used to renew evidence after its fixed deadline
  // or under a mutated principal. This branch performs no additional native IO.
  const expiredEvidence: readonly RealmSubjectEvidence[] = Object.freeze(
    request.candidates.map(() => Object.freeze({ state: 'unknown' as const })),
  );
  let finished: Promise<readonly RealmSubjectEvidence[]> | undefined;
  return Object.freeze({
    finish() {
      // Memoization limits final work; it does not turn evidence into a cache.
      if (Date.now() >= context.deadline || principalSignature(context.actor) !== principal)
        return Promise.resolve(expiredEvidence);
      return (finished ??= finish());
    },
  });

  async function finish(): Promise<readonly RealmSubjectEvidence[]> {
    const results: RealmSubjectEvidence[] = [];
    try {
      requirePrincipal();
      const finalParent = parent ? await observeParent(dependencies, request.realmId, context) : null;
      for (let index = 0; index < prepared.length; index++) {
        requirePrincipal();
        const item = prepared[index]!;
        if ('state' in item) {
          results.push(item);
          continue;
        }
        if (!finalParent || finalParent.signature !== item.parent.signature || !currentHome(item.parent, finalParent)) {
          results.push({ state: 'withheld' });
          continue;
        }
        const candidate = request.candidates[index]!;
        const subject = await observeSubject(dependencies, candidate.subjectId, context);
        const source =
          subject && subject.signature === item.subject.signature && currentHome(item.subject, subject)
            ? await item.source.final()
            : null;
        if (!subject || !source) {
          results.push({ state: 'withheld' });
          continue;
        }
        if (item.source.state === 'absent') {
          results.push({ state: 'absent' });
          continue;
        }
        const before = hash([item.source.signature, item.parent.signature, item.subject.signature]);
        const final = hash([source.signature, finalParent.signature, subject.signature]);
        results.push({
          state: 'positive',
          freshness: {
            before,
            final,
            expiresAt: context.deadline,
            anchors: [...source.anchors, ...finalParent.anchors, ...subject.anchors],
          },
        });
      }
      requirePrincipal();
      return Object.freeze(results.map((result) => Object.freeze(result)));
    } catch (error) {
      // No partial success after a dependency failure. In particular an absent
      // producer cannot masquerade as a complete empty population.
      return Object.freeze(
        request.candidates.map(() =>
          Object.freeze({
            state: denied(error) ? ('withheld' as const) : ('unknown' as const),
          }),
        ),
      );
    }
  }
}
