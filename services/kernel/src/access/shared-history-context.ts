import type { Pool } from 'pg';
import {
  currentCommand,
  hasLiveCommandTransaction,
  noEffect,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { enrollContextRoleProvenance } from '../semantic/access-capabilities.ts';
import { runOperationalTransaction } from '../command/operational.ts';
import type { Resource } from '../request/access.ts';
import { partitionOf } from '../route/route.ts';
import type { WorkClient } from '../work/client.ts';

export type ContextRoleProvenance = Readonly<{
  occurrence: string;
  resourceId: string;
  resourceType: 'semantic.context';
  originalCreator: string;
  accountId: string;
  grantRole: string;
  valid: string | null;
  side: 'creator' | 'new' | 'former';
  grantTransaction: string | null;
  sourceTransaction: string;
  contextKey: string | null;
  delivery: 'pending' | 'delivered' | 'not-applicable';
}>;

export type ContextRoleOccurrence = Readonly<{ route: number; occurrence: string }>;
export type ContextRoleDelivery =
  | Readonly<{ state: 'missing' | 'delivered' | 'not-applicable' }>
  | Readonly<{
      state: 'pending';
      reason:
        | 'semantic-context-historical-party-receiver-unavailable'
        | 'semantic-context-historical-party-enrollment-pending';
      source: ContextRoleOccurrence;
    }>;

function assertOccurrence(value: string, cursor = false): void {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n ||
    (!cursor && value === '0')
  )
    throw new TypeError('Invalid role occurrence cursor');
}

/** Native role occurrences, not a permission decision or assertion of current ownership. Seek
 * the exact account prefix within one physical resource home; no lost OLD grant is reconstructed. */
export async function readContextRoleProvenance(
  tx: CommandTransaction,
  input: { resource: Resource; accountId: string; after?: string },
): Promise<readonly ContextRoleProvenance[]> {
  partitionOf(input.resource.route);
  if (input.after !== undefined) assertOccurrence(input.after, true);
  const result = await tx.query<ContextRoleProvenance>(
    `SELECT occurrence::text,resource_id::text AS "resourceId",resource_type AS "resourceType",
       original_creator::text AS "originalCreator",account_id::text AS "accountId",grant_role AS "grantRole",
       valid::text,side,grant_transaction::text AS "grantTransaction",source_transaction::text AS "sourceTransaction",
       context_key::text AS "contextKey",delivery
     FROM access.resource_role_provenance
     WHERE route=$1 AND account_id=$2 AND resource_id=$3 AND resource_type='semantic.context' AND occurrence>$4
     ORDER BY occurrence LIMIT 8`,
    [input.resource.route, input.accountId, input.resource.id, input.after ?? '0'],
  );
  return result.rows;
}

/** Both native callsites use the same Access-owned source lock and validation. The
 * Source wrapper records its own real forthcoming command fence before enrollment. */
async function deliverNativeOccurrence(
  tx: CommandTransaction,
  input: ContextRoleOccurrence,
): Promise<Readonly<{ delivery: ContextRoleDelivery; changed: boolean }>> {
  partitionOf(input.route);
  assertOccurrence(input.occurrence);
  const source = (
    await tx.query<ContextRoleProvenance>(
      `SELECT occurrence::text,resource_id::text AS "resourceId",resource_type AS "resourceType",
       original_creator::text AS "originalCreator",account_id::text AS "accountId",grant_role AS "grantRole",
       valid::text,side,grant_transaction::text AS "grantTransaction",source_transaction::text AS "sourceTransaction",
       context_key::text AS "contextKey",delivery
     FROM access.lock_resource_role_provenance($1,$2)`,
      [input.route, input.occurrence],
    )
  ).rows[0];
  if (!source) return { delivery: { state: 'missing' }, changed: false };
  if (source.delivery !== 'pending') return { delivery: { state: source.delivery }, changed: false };
  const pending = (reason: Extract<ContextRoleDelivery, { state: 'pending' }>['reason']) => ({
    delivery: { state: 'pending' as const, reason, source: input },
    changed: false,
  });
  if (source.resourceType === 'semantic.context') {
    const available = (
      await tx.query<{ available: boolean }>(
        `SELECT to_regprocedure('semantic.enroll_context_role_provenance(integer,bigint,uuid,uuid,uuid,text,text,text,uuid,uuid)')
         IS NOT NULL AS available`,
      )
    ).rows[0]!.available;
    if (!available) return pending('semantic-context-historical-party-receiver-unavailable');
    const result = await enrollContextRoleProvenance(tx, { route: input.route, occurrence: source });
    if (result.state === 'pending') return pending('semantic-context-historical-party-enrollment-pending');
    // The native guard independently checks the actual Source enrollment, in this same
    // physical transaction. Neither a caller's key nor a boolean can forge delivery.
    const state = result.state === 'enrolled' ? 'delivered' : 'not-applicable';
    await tx.query(
      `UPDATE access.resource_role_provenance SET delivery=$3,context_key=$4
       WHERE route=$1 AND occurrence=$2 AND delivery='pending'`,
      [input.route, input.occurrence, state, result.state === 'enrolled' ? result.contextKey : null],
    );
    return { delivery: { state }, changed: true };
  }
  await tx.query('SELECT access.try_deliver_resource_role_provenance($1,$2)', [input.route, input.occurrence]);
  return { delivery: { state: 'not-applicable' }, changed: true };
}

/** A live same-home command supplies Source's real native commit, never human authority
 * reconstructed from historical metadata. Missing/unresolved receiving remains pending. */
export async function deliverContextRoleProvenance(
  tx: CommandTransaction,
  input: ContextRoleOccurrence,
): Promise<ContextRoleDelivery> {
  if (!hasLiveCommandTransaction(tx) || currentCommand(tx).partition !== partitionOf(input.route))
    throw new TypeError('Context role delivery requires a live same-home command');
  return (await deliverNativeOccurrence(tx, input)).delivery;
}

/** One LIVE mechanical selection followed by a native platform command, no Actor or
 * reconstructed permission. The pending index supplies at most eight exact occurrences in one home.
 * The cursor is only scheduling state: restarting at the beginning cannot lose pending work. */
export async function advancePendingContextRoleProvenance(
  deps: Readonly<{ pool: Pool; client: WorkClient; clock?: () => Date }>,
  input: Readonly<{ partition: number; after?: ContextRoleOccurrence }>,
): Promise<Readonly<{ attempted: number; pending: number; after: ContextRoleOccurrence | null }>> {
  const firstRoute = input.partition * 16;
  if (partitionOf(firstRoute) !== input.partition) throw new RangeError('Invalid native Context home');
  if (input.after) {
    if (partitionOf(input.after.route) !== input.partition)
      throw new TypeError('Context cursor belongs to another home');
    assertOccurrence(input.after.occurrence);
  }
  const selected = await runOperationalTransaction(
    deps.pool,
    {
      partition: input.partition,
      kind: 'access.context-role-delivery',
      mode: 'work-step',
      accounts: [],
      workClient: deps.client,
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    },
    async (tx) => {
      const selected = await tx.query<ContextRoleOccurrence>(
        `SELECT route,occurrence::text FROM access.resource_role_provenance
         WHERE delivery='pending' AND route >= $1 AND route < $2
           AND (route,occurrence)>($3::integer,$4::bigint)
         ORDER BY route,occurrence LIMIT 8 FOR UPDATE SKIP LOCKED`,
        [firstRoute, firstRoute + 16, input.after?.route ?? firstRoute, input.after?.occurrence ?? '0'],
      );
      return selected.rows;
    },
  );
  // Release the selection transaction, connection and gate before starting a command.
  // One real platform command re-locks this bounded page in its original home. Source's
  // deferred constraint validates its commit against the executor's forthcoming write basis.
  if (!selected.length) return { attempted: 0, pending: 0, after: null };
  const result = await runCommand(
    deps.pool,
    {
      partition: input.partition,
      basis: {
        actorAccountId: '00000000-0000-8000-8000-000000000001',
        clientId: 'internal-access',
        requestedBy: null,
      },
      clock: deps.clock,
    },
    async (tx) => {
      let pending = 0;
      let changed = false;
      for (const occurrence of selected) {
        const result = await deliverNativeOccurrence(tx, occurrence);
        if (result.delivery.state === 'pending') pending++;
        changed ||= result.changed;
      }
      const value = {
        attempted: selected.length,
        pending,
        after: selected.length === 8 ? selected.at(-1)! : null,
      };
      return changed
        ? { value, events: [{ type: 'com.rezics.access.context-role-delivery-advanced.v1', data: {} }] }
        : noEffect(value);
    },
  );
  return result.value;
}
