import type { ContentCore, ExactContentReference } from '../../../../content/src/core.ts';
import { profileRegistry } from '../../../../../packages/model/src/generated/profiles.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment }
  from '../work/activate.ts';
import { PRIVATE_SEARCH_GRAPH } from '../contribution/private-projection.ts';

const PROFILE_ID = 'content-private-match-unit-v1';
const PROFILE = 'https://rezics.com/definition/content-private-match-unit-v1';
const REVISION = 'urn:rezics:content:revision:';
const MAX_BODY_BYTES = 65_536;
export const CONTENT_PRIVATE_PROJECTION_COST = { contentReads: 3, graphCommands: 1,
  graphProofs: 1, privateUnitsPerVariant: 1 } as const;

export class ContentPrivateProjectionUnavailable extends Error {}

export function contentPrivateUnit(revisionId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(revisionId)) throw new ContentPrivateProjectionUnavailable('invalid Content revision');
  return `urn:rezics:content:private-unit:${hash(revisionId)}`;
}

function identities(reference: ExactContentReference, ownerEpoch: string) {
  const digest = hash(`${ownerEpoch}\0${reference.revisionId}\0private-content-projection-v1`);
  return { receipt: `urn:rezics:receipt:content-private-projection:${digest}`,
    anchor: `urn:rezics:content:private-projection:${digest}`,
    state: `urn:rezics:content:private-state:${hash(reference.variantId)}`,
    unit: contentPrivateUnit(reference.revisionId),
    batch: `urn:rezics:outbox:${hash(`${digest}\0batch`)}`,
    event: `urn:rezics:event:${hash(`${digest}\0event`)}` };
}

/** Runs only after Access registered an exact Content variant read. The command
 * replaces that variant's private unit while leaving public search untouched. */
export async function projectPrivateContentDraft(env: WorkActivationEnvironment,
  content: ContentCore, resource: string, variant: string, expectedRevision: string,
  expectedOwnerEpoch: string): Promise<{ unit: string; body: string; language: string;
    byteDigest: string }> {
  const exact = (await content.readExactBatch([expectedRevision],
    async () => new Set([expectedRevision])))[0];
  if (exact?.status !== 'available' || exact.reference.resourceId !== resource
    || exact.reference.variantId !== variant || exact.reference.model !== 'content-shape-v1'
    || exact.reference.language.kind !== 'tag') {
    throw new ContentPrivateProjectionUnavailable('exact private Content body is unavailable');
  }
  const language = exact.reference.language.tag;
  const body = exact.body.body;
  if (typeof body !== 'string' || !body || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(body)
    || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
    throw new ContentPrivateProjectionUnavailable('private Content body has no admitted text recipe');
  }
  const source = await content.readDraftHead(resource, variant);
  if (!source || source.revisionId !== expectedRevision
    || source.position.dataEpoch !== expectedOwnerEpoch) {
    throw new ContentPrivateProjectionUnavailable('Content draft head changed');
  }
  const profile = profileRegistry[PROFILE_ID];
  const health = await env.fuseki.commandHealth();
  if (!profile || health.profiles[PROFILE_ID] !== profile.sha256) {
    throw new ContentPrivateProjectionUnavailable('private Content projection profile differs');
  }
  const identity = identities(exact.reference, expectedOwnerEpoch);
  const digest = hash(JSON.stringify({ reference: exact.reference, ownerEpoch: expectedOwnerEpoch,
    text: hash(body), language, profile: PROFILE_ID }));
  const revision = `${REVISION}${expectedRevision}`;
  const result = await env.fuseki.commandWithReceipt({ receipt: identity.receipt, digest,
    validations: [{ profile: PROFILE_ID, sha256: profile.sha256,
      shape: `${PROFILE}/state-shape`, focus: [identity.state], graphs: [GRAPHS.current] },
    { profile: PROFILE_ID, sha256: profile.sha256,
      shape: `${PROFILE}/projection-shape`, focus: [identity.anchor], graphs: [GRAPHS.revisions] },
    { profile: PROFILE_ID, sha256: profile.sha256,
      shape: `${PROFILE}/unit-shape`, focus: [identity.unit], graphs: [PRIVATE_SEARCH_GRAPH] }],
    deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}> DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(identity.state)} rv:privateSearchHead ?oldProjection }
      GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} { ?oldUnit ?oldPredicate ?oldValue }
    } INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(identity.state)} a rv:ContentPrivateSearchState ;
        rv:resource ${iri(resource)} ; rv:variant ${iri(variant)} ;
        rv:privateSearchHead ${iri(identity.anchor)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(identity.anchor)}
        a rv:ContentPrivateProjection, rv:RevisionAnchor ;
        rv:component ${iri(identity.state)} ; rv:resource ${iri(resource)} ;
        rv:variant ${iri(variant)} ;
        rv:contentRevision ${iri(revision)} ; rv:matchUnit ${iri(identity.unit)} ;
        rv:byteDigest ${lit(exact.reference.byteDigest)} ;
        rv:ownerDataEpoch ${lit(source.position.dataEpoch)} ;
        rv:ownerSequence ${lit(source.position.sequence)} ;
        rv:modelRevision ${iri(PROFILE)} . }
      GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} { ${iri(identity.unit)} a rv:MatchUnit ;
        rv:resource ${iri(resource)} ; rv:variant ${iri(variant)} ;
        rv:revision ${iri(revision)} ; rv:projection ${iri(identity.anchor)} ;
        rv:language ${lit(language)} ; rv:field rv:Body ; rv:disclosure rv:Private ;
        rv:privateSearchBody ${lit(body)}@${language} . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(identity.receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
        rv:resource ${iri(resource)} ; rv:variant ${iri(variant)} ;
        rv:contentRevision ${iri(revision)} ; rv:projection ${iri(identity.anchor)} ;
        rv:matchUnit ${iri(identity.unit)} ; rv:ownerDataEpoch ${lit(source.position.dataEpoch)} ;
        rv:ownerSequence ${lit(source.position.sequence)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(identity.batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
        rv:eventCount 1 ; rv:event ${iri(identity.event)} .
        ${iri(identity.event)} a rv:ContentPrivateProjectionEvent ; rv:ordinal 0 ;
          rv:action "content.private-project" ; rv:receipt ${iri(identity.receipt)} ;
          rv:variant ${iri(variant)} ; rv:contentRevision ${iri(revision)} . }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(identity.state)} rv:privateSearchHead ?oldProjection . }
        GRAPH ${iri(GRAPHS.revisions)} { ?oldProjection rv:matchUnit ?oldUnit . }
        GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} { ?oldUnit ?oldPredicate ?oldValue . } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(identity.receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` });
  if (result.status !== 'committed' || result.position.dataEpoch !== env.lineage.dataEpoch) {
    throw new ContentPrivateProjectionUnavailable(`private Content projection ${result.status}`);
  }
  const proof = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?body ?digest ?revision WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(identity.state)} rv:privateSearchHead ${iri(identity.anchor)} ;
      rv:resource ${iri(resource)} ; rv:variant ${iri(variant)} . }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(identity.anchor)} rv:byteDigest ?digest ;
      rv:contentRevision ?revision ; rv:matchUnit ${iri(identity.unit)} . }
    GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} { ${iri(identity.unit)} a rv:MatchUnit ;
      rv:variant ${iri(variant)} ; rv:resource ${iri(resource)} ;
      rv:revision ${iri(revision)} ; rv:privateSearchBody ?body . }
  }`, 262_144);
  const rows = proof.results?.bindings ?? [];
  if (rows.length !== 1 || rows[0]?.body?.value !== body
    || rows[0].body['xml:lang'] !== language
    || rows[0]?.digest?.value !== exact.reference.byteDigest
    || rows[0]?.revision?.value !== revision) {
    throw new ContentPrivateProjectionUnavailable('private Content projection differs from source');
  }
  return { unit: identity.unit, body, language, byteDigest: exact.reference.byteDigest };
}
