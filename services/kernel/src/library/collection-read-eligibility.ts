import { EMPTY_ACCESS_WORK } from '../access/work.ts';
import { createResourcePublicEligibility } from '../access/public-eligibility.ts';
import { statementBytes } from '../database/statement-bytes.ts';
import collectionRead from './collection-reads-collection.sql';
import { collectionDirectoryRowPlan } from './collection-directory-bounds.ts';

export type CollectionReadObservation = {
  seen: boolean;
  row: Awaited<ReturnType<typeof collectionRead.run>>;
  failure?: { error: unknown };
};

/** The mounted reader and admitted preparation share the same current native public-read evidence. */
export function collectionReadEligibility(
  resource: { route: number; id: string },
  observation?: CollectionReadObservation,
) {
  const identity = Object.freeze({ route: resource.route, id: resource.id });
  const plan = collectionDirectoryRowPlan(identity);
  const native = Object.freeze({
    keys: plan.total.candidateKeys,
    points: plan.total.nativePoints,
    rows: plan.total.nativeRows,
    witnesses: plan.total.witnessKeys,
    emptySeeks: plan.total.emptySeeks,
    bytes: plan.total.bytes - statementBytes(collectionRead),
  });
  return createResourcePublicEligibility({
    work: {
      prepare: { bound: () => EMPTY_ACCESS_WORK, actual: () => EMPTY_ACCESS_WORK },
      verify: { bound: () => native, actual: () => native },
    },
    resource: identity,
    action: 'collection:read',
    async prepare() {
      return { ready: true };
    },
    async verify({ client }) {
      try {
        const row = await plan.run({ query: client.query.bind(client) });
        if (observation) {
          observation.seen = true;
          observation.row = row;
        }
        // False preserves the curator's grant path for a private Collection.
        return row !== null && row.state === 'active' && row.visibility !== 'private';
      } catch (error) {
        // Access fails closed; the mounted reader must preserve the owning dependency failure.
        if (observation) observation.failure = { error };
        throw error;
      }
    },
  });
}
