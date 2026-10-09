import type { Pool, PoolClient } from 'pg';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { workEditReceiptIri } from '../work/edit.ts';
import { heldMainRecovery, recoveryCursor, reconciledCursor, RetainedEffectConflict } from '../work/reconcile-restored.ts';
import { relayRetainedEventAt, type RelayCoverage } from '../outbox/relay.ts';
import type { OwnerCloudEvent } from '../outbox/event-handlers.ts';
import { OpenLibraryConversionStore } from './open-library-conversion.ts';
import { SourceIntakeStore } from './intake.ts';
import { OpenLibrarySourceGraph } from './graph-projection.ts';
import { SourceNativeWorkProposalStore } from './native-work-proposal.ts';
import { sourceChildOccurrence } from './child-correspondence.ts';
import { nativeChildSupportDigest, nativeChildValue, type NativeChildIntentRow } from './child-native-support.ts';
import { nativeChildDigest, readNativeChild, readNativeChildReceipt } from './child-native.ts';
import { nativeChildRetirementDigest, readNativeChildRetirement } from './child-retirement.ts';

type ChildReceipt = OwnerCloudEvent['data']['receipt'] & { work: string; workRevision: string;
  expectedHead: string; nativeChild: string; nativeChildRevision: string;
  sourceIntent?: string; retirementReason?: string };
type Admission = { principal_id: string; action: string; state: string; scope_id: string;
  request_digest: string; acting_subject: string; authority_epoch: string;
  idempotency_key: string; graph_receipt: string; graph_outcome: string;
  graph_data_epoch: string; graph_sequence: string };
const SHAPE = 'https://rezics.com/definition/work-native-child-v1';

async function retainedChild(access: PoolClient, relay: Pool, coverage: RelayCoverage,
  sequence: string, retirement: boolean) {
  const retained = await relayRetainedEventAt(relay, coverage, sequence)
    .catch(() => { throw new RetainedEffectConflict('retained child event is unavailable'); });
  const event = retained.envelope as OwnerCloudEvent;
  const receipt = event.data?.receipt as ChildReceipt;
  const suffix = retirement ? 'native-child-retired' : 'native-child';
  if (!receipt?.nativeChild || !receipt.nativeChildRevision || !receipt.work
    || !receipt.expectedHead || !receipt.admissionId || !receipt.authorityEpoch
    || !receipt.scope || !receipt.requestDigest || !receipt.id
    || (retirement ? !receipt.retirementReason : !receipt.sourceIntent)
    || event.id !== retained.eventId || event.specversion !== '1.0'
    || event.source !== 'https://rezics.com/services/main'
    || event.type !== `com.rezics.work.${retirement ? 'native-child-retired' : 'native-child-adopted'}.v1`
    || event.datacontenttype !== 'application/json' || event.data.ordinal !== 0
    || event.data.sourcePosition.datasetId !== 'product'
    || event.data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || event.data.sourcePosition.sequence !== sequence
    || event.data.batchId !== retained.batch.batchId
    || event.data.routingEpoch !== retained.batch.routingEpoch
    || retained.batch.eventCount !== 1 || receipt.action !== 'work.edit'
    || receipt.outcome !== 'succeeded' || receipt.workRevision !== receipt.expectedHead
    || receipt.scope !== `work:edit:${receipt.work}`
    || receipt.id !== workEditReceiptIri(receipt.admissionId)
    || retained.eventId !== `urn:rezics:event:${hash(`${receipt.id}\0${suffix}`)}`
    || retained.batch.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained child event identity differs');
  }
  const admitted = (await access.query<Admission>(
    'SELECT * FROM access.admission WHERE id = $1', [receipt.admissionId])).rows[0];
  if (!admitted || admitted.state !== 'sealed' || admitted.action !== 'work.edit'
    || admitted.scope_id !== receipt.scope || admitted.authority_epoch !== receipt.authorityEpoch
    || admitted.request_digest !== receipt.requestDigest || admitted.graph_receipt !== receipt.id
    || admitted.graph_outcome !== 'succeeded' || admitted.graph_data_epoch !== coverage.dataEpoch
    || admitted.graph_sequence !== sequence) {
    throw new RetainedEffectConflict('Access admission differs from retained child');
  }
  return { retained, receipt, admitted };
}

function cursorWhere(env: WorkActivationEnvironment, coverage: RelayCoverage, sequence: string, paired: boolean) {
  const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
  const recovery = recoveryCursor(marker, sequence, paired);
  return { marker, recovery, where: `GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)}
      rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ;
      rv:sequence 0 ; rv:restoreHold true ; rv:restoreCutover ${iri(marker)} .
      ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ; rv:priorSequence ?saved .
      ${recovery.bind} }` };
}

function envelope(receipt: ChildReceipt, coverage: RelayCoverage, sequence: string,
  eventId: string, retirement: boolean) {
  const batch = `urn:rezics:outbox:${hash(receipt.id)}`;
  const family = retirement ? 'NativeChildRetiredEvent' : 'NativeChildAdoptedEvent';
  return `GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} a rv:OperationReceipt ;
    rv:outcome rv:Succeeded ; rv:action "work.edit" ; rv:admissionId ${lit(receipt.admissionId!)} ;
    rv:requestDigest ${lit(receipt.requestDigest)} ; rv:authorityEpoch ${lit(receipt.authorityEpoch!)} ;
    rv:admittedScope ${lit(receipt.scope!)} ; rv:work ${iri(receipt.work)} ;
    rv:workRevision ${iri(receipt.expectedHead)} ; rv:expectedHead ${iri(receipt.expectedHead)} ;
    rv:nativeChild ${iri(receipt.nativeChild)} ; rv:nativeChildRevision ${iri(receipt.nativeChildRevision)} ;
    ${retirement ? `rv:retirementReason ${lit(receipt.retirementReason!)}` : `rv:sourceIntent ${iri(receipt.sourceIntent!)}`} ;
    rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
      rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} ; rv:eventCount 1 ;
      rv:event ${iri(eventId)} . ${iri(eventId)} a rv:${family} ; rv:ordinal 0 ;
      rv:action "work.edit" ; rv:work ${iri(receipt.work)} ; rv:receipt ${iri(receipt.id)} . }`;
}

/** Replay one verified original child or human retirement while both recovery fences are held. */
export async function reconcileRetainedNativeChild(env: WorkActivationEnvironment,
  accessPool: Pool, relayPool: Pool, contentPool: Pool, coverage: RelayCoverage,
  sequence: string, retirement = false) {
  const access = await accessPool.connect();
  try {
    await access.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = (await access.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
    if (fence?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const { retained, receipt, admitted } = await retainedChild(access, relayPool,
      coverage, sequence, retirement);
    const paired = await heldMainRecovery(env, `urn:rezics:restore:${env.lineage.dataEpoch}`, coverage.dataEpoch);
    const { marker, recovery, where } = cursorWhere(env, coverage, sequence, paired);
    let prior: unknown;
    let update: string;
    if (!retirement) {
      const intentId = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/.exec(receipt.sourceIntent!)?.[1];
      const row = intentId && (await contentPool.query<NativeChildIntentRow>(
        'SELECT * FROM source.native_child_intent WHERE id = $1', [intentId])).rows[0];
      if (!row || row.base_support_id || row.request_digest !== nativeChildSupportDigest(row.work, row.request)
        || row.principal_id !== admitted.principal_id || row.work !== receipt.work
        || row.child !== receipt.nativeChild || row.child_revision !== receipt.nativeChildRevision
        || admitted.acting_subject !== row.request.actingSubject
        || admitted.idempotency_key !== `source-child-${row.id}`) {
        throw new RetainedEffectConflict('original child intent differs');
      }
      const value = nativeChildValue(row), digest = nativeChildDigest(value);
      if (digest !== receipt.requestDigest || row.request.expectedHead !== receipt.expectedHead) {
        throw new RetainedEffectConflict('native child command differs from source intent');
      }
      const conversions = new OpenLibraryConversionStore(contentPool, new SourceIntakeStore(contentPool));
      const graph = new OpenLibrarySourceGraph(env.fuseki, env.lineage, conversions);
      const proposals = new SourceNativeWorkProposalStore(contentPool, graph, conversions);
      const proposal = await proposals.read(row.principal_id, row.proposal_id)
        .catch(() => { throw new RetainedEffectConflict('source proposal must recover first'); });
      const evidence = await conversions.verifiedRead(row.principal_id, row.conversion_id);
      const subject = evidence?.conversion.projection.subjects?.[row.source_ordinal];
      if (!proposal || !evidence || proposal.record !== `https://rezics.com/id/${row.record_id}`
        || proposal.proposal !== row.request.proposal || proposal.conversion !== row.request.conversion
        || proposal.observation !== evidence.observation.observation
        || row.request.conversion !== evidence.conversion.conversion
        || row.field_key !== 'subjects' || subject !== row.source_key
        || row.request.occurrence !== row.occurrence
        || sourceChildOccurrence(evidence.observation.observation, 'subjects', row.source_ordinal) !== row.occurrence) {
        throw new RetainedEffectConflict('retained source child occurrence differs');
      }
      const application = (await contentPool.query<{ graph_receipt: string; admission_id: string;
        data_epoch: string; sequence: string }>(
        'SELECT * FROM source.native_child_application WHERE intent_id = $1', [row.id])).rows[0];
      if (application && (application.graph_receipt !== receipt.id
        || application.admission_id !== receipt.admissionId
        || application.data_epoch !== coverage.dataEpoch || application.sequence !== sequence)) {
        throw new RetainedEffectConflict('source child certificate differs');
      }
      prior = await readNativeChildReceipt(env, receipt.admissionId!);
      const common = `rv:work ${iri(value.work)} ; rv:childField ${lit(value.field)} ;
        rv:sourceKey ${lit(value.sourceKey)} ; schema:position ${value.nativeOrdinal} ;
        rv:editControl rv:HumanConfirmed ; rv:rightsStatus rv:Undetermined`;
      update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${recovery.delete} } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${recovery.insert} } }
          GRAPH ${iri(GRAPHS.current)} { ${iri(value.child)} a rv:NativeChild ;
            rv:childRevision ${iri(value.revision)} ; ${common} . }
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(value.revision)} a rv:NativeChildRevision, rv:RevisionAnchor ;
            rv:component ${iri(value.child)} ; rv:workRevision ${iri(value.expectedHead)} ;
            rv:confirmedBy ${iri(value.actingSubject)} ; ${common} ;
            rv:modelRevision ${iri(SHAPE)} ; rv:shapeRevision ${iri(SHAPE)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
          ${envelope(receipt, coverage, sequence, retained.eventId, false)} }
        WHERE { ${where}
          GRAPH ${iri(GRAPHS.current)} { ${iri(value.work)} a schema:CreativeWork ;
            rv:head ${iri(value.expectedHead)} . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(value.child)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(value.revision)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ?b rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} } } }`;
    } else {
      const native = await readNativeChild(env, receipt.nativeChild, receipt.nativeChildRevision);
      if (!native || native.work !== receipt.work || native.expectedHead !== receipt.expectedHead) {
        throw new RetainedEffectConflict('original native child must recover first');
      }
      const original = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt ?admission WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:nativeChild ${iri(receipt.nativeChild)} ;
          rv:nativeChildRevision ${iri(receipt.nativeChildRevision)} ; rv:sourceIntent ?intent ;
          rv:admissionId ?admission ; rv:outcome rv:Succeeded . } } LIMIT 3`, 4096)).results?.bindings ?? [];
      if (original.length !== 1 || !original[0]?.receipt || !original[0].admission
        || original[0].receipt.value !== workEditReceiptIri(original[0].admission.value)
        || !await readNativeChildReceipt(env, original[0].admission.value)) {
        throw new RetainedEffectConflict('original child receipt is unavailable');
      }
      const digest = nativeChildRetirementDigest({ work: receipt.work,
        child: receipt.nativeChild, revision: receipt.nativeChildRevision,
        expectedHead: receipt.expectedHead, actingSubject: admitted.acting_subject,
        reason: receipt.retirementReason! });
      if (digest !== receipt.requestDigest) throw new RetainedEffectConflict('retirement intent differs');
      prior = await readNativeChildRetirement(env, receipt.nativeChild);
      update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${recovery.delete} } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${recovery.insert} } }
          GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.nativeChild)} rv:retiredBy ${iri(receipt.id)} . }
          ${envelope(receipt, coverage, sequence, retained.eventId, true)} }
        WHERE { ${where}
          GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.work)} a schema:CreativeWork ;
            rv:head ${iri(receipt.expectedHead)} . ${iri(receipt.nativeChild)} a rv:NativeChild ;
            rv:work ${iri(receipt.work)} ; rv:childRevision ${iri(receipt.nativeChildRevision)} . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.work)} rv:protectionHead ?p } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.nativeChild)} rv:retiredBy ?r } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ?b rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} } } }`;
    }
    if (!prior) {
      const validations = await profileValidations(env.fuseki, 'work-native-child-v1', [
        { shape: `${SHAPE}/child-shape`, focus: [receipt.nativeChild], graphs: [GRAPHS.current, GRAPHS.revisions] },
        { shape: `${SHAPE}/revision-shape`, focus: [receipt.nativeChildRevision], graphs: [GRAPHS.current, GRAPHS.revisions] },
      ]);
      const result = await env.fuseki.commandWithReceipt({ receipt: receipt.id,
        digest: receipt.requestDigest, update, validations, deadlineMs: 10_000 });
      if (result.status !== 'committed') throw new RetainedEffectConflict(
        `native child replay ${result.status}: ${JSON.stringify(result)}`);
    }
    const exact = retirement ? await readNativeChildRetirement(env, receipt.nativeChild)
      : await readNativeChildReceipt(env, receipt.admissionId!);
    const exactReceipt = exact && ('retirement' in exact ? exact.retirement : exact.receipt);
    const position = exact && ('sourcePosition' in exact ? exact.sourcePosition : exact);
    if (!exact || exactReceipt !== receipt.id
      || position?.dataEpoch !== coverage.dataEpoch || position.sequence !== sequence
      || BigInt(await reconciledCursor(env, marker) ?? '-1') < BigInt(sequence)) {
      throw new RetainedEffectConflict('native child replay is incomplete');
    }
    await access.query('COMMIT');
    return { receipt: receipt.id, child: receipt.nativeChild,
      revision: receipt.nativeChildRevision, replayed: !!prior };
  } catch (error) { await access.query('ROLLBACK'); throw error; }
  finally { access.release(); }
}
