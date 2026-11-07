import { MEMBERSHIP_LIMIT } from './domain-ports.ts';
import { EMPTY_ACCESS_WORK, type AccessWork } from '../access/work.ts';
import type { AccessRealmRoleReader } from '../request/access.ts';
import { routeOf } from '../route/route.ts';

type One = Parameters<AccessRealmRoleReader>[1];
type Batch = Parameters<NonNullable<AccessRealmRoleReader['batch']>>[1];
export type RoleProjection = Readonly<{ role: string; member: boolean; valid: string }>;
export type BatchRoleProjection = RoleProjection & Readonly<{ realmId: string; accountId: string }>;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

// The Access clock emits ISO instants (PostgreSQL also emits an explicit offset).
// Admit that closed, finite timestamp surface only, including microseconds.
function timestamp(at: string): boolean {
  return (
    typeof at === 'string' &&
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?(?::\d{2})?)$/.test(at) &&
    Number.isFinite(Date.parse(at))
  );
}

export function roleParameters(input: One) {
  return { route: routeOf(input.realmId), realm_id: input.realmId, account_id: input.accountId, at: input.at };
}
export function roleBatchParameters(input: Batch) {
  return {
    at: input.at,
    pairs: input.pairs.map(({ realmId, accountId }) => ({
      route: routeOf(realmId),
      realm_id: realmId,
      account_id: accountId,
    })),
  };
}

// Closed ISO native projection: six-digit PostgreSQL year, date/time,
// microseconds, signed hour/minute/second offset and optional BC suffix.
// Combining the widest fields bounds both calendar ends and infinity. A range
// adds quoted endpoints, comma and brackets; bytes() includes JSON escaping.
const endpoint = '294276-12-31 23:59:59.999999+15:59:59 BC';
const range = `["${endpoint}","${endpoint}")`;
const projection = { role: 'member', member: false, valid: range };
const id = 'x'.repeat(36);

function dispatch(parameters: unknown, count: number, batch: boolean): AccessWork {
  if (!count) return EMPTY_ACCESS_WORK; // batch returns before the statement
  const row = batch ? { realmId: id, accountId: id, ...projection } : projection;
  // membership-role.sql: one input, Realm tuple/join, two VALUES/cross rows,
  // one current tuple/two left-join rows, one next tuple/LIMIT/two left-join
  // rows, two projections. Exclusion of overlapping intervals proves current
  // cardinality <= 1; realm_member_next supplies the ordered LIMIT 1 seek.
  // Batch adds a parameters row, a recordset row per pair, and the Realm/current
  // LATERAL LIMIT rows. These are finite relational intermediates, not observed
  // output lengths or a fitted allowance for GiST visits/pages.
  const singleRows = 1 + 1 + 1 + 2 + 2 + 1 + 2 + 1 + 1 + 2 + 2;
  const batchRows = singleRows + 1 + 1 + 1;
  return Object.freeze({
    keys: count * 3, // Realm point, current temporal point, next lower-bound seek
    points: 1 + count * 3, // one statement dispatch, then the three native probes
    witnesses: 0,
    rows: batch ? 1 + count * batchRows : singleRows,
    bytes: bytes(parameters) + 2 + count * 2 * bytes(row) + (count * 2 - 1),
    // A missing Realm has one empty seek; an existing Realm can miss both the
    // current and next interval. Owner's negative proof does no native probe.
    emptySeeks: count * 2,
  });
}

export function roleWorkBound(input: One): AccessWork | undefined {
  if (!timestamp(input.at) || routeOf(input.realmId) === null || routeOf(input.accountId) === null) return;
  return dispatch(roleParameters(input), 1, false);
}

export function roleBatchWorkBound(input: Batch): AccessWork | undefined {
  if (!timestamp(input.at)) return;
  // The original evaluator admits at most acting human + delegated human, each
  // with MEMBERSHIP_LIMIT inverse slots. This declaration never raises that cap
  // or changes ordinary batch calls. Duplicate pairs are outside that surface.
  if (input.pairs.length > 2 * MEMBERSHIP_LIMIT) return;
  const accounts = new Map<string, number>();
  const pairs = new Set<string>();
  for (const { realmId, accountId } of input.pairs) {
    if (routeOf(realmId) === null || routeOf(accountId) === null) return;
    const key = `${realmId}/${accountId}`;
    if (pairs.has(key)) return;
    pairs.add(key);
    accounts.set(accountId, (accounts.get(accountId) ?? 0) + 1);
    if (accounts.size > 2 || accounts.get(accountId)! > MEMBERSHIP_LIMIT) return;
  }
  return dispatch(roleBatchParameters(input), input.pairs.length, true);
}

function emptyMember(row: RoleProjection): number {
  // Only the member projection describes native membership seeks. No current
  // tuple means one empty seek; an unbounded upper gap also means no next tuple.
  return row.member ? 0 : row.valid.endsWith(',)') ? 2 : 1;
}

export function roleWorkReceipt(
  bound: AccessWork | undefined,
  parameters: unknown,
  rows: readonly RoleProjection[],
): AccessWork | undefined {
  if (!bound) return;
  if (rows.some((row) => typeof row.valid !== 'string' || typeof row.member !== 'boolean')) return;
  const member = rows.find((row) => row.role === 'member');
  return Object.freeze({
    ...bound,
    bytes: bytes(parameters) + bytes(rows),
    emptySeeks: member ? emptyMember(member) : 1,
  });
}

export function roleBatchWorkReceipt(
  bound: AccessWork | undefined,
  parameters: unknown,
  rows: readonly BatchRoleProjection[],
  count: number,
): AccessWork | undefined {
  if (!bound) return;
  if (!count) return EMPTY_ACCESS_WORK;
  if (rows.some((row) => typeof row.valid !== 'string' || typeof row.member !== 'boolean')) return;
  const members = rows.filter((row) => row.role === 'member');
  return Object.freeze({
    ...bound,
    bytes: bytes(parameters) + bytes(rows),
    emptySeeks: count - members.length + members.reduce((total, row) => total + emptyMember(row), 0),
  });
}
