import type { Pool } from 'pg';
import { profileValidations } from '../../infrastructure/profile.ts';
import { relayRetainedEventAt, RelayCheckpointConflict,
  type MainCloudEvent, type RelayCoverage } from '../outbox/relay.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment }
  from './activate.ts';
import { fixedReleaseDigest, fixedReleaseReceiptIri, readFixedRelease,
  readFixedReleaseTerminal, type FixedReleaseInput } from './fixed-release.ts';
import { readWorkComponentState } from './history.ts';
import { reconciledCursor, RetainedEffectConflict } from './reconcile-restored.ts';

const PROFILE = 'https://rezics.com/definition/fixed-native-text-release-v1';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

interface RetainedRelease {
  input: Omit<FixedReleaseInput, 'idempotencyKey'>;
  release: string;
  manifest: string;
  bodyDigest: string;
  contribution: string;
  publicationDecision: string;
  selectedDraft: string;
  language: string;
  receipt: MainCloudEvent['data']['receipt'];
  batchId: string;
}

/** Parse only the original sealed event; absent fields are never inferred from current state. */
export function parseRetainedFixedRelease(eventId: string, envelope: MainCloudEvent,
  coverage: RelayCoverage, sequence: string): RetainedRelease {
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (!data || !receipt || envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.release.sealed.v1'
    || envelope.datacontenttype !== 'application/json'
    || data.ordinal !== 0 || data.sourcePosition?.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || !data.routingEpoch || receipt.action !== 'release.seal'
    || receipt.outcome !== 'succeeded'
    || !/^[0-9a-f-]{36}$/.test(receipt.admissionId)
    || !/^[0-9]+$/.test(receipt.authorityEpoch)
    || !/^[0-9a-f]{64}$/.test(receipt.requestDigest)
    || !receipt.fixedRelease || !nativeId.test(receipt.fixedRelease)
    || !receipt.work || !nativeId.test(receipt.work)
    || !receipt.mainVersion || !nativeId.test(receipt.mainVersion)
    || !receipt.mainRevision || !nativeId.test(receipt.mainRevision)
    || !receipt.selection || !nativeId.test(receipt.selection)
    || !receipt.contribution || !nativeId.test(receipt.contribution)
    || !receipt.publicationDecision || !nativeId.test(receipt.publicationDecision)
    || !receipt.selectedDraft || !nativeId.test(receipt.selectedDraft)
    || !receipt.language || !receipt.sealedBy || !nativeId.test(receipt.sealedBy)
    || !/^[0-9a-f]{64}$/.test(receipt.bodyDigest ?? '')
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.releaseManifest ?? '')
    || receipt.scope !== `release:seal:${receipt.mainVersion}`
    || receipt.id !== fixedReleaseReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(`${receipt.id}\0fixed-release`)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained fixed release event is incomplete');
  }
  return { input: { work: receipt.work, mainVersion: receipt.mainVersion,
    expectedMainRevision: receipt.mainRevision, expectedSelection: receipt.selection,
    actingSubject: receipt.sealedBy }, release: receipt.fixedRelease,
    manifest: receipt.releaseManifest!, bodyDigest: receipt.bodyDigest!,
    contribution: receipt.contribution, publicationDecision: receipt.publicationDecision,
    selectedDraft: receipt.selectedDraft, language: receipt.language,
    receipt, batchId: data.batchId };
}

/** Rebuild one exact release from retained relay and sealed Access evidence under the restore hold. */
export async function reconcileRetainedFixedRelease(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; release: string; replayed: boolean }> {
  let retained: Awaited<ReturnType<typeof relayRetainedEventAt>>;
  try { retained = await relayRetainedEventAt(relayPool, coverage, sequence); }
  catch (error) {
    if (error instanceof RelayCheckpointConflict) throw new RetainedEffectConflict(error.message);
    throw error;
  }
  const { eventId, envelope, batch } = retained;
  const proof = parseRetainedFixedRelease(eventId, envelope, coverage, sequence);
  const { input, release, receipt, bodyDigest, manifest, contribution,
    publicationDecision, selectedDraft, language, batchId } = proof;
  if (batch.batchId !== batchId || batch.routingEpoch !== envelope.data.routingEpoch
    || batch.eventCount !== 1) {
    throw new RetainedEffectConflict('retained fixed release batch header differs');
  }
  const state = await readWorkComponentState(env, manifest, release, PROFILE);
  const pinned = { work: input.work, mainVersion: input.mainVersion,
    mainRevision: input.expectedMainRevision, selection: input.expectedSelection,
    contribution, publicationDecision, selectedDraft, language, bodyDigest,
    sealedBy: input.actingSubject };
  if (Object.entries(pinned).some(([key, value]) => state[key] !== value)) {
    throw new RetainedEffectConflict('retained fixed release manifest differs from event');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) {
      throw new RetainedEffectConflict('Access recovery fence is not held');
    }
    const admission = await client.query<{ action: string; state: string; scope_id: string;
      request_digest: string; authority_epoch: string; acting_subject: string;
      idempotency_key: string; graph_receipt: string | null; graph_outcome: string | null;
      graph_data_epoch: string | null; graph_sequence: string | null }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         idempotency_key, graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = admission.rows[0];
    if (admission.rows.length !== 1 || !admitted || admitted.action !== 'release.seal'
      || admitted.state !== 'sealed' || admitted.acting_subject !== input.actingSubject
      || admitted.scope_id !== receipt.scope || admitted.request_digest !== receipt.requestDigest
      || !/^[A-Za-z0-9:_./-]{1,128}$/.test(admitted.idempotency_key)
      || fixedReleaseDigest({ ...input, idempotencyKey: admitted.idempotency_key })
        !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence) {
      throw new RetainedEffectConflict('Access admission does not prove retained fixed release');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(release)} a rv:FixedRelease ; rv:work ${iri(input.work)} ;
            rv:mainVersion ${iri(input.mainVersion)} ;
            rv:mainRevision ${iri(input.expectedMainRevision)} ;
            rv:selection ${iri(input.expectedSelection)} ; rv:contribution ${iri(contribution)} ;
            rv:publicationDecision ${iri(publicationDecision)} ;
            rv:selectedDraft ${iri(selectedDraft)} ; rv:language ${lit(language)} ;
            rv:bodyDigest ${lit(bodyDigest)} ; rv:manifest ${iri(manifest)} ;
            rv:sealedBy ${iri(input.actingSubject)} ; rv:modelRevision ${iri(PROFILE)} ;
            rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ; rv:admittedScope ${lit(receipt.scope)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:outcome rv:Succeeded ;
            rv:fixedRelease ${iri(release)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:FixedReleaseSealedEvent ; rv:ordinal 0 ;
            rv:action "release.seal" ; rv:receipt ${iri(receipt.id)} ;
            rv:fixedRelease ${iri(release)} ; rv:work ${iri(input.work)} . }
      } WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ; rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(input.work)} rv:mainVersion ${iri(input.mainVersion)} .
          ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} ;
            rv:head ${iri(input.expectedMainRevision)} ;
            rv:selectionHead ${iri(input.expectedSelection)} .
          ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(input.work)} ;
            rv:publicationHead ${iri(publicationDecision)} . }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(input.expectedMainRevision)} a rv:RevisionAnchor ;
            rv:component ${iri(input.mainVersion)} .
          ${iri(input.expectedSelection)} a rv:PublicationSelection ;
            rv:mainVersion ${iri(input.mainVersion)} ;
            rv:mainRevision ${iri(input.expectedMainRevision)} ;
            rv:contribution ${iri(contribution)} ;
            rv:publicationDecision ${iri(publicationDecision)} ;
            rv:selectedDraft ${iri(selectedDraft)} ; rv:language ${lit(language)} .
          ${iri(publicationDecision)} a rv:PublicationDecision ;
            rv:component ${iri(contribution)} ; rv:selectedDraft ${iri(selectedDraft)} ;
            rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public .
          ${iri(selectedDraft)} a rv:RevisionAnchor ; rv:component ${iri(contribution)} . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(release)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
      }`;
    const existing = await readFixedReleaseTerminal(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try {
        const validations = await profileValidations(env.fuseki, 'fixed-native-text-release-v1', [{
          shape: `${PROFILE}/release-shape`, focus: [release],
          graphs: [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.control],
        }], { release, work: input.work, main: input.mainVersion,
          revision: input.expectedMainRevision, selection: input.expectedSelection,
          contribution, decision: publicationDecision, draft: selectedDraft,
          language, digest: bodyDigest, manifest, actor: input.actingSubject,
          receipt: receipt.id, scope: receipt.scope, epoch: receipt.authorityEpoch });
        const result = await env.fuseki.commandWithReceipt({ receipt: receipt.id,
          digest: receipt.requestDigest, update, validations, deadlineMs: 10_000 });
        if (result.status === 'invalid' || result.status === 'unknown-profile'
          || result.status === 'conflict') throw new Error(`retained fixed release ${result.status}`);
      } catch (error) { updateError = error; }
    }
    const terminal = await readFixedReleaseTerminal(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const exact = await readFixedRelease(env, release, async () => true).catch(() => null);
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.release !== release
      || terminal.receipt !== receipt.id || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId || terminal.scope !== receipt.scope
      || terminal.authorityEpoch !== receipt.authorityEpoch
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence)
      || !exact || exact.work !== input.work || exact.mainVersion !== input.mainVersion
      || exact.mainRevision !== input.expectedMainRevision || exact.selection !== input.expectedSelection
      || exact.contribution !== contribution || exact.publicationDecision !== publicationDecision
      || exact.selectedDraft !== selectedDraft || exact.language !== language
      || exact.bodyDigest !== bodyDigest || exact.sealedBy !== input.actingSubject
      || exact.sourcePosition.dataEpoch !== coverage.dataEpoch
      || exact.sourcePosition.sequence !== sequence) {
      throw new RetainedEffectConflict(updateError
        ? 'retained fixed release outcome is unknown' : 'retained fixed release did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, release, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}
