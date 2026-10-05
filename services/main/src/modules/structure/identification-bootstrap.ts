import { GRAPHS, iri, RV, type WorkActivationEnvironment } from '../work/activate.ts';
import { compositionForMainVersion, readCompositionHeader } from './graph.ts';
import { readCompositionPage } from './read.ts';
import { readCompositionReceipt, CompositionExists } from './change.ts';
import { CompositionUnavailable } from './graph.ts';

export interface IdentificationStructureProof {
  structure: string; revision: string; receipt: string; occurrence?: string;
}

/** Reuse an empty realization or its one exact Post placement. An existing
 * multi-chapter realization is never replaced by an identification request.
 * At most one header, two immutable records and one exact revision receipt. */
export async function existingIdentificationStructure(env: WorkActivationEnvironment,
  work: string, mainVersion: string, post: string): Promise<IdentificationStructureProof | null> {
  const structure = await compositionForMainVersion(env, mainVersion);
  if (!structure) return null;
  const header = await readCompositionHeader(env, structure);
  if (!header || header.owner !== work || header.profile !== 'book-composition') {
    throw new CompositionUnavailable('Work realization is unavailable');
  }
  if (header.placementCount > 1) throw new CompositionExists('Work already has another realization');
  const page = await readCompositionPage(env, { structure, header, limit: 2,
    canReadTarget: async target => target === post });
  const record = page.occurrences[0];
  if (page.next || page.occurrences.length !== header.placementCount
    || record && (record.role !== 'chapter' || record.target !== post)) {
    throw new CompositionExists('Work already has another realization');
  }
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?admission WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(header.head)} rv:operation ?operation }
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:operation ?operation ; rv:outcome rv:Succeeded ;
      rv:structure ${iri(structure)} ; rv:structureRevision ${iri(header.head)} ; rv:admissionId ?admission }
  } LIMIT 2`)).results?.bindings ?? [];
  const receipt = rows.length === 1 && rows[0]?.admission
    ? await readCompositionReceipt(env, rows[0].admission.value) : null;
  if (!receipt || receipt.outcome !== 'succeeded' || receipt.structure !== structure || receipt.revision !== header.head) {
    throw new CompositionUnavailable('Work realization receipt is unavailable');
  }
  return { structure, revision: header.head, receipt: receipt.receipt,
    ...(record ? { occurrence: record.occurrence } : {}) };
}
