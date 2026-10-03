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
import { nameBackfillCheckpoint, saveNameBackfillCheckpoint } from './backfill-checkpoint.ts';

export type NamePreferencesProjection = (
  agent: string,
  visibility: 'public' | 'private',
  version: number,
) => Promise<void>;
export type NameListingProjection = (
  agent: string,
  listing: 'listed' | 'unlisted',
  version: number,
) => Promise<void>;
let defaultProjection: NamePreferencesProjection | undefined;
let defaultListingProjection: NameListingProjection | undefined;
export const defaultNamePreferencesProjection = () => defaultProjection;
export const defaultNameListingProjection = () => defaultListingProjection;

interface PolicyRow {
  agent: string;
  visibility?: 'public' | 'private';
  version?: number;
  listing?: 'listed' | 'unlisted';
  listingVersion?: number;
}

/** <=64 settings in one native transaction. Independent monotonic versions
 * prevent an old public/listed delivery from undoing either private gate. */
export async function publishNamePolicies(
  env: WorkActivationEnvironment,
  rows: readonly PolicyRow[],
  complete = false,
) {
  if (rows.length > 64) throw new PublicQueryUnavailable('Name policy batch exceeds 64 Agents');
  if (!rows.length && !complete) return;
  const identity = hash(JSON.stringify([env.lineage.dataEpoch, 'name-policy-v2', rows, complete]));
  const receipt = `urn:rezics:receipt:catalogue-search-index:${identity}`,
    digest = hash(receipt);
  const values = rows.map((row) =>
    [
      iri(row.agent),
      iri(`urn:rezics:search:name:visibility:${row.agent.slice(-36)}`),
      row.visibility === undefined ? 'UNDEF' : lit(row.visibility),
      row.version ?? 'UNDEF',
      row.listing === undefined ? 'UNDEF' : lit(row.listing),
      row.listingVersion ?? 'UNDEF',
    ].join(' '),
  );
  const result = await env.fuseki.commandWithReceipt({
    receipt,
    digest,
    validations: [],
    deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?marker rv:nameVisibility ?oldVisibility ; rv:nameVersion ?oldVersion ;
        rv:nameListing ?oldListing ; rv:listingVersion ?oldListingVersion } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?marker rv:nameVisibility ?nextVisibility ; rv:nameVersion ?nextVersion ;
        rv:nameListing ?nextListing ; rv:listingVersion ?nextListingVersion .
        <urn:rezics:search:name:policy-maintenance> rv:publicTitle "" }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
        rv:outcome rv:Succeeded ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        ${rows.length ? `${iri(receipt)} rv:nameResource ${rows.map((row) => iri(row.agent)).join(', ')} .` : ''}
        ${complete ? `${iri(receipt)} rv:namePoliciesComplete true .` : ''} }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri('urn:rezics:outbox:' + identity)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 }
    } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n }
      ${
        rows.length
          ? `VALUES (?agent ?marker ?visibility ?version ?listing ?listingVersion) { ${values.map((row) => `(${row})`).join(' ')} }
      OPTIONAL { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?marker rv:nameVisibility ?oldVisibility ; rv:nameVersion ?oldVersion } }
      OPTIONAL { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?marker rv:nameListing ?oldListing ; rv:listingVersion ?oldListingVersion } }
      BIND(IF(!BOUND(?visibility) || BOUND(?oldVersion) && ?oldVersion > ?version, ?oldVisibility, ?visibility) AS ?nextVisibility)
      BIND(IF(!BOUND(?version) || BOUND(?oldVersion) && ?oldVersion > ?version, ?oldVersion, ?version) AS ?nextVersion)
      BIND(IF(!BOUND(?listing) || BOUND(?oldListingVersion) && ?oldListingVersion > ?listingVersion, ?oldListing, ?listing) AS ?nextListing)
      BIND(IF(!BOUND(?listingVersion) || BOUND(?oldListingVersion) && ?oldListingVersion > ?listingVersion, ?oldListingVersion, ?listingVersion) AS ?nextListingVersion)`
          : ''
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n+1 AS ?next) }`,
  });
  if (result.status !== 'committed')
    throw new PublicQueryUnavailable('Name policy projection ' + result.status);
}

export const namePreferencesProjection =
  (env: WorkActivationEnvironment): NamePreferencesProjection =>
  (agent, visibility, version) =>
    publishNamePolicies(env, [{ agent, visibility, version }]);
export const nameListingProjection =
  (env: WorkActivationEnvironment): NameListingProjection =>
  (agent, listing, listingVersion) =>
    publishNamePolicies(env, [{ agent, listing, listingVersion }]);

/** One resumable keyset batch per call. No inventory ceiling, no per-row writes.
 * Finish this policy pass before publishing legacy Agent names. */
export async function reconcileNamePreferences(env: WorkActivationEnvironment, pool: Pool) {
  const profile = 'agent-name-policy-v2';
  const checkpoint = await nameBackfillCheckpoint(pool, env.lineage.dataEpoch, profile);
  if (checkpoint.complete) return { ...checkpoint, processed: 0 };
  const rows = (
    await pool.query<{
      agent: string;
      visibility: 'public' | 'private';
      version: number;
      listing: 'listed' | 'unlisted';
      listing_version: number;
    }>(
      `SELECT a.id AS agent, CASE WHEN a.active THEN COALESCE(p.profile_visibility,'public')
      ELSE 'private' END AS visibility,
    COALESCE(p.version,0) AS version, COALESCE(l.listing,'listed') AS listing,
    COALESCE(l.version,0) AS listing_version FROM access.authority_subject a
    LEFT JOIN access.person_preferences p ON p.agent_id=a.id
    LEFT JOIN access.agent_listing l ON l.agent_id=a.id
    WHERE a.kind='agent' AND a.id>$1 ORDER BY a.id LIMIT 64`,
      [checkpoint.after],
    )
  ).rows;
  const complete = rows.length < 64;
  await publishNamePolicies(
    env,
    rows.map((row) => ({ ...row, listingVersion: row.listing_version })),
    complete,
  );
  const after = rows.at(-1)?.agent ?? checkpoint.after;
  await saveNameBackfillCheckpoint(pool, env.lineage.dataEpoch, profile, after, complete);
  return { after, complete, processed: rows.length };
}

/** Startup publishes at most one 64-Agent batch and never prevents Main from
 * serving. Operators resume the durable remainder through search:names:backfill. */
export async function configureNamePreferences(env: WorkActivationEnvironment, pool: Pool) {
  defaultProjection = namePreferencesProjection(env);
  defaultListingProjection = nameListingProjection(env);
  try {
    return await reconcileNamePreferences(env, pool);
  } catch (error) {
    console.warn(
      'Public name policy backfill deferred:',
      error instanceof Error ? error.message : String(error),
    );
  }
}
