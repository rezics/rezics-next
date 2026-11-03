/** Members admission has no allowance argument. Meter its actual same-client statements before dispatch. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { hasLiveOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { ProblemError } from '../http/problem.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from '../library/collection-source.ts';

const zero = (): { -readonly [Axis in keyof WorkDimensions]: number } => ({
  candidateKeys: 0,
  nativeRows: 0,
  identityMetadataRows: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 0,
  bytes: 0,
  emptySeeks: 0,
});

/** Fixed projection terms used by the actual Members-definition meter below.
 * Bytes remain SQL/parameter bytes plus these literal producer ceilings. */
export const MEMBERS_DEFINITION_QUERY_BOUNDS = Object.freeze({
  point: Object.freeze({
    candidateKeys: 0,
    nativeRows: 4,
    identityMetadataRows: 0,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 512,
    emptySeeks: 1,
  } satisfies WorkDimensions),
  preparation: Object.freeze({
    candidateKeys: 0,
    nativeRows: 32,
    identityMetadataRows: 0,
    nativePoints: 4,
    witnessKeys: 0,
    statements: 1,
    bytes: 65536,
    emptySeeks: 1,
  } satisfies WorkDimensions),
  canonicalScope: Object.freeze({
    candidateKeys: 0,
    nativeRows: 64,
    identityMetadataRows: 0,
    nativePoints: 8,
    witnessKeys: 0,
    statements: 1,
    bytes: 65536,
    emptySeeks: 1,
  } satisfies WorkDimensions),
  releaseProjection: Object.freeze({
    maxExpandedVarlenaBytes: 1024 ** 3,
    byteMultiplier: 6,
    fixedBytes: 1024,
  }),
});

const budgets = new AsyncLocalStorage<NativeCollectionWork>();
const admission = new AsyncLocalStorage<boolean>();
const installed = new WeakSet<OperationalTransaction>();

export function withMembersWorkBudget<T>(work: NativeCollectionWork, body: () => Promise<T>): Promise<T> {
  return budgets.run(work, body);
}

export async function membersBounded<T>(
  work: NativeCollectionWork,
  bound: Partial<WorkDimensions>,
  body: () => Promise<T>,
): Promise<T> {
  const reservation = work.reserve({ ...zero(), ...bound });
  reservation.dispatch();
  let count: number | undefined;
  try {
    const result = await reservation.query(body);
    if (Array.isArray(result)) count = result.length;
    return result;
  } finally {
    reservation.settle(
      count === undefined
        ? {}
        : {
            candidateKeys: Math.min(bound.candidateKeys ?? 0, count),
            witnessKeys: Math.min(bound.witnessKeys ?? 0, count),
            emptySeeks: count ? 0 : (bound.emptySeeks ?? 0),
          },
    );
  }
}

/** Existing native Source APIs charge structural reads themselves. Leave admission's ceiling on the parent,
 * while transferring the rest to that producer. Neither ledger can spend the other's held dimensions. */
export async function membersSource<T extends { readonly work: WorkReceipt }>(
  work: NativeCollectionWork,
  reads: number,
  body: (allowance: WorkAllowance) => Promise<T>,
): Promise<T> {
  const reserve = { ...zero(), nativeRows: 256, nativePoints: 32, statements: 16, bytes: 384 * 1024, emptySeeks: 16 };
  const ceiling = zero();
  for (const axis of Object.keys(ceiling) as (keyof WorkDimensions)[])
    ceiling[axis] = Math.max(0, work.available(axis) - reads * reserve[axis]);
  return work.compose(body, ceiling);
}

/** Only the Members getter enters this frame. Unknown statements fail before I/O, including future
 * custody APIs without a delivered cost declaration. The transaction itself is never replaced or branded. */
export function meterMembersDefinition<T>(tx: OperationalTransaction, body: () => Promise<T>): Promise<T> {
  const work = budgets.getStore();
  if (!work) return body(); // Other native consumers retain their own accounting policy.
  if (!installed.has(tx)) {
    installed.add(tx);
    const original = tx.query.bind(tx);
    const query = async (config: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
      const active = admission.getStore() && budgets.getStore();
      if (!active) return original(config as string, values);
      if (!hasLiveOperationalTransaction(tx)) throw new ProblemError('semantic_not_ready');
      const sql = typeof config === 'string' ? config : config.text;
      const parameters = (typeof config === 'string' ? values : config.values) ?? [];
      const bytes = Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(parameters));
      // Native SQL files can retain their leading documentation comments in the generated statement.
      const statement = sql.replace(/^\s*(?:(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)*/, '');
      if (!/^(SELECT|WITH)\b/i.test(statement)) throw new ProblemError('dependency_unavailable');
      let bound: Partial<WorkDimensions>;
      if (/semantic\.definition_release\b/.test(sql)) {
        if (/\bbody\b/.test(sql)) {
          const digest = parameters.find((value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value));
          if (!digest) throw new ProblemError('dependency_unavailable');
          const sizeSQL =
            'SELECT pg_column_size(body)::text AS bytes, pg_column_compression(body) IS NOT NULL AS compressed FROM semantic.definition_release WHERE route=0 AND digest=$1';
          const size = await membersBounded(
            active,
            {
              ...MEMBERS_DEFINITION_QUERY_BOUNDS.point,
              bytes: Buffer.byteLength(sizeSQL) + MEMBERS_DEFINITION_QUERY_BOUNDS.point.bytes,
            },
            () => original(sizeSQL, [digest]),
          );
          const row = size.rows[0] as { bytes: string; compressed: boolean } | undefined;
          const stored = row ? Number(row.bytes) : 0;
          if (!Number.isSafeInteger(stored) || stored < 0) throw new ProblemError('dependency_unavailable');
          // PostgreSQL compressed varlena can expand to 1 GiB. A too-large projection refuses before reading it.
          bound = {
            ...MEMBERS_DEFINITION_QUERY_BOUNDS.point,
            bytes:
              bytes +
              MEMBERS_DEFINITION_QUERY_BOUNDS.releaseProjection.byteMultiplier *
                (row?.compressed ? MEMBERS_DEFINITION_QUERY_BOUNDS.releaseProjection.maxExpandedVarlenaBytes : stored) +
              MEMBERS_DEFINITION_QUERY_BOUNDS.releaseProjection.fixedBytes,
          };
        } else
          bound = {
            ...MEMBERS_DEFINITION_QUERY_BOUNDS.point,
            bytes: bytes + MEMBERS_DEFINITION_QUERY_BOUNDS.point.bytes,
          };
      } else if (/library\.members_preparation\b/.test(sql)) {
        bound = {
          ...MEMBERS_DEFINITION_QUERY_BOUNDS.preparation,
          bytes: bytes + MEMBERS_DEFINITION_QUERY_BOUNDS.preparation.bytes,
        };
      } else if (/library\.canonical_source_scope\b/.test(sql) && /library\.collection\b/.test(sql)) {
        bound = {
          ...MEMBERS_DEFINITION_QUERY_BOUNDS.canonicalScope,
          bytes: bytes + MEMBERS_DEFINITION_QUERY_BOUNDS.canonicalScope.bytes,
        };
      } else throw new ProblemError('dependency_unavailable');
      return membersBounded(active, bound, () => original(config as string, values));
    };
    tx.query = query as PoolClient['query'];
  }
  return admission.run(true, body);
}
