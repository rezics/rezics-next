import type { PoolClient } from 'pg';
import { routeOf, ROUTES } from '../route/route.ts';
import type { BulkReason, OutcomeView, TargetState } from './bulk-contract.ts';
import outcomePage from './bulk-outcome-page.sql';
import statePage from './bulk-outcome-state-page.sql';

const states: readonly TargetState[] = [
  'pending',
  'reconciling',
  'applied',
  'no_effect',
  'conflict',
  'denied',
  'failed',
  'cancelled',
];
const decimal = /^(0|[1-9][0-9]*)(?![\s\S])/;

/**
 * Caller must independently authorize and prove the exact operation owner on this same source RR client first.
 * Native producers give every target the root owner. This seek cannot discover ownership of a foreign operation.
 * State is current at the page snapshot; nextAfter is an internal decimal boundary, not a wire cursor.
 */
export async function pageBulkOutcomes(
  client: Pick<PoolClient, 'query'>,
  input: {
    route: number;
    accountId: string;
    operationId: string;
    after: string | null;
    limit: number;
    state: TargetState | null;
  },
): Promise<{ outcomes: OutcomeView[]; nextAfter: string | null }> {
  const { route, accountId, operationId, after, limit, state } = input;
  if (
    !Number.isInteger(route) ||
    route < 0 ||
    route >= ROUTES ||
    routeOf(accountId) !== route ||
    routeOf(operationId) !== route
  )
    throw new RangeError('Owner and operation must carry the source route');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new RangeError('Limit must be an integer from 1 to 20');
  if (state !== null && !states.includes(state)) throw new TypeError('Invalid target state');
  if (after !== null && (typeof after !== 'string' || !decimal.test(after)))
    throw new TypeError('After must be a canonical nonnegative decimal');
  const parameters = {
    route,
    account_id: accountId,
    operation_id: operationId,
    after: after ?? '-1',
    page_limit: limit + 1,
  };
  const rows =
    state === null ? await outcomePage.run(client, parameters) : await statePage.run(client, { ...parameters, state });
  let previous = BigInt(after ?? '-1');
  for (const row of rows) {
    if (typeof row.ordinal !== 'string' || !decimal.test(row.ordinal) || BigInt(row.ordinal) <= previous)
      throw new TypeError('Invalid or unordered outcome ordinal');
    previous = BigInt(row.ordinal);
  }
  const outcomes = rows.slice(0, limit).map((row): OutcomeView => ({
    ordinal: row.ordinal,
    subjectId: row.subjectId,
    memberId: row.memberId,
    state: row.state as TargetState,
    reason: row.reason as BulkReason | null,
    resultingMemberId: row.resultingMemberId,
  }));
  return { outcomes, nextAfter: rows.length > limit ? outcomes.at(-1)!.ordinal : null };
}
