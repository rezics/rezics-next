import { Value } from 'typebox/value';
import { t } from 'elysia';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { targetRef } from '../target/contract.ts';
import { MERGE_COST, MergeUnavailable } from './contract.ts';
import { resolveMergedIdentity } from './preflight.ts';
import type { WorkReadSession } from '../work/read-session.ts';

export type MergedIdentity = { state: 'merged'; source: string; survivor: string; hops: number };
export const mergedIdentity = t.Object({ state: t.Literal('merged'), source: targetRef,
  survivor: targetRef, hops: t.Integer({ minimum: 1, maximum: MERGE_COST.redirectHops }) },
{ additionalProperties: false });

/** The existing direct-edge owner binds a matching graph cut or a selected
 * session's redirect edges. Do not use
 * this metadata lookup as disclosure authority: target resolution discloses
 * every visited identity, and old-address/revision readers must do likewise. */
export function redirectOf(env: WorkActivationEnvironment, position?: { sequence: string }, session?: WorkReadSession) {
  return async (resource: string): Promise<string | null> => {
    if (!Value.Check(targetRef, resource)) throw new MergeUnavailable('Invalid identity');
    const body = `PREFIX rv: <${RV}> SELECT ?sequence ?mergedInto WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?sequence
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      ${position && !session?.fencesSelectedUnits ? `FILTER(STR(?sequence) = ${lit(position.sequence)})` : ''}
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(resource)} rv:mergedInto ?mergedInto } }
    } LIMIT 2`;
    const rows = session?.fencesSelectedUnits
      ? await session.query(body, 2, rows => rows.map(({ sequence: _sequence, ...row }) => row), 4096)
      : (await env.fuseki.query(body, 4096)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.sequence || !/^\d+$/.test(rows[0].sequence.value) || rows[0].mergedInto
      && (rows[0].mergedInto.type !== 'uri' || !Value.Check(targetRef, rows[0].mergedInto.value))) {
      throw new MergeUnavailable('Identity resolution is unavailable or ambiguous');
    }
    return rows[0].mergedInto?.value ?? null;
  };
}

/** Selected sessions bind each visited edge; independent proofs keep one graph
 * cut for the chain, including its terminal disclosure.
 * ≤35 small graph probes and the address owner's shared 32-hop rule. */
export async function readMergedIdentity(env: WorkActivationEnvironment, resource: string,
  canRead: (resource: string) => Promise<boolean>,
  options: { position?: { sequence: string }; maxHops?: number; session?: WorkReadSession } = {}): Promise<MergedIdentity | null> {
  if (!Value.Check(targetRef, resource)) throw new MergeUnavailable('Invalid identity');
  const deadline = Date.now() + MERGE_COST.deadlineMs;
  const selected = options.session?.fencesSelectedUnits ? options.session.position : null;
  const rows = selected || options.position ? [{ sequence: { value: (selected ?? options.position)!.sequence } }] : (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?sequence
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
  } LIMIT 2`, 4096)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.sequence || !/^\d+$/.test(rows[0].sequence.value)) throw new MergeUnavailable('Identity graph is unavailable');
  const position = { sequence: rows[0].sequence.value }, edge = redirectOf(env, position, options.session);
  const result = await resolveMergedIdentity(resource, async current => {
    if (Date.now() >= deadline || !await canRead(current)) throw new MergeUnavailable('Identity is unavailable');
    if (Date.now() >= deadline) throw new MergeUnavailable('Identity resolution deadline exceeded');
    return edge(current);
  }, options.maxHops);
  // Fence disclosure checks as well as graph reads. A moved graph must not
  // return an identity from an earlier chain with later authority.
  if (Date.now() >= deadline) throw new MergeUnavailable('Identity resolution deadline exceeded');
  await edge(result.state === 'merged' ? result.survivor : result.resource);
  return result.state === 'merged' ? result : null;
}
