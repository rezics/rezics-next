import { fusekiReadBudget, type FusekiClient } from '../../../../services/main/src/infrastructure/fuseki.ts';
import { iri } from '../../../../services/main/src/modules/work/activate.ts';

/** A missing owner head does not rule out a fabricated identity stub. Probe
 * every named graph and the default graph without requiring a type or head. */
export async function assertGraphSubjectAbsent(fuseki: Pick<FusekiClient, 'query'>, subject: string): Promise<void> {
  const result = await fuseki.query(`ASK {
    { ${iri(subject)} ?predicate ?object }
    UNION { GRAPH ?graph { ${iri(subject)} ?predicate ?object } }
  }`);
  if (typeof result.boolean !== 'boolean') throw new Error('Graph subject absence probe has no ASK result');
  if (result.boolean) throw new Error(`Graph subject has triples: ${subject}`);
}

/** Nested Work read envelopes debit this outer budget. Background workers exit
 * the caller's budget, so their concurrent reads do not contaminate operation
 * cost assertions and remain running during the measurement. */
export async function measureGraphReads<T>(operation: () => Promise<T>): Promise<{ value: T; calls: number }> {
  const budget = { signal: AbortSignal.timeout(30_000), callsLeft: 1000, bytesLeft: Number.MAX_SAFE_INTEGER };
  const value = await fusekiReadBudget.run(budget, operation);
  return { value, calls: 1000 - budget.callsLeft };
}
