import { FusekiClient, type SparqlResult } from '../../infrastructure/fuseki.ts';
import { readTargetRatingContext, readTargetRatingRevision } from '../rating/target.ts';
import { RatingObservationUnavailable } from '../rating/observation.ts';
import { RevisionCorrupt, RevisionUnavailable } from '../work/history.ts';
import { READ_PREFIX, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { WORK_READ_COST } from '../work/read-contract.ts';

export const PERSONAL_EVIDENCE_COST = {
  heads: 21,
  selectArms: 42,
  graphBatches: 2,
  graphBatchBytes: WORK_READ_COST.graphBytes,
  contextManifestBytes: 1_048_576,
} as const;
export interface PersonalRatingHead {
  target: string;
  context: string;
  observation: string;
  revision: string;
}

/** Batch the existing owner's bounded SELECT probes, preserving its exact row
 * and manifest validation. The second wave is only v4 Context acceptance. No
 * authority result or graph result is cached beyond this page. */
export async function readPersonalRatingEvidence<Head extends PersonalRatingHead>(
  session: WorkReadSession,
  principalId: string,
  heads: readonly Head[],
) {
  if (heads.length > PERSONAL_EVIDENCE_COST.heads)
    throw new WorkReadUnavailable('Personal rating evidence exceeds its page bound');
  type Pending = {
    select: string;
    limit: number;
    resolve: (result: SparqlResult) => void;
    reject: (error: unknown) => void;
  };
  let pending: Pending[] = [],
    batches = 0;
  const cache = new Map<string, Promise<SparqlResult>>();
  const flush = async () => {
    const current = pending;
    pending = [];
    try {
      if (
        ++batches > PERSONAL_EVIDENCE_COST.graphBatches ||
        current.length > PERSONAL_EVIDENCE_COST.selectArms
      )
        throw new WorkReadUnavailable('Personal rating evidence exceeds its query bound');
      const bound = current.reduce((sum, probe) => sum + probe.limit, 0);
      session.checkDeadline();
      // A full page of accepted Contexts can exceed one ordinary probe's byte
      // ceiling. This exchange is still charged to the enclosing session's
      // shared call, byte and deadline budget; it receives no fresh allowance.
      const rows =
        (
          await session.deps.environment.fuseki.query(
            `${READ_PREFIX}\nSELECT * WHERE {
        ${current.map((probe, index) => `{ { ${probe.select} } BIND(${index} AS ?ownerExportProbe) }`).join(' UNION ')}
      } LIMIT ${bound + 1}`,
            PERSONAL_EVIDENCE_COST.graphBatchBytes,
          )
        ).results?.bindings ?? [];
      session.checkDeadline();
      if (rows.length > bound)
        throw new WorkReadUnavailable('Personal rating evidence exceeds its row bound');
      const grouped = current.map(() => [] as NonNullable<SparqlResult['results']>['bindings']);
      for (const row of rows) {
        const { ownerExportProbe, ...binding } = row;
        const index = Number(ownerExportProbe?.value);
        if (!Number.isInteger(index) || !grouped[index])
          throw new WorkReadUnavailable('Personal rating evidence batch is ambiguous');
        grouped[index]!.push(binding);
      }
      current.forEach((probe, index) => probe.resolve({ results: { bindings: grouped[index]! } }));
    } catch (error) {
      current.forEach((probe) => probe.reject(error));
    }
  };
  const fuseki = new FusekiClient('http://owner-export.invalid');
  fuseki.query = (query) => {
    const previous = cache.get(query);
    if (previous) return previous;
    const select = query.replace(/^\s*PREFIX\s+rv:\s*<[^>]+>\s*/i, '').trim();
    const limit = Number(select.match(/\bLIMIT\s+(\d+)\s*$/i)?.[1]);
    if (!/^SELECT\s/i.test(select) || !Number.isSafeInteger(limit) || limit < 1 || limit > 41)
      return Promise.reject(new WorkReadUnavailable('Personal rating owner probe is not bounded'));
    const result = new Promise<SparqlResult>((resolve, reject) => {
      pending.push({ select, limit, resolve, reject });
      if (pending.length === 1)
        queueMicrotask(() => {
          void flush();
        });
    });
    cache.set(query, result);
    return result;
  };
  const env = { ...session.deps.environment, fuseki };
  const contextBudget = {
    bytesLeft: PERSONAL_EVIDENCE_COST.contextManifestBytes as number,
    signal: AbortSignal.timeout(10_000),
  };
  // Start both owner probes for every head together, so identical Contexts share
  // one graph probe. One missing Context does not cancel another person's row.
  return Promise.all(
    heads.map(async (head) => {
      const [rating, context] = await Promise.all([
        readTargetRatingRevision(env, principalId, head),
        readTargetRatingContext(env, head.context, contextBudget).catch((error) => {
          if (
            error instanceof RatingObservationUnavailable ||
            error instanceof WorkReadUnavailable ||
            error instanceof RevisionCorrupt ||
            error instanceof RevisionUnavailable
          )
            return null;
          throw error;
        }),
      ]);
      return { head, rating, context };
    }),
  );
}
