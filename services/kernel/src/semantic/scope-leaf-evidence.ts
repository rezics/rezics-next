import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { FactClause } from '../search/disclosure/check.ts';
import type { IndexedStatement } from '../search/source.ts';

export type LeafWork = Readonly<{
  keys: number;
  points: number;
  witnesses: number;
  rows: number;
  bytes: number;
  emptySeeks: number;
}>;

export type LeafProgress = Readonly<{
  basis: string;
  phase: 'compact' | 'selection' | 'witness';
  valueOrdinal: number;
  after: string | null;
}>;

export type SelectedLeafFact = Readonly<{
  witness: string;
  statement: IndexedStatement;
  release: string;
  revision: number;
  rank: 'normal' | 'preferred';
}>;

export type LeafCoverage = { kind: 'selection'; basis: string } | { kind: 'empty_pair'; basis: string };

export type LeafEvidence =
  | { state: 'basis_changed' | 'not_ready'; usage: LeafWork }
  | {
      state: 'current';
      basis: string;
      type: string | null;
      facts: readonly SelectedLeafFact[];
      coverage: LeafCoverage | null;
      progress: LeafProgress | null;
      usage: LeafWork;
    };

export type LeafRequest = Readonly<{
  subject: string;
  leaf: FactClause;
  after: LeafProgress | null;
  /** One opaque witness identity for revalidation, not a receipt or permission; exclusive with `after`. */
  revalidate: string | null;
  budget: LeafWork;
}>;

export type LeafOptions = Readonly<{
  access: Access;
  actor: Actor;
  routeKey: Uint8Array;
  deadline: number;
  nativeT?: AuthoritativeTime;
}>;

export type LeafReader = (pool: Pool, request: LeafRequest, options: LeafOptions) => Promise<LeafEvidence>;

const emptyUsage: LeafWork = Object.freeze({ keys: 0, points: 0, witnesses: 0, rows: 0, bytes: 0, emptySeeks: 0 });
const workAxes = ['keys', 'points', 'witnesses', 'rows', 'bytes', 'emptySeeks'] as const;

function validateBudget(budget: LeafWork): void {
  if (!budget || typeof budget !== 'object') throw new RangeError('Invalid leaf work budget');

  for (const axis of workAxes) {
    const value = budget[axis];
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Invalid leaf work budget');
  }

  if (budget.keys > 101 || budget.witnesses > 100) throw new RangeError('Invalid leaf work budget');
}

function validateRevalidation(request: LeafRequest): void {
  const witness = request.revalidate;
  if (witness === null) return;

  if (
    request.after !== null ||
    typeof witness !== 'string' ||
    witness.length === 0 ||
    witness.length > 128 ||
    /[^\x00-\x7f]/.test(witness)
  )
    throw new RangeError('Invalid leaf revalidation');
}

/**
 * The native evidence producer is not connected yet. Valid reservations therefore fail closed as
 * not ready; they never prepare Access, query SQL, or claim a current fact or coverage.
 */
export async function readScopeLeafEvidence(
  _pool: Pool,
  request: LeafRequest,
  _options: LeafOptions,
): Promise<LeafEvidence> {
  validateBudget(request?.budget);
  validateRevalidation(request);
  return { state: 'not_ready', usage: emptyUsage };
}
