import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertPublicTextReady, assertSameTextInstance, SearchIndexUnavailable,
  SearchSnapshotMoved } from '../work/search-readiness.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { searchGraphSnapshot } from './snapshot-state.ts';

/** HTTP reads are separate transactions (https://jena.apache.org/documentation/rdfconnection/#remote-transactions).
 * Share graph facts only inside a qualified position, and fence that position
 * once after every owner has finished. Access/media/source fences still run.
 * One readiness proof + one final graph read; both debit the enclosing budget. */
export async function withSearchGraphSnapshot<T>(env: WorkActivationEnvironment, read: () => Promise<T>) {
  const position = await assertPublicTextReady(env.fuseki, env.lineage).catch(async (error: unknown) => {
    // Readiness includes admission in its successful proof. On failure, retain
    // the recovery owner's typed hold outcome without taxing successful reads.
    if (error instanceof SearchIndexUnavailable && !(error instanceof SearchSnapshotMoved)) {
      await assertGraphAdmissionOpen(env.fuseki, env.lineage);
    }
    throw error;
  });
  return searchGraphSnapshot.run({ clients: new Set([env.fuseki]), lineage: env.lineage, position }, async () => {
    const result = await read();
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?generation WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:textIndexGeneration ?generation .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    } LIMIT 2`, 8192)).results?.bindings ?? [];
    if (rows.length !== 1 || rows[0]?.epoch?.value !== position.dataEpoch
      || rows[0]?.sequence?.value !== position.sequence || rows[0]?.generation?.value !== position.generation) {
      throw new SearchSnapshotMoved('Search graph changed during matching or card hydration');
    }
    await assertSameTextInstance(env.fuseki, position);
    return result;
  });
}
