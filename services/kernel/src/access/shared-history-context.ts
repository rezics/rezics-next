import type { Pool } from 'pg';
import { currentCommand, hasLiveCommandTransaction, type CommandTransaction } from '../command/command.ts';
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
      reason: 'semantic-context-historical-party-receiver-unavailable';
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

/** Shared with the deferred native trigger: the SQL entrypoint locks and validates the real
 * occurrence before receiving or transitioning it. No caller-supplied metadata is authoritative. */
async function deliverNativeOccurrence(tx: CommandTransaction, input: ContextRoleOccurrence): Promise<ContextRoleDelivery> {
  partitionOf(input.route);
  assertOccurrence(input.occurrence);
  const result = await tx.query<{ outcome: 'missing' | 'delivered' | 'not-applicable' | 'receiver-unavailable' }>(
    'SELECT access.try_deliver_resource_role_provenance($1,$2) AS outcome',
    [input.route, input.occurrence],
  );
  const outcome = result.rows[0]?.outcome;
  switch (outcome) {
    case 'receiver-unavailable':
      return {
        state: 'pending',
        reason: 'semantic-context-historical-party-receiver-unavailable',
        source: { route: input.route, occurrence: input.occurrence },
      };
    case 'missing':
    case 'delivered':
    case 'not-applicable':
      return { state: outcome };
    default:
      throw new TypeError('Invalid native Context role delivery result');
  }
}

/** Only a live same-home command can drive the request-side adapter. The missing Semantic
 * receiver is explicit pending state, never a false success, empty source or permission denial. */
export async function deliverContextRoleProvenance(
  tx: CommandTransaction,
  input: ContextRoleOccurrence,
): Promise<ContextRoleDelivery> {
  if (!hasLiveCommandTransaction(tx) || currentCommand(tx).partition !== partitionOf(input.route))
    throw new TypeError('Context role delivery requires a live same-home command');
  return deliverNativeOccurrence(tx, input);
}

/** One LIVE mechanical work step, no Actor or reconstructed permission. The native pending
 * partial index supplies at most eight exact occurrences from one configured physical home.
 * The cursor is only scheduling state: restarting at the beginning cannot lose pending work. */
export async function advancePendingContextRoleProvenance(
  deps: Readonly<{ pool: Pool; client: WorkClient; clock?: () => Date }>,
  input: Readonly<{ partition: number; after?: ContextRoleOccurrence }>,
): Promise<Readonly<{ attempted: number; pending: number; after: ContextRoleOccurrence | null }>> {
  const firstRoute = input.partition * 16;
  if (partitionOf(firstRoute) !== input.partition) throw new RangeError('Invalid native Context home');
  if (input.after) {
    if (partitionOf(input.after.route) !== input.partition) throw new TypeError('Context cursor belongs to another home');
    assertOccurrence(input.after.occurrence);
  }
  return runOperationalTransaction(
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
      let pending = 0;
      for (const occurrence of selected.rows) {
        if ((await deliverNativeOccurrence(tx, occurrence)).state === 'pending') pending++;
      }
      return {
        attempted: selected.rows.length,
        pending,
        after: selected.rows.length === 8 ? selected.rows.at(-1)! : null,
      };
    },
  );
}
