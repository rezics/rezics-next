import type { CommandTransaction } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { sourceObservation, type SourceObservation } from './source-provider.ts';
import lock from './source-provider-lock.sql';
import head from './source-provider-head.sql';
import observe from './source-provider-observe.sql';
import list from './source-statistic-list.sql';

export type ObservationBinding = { route: number; subjectId: string; source: string; value: SourceObservation };
export type ObservationHead = {
  digest: string;
  sourceAlias: string;
  sourceRecordId: string;
  asOf: string;
  payload: unknown;
};

/** The head is one indexed subject/provider lookup, never a history selection or source-home join. */
export async function lockSourceObservation(tx: CommandTransaction, input: ObservationBinding) {
  const key = { route: input.route, subject_id: input.subjectId };
  if (!(await lock.run(tx, key))) return { exists: false, current: null } as const;
  const current = await head.run(tx, { ...key, source: input.source });
  if (current) return { exists: true, current: current as ObservationHead };
  // Existing VNDB rows predate observation identities. Adopt their exact payload lazily;
  // never fabricate an observation time or a provider revision during migration.
  const legacy = (await list.run(tx, key)).find((row) => row.source === input.source);
  if (!legacy) return { exists: true, current: null } as const;
  const value = {
    sourceAlias: legacy.sourceAlias as string,
    sourceRecordId: legacy.sourceRecordId as string,
    scale: { min: Number(legacy.scaleMin), max: Number(legacy.scaleMax) },
    mean: Number(legacy.mean), count: Number(legacy.count), asOf: legacy.asOf as string,
    licence: legacy.licence as string, attribution: legacy.attribution as string,
  };
  return { exists: true, current: { ...sourceObservation(input.subjectId, input.source, value),
    sourceAlias: value.sourceAlias, sourceRecordId: value.sourceRecordId, asOf: value.asOf, legacy: true } };
}

/** Older observations never win, including against a cleared head. Equal dates require
 * an identical digest or explicit CAS. Rebinding a provider slot also requires CAS.
 */
export function admitSourceObservation(input: ObservationBinding, current: ObservationHead | null) {
  const next = sourceObservation(input.subjectId, input.source, input.value);
  if (current?.digest === next.digest) return { ...next, identical: true };
  const expected = input.value.expectedObservation;
  const matches = expected !== undefined && expected === (current?.digest ?? null);
  if (expected !== undefined && !matches) throw new ProblemError('conflict');
  if (current) {
    if (input.value.asOf < current.asOf) throw new ProblemError('conflict');
    const rebound = current.sourceAlias !== (input.value.sourceAlias ?? input.source) ||
      current.sourceRecordId !== input.value.sourceRecordId;
    if ((input.value.asOf === current.asOf || rebound) && !matches) throw new ProblemError('conflict');
  }
  return { ...next, identical: false };
}

export async function saveSourceObservation(
  tx: CommandTransaction, input: ObservationBinding,
  next: { digest: string; payload: unknown }, transactionId: string,
) {
  const payload = next.payload as SourceObservation;
  await observe.run(tx, {
    route: input.route, subject_id: input.subjectId, source: input.source, digest: next.digest,
    source_alias: payload.sourceAlias ?? input.source, source_record_id: payload.sourceRecordId,
    as_of: payload.asOf, payload: JSON.stringify(next.payload), transaction_id: transactionId,
  });
}
