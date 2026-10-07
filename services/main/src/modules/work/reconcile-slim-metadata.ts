import type { Pool, PoolClient } from 'pg';
import { relayRetainedEventAt, RelayCheckpointConflict, type RelayCoverage } from '../outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../outbox/relay-position.ts';
import type { CommittedCustodySource } from '../outbox/receipt-custody.ts';
import { checkedEditionV2, checkedMetadataState, editionV2Digest, metadataDigest,
  METADATA_DETAILS_V2, METADATA_PROFILE, WORK_METADATA_COST } from './metadata-schema.ts';
import { workEditReceiptIri } from './edit.ts';
import { unerased } from './public-patterns.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from './activate.ts';

export class SlimMetadataRestoreConflict extends Error {}
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const decimal = /^(0|[1-9][0-9]*)$/;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, member: unknown) =>
  member && typeof member === 'object' && !Array.isArray(member)
    ? Object.fromEntries(Object.entries(member).sort(([a], [b]) => a.localeCompare(b))) : member);

function sourceIdentity(env: WorkActivationEnvironment, source: CommittedCustodySource) {
  const { terminal, prepared, payloadSha256 } = source;
  const digest = hash(JSON.stringify(['held-slim-metadata-restore-v1', env.lineage.dataEpoch,
    env.lineage.routingEpoch, terminal.receipt, terminal.requestDigest, payloadSha256,
    terminal.dataEpoch, terminal.sequence, terminal.streamSequence, prepared.component, prepared.revision]));
  return { digest, receipt: `urn:rezics:name-migration:metadata-restore:${digest}` };
}

function exactEdition(source: CommittedCustodySource) {
  const { prepared, terminal } = source;
  const state = source.model === METADATA_DETAILS_V2
    ? checkedEditionV2(prepared.state) : checkedMetadataState(prepared.state);
  const predecessor = terminal.predecessor;
  if (![METADATA_PROFILE, METADATA_DETAILS_V2].includes(source.model)
    || state.kind !== 'edition' || canonical(state) !== canonical(prepared.state)
    || !nativeId.test(terminal.work) || !nativeId.test(prepared.component)
    || !nativeId.test(prepared.revision) || !predecessor || !nativeId.test(predecessor)
    || new Set([terminal.work, prepared.component, prepared.revision]).size !== 3
    || prepared.revision === predecessor || prepared.component !== state.id
    || terminal.component !== prepared.component || terminal.revision !== prepared.revision
    || terminal.receipt !== workEditReceiptIri(terminal.admissionId)
    || terminal.scope !== `work:edit:${terminal.work}`
    || !/^[1-9][0-9]*$/.test(terminal.sequence) || !/^[1-9][0-9]*$/.test(terminal.streamSequence)) {
    throw new SlimMetadataRestoreConflict('retained slim edition source differs from its exact meaning');
  }
  const expectedHead = predecessor === prepared.component ? null : predecessor;
  const digest = 'contentLanguages' in state
    ? editionV2Digest({ work: terminal.work, expectedHead, state })
    : metadataDigest({ work: terminal.work, expectedHead, state });
  if (digest !== terminal.requestDigest) throw new SlimMetadataRestoreConflict('retained slim edition digest differs');
  return { state, expectedHead };
}

/** Repair one retained Main position under both recovery fences. Custody is the
 * source; ordinary committed owner replay deliberately performs no graph repair. */
export async function reconcileRetainedSlimMetadata(env: WorkActivationEnvironment,
  accessPool: Pool, relayPool: Pool, coverage: RelayCoverage, mainSequence: string,
  accessClient?: PoolClient, relayClient?: PoolClient,
): Promise<{ receipt: string; component: string; revision: string; replayed: boolean }> {
  if (!env.receiptCustody) throw new SlimMetadataRestoreConflict('slim receipt custody is unavailable');
  let retained: Awaited<ReturnType<typeof relayRetainedEventAt>>;
  try { retained = await relayRetainedEventAt(relayPool, coverage, mainSequence, relayClient); }
  catch (error) {
    if (error instanceof RelayCheckpointConflict) throw new SlimMetadataRestoreConflict(error.message, { cause: error });
    throw error;
  }
  const envelope = retained.envelope;
  if (!['com.rezics.work.metadata-changed.v1', 'com.rezics.work.metadata-revised.v1'].includes(envelope.type)
    || !envelope.data?.receipt?.id || envelope.data.receipt.action !== 'work.edit'
    || envelope.data.receipt.outcome !== 'succeeded') {
    throw new SlimMetadataRestoreConflict('retained slim metadata event is incomplete');
  }
  let source: CommittedCustodySource | null;
  try { source = accessClient
    ? (await env.receiptCustody.readHistorical({ dataEpoch: coverage.dataEpoch,streamSequence: mainSequence },accessClient))?.source ?? null
    : await env.receiptCustody.readCommitted(envelope.data.receipt.id); }
  catch (error) { throw new SlimMetadataRestoreConflict('retained slim custody is unavailable or corrupt', { cause: error }); }
  if (!source) throw new SlimMetadataRestoreConflict('retained slim custody is unavailable');
  const { terminal, prepared } = source;
  const manifestIri = `urn:rezics:sha256:${source.manifestSha256}`;
  if (coverage.streamScope !== MAIN_RELAY_STREAM_SCOPE || terminal.dataEpoch !== coverage.dataEpoch
    || terminal.streamSequence !== mainSequence || source.outbox.events.length !== 1
    || canonical(source.outbox.events[0]) !== canonical(envelope)
    || retained.eventId !== envelope.id || retained.batch.batchId !== source.outbox.batchId
    || retained.batch.routingEpoch !== prepared.routingEpoch || retained.batch.eventCount !== 1) {
    throw new SlimMetadataRestoreConflict('retained slim event differs from exact custody');
  }
  let edition: ReturnType<typeof exactEdition>;
  try { edition = exactEdition(source); }
  catch (error) { throw new SlimMetadataRestoreConflict('retained slim edition meaning or digest differs', { cause: error }); }
  const { state, expectedHead } = edition;
  const { receipt: maintenanceReceipt, digest } = sourceIdentity(env, source);
  const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
  const client = accessClient ?? await accessPool.connect();
  try {
    if (!accessClient) await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>('SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows.length !== 1 || fence.rows[0]?.open !== false) {
      throw new SlimMetadataRestoreConflict('Access recovery fence is not held');
    }
    // Serialize only this retained admission through graph reconciliation, so
    // concurrent retries observe the first repair's receipt before preparing.
    const admissions = await client.query<{ action: string; state: string; acting_subject: string;
      scope_id: string; request_digest: string; authority_epoch: string; graph_receipt: string | null;
      graph_outcome: string | null; graph_data_epoch: string | null; graph_sequence: string | null }>(
      `SELECT action,state,acting_subject,scope_id,request_digest,authority_epoch,
        graph_receipt,graph_outcome,graph_data_epoch,graph_sequence
       FROM access.admission WHERE id = $1 FOR UPDATE`, [terminal.admissionId]);
    const admission = admissions.rows[0];
    if (admissions.rows.length !== 1 || !admission || admission.action !== 'work.edit'
      || admission.state !== 'sealed' || !nativeId.test(admission.acting_subject)
      || admission.scope_id !== terminal.scope || admission.request_digest !== terminal.requestDigest
      || admission.authority_epoch !== terminal.authorityEpoch || admission.graph_receipt !== terminal.receipt
      || admission.graph_outcome !== 'succeeded' || admission.graph_data_epoch !== terminal.dataEpoch
      || admission.graph_sequence !== terminal.sequence) {
      throw new SlimMetadataRestoreConflict('sealed Access admission does not prove retained slim metadata');
    }
    const sourceRefs = [terminal.work, prepared.component, prepared.revision,
      ...(expectedHead ? [expectedHead] : []), ...source.objectReferences.map(ref => `sha256:${ref.digest}`)];
    const erased = await (relayClient ?? relayPool).query(`SELECT 1 FROM relay.erasure_target t
      JOIN relay.erasure e ON e.id = t.erasure_id
      WHERE e.suppression_status = 'suppressed' AND t.target_ref = ANY($1::text[]) LIMIT 1`, [sourceRefs]);
    const graphErased = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      VALUES ?source { ${sourceRefs.filter(ref => ref.startsWith('https:')).map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.revisions)} { ?source a rv:ErasedRevision }
    }`, 4096);
    if (erased.rows.length || graphErased.boolean !== false) {
      throw new SlimMetadataRestoreConflict('retained slim metadata source is erased or unavailable');
    }
    const workAvailable = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(terminal.work)} a <https://schema.org/CreativeWork> }
      ${unerased(iri(terminal.work))}
    }`, 4096);
    if (workAvailable.boolean !== true) throw new SlimMetadataRestoreConflict('retained slim metadata Work is erased or unavailable');
    const controls = (await env.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?saved ?savedMain ?last ?lastMain WHERE { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ;
          rv:sequence 0 ; rv:restoreHold true ; rv:restoreCutover ${iri(marker)} .
        ${iri(marker)} rv:priorDataEpoch ${lit(terminal.dataEpoch)} ; rv:priorSequence ?saved ; rv:priorMainSequence ?savedMain .
        OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
        OPTIONAL { ${iri(marker)} rv:reconciledPriorMainSequence ?lastMain }
      } } LIMIT 2`, 4096)).results?.bindings ?? [];
    const control = controls[0];
    if (controls.length !== 1 || !control?.saved || !control.savedMain
      || ['saved', 'savedMain', 'last', 'lastMain'].some(key => control[key] && !decimal.test(control[key]!.value))
      || Boolean(control.last) !== Boolean(control.lastMain)) {
      throw new SlimMetadataRestoreConflict('held slim metadata recovery cut is unavailable');
    }
    const diagnosticCursor = control.last?.value ?? control.saved.value;
    const mainCursor = control.lastMain?.value ?? control.savedMain.value;
    const ownProof = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(maintenanceReceipt)} a rv:OperationReceipt ; rv:commandFamily "metadata-restore-v1" ;
        rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence 0 ;
        rv:sourceReceipt ${iri(terminal.receipt)} ; rv:sourceDigest ${lit(terminal.requestDigest)} ;
        rv:sourcePayloadDigest ${lit(source.payloadSha256)} ; rv:sourceSequence ${terminal.sequence} ;
        rv:sourceMainSequence ${terminal.streamSequence} ; rv:metadataComponent ${iri(prepared.component)} ;
        rv:metadataRevision ${iri(prepared.revision)} ; rv:metadataManifest ${iri(manifestIri)} ;
        rv:metadataModel ${iri(source.model)} . } }`, 8192);
    if (ownProof.boolean !== false && ownProof.boolean !== true) throw new SlimMetadataRestoreConflict('metadata restore proof is unavailable');
    const replayed = ownProof.boolean === true;
    if (replayed) {
      if (BigInt(mainCursor) < BigInt(terminal.streamSequence) || BigInt(diagnosticCursor) < BigInt(terminal.sequence)) {
        throw new SlimMetadataRestoreConflict('metadata restore proof differs from its cursor');
      }
    } else {
      if (BigInt(mainCursor) + 1n !== BigInt(terminal.streamSequence)
        || BigInt(diagnosticCursor) >= BigInt(terminal.sequence)) {
        throw new SlimMetadataRestoreConflict('retained slim metadata position is not the next held position');
      }
      const headers = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?work WHERE {
        { ${iri(prepared.component)} rv:metadataHead ?head ; rv:work ?work }
        UNION { GRAPH ${iri(GRAPHS.current)} { ${iri(prepared.component)} rv:metadataHead ?head ; rv:work ?work } }
      } LIMIT 2`, 4096)).results?.bindings ?? [];
      if (headers.length !== (expectedHead ? 1 : 0)
        || expectedHead && (headers[0]?.head?.value !== expectedHead || headers[0]?.work?.value !== terminal.work)) {
        throw new SlimMetadataRestoreConflict('retained slim metadata local predecessor differs');
      }
      const languages = 'contentLanguages' in state && state.contentLanguages.length ? state.contentLanguages.join(' ') : null;
      const originalLanguages = 'originalLanguages' in state && state.originalLanguages.length ? state.originalLanguages.join(' ') : null;
      const single = 'contentLanguage' in state ? state.contentLanguage : state.contentLanguages.length === 1 ? state.contentLanguages[0]! : null;
      const current = `${iri(prepared.component)} a rv:${source.model === METADATA_DETAILS_V2 ? 'EditionRecord' : 'WorkMetadataComponent'} ;
        rv:work ${iri(terminal.work)} ; rv:metadataKind "edition" ; rv:metadataHead ${iri(prepared.revision)} ;
        rv:editionState rv:${state.status === 'active' ? 'Active' : 'Withdrawn'} .
        ${single ? `${iri(prepared.component)} rv:editionLanguage ${lit(single)} .` : ''}
        ${languages ? `${iri(prepared.component)} rv:contentLanguages ${lit(languages)} .` : ''}
        ${originalLanguages ? `${iri(prepared.component)} rv:originalLanguages ${lit(originalLanguages)} .` : ''}
        ${'titleLanguage' in state && state.titleLanguage ? `${iri(prepared.component)} rv:titleLanguage ${lit(state.titleLanguage)} .` : ''}
        ${'tracklistLanguage' in state && state.tracklistLanguage ? `${iri(prepared.component)} rv:tracklistLanguage ${lit(state.tracklistLanguage)} .` : ''}
        ${'isTranslation' in state && state.isTranslation ? `${iri(prepared.component)} rv:isTranslation "true" .` : ''}`;
      const update = `PREFIX rv: <${RV}> INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${terminal.sequence} ;
          rv:reconciledPriorMainSequence ${terminal.streamSequence} . }
        GRAPH ${iri(GRAPHS.current)} { ${current}
          ${iri(terminal.work)} rv:editionsRevision ${iri(prepared.revision)} . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(prepared.revision)} a rv:${source.model === METADATA_DETAILS_V2 ? 'WorkMetadataDetailsV2Revision' : 'WorkMetadataRevision'}, rv:RevisionAnchor ;
          rv:component ${iri(prepared.component)} ; rv:metadataState ${lit(JSON.stringify(prepared.state))} ;
          ${expectedHead ? `rv:predecessor ${iri(expectedHead)} ;` : ''}
          rv:manifest ${iri(manifestIri)} ; rv:modelRevision ${iri(source.model)} ; rv:shapeRevision ${iri(source.model)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(terminal.dataEpoch)} ; rv:sequence ${terminal.sequence} . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(maintenanceReceipt)} a rv:OperationReceipt ;
          rv:commandFamily "metadata-restore-v1" ; rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence 0 ; rv:work ${iri(terminal.work)} ;
          rv:sourceReceipt ${iri(terminal.receipt)} ; rv:sourceDigest ${lit(terminal.requestDigest)} ;
          rv:sourcePayloadDigest ${lit(source.payloadSha256)} ; rv:sourceDataEpoch ${lit(terminal.dataEpoch)} ;
          rv:sourceSequence ${terminal.sequence} ; rv:sourceMainSequence ${terminal.streamSequence} ;
          rv:sourceAdmissionId ${lit(terminal.admissionId)} ; rv:sourceAuthorityEpoch ${lit(terminal.authorityEpoch)} ;
          rv:sourceScope ${lit(terminal.scope)} ; rv:sourcePredecessor ${iri(terminal.predecessor!)} ;
          rv:metadataComponent ${iri(prepared.component)} ; rv:metadataRevision ${iri(prepared.revision)} ;
          rv:metadataManifest ${iri(manifestIri)} ; rv:metadataModel ${iri(source.model)} . }
      } WHERE { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ;
          rv:sequence 0 ; rv:restoreHold true ; rv:restoreCutover ${iri(marker)} .
        ${iri(marker)} rv:priorDataEpoch ${lit(terminal.dataEpoch)} ; rv:priorSequence ${control.saved.value} ;
          rv:priorMainSequence ${control.savedMain.value} . }
        GRAPH ${iri(GRAPHS.current)} { ${iri(terminal.work)} a <https://schema.org/CreativeWork> }
        ${expectedHead ? `GRAPH ${iri(GRAPHS.current)} { ${iri(prepared.component)} rv:metadataHead ${iri(expectedHead)} }` : ''}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(maintenanceReceipt)} ?p ?o } }
      }`;
      let commandError: unknown;
      try {
        const result = await env.fuseki.commandWithReceipt({ receipt: maintenanceReceipt, digest, update,
          validations: prepared.envelope.validations, deadlineMs: WORK_METADATA_COST.deadlineMs });
        if (result.status !== 'committed') throw new SlimMetadataRestoreConflict(`metadata restore command ${result.status}`);
      } catch (error) { commandError = error; }
      const committed = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(maintenanceReceipt)} rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
          rv:sourcePayloadDigest ${lit(source.payloadSha256)} ; rv:metadataRevision ${iri(prepared.revision)} }
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${terminal.sequence} ;
          rv:reconciledPriorMainSequence ${terminal.streamSequence} }
      }`, 8192);
      if (committed.boolean !== true) throw new SlimMetadataRestoreConflict('slim metadata restore outcome is unproven', { cause: commandError });
    }
    const currentMain = replayed ? mainCursor : terminal.streamSequence;
    if (currentMain === terminal.streamSequence) {
      const head = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { ${iri(prepared.component)}
        rv:metadataHead ${iri(prepared.revision)} ; rv:manifest ${iri(manifestIri)} ; rv:modelRevision ${iri(source.model)} }
      `, 4096);
      if (head.boolean !== true) throw new SlimMetadataRestoreConflict('restored slim edition header is unavailable');
    }
    if (!accessClient) await client.query('COMMIT');
    return { receipt: terminal.receipt, component: prepared.component, revision: prepared.revision, replayed };
  } catch (error) {
    if (!accessClient) try { await client.query('ROLLBACK'); } catch { /* Keep the refusal which left the graph held. */ }
    throw error;
  } finally { if (!accessClient) client.release(); }
}
