import type { Pool } from 'pg';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { authorCreditValidations, readAuthorCredit, readAuthorCreditReceipt } from '../work/author-credit.ts';
import { authorCreditRetirementDigest, readAuthorCreditRetirement } from '../work/author-credit-retirement.ts';
import { workEditReceiptIri } from '../work/edit.ts';
import { reconciledCursor, RetainedEffectConflict } from '../work/reconcile-restored.ts';
import { relayRetainedEventAt, type MainCloudEvent, type RelayCoverage } from '../outbox/relay.ts';

/** Reapply one human retirement at its retained position, after its credit has recovered. */
export async function reconcileRetainedAuthorCreditRetirement(env: WorkActivationEnvironment,
  accessPool: Pool, relayPool: Pool, coverage: RelayCoverage, sequence: string) {
  const retained = await relayRetainedEventAt(relayPool, coverage, sequence)
    .catch(() => { throw new RetainedEffectConflict('retained credit retirement event is unavailable'); });
  const event = retained.envelope as MainCloudEvent;
  const receipt = event.data?.receipt as MainCloudEvent['data']['receipt'] & { retirementReason?: string };
  const credit = receipt?.authorCredit, revision = receipt?.creditRevision;
  const work = receipt?.work, head = receipt?.expectedHead, reason = receipt?.retirementReason;
  if (!receipt || !credit || !revision || !work || !head || !reason
    || event.type !== 'com.rezics.work.author-credit-retired.v1' || event.id !== retained.eventId
    || event.specversion !== '1.0' || event.source !== 'https://rezics.com/services/main'
    || event.datacontenttype !== 'application/json' || event.data.ordinal !== 0
    || event.data.sourcePosition.datasetId !== 'product'
    || event.data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || event.data.sourcePosition.sequence !== sequence || event.data.batchId !== retained.batch.batchId
    || event.data.routingEpoch !== retained.batch.routingEpoch || retained.batch.eventCount !== 1
    || receipt.action !== 'work.edit' || receipt.outcome !== 'succeeded'
    || receipt.workRevision !== head || receipt.scope !== `work:edit:${work}`
    || receipt.id !== workEditReceiptIri(receipt.admissionId)
    || retained.eventId !== `urn:rezics:event:${hash(`${receipt.id}\0author-credit-retired`)}`
    || retained.batch.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained credit retirement identity differs');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = (await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
    if (fence?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const admitted = (await client.query<{ principal_id: string; action: string; state: string;
      scope_id: string; request_digest: string; acting_subject: string; authority_epoch: string;
      graph_receipt: string; graph_outcome: string; graph_data_epoch: string; graph_sequence: string }>(
      'SELECT * FROM access.admission WHERE id = $1', [receipt.admissionId])).rows[0];
    if (!admitted) throw new RetainedEffectConflict('retirement admission is unavailable');
    const digest = authorCreditRetirementDigest({ work, credit, revision, expectedHead: head,
      actingSubject: admitted.acting_subject, reason });
    if (admitted.state !== 'sealed' || admitted.action !== 'work.edit'
      || admitted.scope_id !== `work:edit:${work}` || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.request_digest !== digest || receipt.requestDigest !== digest
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence) {
      throw new RetainedEffectConflict('Access admission differs from retirement');
    }
    const native = await readAuthorCredit(env, credit, revision);
    if (!native || native.work !== work || native.expectedHead !== head) {
      throw new RetainedEffectConflict('original native credit must recover first');
    }
    const originalRows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt ?admission ?intent ?authority WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:authorCredit ${iri(credit)} ;
        rv:creditRevision ${iri(revision)} ; rv:sourceIntent ?intent ;
        rv:admissionId ?admission ; rv:authorityEpoch ?authority ; rv:outcome rv:Succeeded . }
    } LIMIT 3`, 4096)).results?.bindings ?? [];
    const original = originalRows[0];
    if (originalRows.length !== 1 || !original?.receipt || !original.admission || !original.intent
      || !original.authority || original.receipt.value !== workEditReceiptIri(original.admission.value)) {
      throw new RetainedEffectConflict('original credit receipt is unavailable');
    }
    const originalReceipt = await readAuthorCreditReceipt(env, original.admission.value);
    if (!originalReceipt || originalReceipt.receipt !== original.receipt.value
      || originalReceipt.sourceIntent !== original.intent.value
      || originalReceipt.authorityEpoch !== original.authority.value) {
      throw new RetainedEffectConflict('original credit proof differs');
    }
    const prior = await readAuthorCreditRetirement(env, credit);
    if (!prior) {
      const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
      const batch = `urn:rezics:outbox:${hash(receipt.id)}`;
      const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
          GRAPH ${iri(GRAPHS.current)} { ${iri(credit)} rv:retiredBy ${iri(receipt.id)} . }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} a rv:OperationReceipt ;
            rv:outcome rv:Succeeded ; rv:action "work.edit" ;
            rv:admissionId ${lit(receipt.admissionId)} ; rv:requestDigest ${lit(digest)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:admittedScope ${lit(receipt.scope)} ;
            rv:work ${iri(work)} ; rv:workRevision ${iri(head)} ; rv:expectedHead ${iri(head)} ;
            rv:authorCredit ${iri(credit)} ; rv:creditRevision ${iri(revision)} ;
            rv:retirementReason ${lit(reason)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} ; rv:eventCount 1 ;
            rv:event ${iri(retained.eventId)} . ${iri(retained.eventId)} a rv:AuthorCreditRetiredEvent ;
            rv:ordinal 0 ; rv:action "work.edit" ; rv:work ${iri(work)} ; rv:receipt ${iri(receipt.id)} . } }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ; rv:restoreHold true ;
          rv:restoreCutover ${iri(marker)} . ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
          rv:priorSequence ?saved . OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous) FILTER(?previous + 1 = ${sequence}) }
          GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a schema:CreativeWork ; rv:head ${iri(head)} .
            ${iri(credit)} a rv:AuthorCredit ; rv:work ${iri(work)} ; rv:creditRevision ${iri(revision)} . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:protectionHead ?p } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(credit)} rv:retiredBy ?r } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ?b rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} } }
        }`;
      const validations = await authorCreditValidations(env, native, originalReceipt.receipt,
        originalReceipt.authorityEpoch, originalReceipt.sourceIntent);
      const result = await env.fuseki.commandWithReceipt({ receipt: receipt.id, digest, update,
        validations, deadlineMs: 10_000 });
      if (result.status !== 'committed') {
        throw new RetainedEffectConflict(`retained credit retirement command ${result.status}`);
      }
    }
    const actual = await readAuthorCreditRetirement(env, credit);
    const cursor = await reconciledCursor(env, `urn:rezics:restore:${env.lineage.dataEpoch}`);
    if (!actual || actual.retirement !== receipt.id || actual.work !== work || actual.credit !== credit
      || actual.revision !== revision || actual.workHead !== head || actual.reason !== reason
      || actual.admissionId !== receipt.admissionId || actual.requestDigest !== digest
      || actual.sourcePosition.dataEpoch !== coverage.dataEpoch
      || actual.sourcePosition.sequence !== sequence || BigInt(cursor ?? '-1') < BigInt(sequence)) {
      throw new RetainedEffectConflict('native credit retirement recovery is incomplete');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, credit, revision, replayed: !!prior };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
