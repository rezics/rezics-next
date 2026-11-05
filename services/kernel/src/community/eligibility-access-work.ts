import type {
  ResourceEligibilityOptions,
  ResourceEligibilityPrepareContext,
  ResourceEligibilityVerifyContext,
} from '../access/eligibility.ts';
import { ACCESS_WORK_AXES, EMPTY_ACCESS_WORK, type AccessWork } from '../access/work.ts';
import type { Actor, Resource } from '../request/access.ts';
import { routeOf } from '../route/route.ts';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? 'null');
const uuid = 'x'.repeat(36);
// Same native timestamp text envelope as Access; bigint lifecycle versions have
// at most 19 decimal digits. JSON escaping takes at most six bytes per character.
const timestamp = 'x'.repeat(64);
const text = (characters: number) => '\u0001'.repeat(characters);
const bindingProjection = {
  realm_id: uuid,
  space_id: uuid,
  context_id: uuid,
  head_revision_id: uuid,
  realm_version: '9'.repeat(19),
  space_version: '9'.repeat(19),
  space_head: uuid,
  publication_id: null,
};
const realmProjection = {
  realm_id: uuid,
  space_id: uuid,
  visibility: 'protected',
  context_id: uuid,
  board_scheme_id: uuid,
  state: 'active',
  head_revision_id: uuid,
  created_at: timestamp,
  creator: uuid,
  ownership_state: 'orphaned',
  orphaned_at: timestamp,
  claim_eligible_at: timestamp,
  predecessor: uuid,
  title: text(1024),
  summary: text(4096),
  votes: { upvote: -1, downvote: -1, like: -1, love: -1, laugh: -1, insightful: -1, sad: -1 },
  presentation: { avatarMediaId: uuid, bannerMediaId: uuid, rules: { postId: uuid, revisionId: uuid } },
  revision_created_at: timestamp,
  author: uuid,
  inserted_here: false,
};
const spaceProjection = { head_revision_id: uuid, lifecycle_version: '9'.repeat(19) };

type Plan = Readonly<{ keys: number; rows: number; projection: unknown }>;
/** Explicit native plans, not returned row counts or SQL classification.
 *
 * realm-read.sql: three unique candidates (Realm, active host, exact revision),
 * plus input, host EXISTS, materialized identity, outer input cross product,
 * head join and final projection: 3 + 6 = 9 finite rows.
 * container-lifecycle-binding.sql: two unique candidates (Realm, Space), plus
 * input, Realm/input cross product, Space join, scalar and final projection:
 * 2 + 5 = 7. subject is ALWAYS null here, so SQL equality cannot seek a
 * publication_head tuple; its null pointer is still projected and compared.
 * space-eligibility-read.sql: two unique candidates, plus input, materialized
 * identity, outer input cross product, head join and projection: 2 + 5 = 7.
 * read-ban-current.sql: n <= 2 partial-unique current keys, n filter candidates,
 * one projection and one LIMIT output: 2n + 2. Closed history is excluded by
 * realm_ban_current. No result, including an empty seek, refunds these rows.
 *
 * Each dispatch also charges its query point; prepare includes the pool wait.
 * These projections follow schema.sql's UUIDs, enums, bigint, title/summary,
 * realm_votes_allowed and realm_presentation_allowed constraints. Space's
 * unbounded revision address is deliberately absent from its eligibility SQL.
 */
const realmPlan: Plan = { keys: 3, rows: 9, projection: realmProjection };
const bindingPlan: Plan = { keys: 2, rows: 7, projection: bindingProjection };
const spacePlan: Plan = { keys: 2, rows: 7, projection: spaceProjection };
const banPlan = (accounts: number): Plan => ({ keys: accounts, rows: 2 * accounts + 2, projection: { banned: true } });

function planWork(plan: Plan, parameters: unknown, pool = false): AccessWork {
  return {
    keys: plan.keys,
    points: plan.keys + 1 + Number(pool),
    witnesses: 0,
    rows: plan.rows,
    bytes: bytes(parameters) + bytes(plan.projection),
    emptySeeks: 1,
  };
}
function sum(values: readonly AccessWork[]): AccessWork {
  return Object.fromEntries(
    ACCESS_WORK_AXES.map((axis) => [axis, values.reduce((total, value) => total + value[axis], 0)]),
  ) as AccessWork;
}
function validIdentity(resource: Pick<Resource, 'route' | 'id'>): boolean {
  return routeOf(resource.id) === resource.route;
}
function validTime(at: string): boolean {
  return typeof at === 'string' && Buffer.byteLength(at) <= 64 && Number.isFinite(Date.parse(at));
}

/** The same fixed actor/principal pair used by the native protected-read check. */
export function realmReadBanAccounts(actor: Actor): string[] {
  if (actor.kind !== 'account') return [];
  const principal = actor.requestedBy?.split(':')[3];
  return [...new Set([actor.accountId, ...(principal ? [principal] : [])])];
}

type Prepare = ResourceEligibilityPrepareContext;
type Verify<E> = ResourceEligibilityVerifyContext<E>;
type Receipt = Readonly<{ result: WeakRef<object> | boolean | null | undefined; work: AccessWork }>;
type NativeRead = <T>(plan: Plan, parameters: unknown, dispatch: () => Promise<T>, pool?: boolean) => Promise<T>;

/** Private callback receipt plumbing for these three native eligibility owners.
 * Each callback explicitly names its dispatched plan. Receipts retain no row,
 * actor or permission, are consumed synchronously, and cannot move to another
 * context/result. Failure/timeout has no completed receipt: Access retains the
 * entire admitted envelope. There is no second admission sink here.
 */
function receipts<E extends object | null, V = E>(bounds: {
  prepare(context: Prepare): AccessWork | undefined;
  verify(context: Verify<V>): AccessWork | undefined;
}) {
  const completed = new WeakMap<object, Receipt>();
  const invoked = new WeakSet<object>();
  async function run<C extends object, R extends object | boolean | null | undefined>(
    context: C,
    callback: (read: NativeRead) => Promise<R>,
  ): Promise<R> {
    // Reusing a callback context must never overwrite an earlier invocation's receipt.
    if (invoked.has(context)) throw new Error('Community eligibility context already invoked');
    invoked.add(context);
    const dispatched: AccessWork[] = [];
    const result = await callback(async (plan, parameters, dispatch, pool) => {
      const work = planWork(plan, parameters, pool);
      const index = dispatched.push(work) - 1;
      const result = await dispatch();
      dispatched[index] = {
        ...work,
        bytes: bytes(parameters) + bytes(result),
        emptySeeks: result === null || result === undefined ? 1 : 0,
      };
      return result;
    });
    completed.set(context, {
      result: typeof result === 'object' && result !== null ? new WeakRef(result) : result,
      work: sum(dispatched),
    });
    return result;
  }
  function actual(context: object, result: unknown): AccessWork | undefined {
    const receipt = completed.get(context);
    completed.delete(context);
    const expected = receipt?.result instanceof WeakRef ? receipt.result.deref() : receipt?.result;
    return receipt && Object.is(expected, result) ? receipt.work : undefined;
  }
  const work = {
    prepare: { bound: bounds.prepare, actual: (context: Prepare, result: E) => actual(context, result) },
    verify: { bound: bounds.verify, actual: (context: Verify<V>, result: boolean) => actual(context, result) },
  } satisfies {
    prepare: NonNullable<ResourceEligibilityOptions<E>['work']>['prepare'];
    verify: NonNullable<ResourceEligibilityOptions<V>['work']>['verify'];
  };
  return {
    work,
    prepare: (context: Prepare, callback: (read: NativeRead) => Promise<E>) => run(context, callback),
    verify: (context: Verify<V>, callback: (read: NativeRead) => Promise<boolean>) => run(context, callback),
  };
}

export function realmEligibilityAccessWork<E extends object>(resource: Pick<Resource, 'route' | 'id'>) {
  return {
    ...receipts<E>({
      prepare: () =>
        validIdentity(resource)
          ? planWork(bindingPlan, { ...resource, at: 'infinity', subject: null }, true)
          : undefined,
      verify: ({ actor, at }) => {
        if (!validIdentity(resource) || !validTime(at)) return undefined;
        const accounts = realmReadBanAccounts(actor);
        return sum([
          planWork(realmPlan, { ...resource, at }),
          planWork(bindingPlan, { ...resource, at, subject: null }),
          ...(accounts.length
            ? [
                planWork(banPlan(accounts.length), {
                  route: resource.route,
                  realm_id: resource.id,
                  account_ids: accounts,
                  at,
                }),
              ]
            : []),
        ]);
      },
    }),
    realmPlan,
    bindingPlan,
    banPlan,
  };
}

export function spaceEligibilityAccessWork<E extends object | null>(resource: Pick<Resource, 'route' | 'id'>) {
  return {
    ...receipts<E, NonNullable<E>>({
      prepare: ({ resource: identity }) =>
        validIdentity(identity) ? planWork(spacePlan, { ...identity, at: timestamp }, true) : undefined,
      verify: ({ at }) =>
        validIdentity(resource) && validTime(at) ? planWork(spacePlan, { ...resource, at }) : undefined,
    }),
    spacePlan,
  };
}

export function participationEligibilityAccessWork<E extends object>(resource: Pick<Resource, 'route' | 'id'>) {
  return {
    ...receipts<E>({
      // Identity construction dispatches nothing; there is no native evidence read.
      prepare: () => EMPTY_ACCESS_WORK,
      verify: ({ at }) =>
        validIdentity(resource) && validTime(at) ? planWork(realmPlan, { ...resource, at }) : undefined,
    }),
    realmPlan,
  };
}

/** The actual batched viewer resource read: unnest, identity/head probes and
 * projection, plus Realm's current host EXISTS. SQL text/statements are a
 * separate transport surface; these are the native owner's six dimensions. */
export function viewerActionEligibilityWork(kind: 'space' | 'realm', ids: readonly string[], at: string): AccessWork {
  const probes = kind === 'space' ? 2 : 3;
  return Object.freeze({
    keys: probes * ids.length,
    points: probes * ids.length + 1,
    rows: (kind === 'space' ? 7 : 9) * ids.length,
    witnesses: 0,
    emptySeeks: 1,
    bytes: bytes([ids.map((id) => routeOf(id)!), ids, at]) + 2 + ids.length * (bytes({ id: uuid, public: false }) + 1),
  });
}
