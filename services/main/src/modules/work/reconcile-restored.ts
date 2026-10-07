import { CATALOGUE_IMPORT_SCOPE, catalogueImportInput, catalogueImportDigest, catalogueImportIdentity, prepareCatalogueImport, type CatalogueImportInput } from './catalogue-import.ts';
export { reconcileRetainedSlimMetadata, SlimMetadataRestoreConflict } from './reconcile-slim-metadata.ts';
import { prepareRetainedClassification, retainedClassificationConcept, statementUpgradeMarker,
  STATEMENT_CONVERSION_COST } from '../statement/populated-conversion.ts';
import { canonicalLanguage } from '../display-language/select.ts';
import { languagePrior, readMainLanguageHeads } from './selection-heads.ts';
import { DAILY_CONTEXT_ID, DAILY_CONTEXT_PROFILE, DAILY_OBSERVATION_ID, DAILY_OBSERVATION_PROFILE,
  DAILY_CADENCE, ISO_CALENDAR, canonicalRatingTimeZone, dailyRatingSlotIri,
  retainedRatingPeriod, periodTriples, periodBinding } from '../rating/calendar.ts';
import { readRatingManifest } from '../rating/manifest.ts';
import { RELEASE_CONTEXT_ID, RELEASE_CONTEXT_PROFILE, RELEASE_OBSERVATION_ID, RELEASE_OBSERVATION_PROFILE,
  releaseContextTriples, releaseHeadGuard, releaseObservationTriples, releaseRatingContextDigest,
  releaseRatingDigest, releaseRatingSlotIri, releaseTargetPattern } from '../rating/release.ts';
import { EXPERIENCE_CONTEXT_ID, EXPERIENCE_CONTEXT_PROFILE, EXPERIENCE_CADENCE,
  EXPERIENCE_OBSERVATION_ID, EXPERIENCE_OBSERVATION_PROFILE,
  experienceRatingIdentity, validOccasion } from '../rating/experience.ts';
import type { Pool } from 'pg';
import { assertRetainedOrganizationModeration } from '../access/organization-moderation.ts';
import { ORGANIZATION_MODERATION_ACTION, type OrganizationPublicationTarget }
  from '../access/organization-publication.ts';
import { organizationPublicationGuard } from './organization-publication-evidence.ts';
import { profileValidations, type ProfileId } from '../../infrastructure/profile.ts';
import { CONTINUITY, DATASET, GRAPHS, PROFILE, RV, hash, iri, lit,
  prepareComponent, type WorkActivationEnvironment } from './activate.ts';

async function retainedCommand(env: WorkActivationEnvironment, update: string,
  receipt: { id: string; requestDigest: string }, profile: ProfileId | null,
  focuses: readonly { shape: string; focus: string }[] = [],
  binding?: Readonly<Record<string, string>>): Promise<void> {
  const validations = profile ? await profileValidations(env.fuseki, profile,
    focuses.map(entry => ({ shape: entry.shape, focus: [entry.focus],
      graphs: [GRAPHS.current, GRAPHS.revisions] })), binding) : [];
  const result = await env.fuseki.commandWithReceipt({ receipt: receipt.id,
    digest: receipt.requestDigest, update, validations, deadlineMs: 10_000 });
  if (result.status === 'invalid' || result.status === 'unknown-profile') {
    throw new Error(`retained command validation ${result.status}`);
  }
}
import { readComponentState, readMainPayloadForRevision, readWorkComponentState,
  readWorkPayloadForRevision, RevisionCorrupt } from './history.ts';
import { scalarRdfTerm, SCALAR_PREDICATE } from './scalar-value.ts';
import { metadataWorkEditDigest, readWorkEditTerminalReceipt,
  workEditReceiptIri, workScalarEditDigest } from './edit.ts';
import { readWorkTerminalReceipt, workReceiptIri } from './receipt.ts';
import { relayCoverage, relayRetainedEventAt, RelayCheckpointConflict,
  type MainCloudEvent, type RelayCoverage } from '../outbox/relay.ts';
import { CONTRIBUTION_PROFILE, readTextContributionReceipt,
  textContributionDigest, textContributionReceiptIri } from '../contribution/draft.ts';
import { readTextContributionEditReceipt, textContributionEditDigest,
  textContributionEditReceiptIri } from '../contribution/edit.ts';
import { PUBLICATION_PROFILE, readTextPublicationReceipt, textPublicationDigest,
  textPublicationReceiptIri } from '../contribution/publish.ts';
import { readExactContributionDraft } from '../contribution/history.ts';
import { retainedDocumentBody } from '../../../../content/src/document-body.ts';
import { PRIVATE_SEARCH_GRAPH, privateDraftTriples, privateDraftUnit } from '../contribution/private-projection.ts';
import { MAIN_SELECTION_PROFILE, PUBLIC_SEARCH_GRAPH, mainSelectionDigest,
  mainSelectionReceiptIri, readMainSelectionReceipt } from './select-main.ts';
import { MEMBERSHIP_POLICY, REVIEW_POLICY, SELECTION_POLICY, SPACE_REALM_PROFILE,
  SPACE_REALM_PROFILE_V1, SPACE_REALM_PROFILE_V2,
  readSpaceCreationReceipt, spaceCreationDigest, spaceCreationReceiptIri } from '../space/create.ts';
import { REALM_SELECTION_PROFILE, realmSelectionDigest, realmSelectionReceiptIri,
  realmSelectionSlotIri, readRealmSelectionReceipt } from './select-realm.ts';
import { REALM_REJECTION_PROFILE, realmRejectionDigest, realmRejectionReceiptIri,
  readRealmRejectionReceipt } from './reject-realm.ts';
import { CLASSIFICATION_CONTEXT_PROFILE, CLASSIFICATION_INHERIT_POLICY,
  CLASSIFICATION_ISOLATE_POLICY, GLOBAL_CLASSIFICATION_CONTEXT,
  classificationContextDigest, classificationContextReceiptIri,
  readClassificationContextReceipt } from '../classification/context.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE, classificationPropositionDigest,
  classificationPropositionReceiptIri, readClassificationPropositionReceipt,
  type PropositionDefinitions } from '../classification/proposition.ts';
import { VOCABULARY_PROFILE, VOCABULARY_REVISION_PROFILE, vocabularyDigest, classificationModelRevisions,
  type DefineVocabularyConceptInput } from '../classification/vocabulary.ts';
import { CLASSIFICATION_DIRECT_DECISION_PROFILE, classificationDecisionDigest,
  classificationDecisionReceiptIri, classificationDecisionSlotIri,
  readClassificationDecisionReceipt, type SetClassificationDecisionInput } from '../classification/decision.ts';
import { REALM_STANDING_RATING_CONTEXT_PROFILE, RATING_ACCOUNT_POPULATION,
  RATING_LATEST_MEAN_POLICY, RATING_STANDING_CADENCE, ratingContextDigest,
  ratingContextReceiptIri, readRatingContextReceipt } from '../rating/context.ts';
import { RATING_DEFAULT_POLICIES, RATING_DEFAULT_POLICY_PROFILE, ratingPolicyDigest,
  ratingPolicyReceiptIri, readRatingPolicyReceipt, type RatingDefaultPolicy } from '../rating/policy.ts';
import { readStandingRatingReceipt, standingRatingDigest, standingRatingReceiptIri,
  standingRatingSlotIri, STANDING_RATING_OBSERVATION_PROFILE,
  type SetStandingRatingInput } from '../rating/observation.ts';
import { readTranslationLinkTerminal, readTranslationLinks, translationLinkDigest,
  translationLinkReceiptIri, validateTranslationLink,
  type TranslationLinkInput } from './translation-links.ts';

export class RetainedEffectConflict extends Error {}

interface AccessEffectRow {
  action: string;
  state: string;
  scope_id: string;
  request_digest: string;
  authority_epoch: string;
  graph_receipt: string | null;
  graph_outcome: string | null;
  graph_data_epoch: string | null;
  graph_sequence: string | null;
}

function exactCoverage(left: RelayCoverage, right: RelayCoverage): boolean {
  return left.consumer === right.consumer && left.dataEpoch === right.dataEpoch
    && left.sequence === right.sequence && left.batchCount === right.batchCount
    && left.batchDigest === right.batchDigest && left.eventCount === right.eventCount
    && left.eventDigest === right.eventDigest;
}

export async function loadRetainedEvent(
  relayPool: Pool, coverage: RelayCoverage, sequence: string,
): Promise<{ eventId: string; envelope: MainCloudEvent }> {
  try {
    const { eventId, envelope } = await relayRetainedEventAt(relayPool, coverage, sequence);
    return { eventId, envelope };
  } catch (error) {
    if (error instanceof RelayCheckpointConflict) {
      throw new RetainedEffectConflict(error.message);
    }
    throw error;
  }
}

export async function reconciledCursor(env: WorkActivationEnvironment, marker: string): Promise<bigint | null> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?cursor WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true .
      ${iri(marker)} rv:reconciledPriorSequence ?cursor . }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !/^[0-9]+$/.test(rows[0]?.cursor?.value ?? '')) return null;
  return BigInt(rows[0]!.cursor!.value);
}

/** Rebuild a retained maintenance position with no event or Access admission. */
export async function reconcileRetainedEmptyBatch(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ batchId: string; replayed: boolean }> {
  if (!/^[0-9]+$/.test(sequence) || BigInt(sequence) < 1n
    || BigInt(sequence) > BigInt(coverage.sequence)) {
    throw new RetainedEffectConflict('invalid retained batch position');
  }
  const actualCoverage = await relayCoverage(relayPool, coverage.consumer);
  if (!exactCoverage(actualCoverage, coverage)) {
    throw new RetainedEffectConflict('retained relay coverage changed');
  }
  const retained = await relayPool.query<{ batch_id: string; routing_epoch: string; event_count: number }>(
    `SELECT batch_id, routing_epoch, event_count FROM relay.delivered_batch
     WHERE data_epoch = $1 AND sequence = $2`, [coverage.dataEpoch, sequence]);
  const batch = retained.rows[0];
  if (retained.rows.length !== 1 || !batch || batch.event_count !== 0 || !batch.routing_epoch) {
    throw new RetainedEffectConflict('retained zero-event header is unavailable');
  }
  iri(batch.batch_id);
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const readBatch = async () => {
      const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?batch ?count ?event WHERE {
        GRAPH ${iri(GRAPHS.outbox)} {
          ?batch a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount ?count .
          OPTIONAL { ?batch rv:event ?event }
        }
      }`);
      return result.results?.bindings ?? [];
    };
    const existing = await readBatch();
    let updateError: unknown;
    if (existing.length === 0) {
      const commandReceipt = `urn:rezics:receipt:retained-zero:${hash(batch.batch_id)}`;
      const commandDigest = hash(JSON.stringify({ family: 'retained-zero-batch-v1',
        batchId: batch.batch_id, dataEpoch: coverage.dataEpoch, sequence }));
      try { await env.fuseki.commandWithReceipt({ receipt: commandReceipt, digest: commandDigest,
        validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
        INSERT {
          GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch.batch_id)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} ; rv:eventCount 0 . }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(commandReceipt)} a rv:OperationReceipt ;
            rv:requestDigest ${lit(commandDigest)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
        }
        WHERE {
          GRAPH ${iri(GRAPHS.control)} {
            ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
              rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
            ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ; rv:priorSequence ?saved .
            OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
            BIND(COALESCE(?last, ?saved) AS ?previous)
            FILTER(?previous + 1 = ${sequence})
          }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
            ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch.batch_id)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(commandReceipt)} ?p ?o } }
        }` }); }
      catch (error) { updateError = error; }
    }
    const final = await readBatch();
    const cursor = await reconciledCursor(env, marker);
    if (final.length !== 1 || final[0]?.batch?.value !== batch.batch_id
      || final[0]?.count?.value !== '0' || final[0]?.event
      || cursor === null || cursor < BigInt(sequence)) {
      throw new RetainedEffectConflict(updateError
        ? 'retained batch update outcome is unknown' : 'retained zero-event batch did not reconcile');
    }
    await client.query('COMMIT');
    return { batchId: batch.batch_id, replayed: existing.length === 1 };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Reapply one previously committed Work edit while the restored graph remains held.
 * The current Access admission and immutable object bytes must have survived.
 */
export async function reconcileRetainedWorkEdit(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; revision: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.work.edited.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'work.edit' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.work || !receipt.workRevision
    || !receipt.expectedHead || !receipt.workManifest || receipt.reason
    || receipt.id !== workEditReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained Work edit envelope is incomplete');
  }
  for (const value of [eventId, data.batchId, receipt.id, receipt.operation,
    receipt.work, receipt.workRevision, receipt.expectedHead]) iri(value);
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.workManifest)) {
    throw new RetainedEffectConflict('retained Work manifest reference is invalid');
  }
  const payload = await readWorkPayloadForRevision(env, receipt.workManifest, receipt.work);
  if (receipt.requestDigest !== metadataWorkEditDigest(receipt.work, receipt.expectedHead, payload.title)
    && receipt.requestDigest !== workScalarEditDigest(receipt.work, receipt.expectedHead,
      payload.scalarValue)) {
    throw new RetainedEffectConflict('retained Work edit digest differs from its exact payload');
  }
  const scalarTerm = scalarRdfTerm(payload.scalarValue);
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow>(
      `SELECT action, state, scope_id, request_digest, authority_epoch,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'work.edit' || admitted.state !== 'sealed'
      || admitted.scope_id !== receipt.scope || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence) {
      throw new RetainedEffectConflict('current Access admission does not prove retained edit');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }
        GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.work)} rv:head ${iri(receipt.expectedHead)} ;
          rdfs:label ?oldTitle . ${iri(receipt.work)} <${SCALAR_PREDICATE}> ?oldScalar . }
      }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.work)} rv:head ${iri(receipt.workRevision)} ;
          rdfs:label ${lit(payload.title)}@${payload.language} .
          ${scalarTerm ? `${iri(receipt.work)} <${SCALAR_PREDICATE}> ${scalarTerm} .` : ''} }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(receipt.workRevision)} a rv:RevisionAnchor ; rv:component ${iri(receipt.work)} ;
            rv:predecessor ${iri(receipt.expectedHead)} ; rv:operation ${iri(receipt.operation)} ;
            rv:manifest ${iri(receipt.workManifest)} ; rv:modelRevision ${iri(PROFILE)} ;
            rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(receipt.operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ; rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:admittedScope ${lit(receipt.scope)} ;
            rv:outcome rv:Succeeded ; rv:work ${iri(receipt.work)} ;
            rv:workRevision ${iri(receipt.workRevision)} ; rv:expectedHead ${iri(receipt.expectedHead)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:WorkEditedEvent ; rv:ordinal 0 ; rv:action "work.edit" ;
            rv:receipt ${iri(receipt.id)} ; rv:operation ${iri(receipt.operation)} ;
            rv:work ${iri(receipt.work)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(receipt.work)} rv:head ${iri(receipt.expectedHead)} ;
            rv:mainVersion ${iri(payload.mainVersion)} ; rdfs:label ?oldTitle .
          OPTIONAL { ${iri(receipt.work)} <${SCALAR_PREDICATE}> ?oldScalar }
        }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt.workRevision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readWorkEditTerminalReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt, 'work-metadata-v1', [
        { shape: `${PROFILE}/work-shape`, focus: receipt.work },
      ]); }
      catch (error) { updateError = error; }
    }
    const terminal = await readWorkEditTerminalReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}>
      ASK {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt.workRevision)} a rv:RevisionAnchor ;
        rv:component ${iri(receipt.work)} ; rv:predecessor ${iri(receipt.expectedHead)} ;
        rv:operation ${iri(receipt.operation)} ; rv:manifest ${iri(receipt.workManifest)} ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} ;
        rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:WorkEditedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const currentCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}>
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> ASK {
          GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.work)} rv:head ${iri(receipt.workRevision)} ;
            rv:mainVersion ${iri(payload.mainVersion)} ; rdfs:label ${lit(payload.title)}@${payload.language} .
            ${scalarTerm ? `${iri(receipt.work)} <${SCALAR_PREDICATE}> ${scalarTerm} .` :
    `FILTER NOT EXISTS { ${iri(receipt.work)} <${SCALAR_PREDICATE}> ?scalar }`} }
        }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.work !== receipt.work || terminal.revision !== receipt.workRevision
      || terminal.predecessor !== receipt.expectedHead || terminal.dataEpoch !== coverage.dataEpoch
      || terminal.sequence !== sequence || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || currentCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained edit update outcome is unknown' : 'retained edit did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, revision: receipt.workRevision, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Reapply one committed metadata Work creation with its original public IDs. */
export async function reconcileRetainedWorkCreate(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; work: string; workRevision: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.work.created.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'work.create' || receipt.outcome !== 'succeeded'
    || !['work:create:root',CATALOGUE_IMPORT_SCOPE].includes(receipt.scope) || !receipt.operation || !receipt.work
    || !receipt.mainVersion || !receipt.workRevision || !receipt.mainRevision
    || !receipt.workManifest || !receipt.mainManifest || receipt.expectedHead || receipt.reason
    || receipt.id !== workReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained Work create envelope is incomplete');
  }
  for (const value of [eventId, data.batchId, receipt.id, receipt.operation, receipt.work,
    receipt.mainVersion, receipt.workRevision, receipt.mainRevision]) iri(value);
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.workManifest)
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.mainManifest)) {
    throw new RetainedEffectConflict('retained Work create manifest reference is invalid');
  }
  const payload = await readWorkPayloadForRevision(env, receipt.workManifest, receipt.work);
  await readMainPayloadForRevision(env, receipt.mainManifest,
    receipt.mainVersion, receipt.work);
  if (payload.mainVersion !== receipt.mainVersion) {
    throw new RetainedEffectConflict('retained Work and MainVersion payloads differ');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & {acting_subject: string;principal_id: string}>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject, principal_id,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'work.create' || admitted.state !== 'sealed'
      || admitted.scope_id !== receipt.scope || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence) {
      throw new RetainedEffectConflict('current Access admission does not prove retained create');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    let update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(receipt.work)} a schema:CreativeWork${payload.semanticTypes.map(type => `, <${type}>`).join('')} ;
            rv:mainVersion ${iri(receipt.mainVersion)} ;
            rv:continuityProfile ${iri(CONTINUITY)} ; rdfs:label ${lit(payload.title)}@${payload.language} ;
            rv:head ${iri(receipt.workRevision)} .
          ${iri(receipt.mainVersion)} a rv:MainVersion ; rv:work ${iri(receipt.work)} ;
            rv:hostingPolicy rv:MetadataOnly ; rv:head ${iri(receipt.mainRevision)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(receipt.workRevision)} a rv:RevisionAnchor ; rv:component ${iri(receipt.work)} ;
            rv:operation ${iri(receipt.operation)} ; rv:manifest ${iri(receipt.workManifest)} ;
            rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
          ${iri(receipt.mainRevision)} a rv:RevisionAnchor ; rv:component ${iri(receipt.mainVersion)} ;
            rv:operation ${iri(receipt.operation)} ; rv:manifest ${iri(receipt.mainManifest)} ;
            rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(receipt.operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ; rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:admittedScope ${lit(receipt.scope)} ;
            rv:outcome rv:Succeeded ; rv:work ${iri(receipt.work)} ;
            rv:mainVersion ${iri(receipt.mainVersion)} ; rv:workRevision ${iri(receipt.workRevision)} ;
            rv:mainRevision ${iri(receipt.mainRevision)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:WorkCreatedEvent ; rv:ordinal 0 ; rv:action "work.create" ;
            rv:receipt ${iri(receipt.id)} ; rv:operation ${iri(receipt.operation)} ;
            rv:work ${iri(receipt.work)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.work)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.mainVersion)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt.workRevision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt.mainRevision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    let catalogue: Awaited<ReturnType<typeof prepareCatalogueImport>>|null = null;
    if (receipt.scope === CATALOGUE_IMPORT_SCOPE) {
      const raw = await readWorkComponentState(env,receipt.workManifest,receipt.work);
      const original = Object.fromEntries(Object.keys(catalogueImportInput.properties)
        .filter(key => key in raw).map(key => [key,raw[key]])) as CatalogueImportInput;
      const retainedRows = raw.classifications as {sense?: string;expectedSenseHead?: string;outcome: 'accepted'|'rejected'}[];
      const legacy = retainedRows.some(row => 'sense' in row);
      const input = legacy ? {...original,classifications: []} : original;
      const digest = legacy ? hash(JSON.stringify({family: 'work-catalogue-import-v1',actingSubject: admitted.acting_subject,input: original}))
        : catalogueImportDigest(input,admitted.acting_subject);
      if (digest !== receipt.requestDigest)
        throw new RetainedEffectConflict('Retained catalogue request digest differs');
      const heads = new Map(Object.entries(raw.creditHeads && typeof raw.creditHeads === 'object'
        ? raw.creditHeads as Record<string,string> : {}));
      for (const credit of input.credits) if (credit.expectedAgentHead) heads.set(credit.agent,credit.expectedAgentHead);
      if (input.credits.some(credit => !heads.has(credit.agent)))
        throw new RetainedEffectConflict('Retained catalogue attribution is incomplete');
      catalogue = await prepareCatalogueImport({...env,lineage: {...env.lineage,dataEpoch: coverage.dataEpoch}},
        {id: receipt.admissionId,principalId: admitted.principal_id,actingSubject: admitted.acting_subject,
          scope: receipt.scope,action: 'work.create',idempotencyKey: receipt.admissionId,requestDigest: receipt.requestDigest,
          authorityEpoch: receipt.authorityEpoch,registeredAt: new Date(0).toISOString(),
          expiresAt: new Date(8640000000000000).toISOString(),state: 'sealed',dispatchEligible: false,replayed: true},
        input,[],heads);
      if (legacy) {
        if (retainedRows.length > 8) throw new RetainedEffectConflict('Retained catalogue classification bound exceeded');
        for (const [index,row] of retainedRows.entries()) {
          if (!row.sense || !row.expectedSenseHead || !['accepted','rejected'].includes(row.outcome))
            throw new RetainedEffectConflict('Retained catalogue exact definition is unavailable');
          const application = catalogueImportIdentity(receipt.admissionId,`application:${index}`);
          const decision = catalogueImportIdentity(receipt.admissionId,`decision:${index}`);
          const slot = classificationDecisionSlotIri(receipt.mainVersion,row.sense,GLOBAL_CLASSIFICATION_CONTEXT);
          const state = {work: receipt.work,mainVersion: receipt.mainVersion,sense: row.sense,
            senseRevision: row.expectedSenseHead,context: GLOBAL_CLASSIFICATION_CONTEXT,
            proposer: admitted.acting_subject,decider: admitted.acting_subject,outcome: row.outcome,
            application,decision,slot,predecessor: null,policy: CLASSIFICATION_DIRECT_DECISION_PROFILE};
          const manifest = 'urn:rezics:sha256:'+prepareComponent(env.objectDirectory,application,state,CLASSIFICATION_DIRECT_DECISION_PROFILE);
          const concept = await retainedClassificationConcept(env,state);
          const converted = await prepareRetainedClassification(env,{application,decision,manifest,
            main: receipt.mainVersion,concept,context: GLOBAL_CLASSIFICATION_CONTEXT,proposer: admitted.acting_subject,
            decidedBy: admitted.acting_subject,outcome: row.outcome,contextRevision: null,
            operation: receipt.operation,dataEpoch: coverage.dataEpoch,sequence});
          catalogue.validations.push(...converted.validations);
          catalogue.update = catalogue.update
            .replace('GRAPH '+iri(GRAPHS.current)+' {','GRAPH '+iri(GRAPHS.current)+' { '+converted.current)
            .replace('GRAPH '+iri(GRAPHS.revisions)+' {','GRAPH '+iri(GRAPHS.revisions)+' { '+converted.revisions+
              ` ${iri(decision)} a rv:ClassificationDecision,rv:RevisionAnchor ; rv:component ${iri(application)} ;
                rv:application ${iri(application)} ; rv:decisionBasis rv:GlobalCuratorReview ;
                rv:decisionPolicy ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
                rv:modelRevision ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
                rv:shapeRevision ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
                rv:manifest ${iri(manifest)} ; rv:operation ${iri(receipt.operation)} ;
                rv:outcome rv:${row.outcome === 'accepted' ? 'Accepted' : 'Rejected'} ;
                rv:decidedBy ${iri(admitted.acting_subject)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ?next .`);
        }
        // Re-encoding a historical input as the new contract must not replace
        // the retained Work's manifest or its recorded request digest.
        const revisionStart = catalogue.update.indexOf(iri(receipt.workRevision)+' a rv:RevisionAnchor');
        const manifestStart = catalogue.update.indexOf('rv:manifest ',revisionStart)+12;
        const manifestEnd = catalogue.update.indexOf('>',manifestStart)+1;
        if (revisionStart < 0 || manifestStart < 12 || manifestEnd <= manifestStart)
          throw new RetainedEffectConflict('Retained catalogue Work manifest anchor is unavailable');
        catalogue.update = catalogue.update.slice(0,manifestStart)+iri(receipt.workManifest)+catalogue.update.slice(manifestEnd);
      }
      const whereAt = catalogue.update.lastIndexOf('} WHERE {');
      const guardsAt = catalogue.update.indexOf('FILTER NOT EXISTS { GRAPH '+iri(GRAPHS.current),whereAt);
      if (whereAt < 0 || guardsAt < 0) throw new RetainedEffectConflict('Catalogue recovery template is incomplete');
      const originalWhereAt = update.lastIndexOf('WHERE {');
      if (originalWhereAt < 0) throw new RetainedEffectConflict('Catalogue recovery template is unavailable');
      const oldWhere = update.slice(originalWhereAt+7,-1);
      if (!oldWhere.includes('rv:restoreHold true')) throw new RetainedEffectConflict('Catalogue recovery fence is absent');
      const prefix = catalogue.update.slice(0,whereAt)
        .replace('DELETE { GRAPH '+iri(GRAPHS.control)+' { '+iri(DATASET)+' rv:sequence ?n } }',
          'DELETE { GRAPH '+iri(GRAPHS.control)+' { '+iri(marker)+' rv:reconciledPriorSequence ?last } }')
        .replace('GRAPH '+iri(GRAPHS.control)+' { '+iri(DATASET)+' rv:sequence ?next }',
          'GRAPH '+iri(GRAPHS.control)+' { '+iri(marker)+' rv:reconciledPriorSequence '+sequence+' }');
      update = prefix+'} WHERE { '+oldWhere+' BIND('+sequence+' AS ?next) '+catalogue.update.slice(guardsAt);
    }
    const existing = await readWorkTerminalReceipt(env.fuseki, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { if (catalogue) {
        const result = await env.fuseki.commandWithReceipt({receipt: receipt.id,digest: receipt.requestDigest,
          update,validations: catalogue.validations,deadlineMs: 10_000});
        if (result.status === 'invalid' || result.status === 'unknown-profile')
          throw new RetainedEffectConflict('Retained catalogue validation failed',{cause: new Error(JSON.stringify(result))});
      }
        else await retainedCommand(env, update, receipt, 'work-metadata-v1', [
        { shape: `${PROFILE}/work-shape`, focus: receipt.work },
        { shape: `${PROFILE}/main-version-shape`, focus: receipt.mainVersion },
      ]); }
      catch (error) { updateError = error; }
    }
    const terminal = await readWorkTerminalReceipt(env.fuseki, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(receipt.work)} a schema:CreativeWork ; rv:mainVersion ${iri(receipt.mainVersion)} .
        ${iri(receipt.mainVersion)} a rv:MainVersion ; rv:work ${iri(receipt.work)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(receipt.workRevision)} rv:manifest ${iri(receipt.workManifest)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        ${iri(receipt.mainRevision)} rv:manifest ${iri(receipt.mainManifest)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} ;
        rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:WorkCreatedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const currentCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}>
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> ASK {
          GRAPH ${iri(GRAPHS.current)} {
            ${iri(receipt.work)} rdfs:label ${lit(payload.title)}@${payload.language} ;
              rv:head ${iri(receipt.workRevision)} .
            ${iri(receipt.mainVersion)} rv:head ${iri(receipt.mainRevision)} . }
        }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.work !== receipt.work || terminal.mainVersion !== receipt.mainVersion
      || terminal.workRevision !== receipt.workRevision || terminal.mainRevision !== receipt.mainRevision
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || currentCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained create update outcome is unknown' : 'retained create did not reconcile',
      {cause: updateError});
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, work: receipt.work, workRevision: receipt.workRevision,
      replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Reapply one Space and distinct Realm capability with their original identities. */
export async function reconcileRetainedClassificationContext(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; context: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.classification.context-created.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'classification.context.configure' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.realm || !receipt.classificationContext
    || !receipt.contextRevision || !receipt.contextManifest
    || receipt.scope !== `classification:context:${receipt.realm}`
    || receipt.work || receipt.mainVersion || receipt.space || receipt.selection || receipt.reason
    || receipt.id !== classificationContextReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained classification context envelope is incomplete');
  }
  const realm = receipt.realm;
  const context = receipt.classificationContext;
  const revision = receipt.contextRevision;
  const operation = receipt.operation;
  for (const value of [eventId, data.batchId, receipt.id, realm, context, revision,
    operation]) iri(value);
  if (realm === context || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.contextManifest)) {
    throw new RetainedEffectConflict('retained classification context references are invalid');
  }
  const state = readComponentState(env.objectDirectory, receipt.contextManifest,
    context, CLASSIFICATION_CONTEXT_PROFILE);
  if (state.realm !== realm || state.role !== 'realm-classification' || state.state !== 'active'
    || state.fallbackContext !== GLOBAL_CLASSIFICATION_CONTEXT
    || state.inheritancePolicy !== CLASSIFICATION_INHERIT_POLICY) {
    throw new RetainedEffectConflict('retained classification context payload differs');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'classification.context.configure'
      || admitted.state !== 'sealed' || admitted.scope_id !== receipt.scope
      || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || classificationContextDigest({ realm, actingSubject: admitted.acting_subject })
        !== receipt.requestDigest) {
      throw new RetainedEffectConflict('current Access admission does not prove retained context');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
            rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
            rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
          ${iri(realm)} rv:classificationContext ${iri(context)} .
          ${iri(context)} a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ;
            rv:contextState rv:Active ; rv:realm ${iri(realm)} ;
            rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
            rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
            rv:head ${iri(revision)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(context)} ;
            rv:operation ${iri(operation)} ; rv:manifest ${iri(receipt.contextManifest)} ;
            rv:modelRevision ${iri(CLASSIFICATION_CONTEXT_PROFILE)} ;
            rv:shapeRevision ${iri(CLASSIFICATION_CONTEXT_PROFILE)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
            rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Succeeded ;
            rv:classificationContext ${iri(context)} ; rv:realm ${iri(realm)} ;
            rv:contextRevision ${iri(revision)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:ClassificationContextCreatedEvent ; rv:ordinal 0 ;
            rv:action "classification.context.configure" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(operation)} ; rv:realm ${iri(realm)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a rv:Realm ; rv:realmState rv:Active . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ${iri(realm)} rv:classificationContext ?priorContext } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(context)} ?p ?o } }
        FILTER (!EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ?globalPredicate ?globalValue } }
          || EXISTS { GRAPH ${iri(GRAPHS.current)} {
            ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
              rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
              rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} . } })
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?fallback } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?globalRealm } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readClassificationContextReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt, 'classification-context-v1', [
        { shape: `${CLASSIFICATION_CONTEXT_PROFILE}/global-shape`, focus: GLOBAL_CLASSIFICATION_CONTEXT },
        { shape: `${CLASSIFICATION_CONTEXT_PROFILE}/realm-shape`, focus: realm },
        { shape: `${CLASSIFICATION_CONTEXT_PROFILE}/context-shape`, focus: context },
      ], { realm, context }); }
      catch (error) { updateError = error; }
    }
    const terminal = await readClassificationContextReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
          rv:contextRole rv:GlobalClassification ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
        ${iri(realm)} a rv:Realm ; rv:classificationContext ${iri(context)} .
        ${iri(context)} a rv:ClassificationContext ; rv:realm ${iri(realm)} ;
          rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ;
        rv:component ${iri(context)} ; rv:manifest ${iri(receipt.contextManifest)} ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:ClassificationContextCreatedEvent ; rv:receipt ${iri(receipt.id)} . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?fallback } }
    }`);
    const headCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
          ${iri(context)} rv:head ${iri(revision)} . } }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.context !== context || terminal.realm !== realm || terminal.revision !== revision
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || headCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained classification context update outcome is unknown'
        : 'retained classification context did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, context, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally { client.release(); }
}

/** Reapply one Realm standing question from its sealed admission and immutable bytes. */
export async function reconcileRetainedRatingContext(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; context: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.rating.context-created.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'rating.context.create' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.realm || !receipt.ratingContext
    || !receipt.ratingContextRevision || !receipt.ratingContextManifest
    || receipt.scope !== `rating:context:${receipt.realm}`
    || receipt.work || receipt.mainVersion || receipt.space || receipt.selection || receipt.reason
    || receipt.id !== ratingContextReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained rating context envelope is incomplete');
  }
  const realm = receipt.realm;
  const context = receipt.ratingContext;
  const revision = receipt.ratingContextRevision;
  const operation = receipt.operation;
  for (const value of [eventId, data.batchId, receipt.id, realm, context, revision,
    operation]) iri(value);
  if (realm === context
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.ratingContextManifest)) {
    throw new RetainedEffectConflict('retained rating context references are invalid');
  }
  const releaseState = retainedReleaseState(env.objectDirectory, receipt.ratingContextManifest,
    context, RELEASE_CONTEXT_PROFILE);
  if (releaseState) {
    return reconcileRetainedReleaseRatingContext(env, accessPool, coverage, sequence,
      { eventId, batchId: data.batchId, receipt, state: releaseState });
  }
  const { state, daily, experience } = readRatingManifest(env.objectDirectory, receipt.ratingContextManifest,
    context, 'context');
  const profile = experience ? EXPERIENCE_CONTEXT_PROFILE : daily ? DAILY_CONTEXT_PROFILE : REALM_STANDING_RATING_CONTEXT_PROFILE;
  const cadence = experience ? EXPERIENCE_CADENCE : daily ? DAILY_CADENCE : RATING_STANDING_CADENCE;
  const timeZone = daily && typeof state.timeZone === 'string' ? canonicalRatingTimeZone(state.timeZone) : undefined;
  if (daily && (!timeZone || state.timeZone !== timeZone || state.calendar !== 'iso8601')) {
    throw new RetainedEffectConflict('retained daily Context policy differs');
  }
  const question = state.question;
  if (state.context !== context || state.realm !== realm || state.state !== 'active'
    || typeof question !== 'string' || state.targetGrain !== 'MainVersion'
    || state.scaleMin !== 1 || state.scaleMax !== 10
    || state.cadence !== cadence
    || state.populationPolicy !== RATING_ACCOUNT_POPULATION
    || state.aggregationPolicy !== RATING_LATEST_MEAN_POLICY) {
    throw new RetainedEffectConflict('retained rating context payload differs');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'rating.context.create'
      || admitted.state !== 'sealed' || admitted.scope_id !== receipt.scope
      || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || ratingContextDigest({ realm, question, actingSubject: admitted.acting_subject,
        ...(experience ? { cadence: 'experience' as const } : {}),
        ...(timeZone ? { timeZone } : {}) })
        !== receipt.requestDigest) {
      throw new RetainedEffectConflict('current Access admission does not prove retained rating context');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(realm)} rv:ratingContext ${iri(context)} .
          ${iri(context)} a rv:RatingContext ${experience ? ', rv:ExperienceRatingContext' : daily ? ', rv:DailyRatingContext' : ''} ;
            ${timeZone ? `rv:ratingTimeZone ${lit(timeZone)} ; rv:ratingCalendar ${iri(ISO_CALENDAR)} ;` : ''}
            rv:contextState rv:Active ;
            rv:realm ${iri(realm)} ; rv:question ${lit(question)}@en ;
            rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
            rv:ratingCadence ${iri(cadence)} ;
            rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
            rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ;
            rv:head ${iri(revision)} ; rv:ratingPolicyHead ${iri(revision)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(context)} ;
            rv:operation ${iri(operation)} ; rv:manifest ${iri(receipt.ratingContextManifest)} ;
            rv:modelRevision ${iri(profile)} ;
            rv:shapeRevision ${iri(profile)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
            rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Succeeded ;
            rv:ratingContext ${iri(context)} ; rv:realm ${iri(realm)} ;
            rv:ratingContextRevision ${iri(revision)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:RatingContextCreatedEvent ; rv:ordinal 0 ;
            rv:action "rating.context.create" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(operation)} ; rv:realm ${iri(realm)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
          ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(context)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readRatingContextReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt, experience ? EXPERIENCE_CONTEXT_ID : daily ? DAILY_CONTEXT_ID : 'realm-standing-rating-context-v1', [
        { shape: `${profile}/realm-shape`, focus: realm },
        { shape: `${profile}/context-shape`, focus: context },
      ], { realm, context, question, ...(timeZone ? { timeZone } : {}) }); }
      catch (error) { updateError = error; }
    }
    const terminal = await readRatingContextReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(realm)} a rv:Realm ; rv:ratingContext ${iri(context)} .
        ${iri(context)} a rv:RatingContext ; rv:realm ${iri(realm)} ;
          rv:question ${lit(question)}@en ; rv:head ${iri(revision)} ;
          rv:ratingPolicyHead ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ;
        rv:component ${iri(context)} ; rv:manifest ${iri(receipt.ratingContextManifest)} ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
        rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:RatingContextCreatedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.context !== context || terminal.realm !== realm || terminal.revision !== revision
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence) || graphCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained rating context update outcome is unknown'
        : 'retained rating context did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, context, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally { client.release(); }
}

/** Replay one sealed default change without touching the question or observations. */
export async function reconcileRetainedRatingPolicy(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; policyRevision: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data, receipt = data?.receipt;
  const selected = Object.entries(RATING_DEFAULT_POLICIES).find(([, value]) =>
    value === receipt?.ratingPolicy)?.[0] as RatingDefaultPolicy | undefined;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.rating.policy-changed.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'rating.context.policy.set' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.realm || !receipt.ratingContext
    || !receipt.ratingContextRevision || !receipt.ratingPolicyRevision
    || !receipt.ratingPolicyManifest || !receipt.ratingPolicyPredecessor || !selected
    || receipt.scope !== `rating:policy:${receipt.ratingContext}`
    || receipt.id !== ratingPolicyReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained Rating policy envelope is incomplete');
  }
  const context = receipt.ratingContext, realm = receipt.realm;
  const contextRevision = receipt.ratingContextRevision;
  const revision = receipt.ratingPolicyRevision, predecessor = receipt.ratingPolicyPredecessor;
  const operation = receipt.operation;
  for (const value of [eventId, data.batchId, receipt.id, context, realm,
    contextRevision, revision, predecessor, operation]) iri(value);
  if (context === realm || revision === predecessor
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.ratingPolicyManifest)) {
    throw new RetainedEffectConflict('retained Rating policy references are invalid');
  }
  const state = readComponentState(env.objectDirectory, receipt.ratingPolicyManifest,
    context, RATING_DEFAULT_POLICY_PROFILE);
  if (state.context !== context || state.realm !== realm || state.contextRevision !== contextRevision
    || state.revision !== revision || state.predecessor !== predecessor
    || state.aggregationPolicy !== selected || typeof state.question !== 'string'
    || state.question.length < 3) {
    throw new RetainedEffectConflict('retained Rating policy bytes differ');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    const witness = await client.query<{ realm: string; revision: string }>(
      'SELECT realm, revision FROM access.rating_aggregate_context WHERE context = $1', [context]);
    if (!admitted || admitted.action !== 'rating.context.policy.set'
      || admitted.state !== 'sealed' || admitted.scope_id !== receipt.scope
      || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || witness.rows.length !== 1 || witness.rows[0]?.realm !== realm
      || witness.rows[0]?.revision !== contextRevision
      || ratingPolicyDigest({ context, expectedPolicyHead: predecessor,
        aggregationPolicy: selected, actingSubject: admitted.acting_subject }) !== receipt.requestDigest) {
      throw new RetainedEffectConflict('Access does not prove retained Rating policy');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }
        GRAPH ${iri(GRAPHS.current)} { ${iri(context)} rv:ratingPolicyHead ${iri(predecessor)} } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} { ${iri(context)} rv:ratingPolicyHead ${iri(revision)} }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RatingPolicyRevision, rv:RevisionAnchor ;
          rv:component ${iri(context)} ; rv:contextRevision ${iri(contextRevision)} ;
          rv:predecessor ${iri(predecessor)} ; rv:ratingAggregationPolicy ${iri(RATING_DEFAULT_POLICIES[selected])} ;
          rv:operation ${iri(operation)} ; rv:manifest ${iri(receipt.ratingPolicyManifest)} ;
          rv:modelRevision ${iri(RATING_DEFAULT_POLICY_PROFILE)} ;
          rv:shapeRevision ${iri(RATING_DEFAULT_POLICY_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} a rv:OperationReceipt ;
          rv:operation ${iri(operation)} ; rv:requestDigest ${lit(receipt.requestDigest)} ;
          rv:admissionId ${lit(receipt.admissionId)} ; rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
          rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Succeeded ;
          rv:ratingContext ${iri(context)} ; rv:realm ${iri(realm)} ;
          rv:ratingContextRevision ${iri(contextRevision)} ;
          rv:ratingPolicyRevision ${iri(revision)} ; rv:predecessor ${iri(predecessor)} ;
          rv:ratingAggregationPolicy ${iri(RATING_DEFAULT_POLICIES[selected])} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} ;
          rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:RatingPolicyChangedEvent ; rv:ordinal 0 ;
          rv:action "rating.context.policy.set" ; rv:receipt ${iri(receipt.id)} ;
          rv:operation ${iri(operation)} ; rv:ratingContext ${iri(context)} . }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
          rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ; rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} { ${iri(context)} a rv:RatingContext, rv:ExperienceRatingContext ;
          rv:realm ${iri(realm)} ; rv:head ${iri(contextRevision)} ;
          rv:ratingPolicyHead ${iri(predecessor)} . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readRatingPolicyReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try {
        const graphs = [GRAPHS.current, GRAPHS.revisions];
        const validations = [
          ...await profileValidations(env.fuseki, EXPERIENCE_CONTEXT_ID, [
            { shape: `${EXPERIENCE_CONTEXT_PROFILE}/realm-shape`, focus: [realm], graphs },
            { shape: `${EXPERIENCE_CONTEXT_PROFILE}/context-shape`, focus: [context], graphs },
          ], { realm, context, question: state.question }),
          ...await profileValidations(env.fuseki, 'rating-aggregate-default-policy-v1', [
            { shape: `${RATING_DEFAULT_POLICY_PROFILE}/context-shape`, focus: [context], graphs },
            { shape: `${RATING_DEFAULT_POLICY_PROFILE}/revision-shape`, focus: [revision], graphs },
          ], { context, revision, contextRevision, predecessor, aggregationPolicy: selected }),
        ];
        const result = await env.fuseki.commandWithReceipt({ receipt: receipt.id,
          digest: receipt.requestDigest, update, validations, deadlineMs: 10_000 });
        if (result.status === 'invalid' || result.status === 'unknown-profile') {
          throw new Error(`retained policy validation ${result.status}`);
        }
      } catch (error) { updateError = error; }
    }
    const terminal = await readRatingPolicyReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RatingPolicyRevision, rv:RevisionAnchor ;
        rv:component ${iri(context)} ; rv:contextRevision ${iri(contextRevision)} ;
        rv:predecessor ${iri(predecessor)} ; rv:manifest ${iri(receipt.ratingPolicyManifest)} ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
        rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:RatingPolicyChangedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest || terminal.admissionId !== receipt.admissionId
      || terminal.context !== context || terminal.realm !== realm
      || terminal.contextRevision !== contextRevision || terminal.policyRevision !== revision
      || terminal.predecessor !== predecessor || terminal.aggregationPolicy !== selected
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence) || graphCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained Rating policy update outcome is unknown' : 'retained Rating policy did not reconcile');
    }
    if (cursor === BigInt(sequence)) {
      const head = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.current)} { ${iri(context)} rv:ratingPolicyHead ${iri(revision)} . }
      }`);
      if (head.boolean !== true) throw new RetainedEffectConflict('retained Rating policy head differs');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, policyRevision: revision, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve failure */ }
    throw error;
  } finally { client.release(); }
}

/** Replay one standing opinion revision from its sealed principal and exact immutable bytes. */
export async function reconcileRetainedStandingRating(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; observation: string; revision: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.rating.observation-changed.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'rating.observation.set' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.realm || !receipt.ratingContext
    || !receipt.contextRevision || !receipt.work || !receipt.mainVersion
    || !receipt.ratingSlot || !receipt.ratingObservation || !receipt.observationRevision
    || !receipt.observationManifest
    || !['available', 'withdrawn'].includes(receipt.ratingAvailability ?? '')
    || (receipt.ratingAvailability === 'available'
      && (receipt.ratingValue === undefined || !Number.isInteger(receipt.ratingValue)
        || receipt.ratingValue < 1 || receipt.ratingValue > 10))
    || (receipt.ratingAvailability === 'withdrawn' && receipt.ratingValue !== undefined)
    || receipt.scope !== `rating:observe:${receipt.ratingContext}`
    || receipt.id !== standingRatingReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained standing rating envelope is incomplete');
  }
  const context = receipt.ratingContext;
  const observation = receipt.ratingObservation;
  const revision = receipt.observationRevision;
  const predecessor = receipt.expectedHead ?? null;
  for (const value of [eventId, data.batchId, receipt.id, receipt.operation,
    receipt.realm, context, receipt.contextRevision, receipt.work,
    receipt.mainVersion, receipt.ratingSlot, observation, revision,
    ...(predecessor ? [predecessor] : [])]) iri(value);
  if (!/^urn:rezics:rating-slot:[0-9a-f]{64}$/.test(receipt.ratingSlot)
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.observationManifest)) {
    throw new RetainedEffectConflict('retained standing rating references are invalid');
  }
  const releaseState = retainedReleaseState(env.objectDirectory, receipt.observationManifest,
    observation, RELEASE_OBSERVATION_PROFILE);
  if (releaseState) {
    return reconcileRetainedReleaseRating(env, accessPool, coverage, sequence,
      { eventId, batchId: data.batchId, receipt, state: releaseState });
  }
  const { state, daily, experience } = readRatingManifest(env.objectDirectory, receipt.observationManifest,
    observation, 'observation');
  const profile = experience ? EXPERIENCE_OBSERVATION_PROFILE : daily ? DAILY_OBSERVATION_PROFILE : STANDING_RATING_OBSERVATION_PROFILE;
  const occasion = experience && validOccasion(state.occasion) ? state.occasion : undefined;
  if (experience && (!occasion || typeof state.occasionKey !== 'string')) {
    throw new RetainedEffectConflict('retained experience occasion is incomplete');
  }
  const period = daily ? retainedRatingPeriod(state) : undefined;
  const timestamp = (value: unknown): value is string => typeof value === 'string'
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
  if (state.observation !== observation || state.slot !== receipt.ratingSlot
    || state.context !== context || state.contextRevision !== receipt.contextRevision
    || state.realm !== receipt.realm || state.work !== receipt.work
    || state.mainVersion !== receipt.mainVersion || state.revision !== revision
    || state.predecessor !== predecessor
    || state.availability !== receipt.ratingAvailability
    || state.value !== (receipt.ratingAvailability === 'available'
      ? receipt.ratingValue : null)
    || !timestamp(state.evaluatedAt) || !timestamp(state.submittedAt)
    || !timestamp(state.originalSubmissionAt) || !timestamp(state.revisedAt)
    || state.submittedAt !== state.revisedAt
    || (predecessor === null && (state.evaluatedAt !== state.submittedAt
      || state.originalSubmissionAt !== state.submittedAt))) {
    throw new RetainedEffectConflict('retained standing rating payload differs');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string;
      principal_id: string; registered_at: Date }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch,
         acting_subject, principal_id, registered_at, graph_receipt, graph_outcome, graph_data_epoch,
         graph_sequence FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    const input: SetStandingRatingInput = { context, work: receipt.work,
      mainVersion: receipt.mainVersion, expectedRevisionHead: predecessor,
      value: receipt.ratingAvailability === 'available' ? receipt.ratingValue! : null,
      actingSubject: admitted?.acting_subject ?? '', ...(occasion ? { occasion } : {}) };
    const identity = admitted && occasion
      ? experienceRatingIdentity(admitted.principal_id, context, receipt.mainVersion, occasion) : undefined;
    if (!admitted || admitted.action !== 'rating.observation.set'
      || admitted.state !== 'sealed' || admitted.scope_id !== receipt.scope
      || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || (identity ? identity.slot : period ? dailyRatingSlotIri(admitted.principal_id, context, receipt.mainVersion, period.day)
        : standingRatingSlotIri(admitted.principal_id, context, receipt.mainVersion)) !== receipt.ratingSlot
      || (identity && identity.occasionKey !== state.occasionKey)
      || ((daily || experience) && admitted.registered_at.toISOString() !== state.submittedAt)
      || standingRatingDigest(input, daily) !== receipt.requestDigest) {
      throw new RetainedEffectConflict('current Access admission does not prove retained rating');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const priorGuard = predecessor
      ? `GRAPH ${iri(GRAPHS.current)} {
           ${iri(observation)} a rv:RatingObservation ;
             rv:ratingSlot ${iri(receipt.ratingSlot)} ; rv:ratingContext ${iri(context)} ;
             rv:targetMainVersion ${iri(receipt.mainVersion)} ;
             rv:observationHead ${iri(predecessor)} . }
         GRAPH ${iri(GRAPHS.revisions)} { ${iri(predecessor)}
           a rv:RatingObservationRevision, rv:RevisionAnchor ;
           rv:component ${iri(observation)} ;
           rv:evaluatedAt ${lit(state.evaluatedAt)}^^xsd:dateTime ;
           rv:originalSubmissionAt ${lit(state.originalSubmissionAt)}^^xsd:dateTime . }`
      : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
           ?occupied rv:ratingSlot ${iri(receipt.ratingSlot)} . } }
         FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(observation)} ?p ?o } }`;
    const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }
        ${predecessor ? `GRAPH ${iri(GRAPHS.current)} {
          ${iri(observation)} rv:observationHead ${iri(predecessor)} }` : ''}
      }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(observation)} a rv:RatingObservation ${experience ? ', rv:ExperienceRatingObservation' : daily ? ', rv:DailyRatingObservation' : ''} ;
            ${identity ? `rv:ratingOccasion ${iri(identity.occasionKey)} ;` : ''}
            ${period ? periodTriples(period) : ''}
            rv:ratingContext ${iri(context)} ;
            rv:targetMainVersion ${iri(receipt.mainVersion)} ;
            rv:ratingSlot ${iri(receipt.ratingSlot)} ; rv:observationHead ${iri(revision)} . }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(revision)} a rv:RatingObservationRevision, rv:RevisionAnchor ${experience ? ', rv:ExperienceRatingObservationRevision' : daily ? ', rv:DailyRatingObservationRevision' : ''} ;
            ${identity ? `rv:ratingOccasion ${iri(identity.occasionKey)} ;` : ''}
            ${period ? periodTriples(period) : ''}
            rv:component ${iri(observation)} ; rv:observation ${iri(observation)} ;
            rv:operation ${iri(receipt.operation)} ;
            rv:ratingAvailability rv:${receipt.ratingAvailability === 'available'
              ? 'Available' : 'Withdrawn'} ;
            ${receipt.ratingAvailability === 'available'
              ? `rv:ratingValue ${receipt.ratingValue} ;` : ''}
            ${predecessor ? `rv:predecessor ${iri(predecessor)} ;` : ''}
            rv:evaluatedAt ${lit(state.evaluatedAt)}^^xsd:dateTime ;
            rv:submittedAt ${lit(state.submittedAt)}^^xsd:dateTime ;
            rv:originalSubmissionAt ${lit(state.originalSubmissionAt)}^^xsd:dateTime ;
            rv:revisedAt ${lit(state.revisedAt)}^^xsd:dateTime ;
            rv:manifest ${iri(receipt.observationManifest)} ;
            rv:modelRevision ${iri(profile)} ;
            rv:shapeRevision ${iri(profile)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} . }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(receipt.operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
            rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Succeeded ;
            rv:realm ${iri(receipt.realm)} ; rv:ratingContext ${iri(context)} ;
            rv:contextRevision ${iri(receipt.contextRevision)} ;
            rv:work ${iri(receipt.work)} ; rv:mainVersion ${iri(receipt.mainVersion)} ;
            rv:ratingSlot ${iri(receipt.ratingSlot)} ;
            rv:ratingObservation ${iri(observation)} ;
            rv:observationRevision ${iri(revision)} ;
            rv:ratingAvailability rv:${receipt.ratingAvailability === 'available'
              ? 'Available' : 'Withdrawn'} ;
            ${receipt.ratingAvailability === 'available'
              ? `rv:ratingValue ${receipt.ratingValue} ;` : ''}
            ${predecessor ? `rv:expectedHead ${iri(predecessor)} ;` : ''}
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} . }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:RatingObservationChangedEvent ; rv:ordinal 0 ;
            rv:action "rating.observation.set" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(receipt.operation)} ; rv:ratingContext ${iri(context)} ;
            rv:ratingObservation ${iri(observation)} . }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ?space a rv:Space ; rv:realmCapability ${iri(receipt.realm)} ;
            rv:disclosure rv:Public .
          ${iri(receipt.realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
            rv:ratingContext ${iri(context)} .
          ${iri(context)} a rv:RatingContext ; rv:contextState rv:Active ;
            rv:realm ${iri(receipt.realm)} ; rv:targetGrain rv:MainVersion ;
            rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
            rv:ratingCadence ${iri(experience ? EXPERIENCE_CADENCE : daily ? DAILY_CADENCE : RATING_STANDING_CADENCE)} ;
            rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
            rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ;
            rv:head ${iri(receipt.contextRevision)} .
          ${iri(receipt.work)} a schema:CreativeWork ;
            rv:mainVersion ${iri(receipt.mainVersion)} .
          ${iri(receipt.mainVersion)} a rv:MainVersion ; rv:work ${iri(receipt.work)} . }
        ${priorGuard}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readStandingRatingReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt, experience ? EXPERIENCE_OBSERVATION_ID : daily ? DAILY_OBSERVATION_ID : 'realm-standing-rating-observation-v1', [
        { shape: `${profile}/realm-shape`, focus: receipt.realm },
        { shape: `${profile}/context-shape`, focus: context },
        { shape: `${profile}/work-shape`, focus: receipt.work },
        { shape: `${profile}/main-shape`, focus: receipt.mainVersion },
        { shape: `${profile}/observation-shape`, focus: observation },
        { shape: `${profile}/revision-shape`, focus: revision },
      ], { realm: receipt.realm!, context, work: receipt.work,
        main: receipt.mainVersion, slot: receipt.ratingSlot, observation, revision,
        ...(identity ? { occasion: identity.occasionKey } : {}),
        availability: receipt.ratingAvailability!,
        ...(period ? periodBinding(period) : {}),
        ...(receipt.ratingAvailability === 'available' ? { value: String(receipt.ratingValue) } : {}),
        ...(predecessor ? { predecessor } : {}) }); } catch (error) { updateError = error; }
    }
    const terminal = await readStandingRatingReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(observation)} a rv:RatingObservation ;
        ${identity ? `rv:ratingOccasion ${iri(identity.occasionKey)} ;` : ''}
        rv:ratingContext ${iri(context)} ; rv:targetMainVersion ${iri(receipt.mainVersion)} ;
        rv:ratingSlot ${iri(receipt.ratingSlot)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)}
        a rv:RatingObservationRevision, rv:RevisionAnchor ;
        ${identity ? `rv:ratingOccasion ${iri(identity.occasionKey)} ;` : ''}
        rv:component ${iri(observation)} ; rv:manifest ${iri(receipt.observationManifest)} ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
        rv:event ${iri(eventId)} ; rv:sequence ${sequence} .
        ${iri(eventId)} a rv:RatingObservationChangedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const headCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
          ${iri(observation)} rv:observationHead ${iri(revision)} . } }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.observation !== observation || terminal.revision !== revision
      || terminal.context !== context || terminal.slot !== receipt.ratingSlot
      || terminal.predecessor !== predecessor
      || terminal.availability !== receipt.ratingAvailability
      || terminal.value !== (receipt.ratingAvailability === 'available'
        ? receipt.ratingValue : null)
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || headCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained standing rating update outcome is unknown'
        : 'retained standing rating did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, observation, revision, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally { client.release(); }
}

/** The exact-release profiles are tried first; any other retained manifest keeps its own path. */
function retainedReleaseState(directory: string, manifest: string, component: string,
  profile: string): Record<string, unknown> | null {
  try { return readComponentState(directory, manifest, component, profile); }
  catch (error) { if (error instanceof RevisionCorrupt) return null; throw error; }
}

type RetainedReceipt = MainCloudEvent['data']['receipt'];
interface RetainedRelease {
  eventId: string; batchId: string; receipt: RetainedReceipt; state: Record<string, unknown>;
}

const restoreGuard = (env: WorkActivationEnvironment, coverage: RelayCoverage, sequence: string,
  marker: string) => `GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }`;

/** Replay one release-grain Context from its sealed admission and exact immutable bytes. */
async function reconcileRetainedReleaseRatingContext(env: WorkActivationEnvironment, accessPool: Pool,
  coverage: RelayCoverage, sequence: string, retained: RetainedRelease,
): Promise<{ receipt: string; context: string; replayed: boolean }> {
  const { eventId, batchId, receipt, state } = retained;
  const realm = receipt.realm!, context = receipt.ratingContext!;
  const revision = receipt.ratingContextRevision!, operation = receipt.operation!;
  const question = state.question;
  if (state.context !== context || state.realm !== realm || state.state !== 'active'
    || typeof question !== 'string' || state.targetGrain !== 'FixedRelease'
    || state.scaleMin !== 1 || state.scaleMax !== 10 || state.cadence !== RATING_STANDING_CADENCE
    || state.populationPolicy !== RATING_ACCOUNT_POPULATION
    || state.aggregationPolicy !== RATING_LATEST_MEAN_POLICY) {
    throw new RetainedEffectConflict('retained release rating context payload differs');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'rating.context.create'
      || admitted.state !== 'sealed' || admitted.scope_id !== receipt.scope
      || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || releaseRatingContextDigest({ realm, question, actingSubject: admitted.acting_subject })
        !== receipt.requestDigest) {
      throw new RetainedEffectConflict('current Access admission does not prove retained release rating context');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        ${releaseContextTriples({ realm, context, revision, operation, question,
          manifest: receipt.ratingContextManifest!, receipt: receipt.id, digest: receipt.requestDigest,
          admission: { id: receipt.admissionId, authorityEpoch: receipt.authorityEpoch, scope: receipt.scope },
          batch: batchId, event: eventId, dataEpoch: coverage.dataEpoch, sequence })}
      }
      WHERE {
        ${restoreGuard(env, coverage, sequence, marker)}
        GRAPH ${iri(GRAPHS.current)} {
          ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
          ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(context)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readRatingContextReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt, RELEASE_CONTEXT_ID, [
        { shape: `${RELEASE_CONTEXT_PROFILE}/realm-shape`, focus: realm },
        { shape: `${RELEASE_CONTEXT_PROFILE}/context-shape`, focus: context },
      ], { realm, context, question }); } catch (error) { updateError = error; }
    }
    const terminal = await readRatingContextReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(realm)} a rv:Realm ; rv:ratingContext ${iri(context)} .
        ${iri(context)} a rv:ReleaseRatingContext ; rv:realm ${iri(realm)} ;
          rv:targetGrain rv:FixedRelease ; rv:question ${lit(question)}@en ; rv:head ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ;
        rv:component ${iri(context)} ; rv:manifest ${iri(receipt.ratingContextManifest!)} ;
        rv:modelRevision ${iri(RELEASE_CONTEXT_PROFILE)} ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batchId)} a rv:OutboxBatch ;
        rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:RatingContextCreatedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.context !== context || terminal.realm !== realm || terminal.revision !== revision
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence) || graphCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained release rating context update outcome is unknown'
        : 'retained release rating context did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, context, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally { client.release(); }
}

/** Replay one exact-release opinion revision from its sealed principal and immutable bytes. */
async function reconcileRetainedReleaseRating(env: WorkActivationEnvironment, accessPool: Pool,
  coverage: RelayCoverage, sequence: string, retained: RetainedRelease,
): Promise<{ receipt: string; observation: string; revision: string; replayed: boolean }> {
  const { eventId, batchId, receipt, state } = retained;
  const context = receipt.ratingContext!, observation = receipt.ratingObservation!;
  const revision = receipt.observationRevision!, slot = receipt.ratingSlot!;
  const work = receipt.work!, mainVersion = receipt.mainVersion!;
  const predecessor = receipt.expectedHead ?? null;
  const availability = receipt.ratingAvailability!;
  const value = availability === 'available' ? receipt.ratingValue! : null;
  const release = state.release;
  const timestamp = (candidate: unknown): candidate is string => typeof candidate === 'string'
    && !Number.isNaN(Date.parse(candidate)) && new Date(candidate).toISOString() === candidate;
  if (typeof release !== 'string' || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(release)
    || state.observation !== observation || state.slot !== slot || state.context !== context
    || state.contextRevision !== receipt.contextRevision || state.realm !== receipt.realm
    || state.work !== work || state.mainVersion !== mainVersion || state.revision !== revision
    || state.predecessor !== predecessor || state.availability !== availability || state.value !== value
    || !timestamp(state.evaluatedAt) || !timestamp(state.submittedAt)
    || !timestamp(state.originalSubmissionAt) || !timestamp(state.revisedAt)
    || state.submittedAt !== state.revisedAt
    || (predecessor === null && (state.evaluatedAt !== state.submittedAt
      || state.originalSubmissionAt !== state.submittedAt))) {
    throw new RetainedEffectConflict('retained release rating payload differs');
  }
  const times = { evaluatedAt: state.evaluatedAt as string, submittedAt: state.submittedAt as string,
    originalSubmissionAt: state.originalSubmissionAt as string, revisedAt: state.revisedAt as string };
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string; principal_id: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject, principal_id,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'rating.observation.set'
      || admitted.state !== 'sealed' || admitted.scope_id !== receipt.scope
      || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || releaseRatingSlotIri(admitted.principal_id, context, release) !== slot
      || releaseRatingDigest({ context, work, mainVersion, release, expectedRevisionHead: predecessor,
        value, actingSubject: admitted.acting_subject }) !== receipt.requestDigest) {
      throw new RetainedEffectConflict('current Access admission does not prove retained release rating');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const binding = { realm: receipt.realm!, context, work, mainVersion, release, slot, observation,
      revision, availability, value, predecessor };
    const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }
        ${predecessor ? `GRAPH ${iri(GRAPHS.current)} {
          ${iri(observation)} rv:observationHead ${iri(predecessor)} }` : ''}
      }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        ${releaseObservationTriples({ ...binding, operation: receipt.operation!,
          contextRevision: receipt.contextRevision!, manifest: receipt.observationManifest!,
          receipt: receipt.id, digest: receipt.requestDigest,
          admission: { id: receipt.admissionId, authorityEpoch: receipt.authorityEpoch, scope: receipt.scope },
          batch: batchId, event: eventId, dataEpoch: coverage.dataEpoch, sequence, times })}
      }
      WHERE {
        ${restoreGuard(env, coverage, sequence, marker)}
        ${releaseTargetPattern({ realm: iri(receipt.realm!), context: iri(context), work: iri(work),
          main: iri(mainVersion), release: iri(release), contextRevision: iri(receipt.contextRevision!) })}
        ${releaseHeadGuard({ observation, slot, context, release, predecessor }, times)}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readStandingRatingReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      const shape = (role: string) => `${RELEASE_OBSERVATION_PROFILE}/${role}-shape`;
      try { await retainedCommand(env, update, receipt, RELEASE_OBSERVATION_ID, [
        { shape: shape('realm'), focus: receipt.realm! }, { shape: shape('context'), focus: context },
        { shape: shape('work'), focus: work }, { shape: shape('main'), focus: mainVersion },
        { shape: shape('release'), focus: release }, { shape: shape('observation'), focus: observation },
        { shape: shape('revision'), focus: revision },
      ], { realm: receipt.realm!, context, work, main: mainVersion, release, slot, observation, revision,
        availability, ...(value === null ? {} : { value: String(value) }),
        ...(predecessor ? { predecessor } : {}) }); } catch (error) { updateError = error; }
    }
    const terminal = await readStandingRatingReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(observation)} a rv:ReleaseRatingObservation ;
        rv:ratingContext ${iri(context)} ; rv:targetRelease ${iri(release)} ; rv:ratingSlot ${iri(slot)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:ReleaseRatingObservationRevision, rv:RevisionAnchor ;
        rv:component ${iri(observation)} ; rv:manifest ${iri(receipt.observationManifest!)} ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batchId)} a rv:OutboxBatch ;
        rv:event ${iri(eventId)} ; rv:sequence ${sequence} .
        ${iri(eventId)} a rv:RatingObservationChangedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const headCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
          ${iri(observation)} rv:observationHead ${iri(revision)} . } }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.observation !== observation || terminal.revision !== revision
      || terminal.context !== context || terminal.slot !== slot || terminal.release !== release
      || terminal.predecessor !== predecessor || terminal.availability !== availability
      || terminal.value !== value || terminal.dataEpoch !== coverage.dataEpoch
      || terminal.sequence !== sequence || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || headCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained release rating update outcome is unknown'
        : 'retained release rating did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, observation, revision, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally { client.release(); }
}

/** Replay one sealed shared definition bundle from exact retained bytes. */
export async function reconcileRetainedClassificationProposition(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; sense: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.classification.proposition-defined.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'classification.proposition.define' || receipt.outcome !== 'succeeded'
    || receipt.scope !== 'classification:define:global' || !receipt.operation
    || !receipt.scheme || !receipt.concept || !receipt.path || !receipt.expression
    || !receipt.sense || !receipt.definitionRevision || !receipt.definitionManifest
    || receipt.work || receipt.mainVersion || receipt.realm || receipt.classificationContext
    || receipt.id !== classificationPropositionReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained classification proposition envelope is incomplete');
  }
  const definitions: PropositionDefinitions = { scheme: receipt.scheme, concept: receipt.concept,
    path: receipt.path, expression: receipt.expression, sense: receipt.sense };
  const ids = Object.values(definitions);
  const revision = receipt.definitionRevision;
  const operation = receipt.operation;
  for (const value of [eventId, data.batchId, receipt.id, revision, operation, ...ids]) iri(value);
  if (new Set(ids).size !== 5 || ids.some((id) => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(id))
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.definitionManifest)) {
    throw new RetainedEffectConflict('retained classification definition references are invalid');
  }
  const vocabulary = retainedReleaseState(env.objectDirectory, receipt.definitionManifest,
    definitions.sense, VOCABULARY_PROFILE);
  if (vocabulary) return reconcileRetainedVocabularyProposition(env, accessPool, coverage, sequence,
    eventId, data, receipt, definitions, vocabulary);
  const state = readComponentState(env.objectDirectory, receipt.definitionManifest,
    definitions.sense, CLASSIFICATION_PROPOSITION_PROFILE);
  if (ids.some((id, index) => state[Object.keys(definitions)[index]!] !== id)
    || typeof state.label !== 'string' || state.language !== 'en'
    || state.scope !== GLOBAL_CLASSIFICATION_CONTEXT
    || state.profile !== CLASSIFICATION_PROPOSITION_PROFILE) {
    throw new RetainedEffectConflict('retained classification proposition payload differs');
  }
  const label = state.label;
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'classification.proposition.define'
      || admitted.state !== 'sealed' || admitted.scope_id !== receipt.scope
      || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || classificationPropositionDigest({ label, actingSubject: admitted.acting_subject })
        !== receipt.requestDigest) {
      throw new RetainedEffectConflict('current Access admission does not prove retained definition');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}> PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(definitions.scheme)} a skos:ConceptScheme ; rv:schemeState rv:Active .
          ${iri(definitions.concept)} a skos:Concept ; skos:inScheme ${iri(definitions.scheme)} ;
            skos:prefLabel ${lit(label)}@en ; rv:conceptState rv:Active .
          ${iri(definitions.path)} a rv:ConceptPath ; rv:pathKind rv:SingleConcept ;
            rv:pathLength 1 ; rv:terminalConcept ${iri(definitions.concept)} ; rv:pathState rv:Active .
          ${iri(definitions.expression)} a rv:ClassificationExpression ;
            rv:path ${iri(definitions.path)} ; rv:propositionKind rv:ConceptAssertion ;
            rv:assertedConcept ${iri(definitions.concept)} ; rv:expressionState rv:Active .
          ${iri(definitions.sense)} a rv:ClassificationSense ; rv:path ${iri(definitions.path)} ;
            rv:expression ${iri(definitions.expression)} ;
            rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
            rv:senseState rv:Active ; rv:head ${iri(revision)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(definitions.sense)} ;
            rv:operation ${iri(operation)} ; rv:manifest ${iri(receipt.definitionManifest)} ;
            rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
            rv:shapeRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
            rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Succeeded ;
            rv:scheme ${iri(definitions.scheme)} ; rv:concept ${iri(definitions.concept)} ;
            rv:path ${iri(definitions.path)} ; rv:expression ${iri(definitions.expression)} ;
            rv:sense ${iri(definitions.sense)} ; rv:definitionRevision ${iri(revision)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:ClassificationPropositionDefinedEvent ; rv:ordinal 0 ;
            rv:action "classification.proposition.define" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(operation)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
            rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
            rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
        }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?realm } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?fallback } }
        ${ids.map((id) => `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(id)} ?p ?o } }`).join('\n')}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readClassificationPropositionReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt, 'classification-proposition-v1',
        (Object.entries(definitions) as [string, string][]).map(([role, focus]) => ({
          shape: `${CLASSIFICATION_PROPOSITION_PROFILE}/${role}-shape`, focus,
        })), { ...definitions }); } catch (error) { updateError = error; }
    }
    const terminal = await readClassificationPropositionReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(definitions.scheme)} a <http://www.w3.org/2004/02/skos/core#ConceptScheme> .
        ${iri(definitions.concept)} <http://www.w3.org/2004/02/skos/core#inScheme> ${iri(definitions.scheme)} .
        ${iri(definitions.path)} rv:terminalConcept ${iri(definitions.concept)} .
        ${iri(definitions.expression)} rv:path ${iri(definitions.path)} ;
          rv:assertedConcept ${iri(definitions.concept)} .
        ${iri(definitions.sense)} rv:expression ${iri(definitions.expression)} ;
          rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ;
        rv:component ${iri(definitions.sense)} ; rv:manifest ${iri(receipt.definitionManifest)} ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
        rv:event ${iri(eventId)} ; rv:sequence ${sequence} .
        ${iri(eventId)} a rv:ClassificationPropositionDefinedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const headCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
          ${iri(definitions.sense)} rv:head ${iri(revision)} . } }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.revision !== revision || ids.some((id, index) =>
        terminal.definitions?.[Object.keys(definitions)[index] as keyof PropositionDefinitions] !== id)
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || headCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained classification proposition update outcome is unknown'
        : 'retained classification proposition did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, sense: definitions.sense, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally { client.release(); }
}

/** Replay v2's scheme append and Concept identity from the three exact retained manifests. */
async function reconcileRetainedVocabularyProposition(
  env: WorkActivationEnvironment,
  accessPool: Pool,
  coverage: RelayCoverage,
  sequence: string,
  eventId: string,
  data: MainCloudEvent['data'],
  receipt: RetainedReceipt,
  definitions: PropositionDefinitions,
  state: Record<string, unknown>,
): Promise<{ receipt: string; sense: string; replayed: boolean }> {
  const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
  const manifest = /^urn:rezics:sha256:[0-9a-f]{64}$/;
  if (
    Object.entries(definitions).some(([key, value]) => state[key] !== value) ||
    state.profile !== VOCABULARY_PROFILE ||
    state.scope !== GLOBAL_CLASSIFICATION_CONTEXT ||
    !native.test(String(state.schemeHead)) ||
    !native.test(String(state.conceptHead)) ||
    (state.previousSchemeHead !== null && !native.test(String(state.previousSchemeHead))) ||
    !manifest.test(String(state.schemeManifest)) ||
    !manifest.test(String(state.conceptManifest)) ||
    !Array.isArray(state.labels) ||
    !Array.isArray(state.alternativeLabels) ||
    !Array.isArray(state.broader) ||
    !Array.isArray(state.narrower) ||
    typeof state.actingSubject !== 'string'
  ) {
    throw new RetainedEffectConflict('retained vocabulary payload is invalid');
  }
  const schemeHead = state.schemeHead as string,
    conceptHead = state.conceptHead as string;
  const previous = state.previousSchemeHead as string | null;
  const input: DefineVocabularyConceptInput = {
    scheme: previous ? { id: definitions.scheme, expectedHead: previous } : null,
    labels: state.labels as DefineVocabularyConceptInput['labels'],
    alternativeLabels: state.alternativeLabels as DefineVocabularyConceptInput['alternativeLabels'],
    broader: state.broader as string[],
    narrower: state.narrower as string[],
    actingSubject: state.actingSubject,
  };
  let digest: string;
  try {
    digest = vocabularyDigest(input);
  } catch {
    throw new RetainedEffectConflict('retained vocabulary input is invalid');
  }
  if (digest !== receipt.requestDigest)
    throw new RetainedEffectConflict('retained vocabulary digest differs');
  const schemeState = readComponentState(
    env.objectDirectory,
    state.schemeManifest as string,
    definitions.scheme,
    VOCABULARY_PROFILE,
  );
  const conceptState = readComponentState(
    env.objectDirectory,
    state.conceptManifest as string,
    definitions.concept,
    VOCABULARY_PROFILE,
  );
  if (
    schemeState.profile !== VOCABULARY_PROFILE ||
    schemeState.scheme !== definitions.scheme ||
    schemeState.previousHead !== previous ||
    schemeState.addedConcept !== definitions.concept ||
    schemeState.actingSubject !== input.actingSubject ||
    conceptState.profile !== VOCABULARY_PROFILE ||
    conceptState.concept !== definitions.concept ||
    conceptState.scheme !== definitions.scheme ||
    conceptState.actingSubject !== input.actingSubject ||
    JSON.stringify(conceptState.labels) !== JSON.stringify(input.labels) ||
    JSON.stringify(conceptState.alternativeLabels) !== JSON.stringify(input.alternativeLabels) ||
    JSON.stringify(conceptState.broader) !== JSON.stringify(input.broader) ||
    JSON.stringify(conceptState.narrower) !== JSON.stringify(input.narrower)
  ) {
    throw new RetainedEffectConflict('retained vocabulary manifests differ');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE',
    );
    if (fence.rows[0]?.open !== false)
      throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`,
      [receipt.admissionId],
    );
    const admitted = access.rows[0];
    if (
      !admitted ||
      admitted.action !== 'classification.proposition.define' ||
      admitted.state !== 'sealed' ||
      admitted.scope_id !== receipt.scope ||
      admitted.request_digest !== digest ||
      admitted.authority_epoch !== receipt.authorityEpoch ||
      admitted.acting_subject !== input.actingSubject ||
      admitted.graph_receipt !== receipt.id ||
      admitted.graph_outcome !== 'succeeded' ||
      admitted.graph_data_epoch !== coverage.dataEpoch ||
      admitted.graph_sequence !== sequence
    ) {
      throw new RetainedEffectConflict('Access admission does not prove retained vocabulary');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const revision = receipt.definitionRevision!;
    const relationGuard = [...input.broader, ...input.narrower]
      .map(
        (id) =>
          `GRAPH ${iri(GRAPHS.current)} { ${iri(id)} a skos:Concept ;
        skos:inScheme ${iri(definitions.scheme)} ; rv:conceptState rv:Active . }`,
      )
      .join('\n');
    const schemeGuard = previous
      ? `GRAPH ${iri(GRAPHS.current)} { ${iri(definitions.scheme)} a skos:ConceptScheme ;
          rv:schemeState rv:Active ; rv:schemeRevisionHead ${iri(previous)} . }`
      : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(definitions.scheme)} ?p ?o } }`;
    const schemeCurrent = previous
      ? `${iri(definitions.scheme)} rv:schemeRevisionHead ${iri(schemeHead)} .`
      : `${iri(definitions.scheme)} a skos:ConceptScheme, rv:VocabularyDefinition ;
          rv:definitionProfile ${iri(VOCABULARY_PROFILE)} ; rv:schemeState rv:Active ;
          rv:schemeRevisionHead ${iri(schemeHead)} .`;
    const anchor = (
      id: string,
      component: string,
      objectManifest: string,
      predecessor: string | null,
    ) =>
      `${iri(id)} a rv:RevisionAnchor ; rv:component ${iri(component)} ;
        rv:operation ${iri(receipt.operation!)} ; rv:recordedBy ${iri(input.actingSubject)} ;
        rv:manifest ${iri(objectManifest)} ; rv:modelRevision ${iri(VOCABULARY_PROFILE)} ;
        rv:shapeRevision ${iri(VOCABULARY_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence}${
          predecessor ? ` ; rv:predecessor ${iri(predecessor)}` : ''
        } .`;
    const update = `PREFIX rv: <${RV}> PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }
        ${previous ? `GRAPH ${iri(GRAPHS.current)} { ${iri(definitions.scheme)} rv:schemeRevisionHead ${iri(previous)} }` : ''} }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} {
          ${schemeCurrent}
          ${iri(definitions.concept)} a skos:Concept, rv:VocabularyDefinition ;
            rv:definitionProfile ${iri(VOCABULARY_PROFILE)} ; skos:inScheme ${iri(definitions.scheme)} ;
            rv:conceptState rv:Active ; rv:head ${iri(conceptHead)} ;
            skos:prefLabel ${input.labels.map((item) => `${lit(item.value)}@${item.language}`).join(', ')} .
          ${input.alternativeLabels.map((item) => `${iri(definitions.concept)} skos:altLabel ${lit(item.value)}@${item.language} .`).join('\n')}
          ${input.broader.map((id) => `${iri(definitions.concept)} skos:broader ${iri(id)} .`).join('\n')}
          ${input.narrower.map((id) => `${iri(definitions.concept)} skos:narrower ${iri(id)} .`).join('\n')}
          ${iri(definitions.path)} a rv:ConceptPath, rv:VocabularyDefinition ;
            rv:definitionProfile ${iri(VOCABULARY_PROFILE)} ; rv:pathKind rv:SingleConcept ;
            rv:pathLength 1 ; rv:terminalConcept ${iri(definitions.concept)} ; rv:pathState rv:Active .
          ${iri(definitions.expression)} a rv:ClassificationExpression, rv:VocabularyDefinition ;
            rv:definitionProfile ${iri(VOCABULARY_PROFILE)} ; rv:path ${iri(definitions.path)} ;
            rv:propositionKind rv:ConceptAssertion ; rv:assertedConcept ${iri(definitions.concept)} ;
            rv:expressionState rv:Active .
          ${iri(definitions.sense)} a rv:ClassificationSense, rv:VocabularyDefinition ;
            rv:definitionProfile ${iri(VOCABULARY_PROFILE)} ; rv:path ${iri(definitions.path)} ;
            rv:expression ${iri(definitions.expression)} ; rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
            rv:senseState rv:Active ; rv:head ${iri(revision)} . }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${anchor(schemeHead, definitions.scheme, state.schemeManifest as string, previous)}
          ${anchor(conceptHead, definitions.concept, state.conceptManifest as string, null)}
          ${anchor(revision, definitions.sense, receipt.definitionManifest!, null)} }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(receipt.operation!)} ;
            rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:admittedScope ${lit(receipt.scope)} ;
            rv:outcome rv:Succeeded ; rv:scheme ${iri(definitions.scheme)} ;
            rv:concept ${iri(definitions.concept)} ; rv:path ${iri(definitions.path)} ;
            rv:expression ${iri(definitions.expression)} ; rv:sense ${iri(definitions.sense)} ;
            rv:definitionRevision ${iri(revision)} ; rv:schemeRevision ${iri(schemeHead)} ;
            rv:conceptRevision ${iri(conceptHead)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:ClassificationPropositionDefinedEvent ; rv:ordinal 0 ;
            rv:action "classification.proposition.define" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(receipt.operation!)} . }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ; rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?prior)
          FILTER(?prior + 1 = ${sequence}) }
        GRAPH ${iri(GRAPHS.current)} { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
          rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} . }
        ${schemeGuard}
        ${relationGuard}
        ${Object.entries(definitions)
          .filter(([key]) => key !== 'scheme')
          .map(
            ([, id]) => `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(id)} ?p ?o } }`,
          )
          .join('\n')}
        ${[schemeHead, conceptHead, revision].map(id =>
          `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(id)} ?p ?o } }`).join('\n')}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
      }`;
    const existing = await readClassificationPropositionReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try {
        const current = await profileValidations(
          env.fuseki,
          'classification-proposition-v2',
          (Object.entries(definitions) as [string, string][]).map(([role, focus]) => ({
            shape: `${VOCABULARY_PROFILE}/${role}-shape`,
            focus: [focus],
            graphs: [GRAPHS.current],
          })),
          { ...definitions },
        );
        const revisions = await profileValidations(
          env.fuseki,
          'concept-scheme-revision-v1',
          [schemeHead, conceptHead, revision].map((focus) => ({
            shape: `${VOCABULARY_REVISION_PROFILE}/anchor-shape`,
            focus: [focus],
            graphs: [GRAPHS.revisions],
          })),
        );
        const result = await env.fuseki.commandWithReceipt({
          receipt: receipt.id,
          digest: receipt.requestDigest,
          update,
          validations: [...current, ...revisions],
          deadlineMs: 10_000,
        });
        if (result.status === 'invalid' || result.status === 'unknown-profile') {
          throw new Error(`retained vocabulary validation ${result.status}`);
        }
      } catch (error) {
        updateError = error;
      }
    }
    const terminal = await readClassificationPropositionReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graph =
      await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX skos: <http://www.w3.org/2004/02/skos/core#> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(definitions.concept)} a skos:Concept ;
        skos:inScheme ${iri(definitions.scheme)} ; rv:head ${iri(conceptHead)} .
        ${iri(definitions.sense)} rv:head ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} rv:component ${iri(definitions.sense)} ;
        rv:manifest ${iri(receipt.definitionManifest!)} .
        ${iri(schemeHead)} rv:component ${iri(definitions.scheme)} ;
          rv:manifest ${iri(state.schemeManifest as string)} .
        ${iri(conceptHead)} rv:component ${iri(definitions.concept)} ;
          rv:manifest ${iri(state.conceptManifest as string)} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} rv:event ${iri(eventId)} ;
        rv:sequence ${sequence} . }
    }`);
    if (
      !terminal ||
      terminal.outcome !== 'succeeded' ||
      terminal.receipt !== receipt.id ||
      terminal.requestDigest !== digest ||
      terminal.schemeHead !== schemeHead ||
      terminal.conceptHead !== conceptHead ||
      terminal.revision !== revision ||
      terminal.definitions?.concept !== definitions.concept ||
      terminal.definitions.scheme !== definitions.scheme ||
      cursor === null ||
      cursor < BigInt(sequence) ||
      graph.boolean !== true
    ) {
      throw new RetainedEffectConflict(
        updateError
          ? 'retained vocabulary update outcome is unknown'
          : 'retained vocabulary did not reconcile',
      );
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, sense: definitions.sense, replayed: !!existing };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* retain original error */
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Rebuild a Statement acceptance from sealed legacy evidence. */
export async function reconcileRetainedClassificationDecision(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; application: string; decision: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.classification.decision-changed.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'classification.decision.set' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.work || !receipt.mainVersion || !receipt.sense
    || !receipt.classificationContext || !receipt.slot || !receipt.application
    || !receipt.decision || !receipt.decisionManifest
    || !['accepted', 'rejected'].includes(receipt.decisionOutcome ?? '')
    || (receipt.realm ? receipt.scope !== `classification:decide:${receipt.realm}`
      || !receipt.contextRevision
      : receipt.scope !== 'classification:decide:global' || receipt.contextRevision
        || receipt.classificationContext !== GLOBAL_CLASSIFICATION_CONTEXT)
    || receipt.id !== classificationDecisionReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained classification decision envelope is incomplete');
  }
  const context = receipt.classificationContext;
  const realm = receipt.realm;
  const application = receipt.application;
  const decision = receipt.decision;
  const predecessor = receipt.expectedHead ?? null;
  const required = [eventId, data.batchId, receipt.id, receipt.operation, receipt.work,
    receipt.mainVersion, receipt.sense, context, receipt.slot, application, decision];
  for (const value of [...required, ...(realm ? [realm, receipt.contextRevision!] : []),
    ...(predecessor ? [predecessor] : [])]) iri(value);
  if (receipt.slot !== classificationDecisionSlotIri(receipt.mainVersion, receipt.sense, context)
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.decisionManifest)
    || new Set([receipt.work, receipt.mainVersion, receipt.sense, application, decision,
      ...(realm ? [realm, context, receipt.contextRevision!] : [])]).size
      !== (realm ? 8 : 5)) {
    throw new RetainedEffectConflict('retained classification decision references are invalid');
  }
  const state = readComponentState(env.objectDirectory, receipt.decisionManifest,
    application, CLASSIFICATION_DIRECT_DECISION_PROFILE);
  const senseRevision = state.senseRevision;
  const proposer = state.proposer;
  const decider = state.decider;
  if (state.application !== application || state.slot !== receipt.slot
    || state.work !== receipt.work || state.mainVersion !== receipt.mainVersion
    || state.sense !== receipt.sense || state.context !== context
    || state.realm !== (realm ?? null)
    || state.contextRevision !== (receipt.contextRevision ?? null)
    || state.decision !== decision || state.predecessor !== predecessor
    || state.outcome !== receipt.decisionOutcome
    || state.policy !== CLASSIFICATION_DIRECT_DECISION_PROFILE
    || typeof proposer !== 'string' || typeof decider !== 'string'
    || typeof senseRevision !== 'string'
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(proposer)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(decider)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(senseRevision)) {
    throw new RetainedEffectConflict('retained classification decision payload differs');
  }
  const concept = await retainedClassificationConcept(env,state);
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    const input: SetClassificationDecisionInput = {
      context: realm ? { kind: 'realm-classification', id: realm } : { kind: 'global' },
      work: receipt.work, mainVersion: receipt.mainVersion, sense: receipt.sense,
      expectedDecisionHead: predecessor, outcome: receipt.decisionOutcome!,
      actingSubject: admitted?.acting_subject ?? '',
    };
    if (access.rows.length !== 1 || !admitted || admitted.action !== 'classification.decision.set'
      || admitted.state !== 'sealed' || admitted.scope_id !== receipt.scope
      || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || decider !== admitted.acting_subject
      || classificationDecisionDigest(input) !== receipt.requestDigest) {
      throw new RetainedEffectConflict('current Access admission does not prove retained decision');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const maintenanceDigest = hash(JSON.stringify(['statement-storage-restore-v1',
      env.lineage.dataEpoch, env.lineage.routingEpoch, receipt.id, receipt.requestDigest,
      coverage.dataEpoch, sequence]));
    const maintenanceReceipt = `urn:rezics:name-migration:statement-upgrade:restore:${maintenanceDigest}`;
    const existing = await readClassificationDecisionReceipt(env, receipt.admissionId);
    // A replay uses the committed conversion identity. Preparing against a later
    // slot head would manufacture a different predecessor and orphan manifest.
    const saved = existing ? (await env.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?statement ?revision ?slot ?decision ?meaningKey WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(maintenanceReceipt)}
          rv:requestDigest ${lit(maintenanceDigest)} ; rv:outcome rv:Succeeded ;
          rv:restoredReceipt ${iri(receipt.id)} ; rv:convertedApplication ${iri(application)} ;
          rv:convertedDecision ${iri(decision)} ; rv:statement ?statement ;
          rv:statementRevision ?revision ; rv:decisionSlot ?slot ; rv:statementDecision ?decision }
        GRAPH ${iri(GRAPHS.current)} { ?statement rv:meaningKey ?meaningKey ;
          rv:interpretationDefinition ${iri(senseRevision)} ;
          <http://www.w3.org/1999/02/22-rdf-syntax-ns#object> ${iri(concept)} }
      } LIMIT 2`, STATEMENT_CONVERSION_COST.responseBytes)).results?.bindings ?? [] : [];
    if (existing && (saved.length !== 1
      || ['statement', 'revision', 'slot', 'decision', 'meaningKey'].some(key => !saved[0]?.[key]))) {
      throw new RetainedEffectConflict('retained classification conversion proof is unavailable');
    }
    const prepared = existing ? {
      statement: saved[0]!.statement!.value, revision: saved[0]!.revision!.value,
      slot: saved[0]!.slot!.value, decision: saved[0]!.decision!.value,
      meaningKey: saved[0]!.meaningKey!.value, current: '', revisions: '',
      nativeRevisions: '', nativePredecessor: null, validations: [],
    } : await prepareRetainedClassification(env, { application, decision,
      manifest: receipt.decisionManifest, main: receipt.mainVersion, concept, context,
      proposer, decidedBy: decider, outcome: receipt.decisionOutcome!,
      contextRevision: receipt.contextRevision ?? null,
      operation: receipt.operation, dataEpoch: coverage.dataEpoch, sequence });
    const contextGuard = realm
      ? `?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
         ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
           rv:classificationContext ${iri(context)} .
         ${iri(context)} a rv:ClassificationContext ;
           rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ;
           rv:realm ${iri(realm)} ; rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
           rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
           rv:head ${iri(receipt.contextRevision!)} .`
      : '';
    const priorGuard = predecessor
      ? `GRAPH ${iri(GRAPHS.revisions)} { ${iri(predecessor)} a rv:ClassificationDecision ; rv:component ${iri(application)} }
        GRAPH ${iri(GRAPHS.current)} { ?priorSlot a rv:DecisionSlot ;
          rv:acceptanceContext ${iri(context)} ; rv:decisionHead ?priorConverted }
        GRAPH ${iri(GRAPHS.revisions)} { ?priorConverted rv:component ?priorSlot ; rv:convertedFrom ${iri(predecessor)} }`
      : '';
    const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(application)} rv:decisionHead ?historicalHead }
        ${prepared.nativePredecessor ? `GRAPH ${iri(GRAPHS.current)} {
          ${iri(prepared.slot)} rv:decisionHead ${iri(prepared.nativePredecessor)} }` : ''}
      }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} { ${prepared.current} }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${prepared.nativeRevisions}
          ${iri(application)} a rv:ClassificationApplication ;
            rv:targetMainVersion ${iri(receipt.mainVersion)} ; rv:sense ${iri(receipt.sense)} ;
            rv:applicationKey ${iri(receipt.slot)} ; rv:classificationContext ${iri(context)} ;
            rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ;
            rv:proposer ${iri(proposer)} ; rv:decisionHead ${iri(decision)} .
          ${iri(decision)} a rv:ClassificationDecision, rv:RevisionAnchor ;
            rv:component ${iri(application)} ; rv:application ${iri(application)} ;
            rv:operation ${iri(receipt.operation)} ;
            rv:outcome rv:${receipt.decisionOutcome === 'accepted' ? 'Accepted' : 'Rejected'} ;
            rv:decisionBasis rv:${realm ? 'RealmManagerReview' : 'GlobalCuratorReview'} ;
            rv:decidedBy ${iri(decider)} ;
            rv:decisionPolicy ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
            ${realm ? `rv:contextRevision ${iri(receipt.contextRevision!)} ;` : ''}
            ${predecessor ? `rv:predecessor ${iri(predecessor)} ;` : ''}
            rv:manifest ${iri(receipt.decisionManifest)} ;
            rv:modelRevision ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
            rv:shapeRevision ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(maintenanceReceipt)} a rv:OperationReceipt ;
            rv:commandFamily "statement-upgrade-restore-v1" ;
            rv:requestDigest ${lit(maintenanceDigest)} ; rv:outcome rv:Succeeded ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:sequence ?sequence ; rv:statementUpgrade ${iri(statementUpgradeMarker(env.lineage.dataEpoch))} ;
            rv:restoredReceipt ${iri(receipt.id)} ; rv:convertedApplication ${iri(application)} ;
            rv:convertedDecision ${iri(decision)} ; rv:statement ${iri(prepared.statement)} ;
            rv:statementRevision ${iri(prepared.revision)} ; rv:decisionSlot ${iri(prepared.slot)} ;
            rv:statementDecision ${iri(prepared.decision)} .
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(receipt.operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
            rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Succeeded ;
            rv:work ${iri(receipt.work)} ; rv:mainVersion ${iri(receipt.mainVersion)} ;
            rv:sense ${iri(receipt.sense)} ; rv:classificationContext ${iri(context)} ;
            ${realm ? `rv:realm ${iri(realm)} ; rv:contextRevision ${iri(receipt.contextRevision!)} ;` : ''}
            rv:slot ${iri(receipt.slot)} ; rv:application ${iri(application)} ;
            rv:decision ${iri(decision)} ;
            rv:decisionOutcome rv:${receipt.decisionOutcome === 'accepted' ? 'Accepted' : 'Rejected'} ;
            ${predecessor ? `rv:expectedHead ${iri(predecessor)} ;` : ''}
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:ClassificationDecisionChangedEvent ; rv:ordinal 0 ;
            rv:action "classification.decision.set" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(receipt.operation)} ; rv:work ${iri(receipt.work)} ;
            ${realm ? `rv:realm ${iri(realm)} ;` : ''}
            rv:application ${iri(application)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:sequence ?sequence ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(receipt.work)} a schema:CreativeWork ;
            rv:mainVersion ${iri(receipt.mainVersion)} .
          ${iri(receipt.mainVersion)} a rv:MainVersion ; rv:work ${iri(receipt.work)} .
          ${iri(receipt.sense)} a rv:ClassificationSense ; rv:senseState rv:Active ;
            rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} .
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
            rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
            rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
          ${contextGuard}
          FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?globalRealm }
          FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?globalFallback }
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(senseRevision)} a rv:RevisionAnchor ; rv:component ${iri(receipt.sense)} ;
            rv:modelRevision ?senseModel . ${classificationModelRevisions('?senseModel')} }
        ${priorGuard}
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(prepared.slot)} rv:decisionHead ?replacedHead } }
        ${prepared.nativePredecessor
          ? `GRAPH ${iri(GRAPHS.current)} { ${iri(prepared.slot)} rv:decisionHead ${iri(prepared.nativePredecessor)} }
             FILTER(?replacedHead = ${iri(prepared.nativePredecessor)})
             FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(prepared.slot)} rv:decisionHead ?otherNativeHead .
               FILTER(?otherNativeHead != ${iri(prepared.nativePredecessor)}) } }`
          : `FILTER(!BOUND(?replacedHead))`}
        OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ${iri(application)} rv:decisionHead ?historicalHead } }
        ${predecessor ? `OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(application)} rv:decisionHead ?retainedRawHead } }
          FILTER(COALESCE(?historicalHead, ?retainedRawHead) = ${iri(predecessor)})
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(application)} rv:decisionHead ?otherHistoricalHead .
            FILTER(?otherHistoricalHead != ${iri(predecessor)}) } }` : 'FILTER(!BOUND(?historicalHead))'}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(maintenanceReceipt)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    let updateError: unknown;
    if (!existing) {
      // Offline representation recovery preserves the sealed raw expectedHead.
      // It differs from the native predecessor, so the live command CAS cannot
      // describe this transition. Both fences and both predecessors are guarded
      // in this single maintenance transaction; no new admission is created.
      try {
        const result = await env.fuseki.commandWithReceipt({ receipt: maintenanceReceipt,
          digest: maintenanceDigest, update,
          validations: prepared.validations.filter(validation =>
            validation.profile !== 'classification-direct-decision-v1'),
          deadlineMs: STATEMENT_CONVERSION_COST.deadlineMs });
        if (result.status !== 'committed') throw new Error(`retained classification maintenance ${result.status}`);
      } catch (error) { updateError = error; }
    }
    const terminal = await readClassificationDecisionReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(prepared.statement)} a <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> ;
        <http://www.w3.org/1999/02/22-rdf-syntax-ns#subject> ${iri(receipt.mainVersion)} ; rv:meaningKey ${iri(prepared.meaningKey)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} a rv:ClassificationDecision, rv:RevisionAnchor ;
        rv:component ${iri(application)} ; rv:application ${iri(application)} ;
        rv:manifest ${iri(receipt.decisionManifest)} ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        ${iri(prepared.revision)} a rv:StatementRevision ; rv:component ${iri(prepared.statement)} .
        ${iri(prepared.decision)} a rv:StatementDecision ; rv:component ${iri(prepared.slot)} ;
          rv:convertedFrom ${iri(decision)} ; rv:support ${iri(prepared.statement)} ;
          rv:decidedBy ${iri(decider)} ; rv:operation ${iri(receipt.operation)} ;
          rv:outcome rv:${receipt.decisionOutcome === 'accepted' ? 'Accepted' : 'Rejected'} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(maintenanceReceipt)} rv:requestDigest ${lit(maintenanceDigest)} ;
        rv:outcome rv:Succeeded ; rv:restoredReceipt ${iri(receipt.id)} ;
        rv:statement ${iri(prepared.statement)} ; rv:statementDecision ${iri(prepared.decision)} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
        rv:event ${iri(eventId)} ; rv:sequence ${sequence} .
        ${iri(eventId)} a rv:ClassificationDecisionChangedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const headCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
          ${iri(prepared.slot)} rv:decisionHead ${iri(prepared.decision)} . } }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.application !== application || terminal.decision !== decision
      || terminal.slot !== receipt.slot || terminal.context !== context
      || terminal.expectedHead !== predecessor
      || terminal.decisionOutcome !== receipt.decisionOutcome
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || headCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained classification decision update outcome is unknown'
        : 'retained classification decision did not reconcile', { cause: updateError });
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, application, decision, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally { client.release(); }
}

export async function reconcileRetainedRealmSpaceCreate(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; space: string; realm: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.space.created.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'space.create' || receipt.outcome !== 'succeeded'
    || receipt.scope !== 'space:create:root' || !receipt.operation || !receipt.space
    || !receipt.realm || !receipt.spaceRevision || !receipt.realmRevision
    || !receipt.spaceManifest || !receipt.realmManifest || !receipt.owner
    || receipt.work || receipt.mainVersion || receipt.contribution || receipt.selection
    || receipt.expectedHead || receipt.reason
    || receipt.id !== spaceCreationReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained Space create envelope is incomplete');
  }
  const space = receipt.space;
  const realm = receipt.realm;
  const spaceRevision = receipt.spaceRevision;
  const realmRevision = receipt.realmRevision;
  const owner = receipt.owner;
  const operation = receipt.operation;
  for (const value of [eventId, data.batchId, receipt.id, space, realm,
    spaceRevision, realmRevision, owner, operation]) iri(value);
  if (space === realm
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.spaceManifest)
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.realmManifest)) {
    throw new RetainedEffectConflict('retained Space manifest references are invalid');
  }
  let profile = SPACE_REALM_PROFILE;
  let spaceState: Record<string, unknown>;
  try { spaceState = readComponentState(env.objectDirectory, receipt.spaceManifest,
    space, profile); }
  catch {
    profile = SPACE_REALM_PROFILE_V2;
    try { spaceState = readComponentState(env.objectDirectory, receipt.spaceManifest, space, profile); }
    catch {
      profile = SPACE_REALM_PROFILE_V1;
      spaceState = readComponentState(env.objectDirectory, receipt.spaceManifest, space, profile);
    }
  }
  // Older profiles recorded English implicitly; replay preserves that recorded meaning.
  const language = profile === SPACE_REALM_PROFILE ? spaceState.language : 'en';
  if (typeof language !== 'string' || !canonicalLanguage(language)) {
    throw new RetainedEffectConflict('retained Space name language is invalid');
  }
  const realmState = readComponentState(env.objectDirectory, receipt.realmManifest,
    realm, profile);
  const handle = realmState.handle;
  const topics = realmState.topics;
  if (handle !== undefined && typeof handle !== 'string'
    || topics !== undefined && (!Array.isArray(topics) || topics.some(topic => typeof topic !== 'string'))
    || profile === SPACE_REALM_PROFILE_V1 && (handle !== undefined || topics !== undefined)) {
    throw new RetainedEffectConflict('retained Space community fields are invalid');
  }
  if (spaceState.owner !== owner || spaceState.realmCapability !== realm
    || spaceState.disclosure !== 'public'
    || JSON.stringify(spaceState.capabilities) !== '["realm"]'
    || typeof spaceState.name !== 'string'
    || realmState.space !== space || realmState.state !== 'active'
    || realmState.selectionPolicy !== SELECTION_POLICY
    || realmState.membershipPolicy !== MEMBERSHIP_POLICY
    || realmState.reviewPolicy !== REVIEW_POLICY
    || spaceCreationDigest({ name: spaceState.name, language, actingSubject: owner,
      ...handle !== undefined ? { handle } : {},
      ...topics !== undefined ? { topics: topics as string[] } : {} })
      !== receipt.requestDigest) {
    throw new RetainedEffectConflict('retained Space payload differs from receipt');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'space.create' || admitted.state !== 'sealed'
      || admitted.acting_subject !== owner || admitted.scope_id !== receipt.scope
      || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence) {
      throw new RetainedEffectConflict('current Access admission does not prove retained Space');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(space)} a rv:Space ; rv:owner ${iri(owner)} ;
            ${profile !== SPACE_REALM_PROFILE_V1 ? `rv:definitionProfile ${iri(profile)} ;` : ''}
            rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public ;
            rdfs:label ${lit(spaceState.name)}@${language} ; rv:head ${iri(spaceRevision)} .
          ${iri(realm)} a rv:Realm ; rv:space ${iri(space)} ; rv:realmState rv:Active ;
            ${profile !== SPACE_REALM_PROFILE_V1 ? `rv:definitionProfile ${iri(profile)} ;` : ''}
            ${Array.isArray(topics) && topics.length ? `rv:topic ${topics.map(topic => iri(topic as string)).join(', ')} ;` : ''}
            rv:selectionPolicy ${iri(SELECTION_POLICY)} ;
            rv:membershipPolicy ${iri(MEMBERSHIP_POLICY)} ;
            rv:reviewPolicy ${iri(REVIEW_POLICY)} ; rv:head ${iri(realmRevision)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(spaceRevision)} a rv:RevisionAnchor ; rv:component ${iri(space)} ;
            rv:operation ${iri(operation)} ; rv:manifest ${iri(receipt.spaceManifest)} ;
            rv:modelRevision ${iri(profile)} ;
            rv:shapeRevision ${iri(profile)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
          ${iri(realmRevision)} a rv:RevisionAnchor ; rv:component ${iri(realm)} ;
            rv:operation ${iri(operation)} ; rv:manifest ${iri(receipt.realmManifest)} ;
            rv:modelRevision ${iri(profile)} ;
            rv:shapeRevision ${iri(profile)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ; rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:admittedScope ${lit(receipt.scope)} ;
            rv:outcome rv:Succeeded ; rv:space ${iri(space)} ; rv:realm ${iri(realm)} ;
            rv:spaceRevision ${iri(spaceRevision)} ; rv:realmRevision ${iri(realmRevision)} ;
            rv:owner ${iri(owner)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:SpaceCreatedEvent ; rv:ordinal 0 ;
            rv:action "space.create" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(operation)} ; rv:space ${iri(space)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(space)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(spaceRevision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(realmRevision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readSpaceCreationReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt,
        profile.split('/').at(-1)! as ProfileId, [
        { shape: `${profile}/space-shape`, focus: space },
        { shape: `${profile}/realm-shape`, focus: realm },
      ]); }
      catch (error) { updateError = error; }
    }
    const terminal = await readSpaceCreationReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(space)} a rv:Space ; rv:owner ${iri(owner)} ; rv:realmCapability ${iri(realm)} .
        ${iri(realm)} a rv:Realm ; rv:space ${iri(space)} ; rv:realmState rv:Active . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(spaceRevision)} a rv:RevisionAnchor ; rv:component ${iri(space)} ;
          rv:manifest ${iri(receipt.spaceManifest)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} .
        ${iri(realmRevision)} a rv:RevisionAnchor ; rv:component ${iri(realm)} ;
          rv:manifest ${iri(receipt.realmManifest)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:SpaceCreatedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const headCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH ${iri(GRAPHS.current)} {
            ${iri(space)} rv:head ${iri(spaceRevision)} .
            ${iri(realm)} rv:head ${iri(realmRevision)} . }
        }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.space !== space || terminal.realm !== realm
      || terminal.spaceRevision !== spaceRevision || terminal.realmRevision !== realmRevision
      || terminal.owner !== owner || terminal.dataEpoch !== coverage.dataEpoch
      || terminal.sequence !== sequence || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || headCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained Space update outcome is unknown' : 'retained Space did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, space, realm, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Reapply one retained private draft with its original identity and immutable bytes. */
export async function reconcileRetainedContributionDraftCreate(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; contribution: string; draftRevision: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.contribution.draft-created.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'contribution.create' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.work || !receipt.contribution
    || !receipt.draftRevision || !receipt.draftManifest || !receipt.author
    || !receipt.language || receipt.scope !== `contribution:create:${receipt.work}`
    || receipt.mainVersion || receipt.workRevision || receipt.mainRevision
    || receipt.expectedHead || receipt.reason
    || receipt.id !== textContributionReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained Contribution draft envelope is incomplete');
  }
  const work = receipt.work;
  const contribution = receipt.contribution;
  const draftRevision = receipt.draftRevision;
  const operation = receipt.operation;
  const author = receipt.author;
  const language = receipt.language;
  const draftManifest = receipt.draftManifest;
  for (const value of [eventId, data.batchId, receipt.id, work, contribution,
    draftRevision, operation, author]) iri(value);
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(draftManifest)) {
    throw new RetainedEffectConflict('retained Contribution manifest reference is invalid');
  }
  const state = readComponentState(env.objectDirectory, draftManifest,
    contribution, CONTRIBUTION_PROFILE);
  const content = retainedDocumentBody(state);
  if (state.work !== work || state.author !== author || state.language !== language
    || typeof state.body !== 'string' || state.publication !== 'draft'
    || textContributionDigest({ work, actingSubject: author, language,
      ...(content.document ? { document: content.document } : { body: content.body }) }) !== receipt.requestDigest) {
    throw new RetainedEffectConflict('retained Contribution payload differs from receipt');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'contribution.create' || admitted.state !== 'sealed'
      || admitted.acting_subject !== author || admitted.scope_id !== receipt.scope
      || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence) {
      throw new RetainedEffectConflict('current Access admission does not prove retained draft');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(work)} ;
            rv:author ${iri(author)} ; rv:language ${lit(language)} ;
            rv:draftHead ${iri(draftRevision)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(draftRevision)} a rv:RevisionAnchor ; rv:component ${iri(contribution)} ;
            rv:operation ${iri(operation)} ; rv:manifest ${iri(draftManifest)} ;
            rv:modelRevision ${iri(CONTRIBUTION_PROFILE)} ;
            rv:shapeRevision ${iri(CONTRIBUTION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} {
          ${privateDraftTriples(contribution, draftRevision, work, language, state.body)}
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
            rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Succeeded ;
            rv:work ${iri(work)} ; rv:contribution ${iri(contribution)} ;
            rv:draftRevision ${iri(draftRevision)} ; rv:language ${lit(language)} ;
            rv:author ${iri(author)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:ContributionDraftCreatedEvent ; rv:ordinal 0 ;
            rv:action "contribution.create" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(operation)} ; rv:work ${iri(work)} ;
            rv:contribution ${iri(contribution)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a schema:CreativeWork . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(contribution)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(draftRevision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readTextContributionReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt, 'text-contribution-v1', [
        { shape: `${CONTRIBUTION_PROFILE}/contribution-shape`, focus: contribution },
      ]); }
      catch (error) { updateError = error; }
    }
    const terminal = await readTextContributionReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(work)} ;
          rv:author ${iri(author)} ; rv:language ${lit(language)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(draftRevision)} a rv:RevisionAnchor ; rv:component ${iri(contribution)} ;
          rv:manifest ${iri(draftManifest)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:ContributionDraftCreatedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const headCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH ${iri(GRAPHS.current)} {
            ${iri(contribution)} rv:draftHead ${iri(draftRevision)} . }
          GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} {
            ${iri(privateDraftUnit(draftRevision))} a rv:MatchUnit ;
              rv:contribution ${iri(contribution)} ; rv:revision ${iri(draftRevision)} ;
              rv:field rv:Body ; rv:disclosure rv:Private ;
              rv:privateSearchBody ${lit(state.body)}@${language} . }
        }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.work !== work || terminal.contribution !== contribution
      || terminal.draftRevision !== draftRevision || terminal.author !== author
      || terminal.language !== language || terminal.dataEpoch !== coverage.dataEpoch
      || terminal.sequence !== sequence || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || headCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained draft update outcome is unknown' : 'retained draft did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, contribution, draftRevision, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Reapply one retained private draft edit against its exact previous head. */
export async function reconcileRetainedContributionDraftEdit(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; draftRevision: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.contribution.draft-edited.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'contribution.edit' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.work || !receipt.contribution
    || !receipt.draftRevision || !receipt.draftManifest || !receipt.expectedHead
    || !receipt.author || !receipt.language
    || receipt.scope !== `contribution:edit:${receipt.contribution}`
    || receipt.mainVersion || receipt.workRevision || receipt.mainRevision || receipt.reason
    || receipt.id !== textContributionEditReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained Contribution draft edit envelope is incomplete');
  }
  const work = receipt.work;
  const contribution = receipt.contribution;
  const draftRevision = receipt.draftRevision;
  const draftManifest = receipt.draftManifest;
  const expectedHead = receipt.expectedHead;
  const operation = receipt.operation;
  const author = receipt.author;
  const language = receipt.language;
  for (const value of [eventId, data.batchId, receipt.id, work, contribution,
    draftRevision, expectedHead, operation, author]) iri(value);
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(draftManifest)) {
    throw new RetainedEffectConflict('retained Contribution edit manifest is invalid');
  }
  const state = readComponentState(env.objectDirectory, draftManifest,
    contribution, CONTRIBUTION_PROFILE);
  const content = retainedDocumentBody(state);
  if (state.work !== work || state.author !== author || state.language !== language
    || typeof state.body !== 'string' || state.publication !== 'draft') {
    throw new RetainedEffectConflict('retained Contribution edit payload differs');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'contribution.edit' || admitted.state !== 'sealed'
      || admitted.scope_id !== receipt.scope
      || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || textContributionEditDigest({ contribution, expectedHead,
        ...(content.document ? { document: content.document } : { body: content.body }),
        actingSubject: admitted.acting_subject }) !== receipt.requestDigest) {
      throw new RetainedEffectConflict('current Access admission does not prove retained draft edit');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }
        GRAPH ${iri(GRAPHS.current)} { ${iri(contribution)} rv:draftHead ${iri(expectedHead)} }
        GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} { ${iri(privateDraftUnit(expectedHead))} ?oldProperty ?oldValue }
      }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} { ${iri(contribution)} rv:draftHead ${iri(draftRevision)} }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(draftRevision)} a rv:RevisionAnchor ; rv:component ${iri(contribution)} ;
            rv:predecessor ${iri(expectedHead)} ; rv:operation ${iri(operation)} ;
            rv:manifest ${iri(draftManifest)} ; rv:modelRevision ${iri(CONTRIBUTION_PROFILE)} ;
            rv:shapeRevision ${iri(CONTRIBUTION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} {
          ${privateDraftTriples(contribution, draftRevision, work, language, state.body)}
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
            rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Succeeded ;
            rv:work ${iri(work)} ; rv:contribution ${iri(contribution)} ;
            rv:draftRevision ${iri(draftRevision)} ; rv:expectedHead ${iri(expectedHead)} ;
            rv:author ${iri(author)} ; rv:language ${lit(language)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:ContributionDraftEditedEvent ; rv:ordinal 0 ;
            rv:action "contribution.edit" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(operation)} ; rv:work ${iri(work)} ;
            rv:contribution ${iri(contribution)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(work)} ;
            rv:author ${iri(author)} ; rv:language ${lit(language)} ;
            rv:draftHead ${iri(expectedHead)} .
          ${iri(work)} a schema:CreativeWork .
        }
        OPTIONAL { GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} {
          ${iri(privateDraftUnit(expectedHead))} ?oldProperty ?oldValue } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(draftRevision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readTextContributionEditReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt, 'text-contribution-v1', [
        { shape: `${CONTRIBUTION_PROFILE}/contribution-shape`, focus: contribution },
      ]); }
      catch (error) { updateError = error; }
    }
    const terminal = await readTextContributionEditReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(draftRevision)} a rv:RevisionAnchor ; rv:component ${iri(contribution)} ;
          rv:predecessor ${iri(expectedHead)} ; rv:operation ${iri(operation)} ;
          rv:manifest ${iri(draftManifest)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:ContributionDraftEditedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const headCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH ${iri(GRAPHS.current)} {
            ${iri(contribution)} rv:draftHead ${iri(draftRevision)} . }
          GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} {
            ${iri(privateDraftUnit(draftRevision))} a rv:MatchUnit ;
              rv:contribution ${iri(contribution)} ; rv:revision ${iri(draftRevision)} ;
              rv:field rv:Body ; rv:disclosure rv:Private ;
              rv:privateSearchBody ${lit(state.body)}@${language} . }
        }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.work !== work || terminal.contribution !== contribution
      || terminal.draftRevision !== draftRevision || terminal.expectedHead !== expectedHead
      || terminal.author !== author || terminal.language !== language
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || headCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained draft edit update outcome is unknown' : 'retained draft edit did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, draftRevision, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Reapply one contributor eligibility decision after an older graph restore. */
export async function reconcileRetainedContributionPublication(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; publicationDecision: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.contribution.eligibility-recorded.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'contribution.publish' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.work || !receipt.contribution
    || !receipt.publicationDecision || !receipt.publicationManifest || !receipt.selectedDraft
    || !receipt.author || !receipt.language || receipt.reason
    || receipt.scope !== `contribution:publish:${receipt.contribution}`
    || receipt.draftRevision || receipt.mainVersion || receipt.workRevision || receipt.mainRevision
    || receipt.id !== textPublicationReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained publication envelope is incomplete');
  }
  const contribution = receipt.contribution;
  const decision = receipt.publicationDecision;
  const selectedDraft = receipt.selectedDraft;
  const predecessor = receipt.expectedHead ?? null;
  const operation = receipt.operation;
  const work = receipt.work;
  const author = receipt.author;
  const language = receipt.language;
  for (const value of [eventId, data.batchId, receipt.id, contribution, decision,
    selectedDraft, operation, work, author, ...(predecessor ? [predecessor] : [])]) iri(value);
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.publicationManifest)) {
    throw new RetainedEffectConflict('retained publication manifest is invalid');
  }
  const state = readComponentState(env.objectDirectory, receipt.publicationManifest,
    contribution, PUBLICATION_PROFILE);
  if (state.contribution !== contribution || state.work !== work || state.author !== author
    || state.language !== language || state.selectedDraft !== selectedDraft
    || state.predecessor !== predecessor || state.rightsBasis !== 'original-contribution'
    || state.disclosure !== 'public') {
    throw new RetainedEffectConflict('retained publication payload differs');
  }
  const exact = await readExactContributionDraft(env, contribution, selectedDraft, async () => true);
  if (exact.work !== work || exact.author !== author || exact.language !== language) {
    throw new RetainedEffectConflict('selected draft identity differs');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'contribution.publish' || admitted.state !== 'sealed'
      || admitted.scope_id !== receipt.scope || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || admitted.acting_subject !== author
      || textPublicationDigest({ contribution, expectedDraftHead: selectedDraft,
        expectedPublicationHead: predecessor, rightsBasis: 'original-contribution',
        disclosure: 'public', actingSubject: admitted.acting_subject }) !== receipt.requestDigest) {
      throw new RetainedEffectConflict('current Access admission does not prove retained publication');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const predecessorTriple = predecessor ? `rv:predecessor ${iri(predecessor)} ;` : '';
    const receiptPredecessor = predecessor ? `rv:expectedHead ${iri(predecessor)} ;` : '';
    const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }
        GRAPH ${iri(GRAPHS.current)} { ${iri(contribution)} rv:publicationHead ?prior }
      }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} { ${iri(contribution)} rv:publicationHead ${iri(decision)} }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(decision)} a rv:PublicationDecision, rv:RevisionAnchor ;
            rv:component ${iri(contribution)} ; ${predecessorTriple}
            rv:operation ${iri(operation)} ; rv:contribution ${iri(contribution)} ;
            rv:work ${iri(work)} ; rv:author ${iri(author)} ; rv:language ${lit(language)} ;
            rv:selectedDraft ${iri(selectedDraft)} ; rv:rightsBasis rv:OriginalContribution ;
            rv:disclosure rv:Public ; rv:manifest ${iri(receipt.publicationManifest)} ;
            rv:modelRevision ${iri(PUBLICATION_PROFILE)} ;
            rv:shapeRevision ${iri(PUBLICATION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
            rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Succeeded ;
            rv:contribution ${iri(contribution)} ; rv:publicationDecision ${iri(decision)} ;
            rv:selectedDraft ${iri(selectedDraft)} ; ${receiptPredecessor}
            rv:work ${iri(work)} ; rv:author ${iri(author)} ; rv:language ${lit(language)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:ContributionEligibilityRecordedEvent ; rv:ordinal 0 ;
            rv:action "contribution.publish" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(operation)} ; rv:work ${iri(work)} ;
            rv:contribution ${iri(contribution)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(work)} ;
            rv:author ${iri(author)} ; rv:language ${lit(language)} ;
            rv:draftHead ${iri(selectedDraft)} .
          ${iri(work)} a schema:CreativeWork .
          OPTIONAL { ${iri(contribution)} rv:publicationHead ?prior }
        }
        FILTER(COALESCE(?prior, ${iri('urn:rezics:none')}) = ${iri(predecessor ?? 'urn:rezics:none')})
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readTextPublicationReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt, 'text-publication-v1', [
        { shape: `${PUBLICATION_PROFILE}/decision-shape`, focus: decision },
      ]); }
      catch (error) { updateError = error; }
    }
    const terminal = await readTextPublicationReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(decision)} a rv:PublicationDecision, rv:RevisionAnchor ;
          rv:component ${iri(contribution)} ; rv:operation ${iri(operation)} ;
          rv:selectedDraft ${iri(selectedDraft)} ; rv:manifest ${iri(receipt.publicationManifest)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:ContributionEligibilityRecordedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const headCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH ${iri(GRAPHS.current)} {
            ${iri(contribution)} rv:publicationHead ${iri(decision)} . }
        }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.contribution !== contribution || terminal.publicationDecision !== decision
      || terminal.selectedDraft !== selectedDraft || terminal.predecessor !== predecessor
      || terminal.work !== work || terminal.author !== author || terminal.language !== language
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || headCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained publication update outcome is unknown' : 'retained publication did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, publicationDecision: decision, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Reapply one exact Main default selection and its public text unit under hold. */
export async function reconcileRetainedMainSelection(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; selection: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.publication.selection-changed.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'publication.select' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.work || !receipt.mainVersion
    || !receipt.mainRevision || !receipt.mainManifest
    || !receipt.contribution || !receipt.publicationDecision || !receipt.selectedDraft
    || !receipt.selection || !receipt.selectionManifest || !receipt.matchUnit || !receipt.language
    || receipt.scope !== `publication:select:${receipt.mainVersion}` || receipt.reason
    || receipt.draftRevision || receipt.workRevision || receipt.author
    || receipt.id !== mainSelectionReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained Main selection envelope is incomplete');
  }
  const work = receipt.work;
  const main = receipt.mainVersion;
  const contribution = receipt.contribution;
  const decision = receipt.publicationDecision;
  const draft = receipt.selectedDraft;
  const selection = receipt.selection;
  const mainRevision = receipt.mainRevision;
  const unit = receipt.matchUnit;
  const language = receipt.language;
  const operation = receipt.operation;
  const predecessor = receipt.expectedHead ?? null;
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) {
    throw new RetainedEffectConflict('retained Main selection language is invalid');
  }
  for (const value of [eventId, data.batchId, receipt.id, work, main, contribution,
    decision, draft, selection, mainRevision, unit, operation,
    ...(predecessor ? [predecessor] : [])]) iri(value);
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.selectionManifest)
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.mainManifest)) {
    throw new RetainedEffectConflict('retained Main selection manifest is invalid');
  }
  const state = readComponentState(env.objectDirectory, receipt.selectionManifest,
    main, MAIN_SELECTION_PROFILE);
  const context = state.context as { kind?: string; id?: string } | undefined;
  if (context?.kind !== 'main-version-default' || context.id !== main
    || state.work !== work || state.contribution !== contribution
    || state.publicationDecision !== decision || state.selectedDraft !== draft
    || state.language !== language || state.selectionBasis !== 'main-maintainer'
    || state.selectionMode !== 'fixed' || state.predecessor !== predecessor
    || state.matchUnit !== unit) {
    throw new RetainedEffectConflict('retained Main selection payload differs');
  }
  const mainState = await readWorkComponentState(env, receipt.mainManifest, main);
  const mainPredecessor = mainState.predecessor;
  if (mainState.work !== work || mainState.hostingPolicy !== 'metadata-only'
    || mainState.defaultSelection !== selection || typeof mainPredecessor !== 'string') {
    throw new RetainedEffectConflict('retained Main Version payload differs');
  }
  iri(mainPredecessor);
  const languageMap = mainState.defaultSelections;
  if (languageMap !== undefined && (!languageMap || typeof languageMap !== 'object'
    || Array.isArray(languageMap)
    || (languageMap as Record<string, unknown>)[language.toLowerCase()] !== selection)) {
    throw new RetainedEffectConflict('retained Main language map differs');
  }
  if (languageMap && !await readMainSelectionReceipt(env, receipt.admissionId)) {
    const expected = Object.fromEntries((await readMainLanguageHeads(env, main))
      .map(head => [head.language.toLowerCase(), head.selection]));
    expected[language.toLowerCase()] = selection;
    const normalized = (value: object) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    if (normalized(languageMap) !== normalized(expected)) {
      throw new RetainedEffectConflict('retained Main language map loses another head');
    }
  }
  const exact = await readExactContributionDraft(env, contribution, draft, async () => true);
  if (exact.work !== work || exact.language !== language) {
    throw new RetainedEffectConflict('retained Main selected draft differs');
  }
  const eligible = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} rv:mainVersion ${iri(main)} .
      ${iri(main)} a rv:MainVersion ; rv:work ${iri(work)} .
      ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(work)} ;
        rv:publicationHead ${iri(decision)} .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(decision)} a rv:PublicationDecision ; rv:component ${iri(contribution)} ;
        rv:selectedDraft ${iri(draft)} ; rv:rightsBasis rv:OriginalContribution ;
        rv:disclosure rv:Public .
    }
  }`);
  if (eligible.boolean !== true) throw new RetainedEffectConflict('selected publication is not eligible');
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'publication.select' || admitted.state !== 'sealed'
      || admitted.scope_id !== receipt.scope || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || mainSelectionDigest({ context: { kind: 'main-version-default', id: main },
        work, contribution, publicationDecision: decision, expectedSelectionHead: predecessor,
        selectionBasis: 'main-maintainer', actingSubject: admitted.acting_subject })
        !== receipt.requestDigest) {
      throw new RetainedEffectConflict('current Access admission does not prove retained selection');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const predecessorTriple = predecessor ? `rv:predecessor ${iri(predecessor)} ;` : '';
    const receiptPredecessor = predecessor ? `rv:expectedHead ${iri(predecessor)} ;` : '';
    const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }
        GRAPH ${iri(GRAPHS.current)} { ${iri(main)} rv:selectionHead ?prior ;
          rv:head ${iri(mainPredecessor)} }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?oldUnit ?oldPredicate ?oldValue }
      }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} { ${iri(main)} rv:selectionHead ${iri(selection)} ;
          rv:head ${iri(mainRevision)} }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(mainRevision)} a rv:RevisionAnchor ; rv:component ${iri(main)} ;
            rv:predecessor ${iri(mainPredecessor)} ; rv:operation ${iri(operation)} ;
            rv:manifest ${iri(receipt.mainManifest)} ; rv:modelRevision ${iri(PROFILE)} ;
            rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
          ${iri(selection)} a rv:PublicationSelection, rv:RevisionAnchor ;
            rv:component ${iri(main)} ; ${predecessorTriple}
            rv:operation ${iri(operation)} ; rv:context ${iri(main)} ;
            rv:work ${iri(work)} ; rv:mainVersion ${iri(main)} ;
            rv:mainRevision ${iri(mainRevision)} ;
            rv:contribution ${iri(contribution)} ; rv:publicationDecision ${iri(decision)} ;
            rv:selectedDraft ${iri(draft)} ; rv:language ${lit(language)} ;
            rv:selectionBasis rv:MainMaintainer ; rv:selectionMode rv:Fixed ;
            rv:matchUnit ${iri(unit)} ; rv:manifest ${iri(receipt.selectionManifest)} ;
            rv:modelRevision ${iri(MAIN_SELECTION_PROFILE)} ;
            rv:shapeRevision ${iri(MAIN_SELECTION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ${iri(unit)} a rv:MatchUnit ; rv:work ${iri(work)} ; rv:mainVersion ${iri(main)} ;
            rv:context ${iri(main)} ; rv:contribution ${iri(contribution)} ;
            rv:revision ${iri(draft)} ; rv:selection ${iri(selection)} ;
            rv:language ${lit(language)} ; rv:field rv:Body ; rv:disclosure rv:Public ;
            rv:searchBody ${lit(exact.body)}@${language} ; rv:publicTitle ?title .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
            rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Succeeded ;
            rv:work ${iri(work)} ; rv:mainVersion ${iri(main)} ;
            rv:mainRevision ${iri(mainRevision)} ;
            rv:contribution ${iri(contribution)} ; rv:publicationDecision ${iri(decision)} ;
            rv:selectedDraft ${iri(draft)} ; rv:selection ${iri(selection)} ;
            rv:matchUnit ${iri(unit)} ; ${receiptPredecessor}
            rv:language ${lit(language)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:PublicationSelectionChangedEvent ; rv:ordinal 0 ;
            rv:action "publication.select" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(operation)} ; rv:work ${iri(work)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(work)} a schema:CreativeWork ; rv:mainVersion ${iri(main)} ;
            <http://www.w3.org/2000/01/rdf-schema#label> ?title .
          ${iri(main)} a rv:MainVersion ; rv:work ${iri(work)} ;
            rv:head ${iri(mainPredecessor)} ; rv:hostingPolicy rv:MetadataOnly .
          ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(work)} ;
            rv:publicationHead ${iri(decision)} .
          ${languageMap ? languagePrior(main, decision) : `OPTIONAL { ${iri(main)} rv:selectionHead ?prior }`}
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(mainPredecessor)} a rv:RevisionAnchor ; rv:component ${iri(main)} .
          ${iri(decision)} a rv:PublicationDecision ; rv:component ${iri(contribution)} ;
            rv:selectedDraft ${iri(draft)} ; rv:rightsBasis rv:OriginalContribution ;
            rv:disclosure rv:Public .
          ${iri(draft)} a rv:RevisionAnchor ; rv:component ${iri(contribution)} .
        }
        ${predecessor ? `OPTIONAL {
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(predecessor)} rv:matchUnit ?oldUnit }
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
            ?oldUnit a rv:MatchUnit ; rv:mainVersion ${iri(main)} ; rv:selection ${iri(predecessor)} .
            ?oldUnit ?oldPredicate ?oldValue .
          }
        }` : ''}
        FILTER(COALESCE(?prior, ${iri('urn:rezics:none')}) = ${iri(predecessor ?? 'urn:rezics:none')})
        FILTER(!BOUND(?prior) || BOUND(?oldUnit))
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(selection)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(mainRevision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readMainSelectionReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt, 'main-default-selection-v1', [
        { shape: `${MAIN_SELECTION_PROFILE}/selection-shape`, focus: selection },
      ]); }
      catch (error) { updateError = error; }
    }
    const terminal = await readMainSelectionReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(mainRevision)} a rv:RevisionAnchor ; rv:component ${iri(main)} ;
          rv:predecessor ${iri(mainPredecessor)} ; rv:operation ${iri(operation)} ;
          rv:manifest ${iri(receipt.mainManifest)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        ${iri(selection)} a rv:PublicationSelection, rv:RevisionAnchor ;
          rv:component ${iri(main)} ; rv:operation ${iri(operation)} ;
          rv:selectedDraft ${iri(draft)} ; rv:matchUnit ${iri(unit)} ;
          rv:manifest ${iri(receipt.selectionManifest)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:PublicationSelectionChangedEvent ; rv:receipt ${iri(receipt.id)} . }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(unit)} a rv:MatchUnit ; rv:selection ${iri(selection)} ;
          rv:mainVersion ${iri(main)} ; rv:searchBody ${lit(exact.body)}@${language} ;
          rv:publicTitle ?title . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(work)} <http://www.w3.org/2000/01/rdf-schema#label> ?title . }
    }`);
    const headCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH ${iri(GRAPHS.current)} { ${iri(main)} rv:selectionHead ${iri(selection)} ;
            rv:head ${iri(mainRevision)} }
        }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.work !== work || terminal.mainVersion !== main
      || terminal.mainRevision !== mainRevision
      || terminal.contribution !== contribution || terminal.publicationDecision !== decision
      || terminal.selectedDraft !== draft || terminal.selection !== selection
      || terminal.matchUnit !== unit || terminal.expectedHead !== predecessor
      || terminal.language !== language || terminal.dataEpoch !== coverage.dataEpoch
      || terminal.sequence !== sequence || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || headCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained selection update outcome is unknown' : 'retained selection did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, selection, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Reapply one exact Realm adoption and its public text unit under hold. */
export async function reconcileRetainedRealmSelection(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; selection: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.realm.selection-changed.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'publication.adopt' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.work || !receipt.mainVersion || !receipt.realm
    || !receipt.slot || !receipt.contribution || !receipt.publicationDecision
    || !receipt.selectedDraft || !receipt.selection || !receipt.selectionManifest
    || !receipt.matchUnit || !receipt.language
    || receipt.scope !== `publication:adopt:${receipt.realm}` || receipt.reason
    || receipt.space || receipt.spaceRevision || receipt.realmRevision || receipt.owner
    || receipt.id !== realmSelectionReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained Realm selection envelope is incomplete');
  }
  const work = receipt.work;
  const main = receipt.mainVersion;
  const realm = receipt.realm;
  const slot = receipt.slot;
  const contribution = receipt.contribution;
  const decision = receipt.publicationDecision;
  const draft = receipt.selectedDraft;
  const selection = receipt.selection;
  const unit = receipt.matchUnit;
  const language = receipt.language;
  const operation = receipt.operation;
  const predecessor = receipt.expectedHead ?? null;
  if (slot !== realmSelectionSlotIri(realm, main)
    || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) {
    throw new RetainedEffectConflict('retained Realm selection slot or language is invalid');
  }
  for (const value of [eventId, data.batchId, receipt.id, work, main, realm, slot,
    contribution, decision, draft, selection, unit, operation,
    ...(predecessor ? [predecessor] : [])]) iri(value);
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.selectionManifest)) {
    throw new RetainedEffectConflict('retained Realm selection manifest is invalid');
  }
  const state = readComponentState(env.objectDirectory, receipt.selectionManifest,
    slot, REALM_SELECTION_PROFILE);
  const rawMedia = state.media;
  const media = rawMedia && typeof rawMedia === 'object' && !Array.isArray(rawMedia)
    ? rawMedia as { variantId?: unknown; publicationDecision?: unknown;
      revisionId?: unknown; byteDigest?: unknown } : null;
  if (rawMedia !== undefined && (!media
    || typeof media.variantId !== 'string'
    || !/^urn:rezics:variant:[0-9a-f-]{36}$/.test(media.variantId)
    || typeof media.publicationDecision !== 'string'
    || !/^urn:rezics:content-publication:[0-9a-f]{64}$/.test(media.publicationDecision)
    || typeof media.revisionId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(media.revisionId)
    || typeof media.byteDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(media.byteDigest))) {
    throw new RetainedEffectConflict('retained Realm media reference is invalid');
  }
  const mediaRef = media as { variantId: string; publicationDecision: string;
    revisionId: string; byteDigest: string } | null;
  const context = state.context as { kind?: string; id?: string } | undefined;
  if (context?.kind !== 'realm-local' || context.id !== realm
    || state.slot !== slot || state.work !== work || state.mainVersion !== main
    || state.contribution !== contribution || state.publicationDecision !== decision
    || state.selectedDraft !== draft || state.language !== language
    || state.selectionBasis !== 'realm-manager-review' || state.selectionMode !== 'fixed'
    || state.reviewPolicy !== REVIEW_POLICY || state.selectionPolicy !== SELECTION_POLICY
    || state.predecessor !== predecessor || state.matchUnit !== unit
    || typeof state.reviewer !== 'string') {
    throw new RetainedEffectConflict('retained Realm selection payload differs');
  }
  const exact = await readExactContributionDraft(env, contribution, draft, async () => true);
  if (exact.work !== work || exact.language !== language) {
    throw new RetainedEffectConflict('retained Realm selected draft differs');
  }
  const eligible = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} {
      ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
      ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
        rv:selectionPolicy ${iri(SELECTION_POLICY)} ; rv:reviewPolicy ${iri(REVIEW_POLICY)} .
      ${iri(work)} rv:mainVersion ${iri(main)} .
      ${iri(main)} a rv:MainVersion ; rv:work ${iri(work)} .
      ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(work)} ;
        rv:publicationHead ${iri(decision)} .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(decision)} a rv:PublicationDecision ; rv:component ${iri(contribution)} ;
        rv:selectedDraft ${iri(draft)} ; rv:rightsBasis rv:OriginalContribution ;
        rv:disclosure rv:Public .
    }
    ${mediaRef ? `GRAPH ${iri(GRAPHS.current)} {
      ${iri(mediaRef.variantId)} a rv:ContentVariant ; rv:resource ${iri(work)} ;
        rv:contentPublicationHead ${iri(mediaRef.publicationDecision)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(mediaRef.publicationDecision)} a rv:ContentPublicationDecision ;
          rv:component ${iri(mediaRef.variantId)} ; rv:resource ${iri(work)} ;
          rv:contentModel "media-set-v1" ;
          rv:contentRevision ${iri(`urn:rezics:content:revision:${mediaRef.revisionId}`)} ;
          rv:byteDigest ${lit(mediaRef.byteDigest)} . }` : ''}
  }`);
  if (eligible.boolean !== true) throw new RetainedEffectConflict('Realm publication is not eligible');
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'publication.adopt' || admitted.state !== 'sealed'
      || admitted.acting_subject !== state.reviewer
      || admitted.scope_id !== receipt.scope || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || realmSelectionDigest({ context: { kind: 'realm-local', id: realm },
        work, mainVersion: main, contribution, publicationDecision: decision,
        ...(mediaRef ? { media: { variantId: mediaRef.variantId,
          publicationDecision: mediaRef.publicationDecision } } : {}),
        expectedSelectionHead: predecessor, selectionBasis: 'realm-manager-review',
        actingSubject: admitted.acting_subject }) !== receipt.requestDigest) {
      throw new RetainedEffectConflict('current Access admission does not prove Realm adoption');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const predecessorTriple = predecessor ? `rv:predecessor ${iri(predecessor)} ;` : '';
    const receiptPredecessor = predecessor ? `rv:expectedHead ${iri(predecessor)} ;` : '';
    const mediaTriple = mediaRef ? `rv:mediaVariant ${iri(mediaRef.variantId)} ;
      rv:mediaPublicationDecision ${iri(mediaRef.publicationDecision)} ;
      rv:mediaRevision ${iri(`urn:rezics:content:revision:${mediaRef.revisionId}`)} ;
      rv:mediaDigest ${lit(mediaRef.byteDigest)} ;` : '';
    const mediaGuard = mediaRef ? `GRAPH ${iri(GRAPHS.current)} {
        ${iri(mediaRef.variantId)} a rv:ContentVariant ; rv:resource ${iri(work)} ;
          rv:contentPublicationHead ${iri(mediaRef.publicationDecision)} . }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(mediaRef.publicationDecision)} a rv:ContentPublicationDecision ;
            rv:component ${iri(mediaRef.variantId)} ; rv:resource ${iri(work)} ;
            rv:contentModel "media-set-v1" ;
            rv:contentRevision ${iri(`urn:rezics:content:revision:${mediaRef.revisionId}`)} ;
            rv:byteDigest ${lit(mediaRef.byteDigest)} . }` : '';
    const update = `PREFIX rv: <${RV}>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }
        GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:selectionHead ?prior }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?oldUnit ?oldPredicate ?oldValue }
      }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(slot)} a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ;
            rv:mainVersion ${iri(main)} ; rv:work ${iri(work)} ;
            rv:selectionHead ${iri(selection)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(selection)} a rv:PublicationSelection, rv:RevisionAnchor ;
            rv:component ${iri(slot)} ; ${predecessorTriple}
            rv:operation ${iri(operation)} ; rv:context ${iri(realm)} ; rv:slot ${iri(slot)} ;
            rv:work ${iri(work)} ; rv:mainVersion ${iri(main)} ;
            rv:contribution ${iri(contribution)} ; rv:publicationDecision ${iri(decision)} ;
            ${mediaTriple}
            rv:selectedDraft ${iri(draft)} ; rv:language ${lit(language)} ;
            rv:selectionBasis rv:RealmManagerReview ; rv:selectionMode rv:Fixed ;
            rv:reviewPolicy ${iri(REVIEW_POLICY)} ; rv:reviewer ${iri(admitted.acting_subject)} ;
            rv:matchUnit ${iri(unit)} ; rv:manifest ${iri(receipt.selectionManifest)} ;
            rv:modelRevision ${iri(REALM_SELECTION_PROFILE)} ;
            rv:shapeRevision ${iri(REALM_SELECTION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ${iri(unit)} a rv:MatchUnit ; rv:work ${iri(work)} ; rv:mainVersion ${iri(main)} ;
            rv:context ${iri(realm)} ; rv:realm ${iri(realm)} ; rv:slot ${iri(slot)} ;
            rv:contribution ${iri(contribution)} ; rv:revision ${iri(draft)} ;
            rv:selection ${iri(selection)} ; rv:language ${lit(language)} ;
            rv:field rv:Body ; rv:disclosure rv:Public ;
            rv:searchBody ${lit(exact.body)}@${language} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ; rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:admittedScope ${lit(receipt.scope)} ;
            rv:outcome rv:Succeeded ; rv:work ${iri(work)} ; rv:mainVersion ${iri(main)} ;
            rv:realm ${iri(realm)} ; rv:slot ${iri(slot)} ; rv:contribution ${iri(contribution)} ;
            rv:publicationDecision ${iri(decision)} ; rv:selectedDraft ${iri(draft)} ;
            rv:selection ${iri(selection)} ; rv:matchUnit ${iri(unit)} ; ${receiptPredecessor}
            rv:language ${lit(language)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:RealmSelectionChangedEvent ; rv:ordinal 0 ;
            rv:action "publication.adopt" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(operation)} ; rv:work ${iri(work)} ; rv:realm ${iri(realm)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
          ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
            rv:selectionPolicy ${iri(SELECTION_POLICY)} ; rv:reviewPolicy ${iri(REVIEW_POLICY)} .
          ${iri(work)} rv:mainVersion ${iri(main)} .
          ${iri(main)} a rv:MainVersion ; rv:work ${iri(work)} .
          ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(work)} ;
            rv:publicationHead ${iri(decision)} .
          OPTIONAL { ${iri(slot)} rv:selectionHead ?prior }
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(decision)} a rv:PublicationDecision ; rv:component ${iri(contribution)} ;
            rv:selectedDraft ${iri(draft)} ; rv:rightsBasis rv:OriginalContribution ;
            rv:disclosure rv:Public .
          ${iri(draft)} a rv:RevisionAnchor ; rv:component ${iri(contribution)} .
        }
        ${mediaGuard}
        OPTIONAL {
          FILTER(BOUND(?prior))
          GRAPH ${iri(GRAPHS.revisions)} { ?prior rv:matchUnit ?oldUnit ; rv:slot ${iri(slot)} }
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
            ?oldUnit a rv:MatchUnit ; rv:slot ${iri(slot)} ; rv:selection ?prior .
            ?oldUnit ?oldPredicate ?oldValue .
          }
        }
        OPTIONAL {
          FILTER(BOUND(?prior))
          GRAPH ${iri(GRAPHS.revisions)} {
            ?prior a rv:RealmPublicationRejection ; rv:slot ${iri(slot)} .
          }
          BIND(true AS ?priorRejected)
        }
        FILTER(COALESCE(?prior, ${iri('urn:rezics:none')}) = ${iri(predecessor ?? 'urn:rezics:none')})
        FILTER(!BOUND(?prior) || (BOUND(?oldUnit) != BOUND(?priorRejected)))
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(selection)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readRealmSelectionReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt, 'realm-local-selection-v1', [
        { shape: `${REALM_SELECTION_PROFILE}/selection-shape`, focus: selection },
      ]); }
      catch (error) { updateError = error; }
    }
    const terminal = await readRealmSelectionReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(selection)} a rv:PublicationSelection, rv:RevisionAnchor ;
          rv:component ${iri(slot)} ; rv:operation ${iri(operation)} ;
          rv:selectedDraft ${iri(draft)} ; rv:matchUnit ${iri(unit)} ;
          ${mediaTriple}
          rv:manifest ${iri(receipt.selectionManifest)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:RealmSelectionChangedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const headRows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:selectionHead ?head }
    }`)).results?.bindings ?? [];
    const currentHead = headRows.length === 1 ? headRows[0]?.head?.value : null;
    const unitCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(unit)} a rv:MatchUnit ; rv:selection ${iri(selection)} ;
          rv:realm ${iri(realm)} ; rv:slot ${iri(slot)} ;
          rv:searchBody ${lit(exact.body)}@${language} . }
    }`);
    const oldUnitRemaining = currentHead !== selection
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(unit)} ?p ?o }
        }`)
      : { boolean: false };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.work !== work || terminal.mainVersion !== main || terminal.realm !== realm
      || terminal.slot !== slot || terminal.contribution !== contribution
      || terminal.publicationDecision !== decision || terminal.selectedDraft !== draft
      || terminal.selection !== selection || terminal.matchUnit !== unit
      || terminal.expectedHead !== predecessor || terminal.language !== language
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || !currentHead
      || (cursor === BigInt(sequence) && currentHead !== selection)
      || (currentHead === selection && unitCheck.boolean !== true)
      || oldUnitRemaining.boolean === true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained Realm selection update outcome is unknown'
        : 'retained Realm selection did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, selection, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Reapply an explicit Realm suppression under the graph recovery hold. */
export async function reconcileRetainedRealmRejection(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; rejection: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.realm.publication-suppressed.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || !['publication.reject', ORGANIZATION_MODERATION_ACTION].includes(receipt.action) || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.work || !receipt.mainVersion || !receipt.realm
    || !receipt.slot || !receipt.rejection || !receipt.rejectionManifest
    || receipt.reasonCode !== 'not-approved'
    || receipt.scope !== `publication:reject:${receipt.realm}` || receipt.reason
    || receipt.contribution || receipt.selection || receipt.matchUnit
    || receipt.space || receipt.spaceRevision || receipt.realmRevision || receipt.owner
    || receipt.id !== realmRejectionReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained Realm suppression envelope is incomplete');
  }
  const work = receipt.work;
  const main = receipt.mainVersion;
  const realm = receipt.realm;
  const slot = receipt.slot;
  const rejection = receipt.rejection;
  const operation = receipt.operation;
  const predecessor = receipt.expectedHead ?? null;
  if (slot !== realmSelectionSlotIri(realm, main)
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.rejectionManifest)) {
    throw new RetainedEffectConflict('retained Realm suppression slot or manifest is invalid');
  }
  for (const value of [eventId, data.batchId, receipt.id, work, main, realm, slot,
    rejection, operation, ...(predecessor ? [predecessor] : [])]) iri(value);
  const state = readComponentState(env.objectDirectory, receipt.rejectionManifest,
    slot, REALM_REJECTION_PROFILE);
  const context = state.context as { kind?: string; id?: string } | undefined;
  if (context?.kind !== 'realm-local' || context.id !== realm
    || state.slot !== slot || state.work !== work || state.mainVersion !== main
    || state.decisionBasis !== 'realm-manager-review'
    || state.reasonCode !== 'not-approved' || state.outcome !== 'rejected'
    || state.reviewPolicy !== REVIEW_POLICY || state.selectionPolicy !== SELECTION_POLICY
    || state.predecessor !== predecessor || typeof state.reviewer !== 'string') {
    throw new RetainedEffectConflict('retained Realm suppression payload differs');
  }
  const organization = state.organizationPublication as OrganizationPublicationTarget | undefined;
  if ((receipt.action === ORGANIZATION_MODERATION_ACTION) !== !!organization
    || (organization && (typeof state.authorityProofDigest !== 'string'
      || organization.realm !== realm || organization.work !== work || organization.mainVersion !== main
      || organization.selection !== predecessor || organization.actingSubject !== state.reviewer))) {
    throw new RetainedEffectConflict('retained organization suppression identity differs');
  }
  const eligible = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} {
      ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
      ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
        rv:selectionPolicy ${iri(SELECTION_POLICY)} ; rv:reviewPolicy ${iri(REVIEW_POLICY)} .
      ${iri(work)} rv:mainVersion ${iri(main)} .
      ${iri(main)} a rv:MainVersion ; rv:work ${iri(work)} .
    }
  }`);
  if (eligible.boolean !== true) {
    throw new RetainedEffectConflict('Realm or Main Version is unavailable for suppression');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== receipt.action || admitted.state !== 'sealed'
      || admitted.acting_subject !== state.reviewer
      || admitted.scope_id !== receipt.scope || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || realmRejectionDigest({ context: { kind: 'realm-local', id: realm },
        work, mainVersion: main, expectedSelectionHead: predecessor,
        decisionBasis: 'realm-manager-review', reasonCode: 'not-approved',
        actingSubject: admitted.acting_subject, ...(organization ? { organizationPublication: organization } : {}) }) !== receipt.requestDigest) {
      throw new RetainedEffectConflict('current Access admission does not prove Realm suppression');
    }
    if (organization) await assertRetainedOrganizationModeration(client, receipt.admissionId,
      organization, state.authorityProofDigest as string);
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const predecessorTriple = predecessor ? `rv:predecessor ${iri(predecessor)} ;` : '';
    const receiptPredecessor = predecessor ? `rv:expectedHead ${iri(predecessor)} ;` : '';
    const update = `PREFIX rv: <${RV}>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }
        GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:selectionHead ?prior }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?oldUnit ?oldPredicate ?oldValue }
      }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(slot)} a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ;
            rv:mainVersion ${iri(main)} ; rv:work ${iri(work)} ;
            rv:selectionHead ${iri(rejection)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(rejection)} a rv:RealmPublicationRejection, rv:RevisionAnchor ;
            rv:component ${iri(slot)} ; ${predecessorTriple}
            rv:operation ${iri(operation)} ; rv:context ${iri(realm)} ; rv:slot ${iri(slot)} ;
            rv:work ${iri(work)} ; rv:mainVersion ${iri(main)} ;
            rv:decisionBasis rv:RealmManagerReview ; rv:reasonCode rv:NotApproved ;
            rv:selectionPolicy ${iri(SELECTION_POLICY)} ;
            rv:reviewPolicy ${iri(REVIEW_POLICY)} ; rv:reviewer ${iri(admitted.acting_subject)} ;
            rv:outcome rv:Rejected ; rv:manifest ${iri(receipt.rejectionManifest)} ;
            rv:modelRevision ${iri(REALM_REJECTION_PROFILE)} ;
            rv:shapeRevision ${iri(REALM_REJECTION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ; rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:admittedScope ${lit(receipt.scope)} ;
            rv:outcome rv:Succeeded ; rv:work ${iri(work)} ; rv:mainVersion ${iri(main)} ;
            rv:realm ${iri(realm)} ; rv:slot ${iri(slot)} ;
            rv:rejection ${iri(rejection)} ; rv:reasonCode rv:NotApproved ; ${receiptPredecessor}
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:RealmPublicationSuppressedEvent ; rv:ordinal 0 ;
            rv:action ${lit(receipt.action)} ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(operation)} ; rv:work ${iri(work)} ; rv:realm ${iri(realm)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
          ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
            rv:selectionPolicy ${iri(SELECTION_POLICY)} ; rv:reviewPolicy ${iri(REVIEW_POLICY)} .
          ${iri(work)} rv:mainVersion ${iri(main)} .
          ${iri(main)} a rv:MainVersion ; rv:work ${iri(work)} .
          OPTIONAL { ${iri(slot)} rv:selectionHead ?prior }
        }
        OPTIONAL {
          FILTER(BOUND(?prior))
          GRAPH ${iri(GRAPHS.revisions)} { ?prior rv:matchUnit ?oldUnit ; rv:slot ${iri(slot)} }
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
            ?oldUnit a rv:MatchUnit ; rv:slot ${iri(slot)} ; rv:selection ?prior .
            ?oldUnit ?oldPredicate ?oldValue .
          }
        }
        OPTIONAL {
          FILTER(BOUND(?prior))
          GRAPH ${iri(GRAPHS.revisions)} {
            ?prior a rv:RealmPublicationRejection ; rv:slot ${iri(slot)} .
          }
          BIND(true AS ?priorRejected)
        }
        FILTER(COALESCE(?prior, ${iri('urn:rezics:none')}) = ${iri(predecessor ?? 'urn:rezics:none')})
        ${organization ? organizationPublicationGuard(organization) : ''}
        FILTER(!BOUND(?prior) || (BOUND(?oldUnit) != BOUND(?priorRejected)))
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(rejection)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readRealmRejectionReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt, 'realm-local-rejection-v1', [
        { shape: `${REALM_REJECTION_PROFILE}/rejection-shape`, focus: rejection },
      ]); }
      catch (error) { updateError = error; }
    }
    const terminal = await readRealmRejectionReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(rejection)} a rv:RealmPublicationRejection, rv:RevisionAnchor ;
          rv:component ${iri(slot)} ; rv:operation ${iri(operation)} ;
          rv:manifest ${iri(receipt.rejectionManifest)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:RealmPublicationSuppressedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const headRows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:selectionHead ?head }
    }`)).results?.bindings ?? [];
    const currentHead = headRows.length === 1 ? headRows[0]?.head?.value : null;
    const remainingLocalUnit = currentHead === rejection
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
            ?unit a rv:MatchUnit ; rv:slot ${iri(slot)} . }
        }`)
      : { boolean: false };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.work !== work || terminal.mainVersion !== main || terminal.realm !== realm
      || terminal.slot !== slot || terminal.rejection !== rejection
      || terminal.expectedHead !== predecessor || terminal.reasonCode !== 'not-approved'
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || !currentHead
      || (cursor === BigInt(sequence) && currentHead !== rejection)
      || remainingLocalUnit.boolean === true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained Realm suppression update outcome is unknown'
        : 'retained Realm suppression did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, rejection, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Restore one terminal cancellation/rejection without creating a domain effect. */
export async function reconcileRetainedAdmissionCancellation(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; reason?: 'stale-head'; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  const workRejected = envelope.type === 'com.rezics.work.edit-rejected.v1';
  const contributionRejected = envelope.type === 'com.rezics.contribution.draft-edit-rejected.v1';
  const publicationRejected = envelope.type === 'com.rezics.contribution.publication-rejected.v1';
  const selectionRejected = envelope.type === 'com.rezics.publication.selection-rejected.v1';
  const rejected = workRejected || contributionRejected || publicationRejected || selectionRejected;
  const cancelled = envelope.type === 'com.rezics.work.admission-cancelled.v1';
  const contributionCancelled = envelope.type === 'com.rezics.contribution.admission-cancelled.v1';
  const publicationCancelled = envelope.type === 'com.rezics.contribution.publication-cancelled.v1';
  const selectionCancelled = envelope.type === 'com.rezics.publication.selection-cancelled.v1';
  const spaceCancelled = envelope.type === 'com.rezics.space.creation-cancelled.v1';
  const realmRejected = envelope.type === 'com.rezics.realm.selection-rejected.v1';
  const realmCancelled = envelope.type === 'com.rezics.realm.selection-cancelled.v1';
  const suppressionRejected = envelope.type === 'com.rezics.realm.suppression-rejected.v1';
  const suppressionCancelled = envelope.type === 'com.rezics.realm.suppression-cancelled.v1';
  const contextCancelled = envelope.type === 'com.rezics.classification.context-cancelled.v1';
  const propositionCancelled = envelope.type === 'com.rezics.classification.proposition-cancelled.v1';
  const decisionStale = envelope.type === 'com.rezics.classification.decision-stale.v1';
  const decisionCancelled = envelope.type === 'com.rezics.classification.decision-cancelled.v1';
  const ratingContextCancelled = envelope.type === 'com.rezics.rating.context-cancelled.v1';
  const ratingPolicyStale = envelope.type === 'com.rezics.rating.policy-stale.v1';
  const ratingPolicyCancelled = envelope.type === 'com.rezics.rating.policy-cancelled.v1';
  const ratingObservationStale = envelope.type === 'com.rezics.rating.observation-stale.v1';
  const ratingObservationCancelled = envelope.type === 'com.rezics.rating.observation-cancelled.v1';
  const terminalRejected = rejected || realmRejected || suppressionRejected || decisionStale
    || ratingObservationStale || ratingPolicyStale;
  const suffix = terminalRejected ? 'stale' : 'cancel';
  const expectedEvent = receipt?.id && `urn:rezics:event:${hash(`${receipt.id}\0${suffix}`)}`;
  const expectedReceipt = receipt?.action === 'work.create'
    ? workReceiptIri(receipt.admissionId) : receipt?.action === 'work.edit'
      ? workEditReceiptIri(receipt.admissionId) : receipt?.action === 'contribution.create'
        ? textContributionReceiptIri(receipt.admissionId) : receipt?.action === 'contribution.edit'
          ? textContributionEditReceiptIri(receipt.admissionId) : receipt?.action === 'contribution.publish'
            ? textPublicationReceiptIri(receipt.admissionId) : receipt?.action === 'publication.select'
              ? mainSelectionReceiptIri(receipt.admissionId) : receipt?.action === 'space.create'
                ? spaceCreationReceiptIri(receipt.admissionId)
                : receipt?.action === 'publication.adopt'
                  ? realmSelectionReceiptIri(receipt.admissionId)
                  : receipt?.action === 'publication.reject' || receipt?.action === ORGANIZATION_MODERATION_ACTION
                    ? realmRejectionReceiptIri(receipt.admissionId)
                    : receipt?.action === 'classification.context.configure'
                      ? classificationContextReceiptIri(receipt.admissionId)
                      : receipt?.action === 'classification.proposition.define'
                        ? classificationPropositionReceiptIri(receipt.admissionId)
                        : receipt?.action === 'classification.decision.set'
                          ? classificationDecisionReceiptIri(receipt.admissionId)
                          : receipt?.action === 'rating.context.create'
                            ? ratingContextReceiptIri(receipt.admissionId)
                          : receipt?.action === 'rating.context.policy.set'
                            ? ratingPolicyReceiptIri(receipt.admissionId)
                            : receipt?.action === 'rating.observation.set'
                              ? standingRatingReceiptIri(receipt.admissionId) : null;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || (!terminalRejected && !cancelled && !contributionCancelled && !publicationCancelled
      && !selectionCancelled && !spaceCancelled && !realmCancelled
      && !suppressionCancelled && !contextCancelled && !propositionCancelled
      && !decisionStale && !decisionCancelled && !ratingContextCancelled
      && !ratingPolicyStale && !ratingPolicyCancelled
      && !ratingObservationStale && !ratingObservationCancelled)
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.outcome !== 'cancelled' || !expectedReceipt || receipt.id !== expectedReceipt
    || (workRejected && (receipt.action !== 'work.edit' || receipt.reason !== 'stale-head'))
    || (contributionRejected && (receipt.action !== 'contribution.edit'
      || receipt.reason !== 'stale-head'))
    || (publicationRejected && (receipt.action !== 'contribution.publish'
      || receipt.reason !== 'stale-head'))
    || (selectionRejected && (receipt.action !== 'publication.select'
      || receipt.reason !== 'stale-head'))
    || (cancelled && (!['work.create', 'work.edit'].includes(receipt.action) || receipt.reason))
    || (contributionCancelled && (!['contribution.create', 'contribution.edit'].includes(receipt.action)
      || receipt.reason))
    || (publicationCancelled && (receipt.action !== 'contribution.publish' || receipt.reason))
    || (selectionCancelled && (receipt.action !== 'publication.select' || receipt.reason))
    || (spaceCancelled && (receipt.action !== 'space.create' || receipt.reason))
    || (realmRejected && (receipt.action !== 'publication.adopt'
      || receipt.reason !== 'stale-head'))
    || (realmCancelled && (receipt.action !== 'publication.adopt' || receipt.reason))
    || (suppressionRejected && (!['publication.reject', ORGANIZATION_MODERATION_ACTION].includes(receipt.action)
      || receipt.reason !== 'stale-head'))
    || (suppressionCancelled && (!['publication.reject', ORGANIZATION_MODERATION_ACTION].includes(receipt.action) || receipt.reason))
    || (contextCancelled && (receipt.action !== 'classification.context.configure'
      || receipt.reason))
    || (propositionCancelled && (receipt.action !== 'classification.proposition.define'
      || receipt.scope !== 'classification:define:global' || receipt.reason))
    || (decisionStale && (receipt.action !== 'classification.decision.set'
      || !receipt.scope.startsWith('classification:decide:')
      || receipt.reason !== 'stale-head'))
    || (decisionCancelled && (receipt.action !== 'classification.decision.set'
      || !receipt.scope.startsWith('classification:decide:') || receipt.reason))
    || (ratingContextCancelled && (receipt.action !== 'rating.context.create'
      || !receipt.scope.startsWith('rating:context:') || receipt.reason))
    || (ratingPolicyStale && (receipt.action !== 'rating.context.policy.set'
      || !receipt.scope.startsWith('rating:policy:') || receipt.reason !== 'stale-head'))
    || (ratingPolicyCancelled && (receipt.action !== 'rating.context.policy.set'
      || !receipt.scope.startsWith('rating:policy:') || receipt.reason))
    || (ratingObservationStale && (receipt.action !== 'rating.observation.set'
      || !receipt.scope.startsWith('rating:observe:') || receipt.reason !== 'stale-head'))
    || (ratingObservationCancelled && (receipt.action !== 'rating.observation.set'
      || !receipt.scope.startsWith('rating:observe:') || receipt.reason))
    || receipt.operation || receipt.work || receipt.mainVersion || receipt.workRevision
    || receipt.mainRevision || receipt.workManifest || receipt.mainManifest || receipt.expectedHead
    || receipt.contribution || receipt.draftRevision || receipt.draftManifest
    || receipt.publicationDecision || receipt.publicationManifest || receipt.selectedDraft
    || receipt.selection || receipt.selectionManifest || receipt.matchUnit
    || receipt.space || receipt.realm || receipt.spaceRevision || receipt.realmRevision
    || receipt.spaceManifest || receipt.realmManifest || receipt.owner || receipt.slot
    || receipt.rejection || receipt.rejectionManifest || receipt.reasonCode
    || receipt.classificationContext || receipt.contextRevision || receipt.contextManifest
    || receipt.scheme || receipt.concept || receipt.path || receipt.expression || receipt.sense
    || receipt.definitionRevision || receipt.definitionManifest
    || receipt.application || receipt.decision || receipt.decisionManifest
    || receipt.decisionOutcome
    || receipt.ratingContext || receipt.ratingContextRevision || receipt.ratingContextManifest
    || receipt.ratingPolicyRevision || receipt.ratingPolicyManifest
    || receipt.ratingPolicyPredecessor || receipt.ratingPolicy
    || receipt.ratingSlot || receipt.ratingObservation || receipt.observationRevision
    || receipt.observationManifest || receipt.ratingAvailability || receipt.ratingValue
    || receipt.author || receipt.language
    || eventId !== expectedEvent || data.batchId !== expectedEvent?.replace(':event:', ':outbox:')) {
    throw new RetainedEffectConflict('retained terminal admission envelope is incomplete');
  }
  for (const value of [eventId, data.batchId, receipt.id]) iri(value);
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow>(
      `SELECT action, state, scope_id, request_digest, authority_epoch,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== receipt.action || admitted.state !== 'sealed'
      || admitted.scope_id !== receipt.scope || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'cancelled'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence) {
      throw new RetainedEffectConflict('current Access admission does not prove retained cancellation');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const reasonTriple = terminalRejected ? 'rv:reason rv:StaleHead ;' : '';
    const eventType = workRejected ? 'WorkEditRejectedEvent'
      : contributionRejected ? 'ContributionDraftEditRejectedEvent'
      : publicationRejected ? 'ContributionPublicationRejectedEvent'
      : selectionRejected ? 'PublicationSelectionRejectedEvent'
      : publicationCancelled ? 'ContributionPublicationCancelledEvent'
      : selectionCancelled ? 'PublicationSelectionCancelledEvent'
      : spaceCancelled ? 'SpaceCreationCancelledEvent'
      : realmRejected ? 'RealmSelectionRejectedEvent'
      : realmCancelled ? 'RealmSelectionCancelledEvent'
      : suppressionRejected ? 'RealmPublicationSuppressionRejectedEvent'
      : suppressionCancelled ? 'RealmPublicationSuppressionCancelledEvent'
      : contextCancelled ? 'ClassificationContextCancelledEvent'
      : propositionCancelled ? 'ClassificationPropositionCancelledEvent'
      : decisionStale ? 'ClassificationDecisionStaleEvent'
      : decisionCancelled ? 'ClassificationDecisionCancelledEvent'
      : ratingContextCancelled ? 'RatingContextCancelledEvent'
      : ratingPolicyStale ? 'RatingPolicyStaleEvent'
      : ratingPolicyCancelled ? 'RatingPolicyCancelledEvent'
      : ratingObservationStale ? 'RatingObservationStaleEvent'
      : ratingObservationCancelled ? 'RatingObservationCancelledEvent'
      : contributionCancelled ? 'ContributionAdmissionCancelledEvent' : 'AdmissionCancelledEvent';
    const admissionTriple = (cancelled || spaceCancelled || contextCancelled
      || propositionCancelled || ratingContextCancelled)
      || ratingPolicyStale || ratingPolicyCancelled
      ? ` ; rv:admissionId ${lit(receipt.admissionId)}` : '';
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ; rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
            rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Cancelled ; ${reasonTriple}
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:${eventType} ; rv:ordinal 0 ;
            rv:action ${lit(receipt.action)} ; rv:receipt ${iri(receipt.id)}${admissionTriple} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const readTerminal = () => receipt.action === 'work.create'
      ? readWorkTerminalReceipt(env.fuseki, receipt.admissionId)
      : receipt.action === 'work.edit'
        ? readWorkEditTerminalReceipt(env, receipt.admissionId)
        : receipt.action === 'contribution.create'
          ? readTextContributionReceipt(env, receipt.admissionId)
          : receipt.action === 'contribution.edit'
            ? readTextContributionEditReceipt(env, receipt.admissionId)
            : receipt.action === 'contribution.publish'
              ? readTextPublicationReceipt(env, receipt.admissionId)
              : receipt.action === 'publication.select'
                ? readMainSelectionReceipt(env, receipt.admissionId)
                : receipt.action === 'space.create'
                  ? readSpaceCreationReceipt(env, receipt.admissionId)
                  : receipt.action === 'publication.adopt'
                    ? readRealmSelectionReceipt(env, receipt.admissionId)
                    : receipt.action === 'publication.reject' || receipt.action === ORGANIZATION_MODERATION_ACTION
                      ? readRealmRejectionReceipt(env, receipt.admissionId)
                      : receipt.action === 'classification.context.configure'
                        ? readClassificationContextReceipt(env, receipt.admissionId)
                        : receipt.action === 'classification.proposition.define'
                          ? readClassificationPropositionReceipt(env, receipt.admissionId)
                          : receipt.action === 'classification.decision.set'
                            ? readClassificationDecisionReceipt(env, receipt.admissionId)
                            : receipt.action === 'rating.context.create'
                              ? readRatingContextReceipt(env, receipt.admissionId)
                            : receipt.action === 'rating.context.policy.set'
                              ? readRatingPolicyReceipt(env, receipt.admissionId)
                              : readStandingRatingReceipt(env, receipt.admissionId);
    const existing = await readTerminal();
    let updateError: unknown;
    if (!existing) {
      try { await retainedCommand(env, update, receipt, null); }
      catch (error) { updateError = error; }
    }
    const terminal = await readTerminal();
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} ;
        rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:${eventType} ; rv:receipt ${iri(receipt.id)} . }
    }`);
    if (!terminal || terminal.outcome !== 'cancelled' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || ('reason' in terminal ? terminal.reason : undefined) !== receipt.reason
      || cursor === null || cursor < BigInt(sequence) || graphCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained cancellation update outcome is unknown' : 'retained cancellation did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, ...(terminalRejected ? { reason: 'stale-head' as const } : {}),
      replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export const reconcileRetainedWorkCancellation = reconcileRetainedAdmissionCancellation;

const TRANSLATION_PROFILE = 'https://rezics.com/definition/translation-link-v1';

/** Interpret only a complete, original translation event. No revision is inferred. */
export function parseRetainedTranslationLink(eventId: string, envelope: MainCloudEvent,
  coverage: RelayCoverage, sequence: string): {
    input: TranslationLinkInput; link: string; batchId: string;
    receipt: MainCloudEvent['data']['receipt'];
  } {
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (!data || !receipt || !data.sourcePosition
    || envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.translation.linked.v1'
    || envelope.datacontenttype !== 'application/json'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || typeof data.routingEpoch !== 'string' || !data.routingEpoch
    || receipt.outcome !== 'succeeded'
    || !['translation.link', 'translation.authorize'].includes(receipt.action)
    || !/^[0-9a-f-]{36}$/.test(receipt.admissionId)
    || !/^[0-9]+$/.test(receipt.authorityEpoch)
    || !/^[0-9a-f]{64}$/.test(receipt.requestDigest)
    || !receipt.translationLink
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(receipt.translationLink)
    || receipt.id !== translationLinkReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(`${receipt.id}\0translation-linked`)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`
    || receipt.sourceMainRevision === undefined
    || receipt.authorizingParty === undefined
    || receipt.authorizationScope === undefined
    || receipt.authorizationEpoch === undefined
    || (receipt.sourceVersionStatus !== 'exact'
      && receipt.sourceVersionStatus !== 'unresolved')
    || (receipt.translationStatus !== 'official'
      && receipt.translationStatus !== 'third-party')) {
    throw new RetainedEffectConflict('retained translation event is incomplete');
  }
  const input: TranslationLinkInput = {
    targetWork: receipt.targetWork ?? '',
    targetMainVersion: receipt.targetMainVersion ?? '',
    targetMainRevision: receipt.targetMainRevision ?? '',
    sourceWork: receipt.sourceWork ?? '',
    sourceMainVersion: receipt.sourceMainVersion ?? '',
    sourceMainRevision: receipt.sourceMainRevision,
    status: receipt.translationStatus,
    contentLanguage: receipt.contentLanguage ?? '',
    translator: receipt.translator ?? '',
    publisher: receipt.publisher ?? '',
    evidence: receipt.evidence ?? '',
    actingSubject: receipt.linkedBy ?? '',
  };
  try { validateTranslationLink(input); }
  catch { throw new RetainedEffectConflict('retained translation input is invalid'); }
  if ((receipt.sourceVersionStatus === 'exact') !== !!input.sourceMainRevision
    || (input.status === 'official') !== (receipt.action === 'translation.authorize')
    || (input.status === 'official'
      ? receipt.authorizingParty !== input.actingSubject
        || receipt.authorizationScope !== receipt.scope
        || receipt.authorizationEpoch !== receipt.authorityEpoch
        || receipt.scope !== `translation:authorize:${input.sourceWork}:${input.sourceMainRevision}`
      : receipt.authorizingParty !== null || receipt.authorizationScope !== null
        || receipt.authorizationEpoch !== null
        || receipt.scope !== `translation:link:${input.targetWork}`)) {
    throw new RetainedEffectConflict('retained translation provenance is inconsistent');
  }
  iri(eventId); iri(data.batchId); iri(receipt.id); iri(receipt.translationLink);
  return { input, link: receipt.translationLink, batchId: data.batchId, receipt };
}

/** Rebuild exactly one immutable translation relation under a held graph restore. */
export async function reconcileRetainedTranslationLink(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; link: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const { input, link, batchId, receipt } = parseRetainedTranslationLink(
    eventId, envelope, coverage, sequence);
  const batch = await relayPool.query<{ batch_id: string; routing_epoch: string;
    event_count: number }>(
    `SELECT batch_id, routing_epoch, event_count FROM relay.delivered_batch
     WHERE data_epoch = $1 AND sequence = $2`, [coverage.dataEpoch, sequence]);
  if (batch.rows.length !== 1 || batch.rows[0]?.batch_id !== batchId
    || batch.rows[0]?.routing_epoch !== envelope.data.routingEpoch
    || batch.rows[0]?.event_count !== 1) {
    throw new RetainedEffectConflict('retained translation batch header differs');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string;
      idempotency_key: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         idempotency_key,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    const originalInput = admitted && { ...input, idempotencyKey: admitted.idempotency_key };
    if (access.rows.length !== 1 || !admitted || admitted.action !== receipt.action
      || admitted.state !== 'sealed' || admitted.acting_subject !== input.actingSubject
      || !/^[A-Za-z0-9:_./-]{1,128}$/.test(admitted.idempotency_key)
      || admitted.scope_id !== receipt.scope || admitted.request_digest !== receipt.requestDigest
      || !originalInput || translationLinkDigest(originalInput) !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence) {
      throw new RetainedEffectConflict('current Access admission does not prove retained translation');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const sourceRevision = input.sourceMainRevision
      ? `; rv:sourceMainRevision ${iri(input.sourceMainRevision)}` : '';
    const authorizing = input.status === 'official'
      ? `; rv:authorizingParty ${iri(input.actingSubject)} ;
           rv:authorizationScope ${lit(receipt.scope)} ;
           rv:authorizationEpoch ${lit(receipt.authorityEpoch)}` : '';
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(link)} a rv:TranslationLink ; rv:targetWork ${iri(input.targetWork)} ;
            rv:targetMainVersion ${iri(input.targetMainVersion)} ;
            rv:targetMainRevision ${iri(input.targetMainRevision)} ;
            rv:sourceWork ${iri(input.sourceWork)} ;
            rv:sourceMainVersion ${iri(input.sourceMainVersion)} ${sourceRevision} ;
            rv:sourceVersionStatus rv:${input.sourceMainRevision ? 'Exact' : 'Unresolved'} ;
            rv:translationStatus rv:${input.status === 'official' ? 'Official' : 'ThirdParty'} ;
            rv:contentLanguage ${lit(input.contentLanguage)} ;
            rv:translator ${iri(input.translator)} ; rv:publisher ${iri(input.publisher)} ;
            rv:evidence ${lit(input.evidence)} ; rv:linkedBy ${iri(input.actingSubject)}
            ${authorizing} ; rv:modelRevision ${iri(TRANSLATION_PROFILE)} ;
            rv:shapeRevision ${iri(TRANSLATION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ; rv:admittedScope ${lit(receipt.scope)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:outcome rv:Succeeded ;
            rv:translationLink ${iri(link)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:TranslationLinkedEvent ; rv:ordinal 0 ;
            rv:action ${lit(receipt.action)} ; rv:receipt ${iri(receipt.id)} ;
            rv:translationLink ${iri(link)} .
        }
      } WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(input.targetWork)} rv:mainVersion ${iri(input.targetMainVersion)} .
          ${iri(input.targetMainVersion)} a rv:MainVersion ; rv:work ${iri(input.targetWork)} ;
            rv:head ${iri(input.targetMainRevision)} .
          ${iri(input.sourceWork)} rv:mainVersion ${iri(input.sourceMainVersion)} .
          ${iri(input.sourceMainVersion)} a rv:MainVersion ; rv:work ${iri(input.sourceWork)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(input.targetMainRevision)} a rv:RevisionAnchor ;
            rv:component ${iri(input.targetMainVersion)} .
          ${input.sourceMainRevision ? `${iri(input.sourceMainRevision)} a rv:RevisionAnchor ;
            rv:component ${iri(input.sourceMainVersion)} .` : ''}
        }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
          ?prior a rv:TranslationLink ; rv:targetMainRevision ${iri(input.targetMainRevision)} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(link)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readTranslationLinkTerminal(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try {
        const validations = await profileValidations(env.fuseki, 'translation-link-v1', [{
          shape: `${TRANSLATION_PROFILE}/link-shape`, focus: [link],
          graphs: [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.control],
        }], {
          link, 'target-work': input.targetWork, 'target-main': input.targetMainVersion,
          'target-revision': input.targetMainRevision, 'source-work': input.sourceWork,
          'source-main': input.sourceMainVersion,
          ...(input.sourceMainRevision ? { 'source-revision': input.sourceMainRevision } : {}),
          status: input.status, language: input.contentLanguage,
          translator: input.translator, publisher: input.publisher,
          evidence: input.evidence, actor: input.actingSubject, receipt: receipt.id,
          scope: receipt.scope, epoch: receipt.authorityEpoch,
        });
        const result = await env.fuseki.commandWithReceipt({ receipt: receipt.id,
          digest: receipt.requestDigest, update, validations, deadlineMs: 10_000 });
        if (result.status === 'invalid' || result.status === 'unknown-profile'
          || result.status === 'conflict') throw new Error(`retained translation command ${result.status}`);
      } catch (error) { updateError = error; }
    }
    const terminal = await readTranslationLinkTerminal(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const linkCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(link)} a rv:TranslationLink ; rv:targetWork ${iri(input.targetWork)} ;
          rv:targetMainVersion ${iri(input.targetMainVersion)} ;
          rv:targetMainRevision ${iri(input.targetMainRevision)} ;
          rv:sourceWork ${iri(input.sourceWork)} ; rv:sourceMainVersion ${iri(input.sourceMainVersion)} ;
          rv:sourceVersionStatus rv:${input.sourceMainRevision ? 'Exact' : 'Unresolved'} ;
          rv:translationStatus rv:${input.status === 'official' ? 'Official' : 'ThirdParty'} ;
          rv:contentLanguage ${lit(input.contentLanguage)} ; rv:translator ${iri(input.translator)} ;
          rv:publisher ${iri(input.publisher)} ; rv:evidence ${lit(input.evidence)} ;
          rv:linkedBy ${iri(input.actingSubject)} ; rv:modelRevision ${iri(TRANSLATION_PROFILE)} ;
          rv:shapeRevision ${iri(TRANSLATION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        ${input.sourceMainRevision ? `${iri(link)} rv:sourceMainRevision ${iri(input.sourceMainRevision)} .`
      : `FILTER NOT EXISTS { ${iri(link)} rv:sourceMainRevision ?unknownSource }`}
        ${input.status === 'official' ? `${iri(link)} rv:authorizingParty ${iri(input.actingSubject)} ;
          rv:authorizationScope ${lit(receipt.scope)} ;
          rv:authorizationEpoch ${lit(receipt.authorityEpoch)} .`
      : `FILTER NOT EXISTS { ${iri(link)} rv:authorizingParty ?unexpectedParty }
         FILTER NOT EXISTS { ${iri(link)} rv:authorizationScope ?unexpectedScope }
         FILTER NOT EXISTS { ${iri(link)} rv:authorizationEpoch ?unexpectedEpoch }`}
        FILTER NOT EXISTS { ?other a rv:TranslationLink ;
          rv:targetMainRevision ${iri(input.targetMainRevision)} . FILTER(?other != ${iri(link)}) }
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt.id)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(receipt.requestDigest)} ;
          rv:admissionId ${lit(receipt.admissionId)} ;
          rv:admittedScope ${lit(receipt.scope)} ;
          rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:outcome rv:Succeeded ;
          rv:translationLink ${iri(link)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:TranslationLinkedEvent ; rv:ordinal 0 ;
          rv:action ${lit(receipt.action)} ; rv:receipt ${iri(receipt.id)} ;
          rv:translationLink ${iri(link)} .
      }
    }`);
    const links = await readTranslationLinks(env, input.targetMainVersion, input.targetMainRevision);
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.link !== link
      || terminal.receipt !== receipt.id || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId || terminal.scope !== receipt.scope
      || terminal.authorityEpoch !== receipt.authorityEpoch
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence) || linkCheck.boolean !== true
      || links.length !== 1 || links[0]?.link !== link
      || links[0]?.targetWork !== input.targetWork || links[0]?.sourceWork !== input.sourceWork
      || links[0]?.sourceMainVersion !== input.sourceMainVersion
      || links[0]?.sourceMainRevision !== input.sourceMainRevision
      || links[0]?.status !== input.status || links[0]?.contentLanguage !== input.contentLanguage
      || links[0]?.translator !== input.translator || links[0]?.publisher !== input.publisher
      || links[0]?.evidence !== input.evidence
      || links[0]?.authorizingParty !== receipt.authorizingParty
      || links[0]?.authorizationScope !== receipt.authorizationScope
      || links[0]?.authorizationEpoch !== receipt.authorizationEpoch) {
      throw new RetainedEffectConflict(updateError
        ? 'retained translation update outcome is unknown' : 'retained translation did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, link, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}
