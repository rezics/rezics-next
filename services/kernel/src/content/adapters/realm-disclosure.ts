import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Access, Actor, AccessClient } from '../../request/access.ts';
import type { AccessWorkAccounting } from '../../access/work.ts';
import { AccessUnavailableError, requireAccessDeadline } from '../../access/unavailable.ts';
import { routeOf } from '../../route/route.ts';
import { ProblemError } from '../../http/problem-error.ts';
import { ContentNotFoundError, prepareRealmSubjectThreadDisclosure, snapshot } from '../reads.ts';
import type { AnchoredPosition } from '../model.ts';
import { realmSubjectPoint } from '../realm-subject-disclosure-work.ts';
import { REALM_SUBJECT_DISCLOSURE_BATCH } from '../contract/index.ts';
import type { RealmDisclosurePorts, RealmObservation, RealmSubjectDisclosureInput } from '../contract/index.ts';
export type RealmSubjectDisclosureDependencies = Readonly<{ pool: Pool; access: Access }>;
export type RealmSubjectDisclosureContext = Readonly<{ actor: Actor; deadline: number; work: AccessWorkAccounting }>;
export type RealmSubjectParentObservation = RealmObservation<AnchoredPosition>;
type Observation = RealmSubjectParentObservation;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nativeSnapshot: typeof snapshot = (...args) => snapshot(...args);
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

function expectedState(error: unknown): 'withheld' | 'unknown' {
  if (denied(error)) return 'withheld';
  if (error instanceof AccessUnavailableError) return 'unknown';
  throw error;
}

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

export const nativeRealmEvidenceHost = {
  hash,
  snapshot: nativeSnapshot,
  point: nativePoint,
  async time(client: AccessClient) {
    const at = await realmSubjectPoint<{ at: string }>(
      client,
      'content.realmSubject.time',
      [],
      () => client.query('SELECT clock_timestamp()::text AS at'),
      { keys: 0, rows: 1, bytes: 128 },
    );
    return at.rows[0]!.at;
  },
};
export type NativeRealmDisclosurePorts = RealmDisclosurePorts<
  RealmSubjectDisclosureDependencies,
  RealmSubjectDisclosureContext,
  AnchoredPosition
>;
export function createNativeRealmDisclosurePorts(
  evidence: Pick<NativeRealmDisclosurePorts, 'parent' | 'subject'>,
  now: () => number,
): NativeRealmDisclosurePorts {
  return {
    ...evidence,
    now,
    hash,
    principal: (context) => principalSignature(context.actor),
    deadline: requireAccessDeadline,
    validate,
    failure: expectedState,
    thread: prepareRealmSubjectThreadDisclosure,
    sameHome: currentHome,
  };
}
export function realmSearchFailure(error: unknown): 'unavailable' | 'concealed' | undefined {
  if (error instanceof AccessUnavailableError) return 'unavailable';
  if (denied(error)) return 'concealed';
  return undefined;
}
