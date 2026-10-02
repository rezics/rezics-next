import type { Pool } from 'pg';
import {
  DATASET,
  GRAPHS,
  RV,
  hash,
  iri,
  lit,
  type WorkActivationEnvironment,
} from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { PublicQueryUnavailable } from '../work/search-budget.ts';

export type NamePreferencesProjection = (
  agent: string,
  visibility: 'public' | 'private',
  version: number,
) => Promise<void>;
let defaultProjection: NamePreferencesProjection | undefined;
export const defaultNamePreferencesProjection = () => defaultProjection;

/** Access owns Person visibility. Its versioned, non-indexed marker removes
 * private names before the Access commit; public names publish after commit.
 * An older delivery can never undo a newer private setting. */
export function namePreferencesProjection(
  env: WorkActivationEnvironment,
): NamePreferencesProjection {
  return async (agent, visibility, version) => {
    const marker = `urn:rezics:search:name:visibility:${agent.slice(-36)}`;
    const identity = hash(JSON.stringify([env.lineage.dataEpoch, agent, visibility, version]));
    const receipt = `urn:rezics:receipt:catalogue-search-index:${identity}`,
      digest = hash(receipt);
    const result = await env.fuseki.commandWithReceipt({
      receipt,
      digest,
      validations: [],
      deadlineMs: 60_000,
      update: `PREFIX rv: <${RV}>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(marker)} rv:nameVisibility ?oldVisibility ; rv:nameVersion ?oldVersion } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(marker)} rv:nameVisibility ?nextVisibility ; rv:nameVersion ?nextVersion }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:nameResource ${iri(agent)} }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri('urn:rezics:outbox:' + identity)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 }
        } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n }
          OPTIONAL { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(marker)} rv:nameVisibility ?oldVisibility ; rv:nameVersion ?oldVersion } }
          BIND(IF(BOUND(?oldVersion) && ?oldVersion > ${version}, ?oldVisibility, ${lit(visibility)}) AS ?nextVisibility)
          BIND(IF(BOUND(?oldVersion) && ?oldVersion > ${version}, ?oldVersion, ${version}) AS ?nextVersion)
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          BIND(?n+1 AS ?next) }`,
    });
    if (result.status === 'committed') return;
    // A superseded idempotent delivery has no mutation or receipt to commit.
    const newer = await env.fuseki
      .query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      ${iri(marker)} rv:nameVersion ?version . FILTER(?version > ${version}) } }`);
    if (!newer.boolean) throw new PublicQueryUnavailable('Person name visibility ' + result.status);
  };
}

/** Startup reconciliation precedes serving reads; each indexed keyset batch
 * holds 64 settings. This is migration work, never a per-page population scan. */
export async function configureNamePreferences(env: WorkActivationEnvironment, pool: Pool) {
  defaultProjection = namePreferencesProjection(env);
  let after = '',
    scanned = 0;
  while (true) {
    const rows = (
      await pool.query<{
        agent_id: string;
        profile_visibility: 'public' | 'private';
        version: number;
      }>(
        `SELECT agent_id, profile_visibility, version FROM access.person_preferences
       WHERE agent_id > $1 ORDER BY agent_id LIMIT 64`,
        [after],
      )
    ).rows;
    if (!rows.length) return;
    scanned += rows.length;
    if (scanned > 50_000)
      throw new PublicQueryUnavailable(
        'Person name reconciliation exceeds startup inventory bound',
      );
    for (const row of rows)
      await defaultProjection(row.agent_id, row.profile_visibility, row.version);
    after = rows.at(-1)!.agent_id;
  }
}
