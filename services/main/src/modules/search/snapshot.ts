import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertPublicTextReady, assertSameTextInstance, assertSearchDeadline, SearchIndexUnavailable,
  SearchSnapshotMoved } from '../work/search-readiness.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { searchGraphSnapshot } from './snapshot-state.ts';
import { observeSearchPhase } from './operation-evidence.ts';

/** Native phrase matching exposes an exact relation, including absence and rank;
 * no per-match token covers that cut. Keep its narrow sequence fence until the
 * matching owner exposes one. A selected-unit consumer instead fences all graph
 * inputs in its Work session; both modes retain recovery and native instance /
 * index generation checks. sourcePosition remains the opening position. */
export async function withSearchGraphSnapshot<T>(env: WorkActivationEnvironment, read: () => Promise<T>,
  graphBasis: 'matching-cut' | 'selected-units' = 'matching-cut') {
  assertSearchDeadline();
  const position = await observeSearchPhase('index-readiness',
    () => assertPublicTextReady(env.fuseki, env.lineage)).catch(async (error: unknown) => {
    // Readiness includes admission in its successful proof. On failure, retain
    // the recovery owner's typed hold outcome without taxing successful reads.
    if (error instanceof SearchIndexUnavailable && !(error instanceof SearchSnapshotMoved)) {
      assertSearchDeadline();
      await assertGraphAdmissionOpen(env.fuseki, env.lineage);
    }
    throw error;
  });
  return searchGraphSnapshot.run({ clients: new Set([env.fuseki]), lineage: env.lineage, position, graphBasis }, async () => {
    assertSearchDeadline();
    const result = await read();
    assertSearchDeadline();
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?generation WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:textIndexGeneration ?generation .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    } LIMIT 2`, 8192)).results?.bindings ?? [];
    assertSearchDeadline();
    if (rows.length !== 1 || rows[0]?.epoch?.value !== position.dataEpoch
      || (graphBasis === 'matching-cut' && rows[0]?.sequence?.value !== position.sequence)
      || rows[0]?.generation?.value !== position.generation) {
      throw new SearchSnapshotMoved('Search graph changed during matching or card hydration');
    }
    if (graphBasis === 'matching-cut') await assertSameTextInstance(env.fuseki, position);
    else {
      // Selected consumers recheck their native relation as an owner dependency.
      // The global writer epoch includes commits with no matching/index change.
      const health = await env.fuseki.commandHealth();
      if (health.instanceId !== position.serverInstanceId
        || (health as { textIndexUncertain?: boolean }).textIndexUncertain === true) {
        throw new SearchIndexUnavailable('Fuseki text owner changed during selected hydration');
      }
    }
    assertSearchDeadline();
    return result;
  });
}
