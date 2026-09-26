import type { Pool } from 'pg';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { reconciledCursor, RetainedEffectConflict } from '../work/reconcile-restored.ts';
import { authorCreditDigest, authorCreditEnvelope, authorCreditTriples, authorCreditValidations,
  readAuthorCreditReceipt, readAuthorCredit } from '../work/author-credit.ts';
import { workEditReceiptIri } from '../work/edit.ts';
import { relayRetainedEventAt, type RelayCoverage, type MainCloudEvent } from '../outbox/relay.ts';
import { SourceIntakeStore } from './intake.ts';
import { OpenLibraryConversionStore } from './open-library-conversion.ts';
import { OpenLibrarySourceGraph } from './graph-projection.ts';
import { SourceNativeWorkProposalStore } from './native-work-proposal.ts';
import { sourceChildOccurrence } from './child-correspondence.ts';
import { creditValue, sourceAuthorCreditRequestDigest, type AuthorCreditIntentRow } from './author-credit.ts';

/** One original immutable occurrence replay, at the exact retained source position. */
export async function reconcileRetainedAuthorCredit(env: WorkActivationEnvironment,
  accessPool: Pool, relayPool: Pool, contentPool: Pool, coverage: RelayCoverage, sequence: string) {
  const retained = await relayRetainedEventAt(relayPool, coverage, sequence)
    .catch(() => { throw new RetainedEffectConflict('retained credit event is unavailable'); });
  const event = retained.envelope as MainCloudEvent;
  const receipt = event.data?.receipt;
  const intentId = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/.exec(receipt?.sourceIntent ?? '')?.[1];
  if (!receipt || !intentId || event.id !== retained.eventId || event.specversion !== '1.0'
    || event.source !== 'https://rezics.com/services/main' || event.type !== 'com.rezics.work.author-credit-adopted.v1'
    || event.datacontenttype !== 'application/json' || event.data.ordinal !== 0
    || event.data.sourcePosition.datasetId !== 'product' || event.data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || event.data.sourcePosition.sequence !== sequence || event.data.batchId !== retained.batch.batchId
    || event.data.routingEpoch !== retained.batch.routingEpoch || retained.batch.eventCount !== 1
    || receipt.action !== 'work.edit' || receipt.outcome !== 'succeeded'
    || receipt.id !== workEditReceiptIri(receipt.admissionId)
    || retained.eventId !== `urn:rezics:event:${hash(`${receipt.id}\0author-credit`)}`
    || retained.batch.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained credit event identity differs');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = (await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
    if (fence?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const row = (await contentPool.query<AuthorCreditIntentRow>(
      'SELECT * FROM source.author_credit_intent WHERE id = $1', [intentId])).rows[0];
    if (!row || row.base_support_id || row.request_digest !== sourceAuthorCreditRequestDigest(row.work, row.request)) {
      throw new RetainedEffectConflict('original source credit intent is unavailable');
    }
    const value = creditValue(row);
    const digest = authorCreditDigest(value, receipt.sourceIntent!);
    const admitted = (await client.query<{ principal_id: string; action: string; state: string; scope_id: string;
      request_digest: string; acting_subject: string; authority_epoch: string; idempotency_key: string;
      graph_receipt: string; graph_outcome: string; graph_data_epoch: string; graph_sequence: string }>(
      'SELECT * FROM access.admission WHERE id = $1', [receipt.admissionId])).rows[0];
    if (!admitted || admitted.principal_id !== row.principal_id || admitted.action !== 'work.edit'
      || admitted.state !== 'sealed' || admitted.scope_id !== `work:edit:${value.work}`
      || receipt.scope !== admitted.scope_id || admitted.request_digest !== digest || receipt.requestDigest !== digest
      || admitted.acting_subject !== value.actingSubject || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.idempotency_key !== `source-credit-${row.id}` || admitted.graph_receipt !== receipt.id
      || admitted.graph_outcome !== 'succeeded' || admitted.graph_data_epoch !== coverage.dataEpoch
      || admitted.graph_sequence !== sequence || receipt.authorCredit !== value.credit
      || receipt.creditRevision !== value.revision || receipt.work !== value.work
      || receipt.expectedHead !== value.expectedHead || receipt.workRevision !== value.expectedHead) {
      throw new RetainedEffectConflict('Access admission differs from retained credit');
    }
    const conversions = new OpenLibraryConversionStore(contentPool, new SourceIntakeStore(contentPool));
    const graph = new OpenLibrarySourceGraph(env.fuseki, env.lineage, conversions);
    const proposals = new SourceNativeWorkProposalStore(contentPool, graph, conversions);
    const proposal = await proposals.read(row.principal_id, row.proposal_id)
      .catch(() => { throw new RetainedEffectConflict('source proposal graph must recover first'); });
    const evidence = await conversions.verifiedRead(row.principal_id, row.conversion_id);
    const child = evidence?.conversion.projection.authorRefs?.[row.source_ordinal];
    if (!proposal || !evidence || proposal.record !== `https://rezics.com/id/${row.record_id}`
      || proposal.conversion !== evidence.conversion.conversion || proposal.proposal !== row.request.proposal
      || proposal.conversion !== row.request.conversion || !child || child.sourceKey !== value.sourceKey
      || child.roleKey !== value.sourceRoleKey || row.request.sourceOrdinal !== row.source_ordinal
      || row.request.occurrence !== row.occurrence
      || sourceChildOccurrence(evidence.observation.observation, 'authors', row.source_ordinal) !== row.occurrence) {
      throw new RetainedEffectConflict('retained source occurrence differs');
    }
    const certificate = (await contentPool.query<{ graph_receipt: string; admission_id: string;
      data_epoch: string; sequence: string }>('SELECT * FROM source.author_credit_application WHERE intent_id = $1', [row.id])).rows[0];
    if (certificate && (certificate.graph_receipt !== receipt.id || certificate.admission_id !== receipt.admissionId
      || certificate.data_epoch !== coverage.dataEpoch || certificate.sequence !== sequence)) {
      throw new RetainedEffectConflict('source certificate differs from retained credit');
    }
    const existing = await readAuthorCreditReceipt(env, receipt.admissionId);
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    if (!existing) {
      const triples = authorCreditTriples(value, coverage.dataEpoch, sequence);
      const admission = { id: receipt.admissionId, scope: receipt.scope,
        authorityEpoch: receipt.authorityEpoch, requestDigest: digest };
      const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
          GRAPH ${iri(GRAPHS.current)} { ${triples.current} }
          GRAPH ${iri(GRAPHS.revisions)} { ${triples.revision} }
          ${authorCreditEnvelope(value, receipt.sourceIntent!, admission, coverage.dataEpoch, sequence)} }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ; rv:restoreHold true ; rv:restoreCutover ${iri(marker)} .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ; rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous) FILTER(?previous + 1 = ${sequence}) }
          GRAPH ${iri(GRAPHS.current)} { ${iri(value.work)} rv:head ${iri(value.expectedHead)} . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(value.credit)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(value.revision)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ?batch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} } }
        }`;
      const validations = await authorCreditValidations(env, value, receipt.id, receipt.authorityEpoch, receipt.sourceIntent!);
      await env.fuseki.commandWithReceipt({ receipt: receipt.id, digest, update, validations, deadlineMs: 10_000 });
    }
    const checked = await readAuthorCreditReceipt(env, receipt.admissionId);
    const native = await readAuthorCredit(env, value.credit, value.revision);
    if (!checked || !native || checked.requestDigest !== digest || checked.dataEpoch !== coverage.dataEpoch
      || checked.sequence !== sequence || checked.credit !== value.credit || checked.revision !== value.revision
      || native.sourceKey !== value.sourceKey || native.sourceRoleKey !== value.sourceRoleKey
      || native.nativeOrdinal !== value.nativeOrdinal || native.actingSubject !== value.actingSubject
      || native.work !== value.work || native.expectedHead !== value.expectedHead
      || BigInt(await reconciledCursor(env, marker) ?? '-1') < BigInt(sequence)) {
      throw new RetainedEffectConflict('native credit recovery is incomplete');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, credit: value.credit, revision: value.revision, replayed: !!existing };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
