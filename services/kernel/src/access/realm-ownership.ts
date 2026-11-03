import type { Pool } from 'pg';
import {
  lockRealmOwnershipSource,
  applyRealmOwnershipSuccession,
  type LockedRealmOwnershipSource,
} from '../community/realm-continuity.ts';
import { resourceRoleHeld } from './resource-role-held.ts';
import {
  authoritativeTimeValue,
  commandAttemptDeadline,
  commandTime,
  currentCommand,
  hasLiveCommandTransaction,
  type AuthoritativeTime,
  type CommandAttempt,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import type { Access, AccessClient, Resource } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withConnection } from '../database/pool.ts';
import { deadlineClient, within } from './authenticate.ts';
import { shareAccount } from './account-share.ts';
import { LifecycleDeniedError } from './lifecycle-20261025094010-command.ts';
import {
  readCurrentResourceRolePage,
  verifyCurrentResourceRoleFrontier,
  type CurrentResourceRoleAfter,
  type CurrentResourceRoleFrontier,
  type CurrentResourceRoleKey,
} from './current-resource-roles.ts';
import { requireResourceCommand, ResourceAccessWriteDeniedError } from './resource-denials.ts';
import { RealmLastOwnerError } from './resource-access-errors.ts';
export { RealmLastOwnerError } from './resource-access-errors.ts';
import catalogue from './resource-roles.json';
import { resourceRoleCatalogue } from './resource-roles.ts';
import read from './realm-ownership-read.sql';
import lock from './realm-ownership-lock.sql';
import holders from './realm-ownership-holders.sql';
import erasureSource from './realm-ownership-erasure-source.sql';
import roleMutation from './role-grant-mutate.sql';

export const REALM_OWNER_ROLE = 'community.realm.owner';

// This ordering is container data. It changes neither role actions nor the Access formula.
const roles = [
  REALM_OWNER_ROLE,
  'community.realm.administrator',
  'community.realm.moderator',
  'community.realm.member',
  'community.realm.standing',
] as const;

type Input = { resource: Resource; accountId: string; at: AuthoritativeTime };
type RoleReadInput = Input & {
  /** Trusted service composition. Without it only built-in definitions apply.
   * A role name in a grant row never installs a role or supplies its actions. */
  access?: Access;
};
function parameters(input: Input) {
  if (
    !input.resource ||
    routeOf(input.resource.id) === null ||
    routeOf(input.resource.id) !== input.resource.route ||
    routeOf(input.accountId) === null
  )
    throw new ResourceAccessWriteDeniedError();
  return {
    route: input.resource.route,
    resource_id: input.resource.id,
    account_id: input.accountId,
    at: authoritativeTimeValue(input.at),
  };
}

/** Private direct-role data for a read already authorized by the caller. Five exact
 * temporal key probes, at most five rows; no account, group or membership expansion.
 * Account lifecycle is deliberately not authorization in this data port.
 */
export async function readRealmOwnershipRoles(
  client: AccessClient,
  input: RoleReadInput,
): Promise<readonly { role: string; rank: number; valid: string }[]> {
  const installed = input.access === undefined ? undefined : resourceRoleCatalogue(input.access);
  const rows = await read.run(client, {
    ...parameters(input),
    roles: roles.filter((role) =>
      input.access === undefined ? Object.hasOwn(catalogue.roles, role) : installed?.roles.has(role) === true,
    ),
  });
  return rows.map((row) => {
    if (row.role === null) throw new TypeError('Realm ownership role is missing');
    return { role: row.role, rank: row.rank, valid: row.valid };
  });
}

/** Lock the native creation anchor, never a parallel owner registry. The caller
 * must already have authorized this exact resource in the live command at T.
 */
export async function lockRealmOwnership(client: AccessClient, input: Input): Promise<void> {
  const key = parameters(input);
  requireResourceCommand(client, input.resource, input.at);
  const row = await lock.run(client, key);
  if (!row) throw new ResourceAccessWriteDeniedError();
}

/** Native explicit-holder invariant. The lock and the bounded holder predicate
 * stay in the same SERIALIZABLE command as the removal. Never call this as a
 * preflight on a pool: that would release the invariant before publication.
 * Both probes use the same authoritative T. The remaining holder must have an
 * open-ended interval; a scheduled expiry cannot guarantee owner continuity.
 * SERIALIZABLE retries recheck the predicates after concurrent grant changes.
 */
export async function assertRealmOwnerMayLeave(client: AccessClient, input: Input): Promise<void> {
  await lockRealmOwnership(client, input);
  const row = await holders.run(client, parameters(input));
  if (!row.target) throw new ResourceAccessWriteDeniedError();
  if (!row.remaining) throw new RealmLastOwnerError();
}

export type RealmErasureSuccessionInput = Readonly<{ resource: Resource; accountId: string }>;
export type RealmErasureSuccessionQualification = 'owner-or-replay' | 'not-owner';
export type RealmErasureSuccessionSource = Readonly<{
  route: number;
  accountId: string;
  version: number;
  at: string;
}>;
declare const preparedRealmErasure: unique symbol;
/** Opaque, constructor-local evidence from one genuine executor attempt. */
export type PreparedRealmErasureSuccession = Readonly<{ [preparedRealmErasure]: true }>;
type DecisionBasis = Readonly<{
  /** Historical replay is durable output, never a new current-tx applied proof. */
  replayed: boolean;
  resource: Resource;
  source: RealmErasureSuccessionSource;
  operationId: string;
  decidedAt: string;
}>;
/** Content consumes a terminal decision inside the SAME Realm transaction, before commit.
 * Orphan generation and claim deadline are Content-owned, not fields invented by Access.
 */
export type RealmErasureSuccessionResult =
  | (DecisionBasis & Readonly<{ status: 'owned'; accountId: string; disposition: 'retained' | 'selected' }>)
  | (DecisionBasis & Readonly<{ status: 'orphaned' }>)
  | Readonly<{ status: 'pending'; reason: 'more' | 'role-source' | 'account-source' }>;
export type RealmErasureSuccessionAuthorization = CommandAuthorization & {
  prepare(attempt: CommandAttempt): Promise<PreparedRealmErasureSuccession>;
};

export type AppliedRealmErasureSuccession = Readonly<{
  state: 'owned' | 'orphaned';
  orphanedAt: string | null;
  claimEligibleAt: string | null;
}>;
type AppliedBinding = Readonly<{
  realmId: string;
  accountId: string;
  time: AuthoritativeTime;
  source: RealmErasureSuccessionSource;
  ownerSource: LockedRealmOwnershipSource;
  operationId: string;
  candidateAccountId: string | null;
  frontierVersion: string;
  result: AppliedRealmErasureSuccession;
}>;
// Only applyErasureSuccession installs this evidence, after native grants and the
// durable decision have been written. A historical row alone cannot mint it.
const appliedBindings = new WeakMap<CommandTransaction, AppliedBinding>();
const appliedReaders = new WeakSet<CommandTransaction>();

export async function readAppliedRealmErasureSuccession(
  tx: CommandTransaction,
  input: Readonly<{ realmId: string; accountId: string }>,
): Promise<AppliedRealmErasureSuccession | null> {
  const binding = appliedBindings.get(tx);
  if (
    !binding ||
    !hasLiveCommandTransaction(tx) ||
    binding.realmId !== input.realmId ||
    binding.accountId !== input.accountId
  )
    return null;
  const command = currentCommand(tx);
  if (
    binding.time !== command.time ||
    currentCommand(tx).transactionId !== binding.operationId ||
    command.authorization?.action !== successionAction ||
    binding.ownerSource.realmId !== input.realmId
  )
    return null;
  const resource = { route: routeOf(input.realmId)!, id: input.realmId };
  const decision = await tx.query<{ valid: boolean }>(
    `SELECT source_route=$4 AND source_version=$5 AND source_at=$6::timestamptz
      AND decision_operation_id=$7 AND decision_state=$8
      AND best_account_id IS NOT DISTINCT FROM $9::uuid
      AND result_orphaned_at IS NOT DISTINCT FROM $10::timestamptz
      AND result_claim_eligible_at IS NOT DISTINCT FROM $11::timestamptz
      AND source_ownership_state=$12
      AND source_orphaned_at IS NOT DISTINCT FROM $13::timestamptz
      AND source_claim_eligible_at IS NOT DISTINCT FROM $14::timestamptz
      AND (SELECT version::text FROM access.current_resource_role_frontier
        WHERE route=$1 AND resource_id=$2)=$15 AS valid
     FROM access.realm_erasure_succession WHERE route=$1 AND resource_id=$2 AND account_id=$3`,
    [
      resource.route,
      resource.id,
      input.accountId,
      binding.source.route,
      binding.source.version,
      binding.source.at,
      binding.operationId,
      binding.result.state,
      binding.candidateAccountId,
      binding.result.orphanedAt,
      binding.result.claimEligibleAt,
      binding.ownerSource.ownershipState,
      binding.ownerSource.orphanedAt,
      binding.ownerSource.claimEligibleAt,
      binding.frontierVersion,
    ],
  );
  if (!decision.rows[0]?.valid) return null;
  if (
    binding.candidateAccountId &&
    !(await resourceRoleHeld(tx, {
      resource,
      role: REALM_OWNER_ROLE,
      accountId: binding.candidateAccountId,
      at: command.time,
    }))
  )
    return null;
  if (
    await resourceRoleHeld(tx, {
      resource,
      role: REALM_OWNER_ROLE,
      accountId: input.accountId,
      at: command.time,
    })
  )
    return null;
  appliedReaders.add(tx);
  return binding.result;
}

type Candidate = Readonly<{ accountId: string; role: string; valid: string; intervalKey: string }>;
type SuccessionProgress = {
  source_route: number;
  source_version: number;
  source_at: string;
  frontier: CurrentResourceRoleFrontier | null;
  cursor_role: string | null;
  cursor_kind: CurrentResourceRoleKey['subjectKind'] | null;
  cursor_subject_id: string | null;
  cursor_subject_role: CurrentResourceRoleKey['subjectRole'] | null;
  cursor_interval_key: string | null;
  best_account_id: string | null;
  best_role: string | null;
  best_valid: string | null;
  best_interval_key: string | null;
  decision_state: 'owned' | 'orphaned' | null;
  decision_operation_id: string | null;
  decided_at: string | null;
  result_orphaned_at: string | null;
  result_claim_eligible_at: string | null;
  same_episode: boolean;
  source_bound: boolean;
};
const successionAction = 'internal.realm-erasure-succession';
const pending = (reason: 'more' | 'role-source' | 'account-source'): RealmErasureSuccessionResult => ({
  status: 'pending',
  reason,
});

/** Trusted native composition only. No Actor, Global action, approval or participant ACK.
 * The constructor's authorization uses the installed executor's prepare/authorize/finalize
 * lifecycle; it neither forges completed authorization branding nor holds a source checkout
 * while acquiring the Realm writer. Content remains the sole lifecycle consumer.
 */
export function createRealmOwnershipCommands(config: { pool: Pool; access: Access; clock?: () => Date }) {
  type Evidence = {
    attempt: CommandAttempt;
    deadline: number;
    input: RealmErasureSuccessionInput;
    source: RealmErasureSuccessionSource;
  };
  const evidence = new WeakMap<PreparedRealmErasureSuccession, Evidence>();
  const admitted = new WeakMap<CommandTransaction, PreparedRealmErasureSuccession>();
  const consumed = new WeakSet<CommandTransaction>();
  const completed = new WeakSet<CommandTransaction>();

  async function qualifyErasureSuccession(
    input: RealmErasureSuccessionInput,
    context: Readonly<{ deadline: number }>,
  ): Promise<RealmErasureSuccessionQualification> {
    const { resource, accountId } = input;
    const accountRoute = routeOf(accountId);
    if (
      !resource ||
      accountRoute === null ||
      routeOf(resource.id) !== resource.route ||
      !Number.isFinite(context.deadline)
    )
      throw new ResourceAccessWriteDeniedError();

    // Read and release the account-home checkout before opening the Realm home.
    const source = await within(context.deadline, () =>
      withConnection(config.pool, (client) =>
        erasureSource.run(deadlineClient(client, context.deadline), {
          route: accountRoute,
          account_id: accountId,
        }),
      ),
    );
    if (
      !source ||
      source.route !== accountRoute ||
      source.accountId !== accountId ||
      !Number.isSafeInteger(source.version) ||
      typeof source.at !== 'string'
    )
      throw new ResourceAccessWriteDeniedError();

    const result = await within(context.deadline, () =>
      withConnection(config.pool, (client) =>
        deadlineClient(client, context.deadline).query<{ qualifies: boolean }>(
          `SELECT
             EXISTS (SELECT 1 FROM access.resource_role_grant
               WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
                 AND subject_role='' AND grant_role=$7 AND valid @> $6::timestamptz)
             OR EXISTS (SELECT 1 FROM access.realm_erasure_succession
               WHERE route=$1 AND resource_id=$2 AND account_id=$3 AND source_route=$4
                 AND source_version=$5 AND source_at=$6::timestamptz AND decision_state IS NOT NULL)
             AS qualifies`,
          [resource.route, resource.id, accountId, source.route, source.version, source.at, REALM_OWNER_ROLE],
        ),
      ),
    );
    const qualifies = result.rows[0]?.qualifies;
    if (typeof qualifies !== 'boolean') throw new ResourceAccessWriteDeniedError();
    return qualifies ? 'owner-or-replay' : 'not-owner';
  }

  async function prepareErasureSuccession(
    attempt: CommandAttempt,
    input: RealmErasureSuccessionInput,
  ): Promise<PreparedRealmErasureSuccession> {
    const deadline = commandAttemptDeadline(attempt);
    parameters({ ...input, at: attempt.time });
    if (attempt.partition !== partitionOf(input.resource.route)) throw new ResourceAccessWriteDeniedError();
    const bound = Object.freeze({ resource: Object.freeze({ ...input.resource }), accountId: input.accountId });
    const source = await within(deadline, () =>
      withConnection(config.pool, (client) =>
        erasureSource.run(deadlineClient(client, deadline), {
          route: routeOf(bound.accountId)!,
          account_id: bound.accountId,
        }),
      ),
    );
    if (!source) throw new ResourceAccessWriteDeniedError();
    commandAttemptDeadline(attempt);
    // The symbol is deliberately absent at runtime: only the private WeakMap is authority.
    const proof = Object.freeze({}) as PreparedRealmErasureSuccession;
    evidence.set(proof, { attempt, deadline, input: bound, source: Object.freeze(source) });
    return proof;
  }

  function erasureSuccessionAuthorization(input: RealmErasureSuccessionInput): RealmErasureSuccessionAuthorization {
    const bound = structuredClone(input);
    return {
      action: successionAction,
      resource: Object.freeze({ ...bound.resource }),
      prepare: (attempt) => prepareErasureSuccession(attempt, bound),
      async authorize(tx, attempt, proof) {
        const prepared = evidence.get(proof as PreparedRealmErasureSuccession);
        if (
          !prepared ||
          prepared.attempt !== attempt ||
          commandTime(tx) !== attempt.time ||
          prepared.deadline !== commandAttemptDeadline(attempt) ||
          prepared.input.resource.route !== bound.resource.route ||
          prepared.input.resource.id !== bound.resource.id ||
          prepared.input.accountId !== bound.accountId ||
          admitted.has(tx)
        )
          throw new ResourceAccessWriteDeniedError();
        if (
          !(await lock.run(tx, {
            route: bound.resource.route,
            resource_id: bound.resource.id,
          }))
        )
          throw new ResourceAccessWriteDeniedError();
        // Bind the root to an actual direct owner interval, not an erased stranger.
        // A durable decision can replay after native grant cleanup.
        const target = await tx.query<{ valid: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM access.resource_role_grant
             WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
               AND subject_role='' AND grant_role=$4 AND valid @> $5::timestamptz)
             OR EXISTS (SELECT 1 FROM access.realm_erasure_succession
               WHERE route=$1 AND resource_id=$2 AND account_id=$3 AND decision_state IS NOT NULL) AS valid`,
          [bound.resource.route, bound.resource.id, bound.accountId, REALM_OWNER_ROLE, prepared.source.at],
        );
        if (!target.rows[0]?.valid) throw new ResourceAccessWriteDeniedError();
        admitted.set(tx, proof as PreparedRealmErasureSuccession);
        return 'execute';
      },
      async finalize(tx) {
        if (!completed.has(tx)) throw new ResourceAccessWriteDeniedError();
        appliedBindings.delete(tx);
        appliedReaders.delete(tx);
      },
      denied: () => new ResourceAccessWriteDeniedError(),
    };
  }

  async function applyErasureSuccession(
    tx: CommandTransaction,
    proof: PreparedRealmErasureSuccession = admitted.get(tx)!,
  ): Promise<RealmErasureSuccessionResult> {
    const prepared = proof && evidence.get(proof);
    const command = currentCommand(tx);
    if (
      !prepared ||
      admitted.get(tx) !== proof ||
      consumed.has(tx) ||
      command.time !== prepared.attempt.time ||
      command.authorization?.action !== successionAction ||
      command.partition !== prepared.attempt.partition ||
      commandAttemptDeadline(prepared.attempt) !== prepared.deadline
    )
      throw new ResourceAccessWriteDeniedError();
    const { resource, accountId } = prepared.input;
    const source = prepared.source;
    await lockRealmOwnership(tx, { resource, accountId, at: command.time });
    const ownerSource = await lockRealmOwnershipSource(tx, resource.id);
    if (!ownerSource || ownerSource.realmId !== resource.id) throw new ResourceAccessWriteDeniedError();
    consumed.add(tx);
    const pause = (reason: 'more' | 'role-source' | 'account-source') => {
      completed.add(tx);
      return pending(reason);
    };
    const key = [resource.route, resource.id, accountId];
    await tx.query(
      `INSERT INTO access.realm_erasure_succession
       (route,resource_id,account_id,source_route,source_version,source_at,
        source_ownership_state,source_orphaned_at,source_claim_eligible_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [
        ...key,
        source.route,
        source.version,
        source.at,
        ownerSource.ownershipState,
        ownerSource.orphanedAt,
        ownerSource.claimEligibleAt,
      ],
    );
    const stored = await tx.query<SuccessionProgress>(
      `SELECT source_route,source_version,source_at::text,frontier,cursor_role,cursor_kind,cursor_subject_id::text,
       cursor_subject_role,cursor_interval_key::text,best_account_id::text,best_role,best_valid::text,
       best_interval_key::text,decision_state,decision_operation_id::text,decided_at::text,
       result_orphaned_at::text,result_claim_eligible_at::text,
       source_ownership_state IS NOT NULL AS source_bound,
       source_ownership_state=$4 AND source_orphaned_at IS NOT DISTINCT FROM $5::timestamptz
         AND source_claim_eligible_at IS NOT DISTINCT FROM $6::timestamptz AS same_episode
       FROM access.realm_erasure_succession WHERE route=$1 AND resource_id=$2 AND account_id=$3 FOR UPDATE`,
      [...key, ownerSource.ownershipState, ownerSource.orphanedAt, ownerSource.claimEligibleAt],
    );
    const row = stored.rows[0];
    if (
      !row ||
      row.source_route !== source.route ||
      row.source_version !== source.version ||
      row.source_at !== source.at
    )
      throw new ResourceAccessWriteDeniedError();
    const result = (
      state: 'owned' | 'orphaned',
      best: Candidate | null,
      operationId: string,
      decidedAt: string,
      replayed: boolean,
    ): RealmErasureSuccessionResult => {
      const basis = { resource, source, operationId, decidedAt, replayed };
      if (state === 'orphaned') return { ...basis, status: 'orphaned' };
      if (!best) throw new ResourceAccessWriteDeniedError();
      return {
        ...basis,
        status: 'owned',
        accountId: best.accountId,
        disposition: best.role === REALM_OWNER_ROLE ? 'retained' : 'selected',
      };
    };
    let best: Candidate | null =
      row.best_account_id && row.best_role && row.best_valid && row.best_interval_key
        ? {
            accountId: row.best_account_id,
            role: row.best_role,
            valid: row.best_valid,
            intervalKey: row.best_interval_key,
          }
        : null;
    if (!row.source_bound) return pause('role-source');
    if (row.decision_state && row.decision_operation_id && row.decided_at) {
      completed.add(tx);
      return result(row.decision_state, best, row.decision_operation_id, row.decided_at, true);
    }
    if (!row.same_episode) throw new ResourceAccessWriteDeniedError();
    const installed = resourceRoleCatalogue(config.access);
    if (!installed?.roles.has(REALM_OWNER_ROLE)) return pause('role-source');
    const eligibleRoles = roles.filter((role) => installed.roles.has(role));
    const after: CurrentResourceRoleAfter | null =
      row.frontier &&
      row.cursor_role &&
      row.cursor_kind &&
      row.cursor_subject_id &&
      row.cursor_subject_role !== null &&
      row.cursor_interval_key
        ? {
            frontier: row.frontier,
            key: {
              grantRole: row.cursor_role,
              subjectKind: row.cursor_kind,
              subjectId: row.cursor_subject_id,
              subjectRole: row.cursor_subject_role,
              intervalKey: row.cursor_interval_key,
            },
          }
        : null;
    async function reset() {
      await tx.query(
        `UPDATE access.realm_erasure_succession SET frontier=NULL,cursor_role=NULL,cursor_kind=NULL,
        cursor_subject_id=NULL,cursor_subject_role=NULL,cursor_interval_key=NULL,
        best_account_id=NULL,best_role=NULL,best_valid=NULL,best_interval_key=NULL
        WHERE route=$1 AND resource_id=$2 AND account_id=$3`,
        key,
      );
      return pause('role-source');
    }
    const page = await readCurrentResourceRolePage(tx, {
      resource,
      roles: eligibleRoles,
      at: command.time,
      after,
      limit: 99,
    });
    if (page.status !== 'ready') return after ? reset() : pause('role-source');
    if (
      (await verifyCurrentResourceRoleFrontier(tx, { resource, frontier: page.frontier, at: command.time })).status !==
      'ready'
    )
      return reset();
    // Released observations of active accounts never prove exclusion. An active losing
    // candidate cannot outrank best later; excluded deleted identities need a permanent
    // genuine erasure root. Suspension, missing coverage and temporary fences stay pending.
    for (const candidate of page.rows) {
      if (candidate.subjectKind !== 'identity' || candidate.subjectRole !== '' || candidate.subjectId === accountId)
        continue;
      const account = await tx.query<{ state: string; fenced: boolean }>(
        'SELECT state,authn_fenced AS fenced FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE',
        [routeOf(candidate.subjectId), candidate.subjectId],
      );
      const identity = account.rows[0];
      if (identity?.state === 'deleted') {
        if (!(await erasureSource.run(tx, { route: routeOf(candidate.subjectId)!, account_id: candidate.subjectId })))
          return pause('account-source');
        continue;
      }
      if (!identity || identity.state !== 'active' || identity.fenced) return pause('account-source');
      await shareAccount(tx, candidate.subjectId);
      const next: Candidate = {
        accountId: candidate.subjectId,
        role: candidate.grantRole,
        valid: candidate.valid,
        intervalKey: candidate.intervalKey,
      };
      const rank = (role: string) =>
        role === REALM_OWNER_ROLE
          ? 4
          : role === 'community.realm.administrator'
            ? 3
            : role === 'community.realm.moderator'
              ? 2
              : 1;
      let better = !best || rank(next.role) > rank(best.role);
      if (best && rank(best.role) === rank(next.role)) {
        // PostgreSQL orders the actual native interval bounds at full precision, including
        // unbounded starts, then the identity UUID. JavaScript Date loses microseconds.
        const order = await tx.query<{ better: boolean }>(
          `SELECT CASE WHEN lower_inf($1::tstzrange) <> lower_inf($2::tstzrange)
            THEN lower_inf($1::tstzrange)
            WHEN lower($1::tstzrange) IS DISTINCT FROM lower($2::tstzrange)
            THEN lower($1::tstzrange) < lower($2::tstzrange) ELSE $3::uuid < $4::uuid END AS better`,
          [next.valid, best.valid, next.accountId, best.accountId],
        );
        better = order.rows[0]?.better === true;
      }
      if (better) best = next;
    }
    if (page.after) {
      const cursor = page.after.key;
      await tx.query(
        `UPDATE access.realm_erasure_succession SET frontier=$4,cursor_role=$5,cursor_kind=$6,
        cursor_subject_id=$7,cursor_subject_role=$8,cursor_interval_key=$9,
        best_account_id=$10,best_role=$11,best_valid=$12,best_interval_key=$13
        WHERE route=$1 AND resource_id=$2 AND account_id=$3`,
        [
          ...key,
          JSON.stringify(page.frontier),
          cursor.grantRole,
          cursor.subjectKind,
          cursor.subjectId,
          cursor.subjectRole,
          cursor.intervalKey,
          best?.accountId ?? null,
          best?.role ?? null,
          best?.valid ?? null,
          best?.intervalKey ?? null,
        ],
      );
      return pause('more');
    }
    if (best) {
      try {
        await shareAccount(tx, best.accountId);
      } catch (error) {
        if (error instanceof LifecycleDeniedError) return reset();
        throw error;
      }
    }
    const at = authoritativeTimeValue(command.time);
    const operationId = currentCommand(tx).transactionId;
    // The installed native role-provenance trigger records this operation for
    // both the new grant and the erased owner's destructive removal.
    await tx.query("SELECT set_config('access.role_native_transaction',$1,true)", [operationId]);
    if (best && best.role !== REALM_OWNER_ROLE) {
      const changed = await roleMutation.run(tx, {
        route: resource.route,
        resource_id: resource.id,
        subject_kind: 'identity',
        subject_id: best.accountId,
        subject_role: '',
        grant_role: REALM_OWNER_ROLE,
        valid: `[${at},)`,
        operation: 'create',
        previous_role: REALM_OWNER_ROLE,
        previous_valid: '(,)',
        transaction_id: operationId,
      });
      if (changed.length !== 1) throw new ResourceAccessWriteDeniedError();
    }
    // This exact immutable root is the sole mechanical exception to the ordinary
    // last-holder guard, which remains unchanged for all human grant administration.
    await tx.query(
      `DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
      AND subject_kind='identity' AND subject_id=$3 AND subject_role='' AND grant_role=$4
      AND valid @> $5::timestamptz`,
      [...key, REALM_OWNER_ROLE, at],
    );
    const state = best ? 'owned' : 'orphaned';
    const saved = await tx.query<{ orphanedAt: string | null; claimEligibleAt: string | null }>(
      `UPDATE access.realm_erasure_succession SET frontier=NULL,cursor_role=NULL,cursor_kind=NULL,
      cursor_subject_id=NULL,cursor_subject_role=NULL,cursor_interval_key=NULL,
      best_account_id=$4,best_role=$5,best_valid=$6,best_interval_key=$7,
      decision_state=$8,decision_operation_id=$9,decided_at=$10,
      result_orphaned_at=CASE WHEN $8='owned' THEN NULL
        ELSE COALESCE(source_orphaned_at,source_at) END,
      result_claim_eligible_at=CASE WHEN $8='owned' THEN NULL
        ELSE COALESCE(source_claim_eligible_at,source_at+interval '720 hours') END
      WHERE route=$1 AND resource_id=$2 AND account_id=$3
      RETURNING result_orphaned_at::text AS "orphanedAt",
        result_claim_eligible_at::text AS "claimEligibleAt"`,
      [
        ...key,
        best?.accountId ?? null,
        best?.role ?? null,
        best?.valid ?? null,
        best?.intervalKey ?? null,
        state,
        operationId,
        at,
      ],
    );
    const savedResult = saved.rows[0];
    if (!savedResult) throw new ResourceAccessWriteDeniedError();
    const frontier = await tx.query<{ version: string }>(
      'SELECT version::text FROM access.current_resource_role_frontier WHERE route=$1 AND resource_id=$2',
      [resource.route, resource.id],
    );
    if (!frontier.rows[0]) throw new ResourceAccessWriteDeniedError();
    const applied = Object.freeze({ state, ...savedResult });
    appliedBindings.set(
      tx,
      Object.freeze({
        realmId: resource.id,
        accountId,
        time: command.time,
        source,
        ownerSource,
        operationId,
        candidateAccountId: best?.accountId ?? null,
        frontierVersion: frontier.rows[0].version,
        result: applied,
      }),
    );
    // The Content source owner consumes the actual native result before control
    // returns to the caller. Any source/state failure rolls back grants and progress.
    const continuity = await applyRealmOwnershipSuccession(tx, ownerSource, accountId);
    if (
      !appliedReaders.has(tx) ||
      continuity.ownershipState !== state ||
      continuity.governanceReadOnly !== (state === 'orphaned')
    )
      throw new ResourceAccessWriteDeniedError();
    completed.add(tx);
    return result(state, best, operationId, at, false);
  }

  return {
    qualifyErasureSuccession,
    prepareErasureSuccession,
    applyErasureSuccession,
    erasureSuccessionAuthorization,
  };
}
