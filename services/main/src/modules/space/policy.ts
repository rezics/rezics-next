import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { SPACE_REALM_PROFILE, SPACE_REALM_PROFILE_V1 } from './create.ts';

export type RealmVisibility = 'public' | 'restricted' | 'private';
export type RealmReviewMode = 'mandatory' | 'trusted-members' | 'open';
export const reviewPolicy = (mode: RealmReviewMode) => `https://rezics.com/definition/${
  mode === 'mandatory' ? 'realm-manager-reviewed-v1' : mode === 'trusted-members' ? 'realm-members-direct-v1' : 'realm-open-v1'}`;
export interface RealmPolicy { visibility: RealmVisibility; reviewMode: RealmReviewMode; revision: string | null; space: string; realmRevision: string | null }
export interface RealmPolicyDelivery { realm: string; receipt_id: string; generation: string;
  visibility: RealmVisibility; review_mode: RealmReviewMode }
export const policyHead = (id: string) => `urn:rezics:realm-policy:${id}`;

/** One exact Realm/Space read, at most 2 rows/8 KiB. Old Realms retain their
 * profile's defaults until the first explicit unified policy publication. */
export async function readRealmPolicy(env: WorkActivationEnvironment, realm: string): Promise<RealmPolicy | null> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?space ?realmRevision ?disclosure ?visibility ?mode ?head WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} . }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
      ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure ?disclosure .
      OPTIONAL { ${iri(realm)} rv:head ?realmRevision }
      OPTIONAL { ${iri(realm)} rv:visibility ?visibility ; rv:reviewMode ?mode ; rv:realmPolicyHead ?head }
    } } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const visibility = row.visibility?.value ?? (row.disclosure?.value === `${RV}Public` ? 'public' : 'private');
  const reviewMode = row.mode?.value ?? 'mandatory';
  if (!['public','restricted','private'].includes(visibility) || !['mandatory','trusted-members','open'].includes(reviewMode)
    || row.disclosure?.value !== `${RV}${visibility === 'private' ? 'Private' : 'Public'}`) return null;
  return { visibility: visibility as RealmVisibility, reviewMode: reviewMode as RealmReviewMode, revision: row.head?.value ?? null,
    space: row.space!.value, realmRevision: row.realmRevision?.value ?? null };
}

/** The committed Access receipt authorizes this idempotent graph delivery.
 * One atomic graph position invalidates public indexes, discovery generations
 * and read/search cursors. No history/body rewrite: independently published
 * originals stay public; copies already downloaded cannot be recalled.
 * O(1) Realm mutations; public search checks the current Space disclosure. */
export async function deliverRealmPolicy(env: WorkActivationEnvironment, op: RealmPolicyDelivery): Promise<void> {
  const receipt = policyHead(op.receipt_id);
  const digest = hash(JSON.stringify(op));
  const committed = async () => (await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded . }
  }`, 1024)).boolean === true;
  if (await committed()) return;
  const spaces = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?space ?spaceProfile ?realmProfile WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(op.realm)} a rv:Realm ; rv:space ?space .
      ?space a rv:Space ; rv:realmCapability ${iri(op.realm)} .
      OPTIONAL { ${iri(op.realm)} rv:definitionProfile ?realmProfile }
      OPTIONAL { ?space rv:definitionProfile ?spaceProfile } }
  } LIMIT 2`, 2048)).results?.bindings ?? [];
  if (spaces.length !== 1 || !spaces[0]?.space) throw new Error('Realm Space is unavailable');
  const space = spaces[0].space.value;
  const spaceProfile = spaces[0].spaceProfile?.value;
  const realmProfile = spaces[0].realmProfile?.value;
  const profile = spaceProfile === SPACE_REALM_PROFILE && realmProfile === SPACE_REALM_PROFILE
    ? SPACE_REALM_PROFILE : spaceProfile === undefined && realmProfile === undefined
    ? SPACE_REALM_PROFILE_V1 : null;
  if (!profile) throw new Error('Realm Space profile is inconsistent');
  const profileId = profile === SPACE_REALM_PROFILE ? 'space-realm-v2' : 'space-realm-v1';
  const validations = await profileValidations(env.fuseki, profileId, [
    { shape: `${profile}/space-shape`, focus: [space], graphs: [GRAPHS.current] },
    { shape: `${profile}/realm-shape`, focus: [op.realm], graphs: [GRAPHS.current] },
  ]);
  let error: unknown;
  try { await env.fuseki.commandWithReceipt({ receipt, digest, validations, deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(space)} rv:disclosure ?disclosure .
        ${iri(op.realm)} rv:visibility ?visibility ; rv:reviewMode ?mode ; rv:realmPolicyHead ?head ; rv:reviewPolicy ?policy . }
    } INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(space)} rv:disclosure rv:${op.visibility === 'private' ? 'Private' : 'Public'} .
        ${iri(op.realm)} rv:visibility ${lit(op.visibility)} ; rv:reviewMode ${lit(op.review_mode)} ;
          rv:realmPolicyHead ${iri(receipt)} ; rv:reviewPolicy ${iri(reviewPolicy(op.review_mode))} . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:requestDigest ${lit(digest)} ; rv:realm ${iri(op.realm)} ; rv:space ${iri(space)} ;
        rv:visibility ${lit(op.visibility)} ; rv:reviewMode ${lit(op.review_mode)} ; rv:policyGeneration ${lit(op.generation)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${hash(receipt)}`)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(`urn:rezics:event:${hash(receipt)}`)} .
        ${iri(`urn:rezics:event:${hash(receipt)}`)} a rv:RealmPolicyChangedEvent ; rv:ordinal 0 ;
          rv:action "realm.policy.publish" ; rv:receipt ${iri(receipt)} ; rv:realm ${iri(op.realm)} . }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} { ${iri(op.realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ${iri(space)} ; rv:reviewPolicy ?policy .
        ${iri(space)} rv:realmCapability ${iri(op.realm)} ; rv:disclosure ?disclosure .
        OPTIONAL { ${iri(op.realm)} rv:visibility ?visibility ; rv:reviewMode ?mode ; rv:realmPolicyHead ?head } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch (cause) { error = cause; }
  if (!await committed()) throw new Error('Realm policy delivery is pending', { cause: error });
}
