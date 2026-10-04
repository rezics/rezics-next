import { randomUUID } from 'node:crypto';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';

/** Card probes own the first active standing question, just as they own the
 * serving population. Preserve earlier files' Contexts and restore their
 * exact Active statements when this sequential fixture finishes. */
export async function isolateCardRatingContext(fuseki: FusekiClient) {
  const saved = `urn:rezics:qa:g1064:contexts:${randomUUID()}`;
  await fuseki.update(`PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.current)} { ?context rv:contextState rv:Active } }
    INSERT { GRAPH ${iri(saved)} { ?context rv:contextState rv:Active } }
    WHERE { GRAPH ${iri(GRAPHS.current)} { ?context a rv:GlobalRatingContext;rv:contextState rv:Active } }`);
  return async () => {
    await fuseki.update(`PREFIX rv: <${RV}>
      INSERT { GRAPH ${iri(GRAPHS.current)} { ?context rv:contextState rv:Active } }
      WHERE { GRAPH ${iri(saved)} { ?context rv:contextState rv:Active } }`);
    await fuseki.update(`DROP SILENT GRAPH ${iri(saved)}`);
  };
}
