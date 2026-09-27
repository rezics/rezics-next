import { CommandRejected, fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AdmissionDenied, AdmissionExpired, type RegisteredAdmission } from '../access/admission.ts';
import { resolveClassification } from '../classification/resolve.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, IdempotencyConflict, prepareComponent,
  prepareWorkComponent, type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { sealMetadataWorkEditAdmission, workEditReceiptIri } from './edit.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { unerased } from './read-session.ts';
import { checkedMetadataIntent, metadataComponent, metadataDigest, METADATA_PROFILE,
  StaleWorkMetadata, WorkMetadataUnavailable, WORK_METADATA_COST, type MetadataIntent } from './metadata-schema.ts';

export interface MetadataReceipt {
  outcome: 'succeeded' | 'cancelled'; receipt: string; admissionId: string;
  requestDigest: string; authorityEpoch: string; scope: string; dataEpoch: string; sequence: string;
  work?: string; component?: string; revision?: string;
}
export async function readMetadataReceipt(env: Pick<WorkActivationEnvironment, 'fuseki'>,
  admissionId: string): Promise<MetadataReceipt | null> {
  const receipt = workEditReceiptIri(admissionId);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?outcome ?digest ?authority ?scope ?epoch ?sequence ?work ?component ?revision WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:admissionId ${lit(admissionId)} ;
        rv:outcome ?outcome ; rv:requestDigest ?digest ; rv:authorityEpoch ?authority ;
        rv:admittedScope ?scope ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(receipt)} rv:work ?work ; rv:metadataComponent ?component ; rv:metadataRevision ?revision }
      } } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const outcome = row.outcome?.value === `${RV}Succeeded` ? 'succeeded'
    : row.outcome?.value === `${RV}Cancelled` ? 'cancelled' : null;
  if (rows.length !== 1 || !outcome || !row.digest || !row.authority || !row.scope
    || !row.epoch || !row.sequence || outcome === 'succeeded' && (!row.work || !row.component || !row.revision)) {
    throw new WorkMetadataUnavailable('Metadata receipt is incomplete');
  }
  return { outcome, receipt, admissionId, requestDigest: row.digest.value, authorityEpoch: row.authority.value,
    scope: row.scope.value, dataEpoch: row.epoch.value, sequence: row.sequence.value,
    ...(outcome === 'succeeded' ? { work: row.work!.value, component: row.component!.value,
      revision: row.revision!.value } : {}) };
}
function checkedReceipt(receipt: MetadataReceipt, admission: RegisteredAdmission, intent: MetadataIntent) {
  if (receipt.requestDigest !== admission.requestDigest || receipt.authorityEpoch !== admission.authorityEpoch
    || receipt.scope !== admission.scope || receipt.admissionId !== admission.id) {
    throw new IdempotencyConflict('Metadata receipt differs from admission');
  }
  if (receipt.outcome === 'cancelled') throw new StaleWorkMetadata('Metadata command was cancelled; refresh its basis');
  if (receipt.work !== intent.work || receipt.component !== metadataComponent(intent.work, intent.state)) {
    throw new IdempotencyConflict('Metadata receipt targets another component');
  }
  return { work: receipt.work, component: receipt.component, revision: receipt.revision!, receipt: receipt.receipt,
    sourcePosition: { dataEpoch: receipt.dataEpoch, sequence: receipt.sequence } };
}

/** One component CAS. The exact graph position additionally fences classification dependencies.
 * Unrelated concurrent writes conservatively cancel this attempt; clients refresh and use a new key. */
export async function commitMetadata(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  unchecked: MetadataIntent): Promise<boolean> {
  const input = checkedMetadataIntent(unchecked), { work, state, expectedHead } = input;
  const digest = metadataDigest(input), component = metadataComponent(work, state);
  if (admission.action !== 'work.edit' || admission.scope !== `work:edit:${work}`
    || admission.requestDigest !== digest) throw new IdempotencyConflict('Metadata admission differs');
  const receipt = workEditReceiptIri(admission.id);
  await assertNotInvalidProfileReceipt(env.fuseki, receipt);
  if (await readMetadataReceipt(env, admission.id)) return false;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?head ?main ?sequence ?componentHead ?owner ?kind WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a <https://schema.org/CreativeWork> ;
        rv:head ?head ; rv:mainVersion ?main .
        OPTIONAL { ${iri(component)} rv:metadataHead ?componentHead ; rv:work ?owner ; rv:metadataKind ?kind }
      } ${unerased(iri(work))}
    } LIMIT 2`, 8192)).results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.head || !row.main || !row.sequence) {
    throw new WorkMetadataUnavailable('Work metadata is unavailable');
  }
  if ((row.componentHead?.value ?? null) !== expectedHead
    || row.owner && (row.owner.value !== work || row.kind?.value !== state.kind)) {
    await sealMetadataWorkEditAdmission(env, admission);
    return false;
  }
  if (state.kind === 'relevance') {
    const resolved = await resolveClassification(env, { work, mainVersion: row.main.value,
      sense: state.sense, context: state.context });
    if (resolved.state !== 'accepted' || resolved.decision !== state.decision
      || resolved.sourcePosition.sequence !== row.sequence.value
      || resolved.sourcePosition.dataEpoch !== env.lineage.dataEpoch) {
      await sealMetadataWorkEditAdmission(env, admission);
      return false;
    }
  }
  const revision = ID + Bun.randomUUIDv7();
  const validations = await profileValidations(env.fuseki, 'work-metadata-details-v1', [
    ...(state.kind === 'header' ? [{ shape: `${METADATA_PROFILE}/work-shape`, focus: [work],
      graphs: [GRAPHS.current, GRAPHS.revisions] }] : []),
    { shape: `${METADATA_PROFILE}/component-shape`, focus: [component], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${METADATA_PROFILE}/revision-shape`, focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  const retained = { intent: input, revision };
  const manifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, component, retained, METADATA_PROFILE)
    : prepareComponent(env.objectDirectory, component, retained, METADATA_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingAdmittedWork(admission.id, 'work-edit');
  const batch = `urn:rezics:outbox:${hash(receipt)}`, event = `urn:rezics:event:${hash(receipt)}`;
  const old = expectedHead ? iri(expectedHead) : '?absentHead';
  const update = `PREFIX rv: <${RV}>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(component)} rv:metadataHead ${old} ;
        rv:editionState ?oldStatus ; rv:editionLanguage ?oldLanguage .
        ${state.kind === 'header' ? `${iri(work)} rv:descriptiveMetadataHead ${old} ;
          rv:completionStatus ?oldCompletion .` : ''} }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(component)} a rv:WorkMetadataComponent ;
        rv:work ${iri(work)} ; rv:metadataKind ${lit(state.kind)} ; rv:metadataHead ${iri(revision)} .
        ${state.kind === 'header' ? `${iri(work)} rv:descriptiveMetadataHead ${iri(revision)} .
          ${state.completionStatus ? `${iri(work)} rv:completionStatus ${lit(state.completionStatus)} .` : ''}` : ''}
        ${state.kind === 'edition' ? `${iri(component)} rv:editionState rv:${state.status === 'active' ? 'Active' : 'Withdrawn'} .
          ${state.contentLanguage === null ? '' : `${iri(component)} rv:editionLanguage ${lit(state.contentLanguage)} .`}` : ''}
      }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:WorkMetadataRevision, rv:RevisionAnchor ;
        rv:component ${iri(component)} ; rv:metadataState ${lit(JSON.stringify(state))} ;
        ${expectedHead ? `rv:predecessor ${iri(expectedHead)} ;` : ''}
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ; rv:modelRevision ${iri(METADATA_PROFILE)} ;
        rv:shapeRevision ${iri(METADATA_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:work ${iri(work)} ; rv:metadataComponent ${iri(component)} ; rv:metadataRevision ${iri(revision)} ;
        rv:workRevision ${iri(revision)} ; rv:expectedHead ${iri(expectedHead ?? component)} ;
        rv:action "work.edit" ; rv:commandFamily "work-metadata-details-v1" ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:WorkMetadataChangedEvent ; rv:ordinal 0 ; rv:action "work.edit" ; rv:receipt ${iri(receipt)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . FILTER(?n = ${row.sequence.value}) }
      GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:head ${iri(row.head.value)} ; rv:mainVersion ${iri(row.main.value)} .
        OPTIONAL { ${iri(component)} rv:editionState ?oldStatus }
        OPTIONAL { ${iri(component)} rv:editionLanguage ?oldLanguage }
        ${state.kind === 'header' ? `OPTIONAL { ${iri(work)} rv:completionStatus ?oldCompletion }` : ''}
        ${expectedHead ? `${iri(component)} a rv:WorkMetadataComponent ; rv:work ${iri(work)} ;
          rv:metadataKind ${lit(state.kind)} ; rv:metadataHead ${iri(expectedHead)} .`
          : `FILTER NOT EXISTS { ${iri(component)} ?occupiedProperty ?occupiedValue }`}
      }
      ${unerased(iri(work))}
      ${expectedHead === null ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(component)} ?identityPredicate ?identityValue } }` : ''}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const result = await validatedCommand(env, { receipt, digest, update, validations,
    deadlineMs: WORK_METADATA_COST.deadlineMs }, admission);
  if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
  if (!await readMetadataReceipt(env, admission.id)) {
    await sealMetadataWorkEditAdmission(env, admission);
    return false;
  }
  return true;
}

/** Reuses the work.edit receipt identity, so strong closure races the same terminal
 * cancellation. Header, edition and relevance revisions do not rewrite a Work title. */
export async function setWorkMetadata(deps: MainWorkDependencies, request: Request,
  input: MetadataIntent & { actingSubject: string; idempotencyKey: string }) {
  const intent = checkedMetadataIntent(input), digest = metadataDigest(intent);
  const signal = AbortSignal.timeout(WORK_METADATA_COST.deadlineMs);
  return fusekiReadBudget.run({ signal, callsLeft: WORK_METADATA_COST.commandGraphCalls,
    bytesLeft: WORK_METADATA_COST.commandGraphBytes }, async () => {
    const env = deps.environment;
    await assertGraphAdmissionOpen(env.fuseki, env.lineage);
    const principal = await deps.account.verify(request, ['work:edit']);
    const registered = await deps.access.register({ principal, actingSubject: input.actingSubject,
      action: 'work.edit', scope: `work:edit:${intent.work}`, idempotencyKey: input.idempotencyKey, requestDigest: digest });
    try {
      let admission = registered;
      if (registered.state !== 'sealed' && registered.dispatchEligible) {
        try { admission = await deps.access.claim(registered.id, digest); }
        catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
      }
      let committed = false, failure: unknown;
      try {
        if (admission.state === 'sealed') { /* A retry resolves the exact receipt below. */ }
        else if (!admission.dispatchEligible || admission.state === 'registered') await sealMetadataWorkEditAdmission(env, admission);
        else committed = await commitMetadata(env, admission, intent);
      } catch (error) { failure = error; }
      const terminal = await readMetadataReceipt(env, admission.id);
      if (!terminal) {
        if (failure instanceof WorkMetadataUnavailable || failure instanceof IdempotencyConflict || failure instanceof CommandRejected) throw failure;
        throw new PendingAdmittedWork(admission.id, 'work-edit');
      }
      await deps.access.recordGraphOutcome(admission.id, terminal);
      await assertNotInvalidProfileReceipt(env.fuseki, terminal.receipt);
      if (failure instanceof CommandRejected) throw failure;
      return { ...checkedReceipt(terminal, admission, intent), replayed: !committed };
    } catch (error) {
      if (error instanceof WorkMetadataUnavailable || error instanceof IdempotencyConflict
        || error instanceof CommandRejected || error instanceof StaleWorkMetadata) throw error;
      // Once admitted, a failed claim/receipt/Access read cannot prove that no effect occurred.
      throw new PendingAdmittedWork(registered.id, 'work-edit');
    }
  });
}
