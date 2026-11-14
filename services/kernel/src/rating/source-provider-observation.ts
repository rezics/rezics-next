import type { CommandTransaction } from '../command/command.ts';
import { ProblemError } from '../http/problem-error.ts';
import { SOURCE_OBSERVATION_PAYLOAD_VERSION, sourceObservation, type SourceObservation } from './source-provider.ts';
import lock from './source-provider-lock.sql';
import head from './source-provider-head.sql';
import observe from './source-provider-observe.sql';

export type ObservationBinding = { route: number; subjectId: string; source: string; value: SourceObservation };
export type ObservationHead = {
  digest: string;
  sourceAlias: string;
  sourceRecordId: string;
  asOf: string;
  payload: unknown;
  payloadVersion: number;
  nativeOrder: string | null;
  lastOrder: string;
  lastSeekOrder: string;
};
export type ObservationOrder = Readonly<{ localOrder: string; lastOrder: string; seekOrder: string; lastSeekOrder: string }>;

/** The head is one indexed subject/provider lookup, never a history selection or source-home join. */
export async function lockSourceObservation(tx: CommandTransaction, input: ObservationBinding) {
  const key = { route: input.route, subject_id: input.subjectId };
  if (!(await lock.run(tx, key))) return { exists: false, current: null } as const;
  const current = await head.run(tx, { ...key, source: input.source });
  if (!current || current.inconsistent) throw new ProblemError('partition_unavailable');
  return { exists: true, current: current.digest === null ? null : (current as ObservationHead) } as const;
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
    const rebound =
      current.sourceAlias !== (input.value.sourceAlias ?? input.source) ||
      current.sourceRecordId !== input.value.sourceRecordId;
    if ((input.value.asOf === current.asOf || rebound) && !matches) throw new ProblemError('conflict');
  }
  return { ...next, identical: false };
}

export async function saveSourceObservation(
  tx: CommandTransaction,
  input: ObservationBinding,
  next: { digest: string; payload: unknown },
  transactionId: string,
  order: ObservationOrder,
) {
  const payload = next.payload as SourceObservation;
  await observe.run(tx, {
    route: input.route,
    subject_id: input.subjectId,
    source: input.source,
    digest: next.digest,
    source_alias: payload.sourceAlias ?? input.source,
    source_record_id: payload.sourceRecordId,
    as_of: payload.asOf,
    payload: JSON.stringify(next.payload),
    transaction_id: transactionId,
    payload_version: SOURCE_OBSERVATION_PAYLOAD_VERSION,
    local_order: order.localOrder,
    last_order: order.lastOrder,
    seek_order: order.seekOrder,
    last_seek_order: order.lastSeekOrder,
  });
}
