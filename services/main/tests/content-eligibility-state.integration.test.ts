import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { FusekiClient, type CommandValidation } from '../src/infrastructure/fuseki.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../src/modules/work/activate.ts';
import { contentSearchEligibilityDecisionIri, contentSearchEligibilityDigest,
  contentSearchEligibilityReceiptIri, buildContentEligibilityUpdate,
  type ContentSearchEligibilityInput } from '../src/modules/content-publication/eligibility.ts';
import { buildPinnedContentPublicationUpdate, contentPublicationDecisionIri,
  contentPublicationDigest, contentPublicationReceiptIri, type PublishPinnedContentInput }
  from '../src/modules/content-publication/publish.ts';
import { readContentEligibilityStatesForVariants } from '../src/modules/content-publication/eligibility-state.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment }
  from '../src/modules/work/activate.ts';
import type { ExactContentReference, PublicationPreparation } from '../../content/src/core.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const root = resolve(import.meta.dir, '../../..');

function admission(input: { id: string; action: RegisteredAdmission['action']; scope: string;
  actingSubject: string; requestDigest: string }): RegisteredAdmission {
  return { ...input, principalId: randomUUID(), idempotencyKey: `native-${randomUUID()}`,
    authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'registered', dispatchEligible: true, replayed: false };
}

function validation(profileId: string, shape: string, focus: string, graph: string): CommandValidation {
  const profile = (profileRegistry as Record<string, { sha256: string; shapes: readonly string[] }>)[profileId];
  if (!profile?.shapes.includes(shape)) throw new Error(`generated profile ${profileId} lacks ${shape}`);
  return { profile: profileId, sha256: profile.sha256, shape, focus: [focus], graphs: [graph] };
}

async function graphSequence(fuseki: FusekiClient): Promise<string> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence }
  }`);
  const sequence = result.results?.bindings?.[0]?.sequence;
  expect(sequence).toMatchObject({ type: 'literal', datatype: XSD_INTEGER });
  if (!sequence || !/^(0|[1-9][0-9]*)$/.test(sequence.value)) {
    throw new Error('native Fuseki graph sequence is not a numeric RDF literal');
  }
  return sequence.value;
}

test('SEARCH19 native reader matches numeric snapshots and separate approval receipts', async () => {
  const { FUSEKI_URL, MAIN_DATA_EPOCH, MAIN_ROUTING_EPOCH } = process.env;
  if (!FUSEKI_URL || !MAIN_DATA_EPOCH || !MAIN_ROUTING_EPOCH) {
    throw new Error('Run this fixture through isolated Content projection QA');
  }

  const fuseki = new FusekiClient(FUSEKI_URL);
  const state = join(root, '.temp', `content-eligibility-state-${randomUUID()}`);
  const environment: WorkActivationEnvironment = { fuseki,
    lineage: { dataEpoch: MAIN_DATA_EPOCH, routingEpoch: MAIN_ROUTING_EPOCH },
    objectDirectory: join(state, 'objects') };
  mkdirSync(environment.objectDirectory, { recursive: true, mode: 0o700 });

  try {
    const title = `Native eligibility ${randomUUID()}`;
    const workIntent = { title, language: 'en' };
    const work = await activateMetadataWork(environment, { ...workIntent,
      admission: { id: randomUUID(), scope: 'work:create:root', action: 'work.create',
        idempotencyKey: `native-${randomUUID()}`,
        requestDigest: metadataWorkRequestDigest(title, [], 'en', {}, true),
        authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString() } });

    const variant = `urn:rezics:variant:${randomUUID()}`;
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const owner = { dataEpoch: randomUUID(), sequence: '8' };
    const revisionId = randomUUID();
    const byteDigest = 'a'.repeat(64);
    const preparationId = `preparation-${randomUUID()}`;
    const reference: ExactContentReference = { owner: 'content', resourceId: work.work, variantId: variant,
      revisionId, format: 'rezics-content-json-v1', model: 'content-shape-v1', byteDigest,
      byteLength: 1, language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      sourceRevision: null, predecessor: null, provenance: { kind: 'native-reader-fixture' } };
    const preparation: PublicationPreparation = { operationId: `prepare-${randomUUID()}`, reference,
      position: { owner: 'content', dataEpoch: owner.dataEpoch, sequence: owner.sequence },
      status: 'pending', pinActive: true, replayed: false };
    const publicationAdmissionId = randomUUID();
    const publicationInput: PublishPinnedContentInput = { resourceId: work.work, variantId: variant,
      preparationId, revisionId, expectedDigest: byteDigest, expectedContentEpoch: owner.dataEpoch,
      expectedPublicationHead: null };
    const publicationAdmission = admission({ id: publicationAdmissionId, action: 'content.publish',
      scope: `content:publish:${variant}`, actingSubject: actor,
      requestDigest: contentPublicationDigest(publicationInput) });
    const publication = contentPublicationDecisionIri(publicationAdmissionId);
    const publicationProfile = 'content-publication-v1';
    const publicationHealth = await fuseki.commandHealth();
    expect(publicationHealth.profiles[publicationProfile]).toBe(
      (profileRegistry as Record<string, { sha256: string }>)[publicationProfile]?.sha256);
    const publicationResult = await fuseki.commandWithReceipt({
      receipt: contentPublicationReceiptIri(publicationAdmissionId),
      digest: contentPublicationDigest(publicationInput),
      update: buildPinnedContentPublicationUpdate(environment, publicationAdmission,
        publicationInput, preparation),
      validations: [
        validation(publicationProfile,
          'https://rezics.com/definition/content-publication-v1/variant-shape', variant, GRAPHS.current),
        validation(publicationProfile,
          'https://rezics.com/definition/content-publication-v1/decision-shape', publication, GRAPHS.revisions),
      ],
      deadlineMs: 10_000,
    });
    expect(publicationResult.status).toBe('committed');

    const eligibilityInput: ContentSearchEligibilityInput = { resourceId: work.work, variantId: variant,
      publicationDecision: publication, expectedEligibilityHead: null, actingSubject: actor,
      rightsBasis: 'original-contribution', disclosure: 'public' };
    const eligibilityAdmissionId = randomUUID();
    const eligibilityAdmission = admission({ id: eligibilityAdmissionId,
      action: 'content.search-eligibility', scope: `content:search-eligibility:${variant}`,
      actingSubject: actor, requestDigest: contentSearchEligibilityDigest(eligibilityInput) });
    const eligibility = contentSearchEligibilityDecisionIri(eligibilityAdmissionId);
    const eligibilityProfile = 'content-search-eligibility-v1';
    const eligibilityHealth = await fuseki.commandHealth();
    expect(eligibilityHealth.profiles[eligibilityProfile]).toBe(
      (profileRegistry as Record<string, { sha256: string }>)[eligibilityProfile]?.sha256);
    const eligibilityResult = await fuseki.commandWithReceipt({
      receipt: contentSearchEligibilityReceiptIri(eligibilityAdmissionId),
      digest: contentSearchEligibilityDigest(eligibilityInput),
      update: buildContentEligibilityUpdate(environment, eligibilityAdmission, eligibilityInput),
      validations: [
        validation(publicationProfile,
          'https://rezics.com/definition/content-publication-v1/variant-shape', variant, GRAPHS.current),
        validation(eligibilityProfile,
          'https://rezics.com/definition/content-search-eligibility-v1/decision-shape', eligibility, GRAPHS.revisions),
      ],
      deadlineMs: 10_000,
    });
    expect(eligibilityResult.status).toBe('committed');

    let snapshotSequence = await graphSequence(fuseki);
    const state = (await readContentEligibilityStatesForVariants(environment, [variant], owner,
      { expectedGraphSequence: snapshotSequence }))[0];
    expect(state).toMatchObject({ kind: 'public-current', id: publication,
      eligibilityDecision: eligibility, rightsBasis: `${RV}OriginalContribution` });

    // A native second receipt with the publication proof fields must make the
    // publication ambiguous. Eligibility receipts carry publicationDecision too,
    // but do not carry contentPreparation and therefore cannot join this proof.
    const duplicatePublicationReceipt = `urn:rezics:receipt:${randomUUID()}`;
    const duplicateDigest = hash(`duplicate-publication-receipt:${duplicatePublicationReceipt}`);
    const duplicateAdmissionId = randomUUID();
    const batch = `urn:rezics:outbox:${randomUUID()}`;
    const duplicateReceiptUpdate = `PREFIX rv: <${RV}> DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
    } INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(duplicatePublicationReceipt)} a rv:OperationReceipt ;
        rv:outcome rv:Succeeded ; rv:requestDigest ${lit(duplicateDigest)} ;
        rv:admissionId ${lit(duplicateAdmissionId)} ; rv:authorityEpoch ${lit('1')} ;
        rv:admittedScope ${lit(`content:publish:${variant}`)} ;
        rv:contentPreparation ${lit(preparationId)} ; rv:publicationDecision ${iri(publication)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(MAIN_DATA_EPOCH)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(MAIN_DATA_EPOCH)} ; rv:sequence ?next ; rv:eventCount 0 . }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(MAIN_DATA_EPOCH)} ;
        rv:routingEpoch ${lit(MAIN_ROUTING_EPOCH)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(duplicatePublicationReceipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
    const duplicateResult = await fuseki.commandWithReceipt({ receipt: duplicatePublicationReceipt,
      digest: duplicateDigest, update: duplicateReceiptUpdate, validations: [], deadlineMs: 10_000 });
    expect(duplicateResult.status).toBe('committed');

    snapshotSequence = await graphSequence(fuseki);
    const duplicateState = (await readContentEligibilityStatesForVariants(environment, [variant], owner,
      { expectedGraphSequence: snapshotSequence }))[0];
    expect(duplicateState).toMatchObject({ kind: 'unresolved',
      reason: 'current publication owner proof is absent or mismatched' });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
