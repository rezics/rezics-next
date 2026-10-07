import { CommandRejected, fusekiReadBudget, type CommandEnvelope } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { catalogueTitleKey } from '../catalogue-intake/title-keys.ts';
import { catalogueNameProjection } from '../search/names.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AdmissionDenied, AdmissionExpired, type RegisteredAdmission } from '../access/admission.ts';
import { resolveClassification } from '../classification/resolve.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, IdempotencyConflict, prepareComponent,
  prepareWorkComponent, type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { sealMetadataWorkEditAdmission, workEditReceiptIri } from './edit.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { unerased } from './read-session.ts';
import { languageListLiteral } from '../release/languages.ts';
import { checkedEditionV2, checkedMetadataIntent, editionLanguageLiteral, editionV2Digest, metadataComponent,
  metadataDigest, METADATA_DETAILS_V2, METADATA_PROFILE, StaleWorkMetadata, WorkMetadataUnavailable,
  WORK_METADATA_COST, type MetadataEditionStateV2, type MetadataIntent, type MetadataState } from './metadata-schema.ts';

export interface MetadataReceipt {
  outcome: 'succeeded' | 'cancelled'; receipt: string; admissionId: string;
  requestDigest: string; authorityEpoch: string; scope: string; dataEpoch: string; sequence: string;
  work?: string; component?: string; revision?: string;
}
export async function readMetadataReceipt(env: Pick<WorkActivationEnvironment, 'fuseki' | 'receiptCustody'>,
  admissionId: string): Promise<MetadataReceipt | null> {
  const receipt = workEditReceiptIri(admissionId);
  const owned = await env.receiptCustody?.resolve(receipt);
  if (owned) return owned;
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
async function commitMetadataEnvelope(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  envelope: CommandEnvelope, metadata: {
    work: string; component: string; revision: string; manifest: string; predecessor: string;
  },
  state: MetadataState | MetadataEditionStateV2) {
  const dispatch = (command: CommandEnvelope) => validatedCommand(env, command, admission);
  if (state.kind !== 'edition' || !env.receiptCustody) return dispatch(envelope);
  return env.receiptCustody.commit({ envelope, component: metadata.component,
    revision: metadata.revision, manifest: metadata.manifest, state, routingEpoch: env.lineage.routingEpoch,
    receipt: { outcome: 'succeeded', receipt: envelope.receipt, admissionId: admission.id,
      requestDigest: envelope.digest, authorityEpoch: admission.authorityEpoch, scope: admission.scope,
      dataEpoch: env.lineage.dataEpoch, work: metadata.work, component: metadata.component,
      revision: metadata.revision, predecessor: metadata.predecessor }, dispatch });
}
async function retireMetadataProof(env: WorkActivationEnvironment, receipt: string) {
  try { await env.receiptCustody?.retire(receipt); }
  catch { /* The reconciled owner result is final; a retry can finish proof retirement. */ }
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
        rv:head ?head ; rv:mainVersion ?main . }
      OPTIONAL { { ${iri(component)} rv:metadataHead ?componentHead ; rv:work ?owner ; rv:metadataKind ?kind }
        UNION { GRAPH ${iri(GRAPHS.current)} {
          ${iri(component)} rv:metadataHead ?componentHead ; rv:work ?owner ; rv:metadataKind ?kind } } }
      ${unerased(iri(work))}
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
    { shape: `${METADATA_PROFILE}/work-shape`, focus: [work], graphs: [GRAPHS.current, GRAPHS.revisions] },
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
  const names = state.kind === 'header'
    ? (await catalogueNameProjection(env, [work], { work, header: state })).get(work)! : null;
  const update = `PREFIX rv: <${RV}>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      ${names ? `GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?nameUnit rv:publicTitle ?oldName }` : ''}
      GRAPH ${iri(GRAPHS.current)} { ${iri(component)} rv:metadataHead ${old} ;
        rv:editionState ?oldStatus ; rv:editionLanguage ?oldLanguage .
        ${state.kind === 'edition' ? `${iri(work)} rv:editionsRevision ?oldEditionsRevision .` : ''}
        ${state.kind === 'header' ? `${iri(work)} rv:descriptiveMetadataHead ${old} ;
          rv:completionStatus ?oldCompletion ; rv:catalogueMetadataTitleKey ?oldTitleKey .` : ''} }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      ${names ? `GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${[...names].map(name => `?nameUnit rv:publicTitle ${name} .`).join('\n')} }` : ''}
      GRAPH ${iri(GRAPHS.current)} { ${iri(component)} a rv:WorkMetadataComponent ;
        rv:work ${iri(work)} ; rv:metadataKind ${lit(state.kind)} ; rv:metadataHead ${iri(revision)} .
        ${state.kind === 'edition' ? `${iri(work)} rv:editionsRevision ${iri(revision)} .` : ''}
        ${state.kind === 'header' ? `${iri(work)} rv:descriptiveMetadataHead ${iri(revision)} .
          ${[...new Set([...(state.originalTitle ? [state.originalTitle.value] : []),
            ...state.localized.flatMap(locale => locale.title ? [locale.title] : [])].map(catalogueTitleKey))]
            .map(key => `${iri(work)} rv:catalogueMetadataTitleKey ${lit(key)} .`).join(' ')}
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
        ${state.kind === 'edition' ? `OPTIONAL { ${iri(work)} rv:editionsRevision ?oldEditionsRevision }` : ''}
        ${state.kind === 'header' ? `OPTIONAL { ${iri(work)} rv:completionStatus ?oldCompletion }
          OPTIONAL { ${iri(work)} rv:catalogueMetadataTitleKey ?oldTitleKey }` : ''}
        ${expectedHead ? `${iri(component)} a rv:WorkMetadataComponent ; rv:work ${iri(work)} ;
          rv:metadataKind ${lit(state.kind)} ; rv:metadataHead ${iri(expectedHead)} .`
          : `FILTER NOT EXISTS { ${iri(component)} ?occupiedProperty ?occupiedValue }`}
      }
      ${unerased(iri(work))}
      ${names ? `OPTIONAL { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ?nameUnit a rv:MatchUnit ; rv:work ${iri(work)} ; rv:disclosure rv:Public .
        OPTIONAL { ?nameUnit rv:publicTitle ?oldName } } }` : ''}
      ${expectedHead === null ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(component)} ?identityPredicate ?identityValue } }` : ''}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const result = await commitMetadataEnvelope(env, admission, { receipt, digest, update, validations,
    deadlineMs: WORK_METADATA_COST.deadlineMs }, { work, component, revision, manifest,
      predecessor: expectedHead ?? component }, state);
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
  input: { profile?: string; work: string; expectedHead: string | null; state: MetadataState | MetadataEditionStateV2;
    actingSubject: string; idempotencyKey: string }) {
  if (input.profile === 'work-metadata-details-v2') {
    return setEditionV2(deps, request, { work: input.work, expectedHead: input.expectedHead,
      state: input.state as MetadataEditionStateV2, actingSubject: input.actingSubject,
      idempotencyKey: input.idempotencyKey });
  }
  const intent = checkedMetadataIntent({ work: input.work, expectedHead: input.expectedHead,
    state: input.state as MetadataState }), digest = metadataDigest(intent);
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
        try { admission = await deps.access.claim(registered.id, digest, principal); }
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
      const result = { ...checkedReceipt(terminal, admission, intent), replayed: !committed };
      if (intent.state.kind === 'edition') await retireMetadataProof(env, terminal.receipt);
      return result;
    } catch (error) {
      if (error instanceof WorkMetadataUnavailable || error instanceof IdempotencyConflict
        || error instanceof CommandRejected || error instanceof StaleWorkMetadata) throw error;
      // Once admitted, a failed claim/receipt/Access read cannot prove that no effect occurred.
      throw new PendingAdmittedWork(registered.id, 'work-edit');
    }
  });
}

async function commitEditionV2(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: { work: string; expectedHead: string | null; state: MetadataEditionStateV2 }): Promise<boolean> {
  const state = checkedEditionV2(input.state);
  const intent = { work: input.work, expectedHead: input.expectedHead, state };
  const digest = editionV2Digest(intent);
  const component = state.id;
  if (admission.action !== 'work.edit' || admission.scope !== `work:edit:${intent.work}`
    || admission.requestDigest !== digest) throw new IdempotencyConflict('Metadata admission differs');
  const receipt = workEditReceiptIri(admission.id);
  await assertNotInvalidProfileReceipt(env.fuseki, receipt);
  if (await readMetadataReceipt(env, admission.id)) return false;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?head ?sequence ?componentHead ?owner ?kind WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} a <https://schema.org/CreativeWork> ; rv:head ?head . }
      OPTIONAL { { ${iri(component)} rv:metadataHead ?componentHead ; rv:work ?owner ; rv:metadataKind ?kind }
        UNION { GRAPH ${iri(GRAPHS.current)} {
          ${iri(component)} rv:metadataHead ?componentHead ; rv:work ?owner ; rv:metadataKind ?kind } } }
    } LIMIT 2`, 8192)).results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.head || !row.sequence) throw new WorkMetadataUnavailable('Work metadata is unavailable');
  if ((row.componentHead?.value ?? null) !== intent.expectedHead
    || row.owner && (row.owner.value !== intent.work || row.kind?.value !== 'edition')) {
    await sealMetadataWorkEditAdmission(env, admission);
    return false;
  }
  const revision = ID + Bun.randomUUIDv7();
  const validations = [...await profileValidations(env.fuseki, 'work-metadata-details-v1', [
    { shape: `${METADATA_PROFILE}/work-shape`, focus: [intent.work], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]), ...await profileValidations(env.fuseki, 'work-metadata-details-v2', [
    { shape: `${METADATA_DETAILS_V2}/component-shape`, focus: [component], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${METADATA_DETAILS_V2}/revision-shape`, focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ])];
  const manifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, component, { intent, revision }, METADATA_DETAILS_V2)
    : prepareComponent(env.objectDirectory, component, { intent, revision }, METADATA_DETAILS_V2);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingAdmittedWork(admission.id, 'work-edit');
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const languages = editionLanguageLiteral(state);
  const originals = languageListLiteral(state.originalLanguages);
  const single = state.contentLanguages.length === 1 ? state.contentLanguages[0] : null;
  const prior = intent.expectedHead;
  const update = `PREFIX rv: <${RV}>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(component)} rv:metadataHead ${prior ? iri(prior) : '?absentHead'} ;
        rv:editionState ?oldStatus ; rv:editionLanguage ?oldLanguage ; rv:contentLanguages ?oldLanguages ;
        rv:titleLanguage ?oldTitle ; rv:tracklistLanguage ?oldTrack ; rv:originalLanguages ?oldOriginals ;
        rv:isTranslation ?oldTranslation . ${iri(intent.work)} rv:editionsRevision ?oldEditionsRevision . }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(component)} a rv:EditionRecord ; rv:work ${iri(intent.work)} ;
        rv:metadataKind "edition" ; rv:metadataHead ${iri(revision)} ;
        rv:editionState rv:${state.status === 'active' ? 'Active' : 'Withdrawn'} .
        ${iri(intent.work)} rv:editionsRevision ${iri(revision)} .
        ${languages ? `${iri(component)} rv:contentLanguages ${lit(languages)} .` : ''}
        ${single ? `${iri(component)} rv:editionLanguage ${lit(single)} .` : ''}
        ${state.titleLanguage ? `${iri(component)} rv:titleLanguage ${lit(state.titleLanguage)} .` : ''}
        ${state.tracklistLanguage ? `${iri(component)} rv:tracklistLanguage ${lit(state.tracklistLanguage)} .` : ''}
        ${originals ? `${iri(component)} rv:originalLanguages ${lit(originals)} .` : ''}
        ${state.isTranslation ? `${iri(component)} rv:isTranslation "true" .` : ''} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:WorkMetadataDetailsV2Revision, rv:RevisionAnchor ;
        rv:component ${iri(component)} ; rv:metadataState ${lit(JSON.stringify(state))} ;
        ${prior ? `rv:predecessor ${iri(prior)} ;` : ''}
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ; rv:modelRevision ${iri(METADATA_DETAILS_V2)} ;
        rv:shapeRevision ${iri(METADATA_DETAILS_V2)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:work ${iri(intent.work)} ; rv:metadataComponent ${iri(component)} ; rv:metadataRevision ${iri(revision)} ;
        rv:workRevision ${iri(revision)} ; rv:expectedHead ${iri(prior ?? component)} ;
        rv:action "work.edit" ; rv:commandFamily "work-metadata-details-v2" ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:WorkMetadataRevisedEvent ; rv:ordinal 0 ; rv:action "work.edit" ; rv:receipt ${iri(receipt)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . FILTER(?n = ${row.sequence.value}) }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:head ${iri(row.head.value)} .
        OPTIONAL { ${iri(component)} rv:editionState ?oldStatus }
        OPTIONAL { ${iri(component)} rv:editionLanguage ?oldLanguage }
        OPTIONAL { ${iri(component)} rv:contentLanguages ?oldLanguages }
        OPTIONAL { ${iri(component)} rv:titleLanguage ?oldTitle }
        OPTIONAL { ${iri(component)} rv:tracklistLanguage ?oldTrack }
        OPTIONAL { ${iri(component)} rv:originalLanguages ?oldOriginals }
        OPTIONAL { ${iri(component)} rv:isTranslation ?oldTranslation }
        OPTIONAL { ${iri(intent.work)} rv:editionsRevision ?oldEditionsRevision }
        ${prior ? `${iri(component)} a rv:EditionRecord ; rv:work ${iri(intent.work)} ;
          rv:metadataKind "edition" ; rv:metadataHead ${iri(prior)} .`
          : `FILTER NOT EXISTS { ${iri(component)} ?occupiedProperty ?occupiedValue }`} }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const result = await commitMetadataEnvelope(env, admission, { receipt, digest, update, validations,
    deadlineMs: WORK_METADATA_COST.deadlineMs }, { work: intent.work, component, revision, manifest,
      predecessor: prior ?? component }, intent.state);
  if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
  if (!await readMetadataReceipt(env, admission.id)) {
    await sealMetadataWorkEditAdmission(env, admission);
    return false;
  }
  return true;
}

async function setEditionV2(deps: MainWorkDependencies, request: Request,
  input: { work: string; expectedHead: string | null; state: MetadataEditionStateV2;
    actingSubject: string; idempotencyKey: string }) {
  const state = checkedEditionV2(input.state);
  const intent = { work: input.work, expectedHead: input.expectedHead, state };
  const digest = editionV2Digest(intent);
  const signal = AbortSignal.timeout(WORK_METADATA_COST.deadlineMs);
  return fusekiReadBudget.run({ signal, callsLeft: WORK_METADATA_COST.commandGraphCalls,
    bytesLeft: WORK_METADATA_COST.commandGraphBytes }, async () => {
    const env = deps.environment;
    await assertGraphAdmissionOpen(env.fuseki, env.lineage);
    const principal = await deps.account.verify(request, ['work:edit']);
    const registered = await deps.access.register({ principal, actingSubject: input.actingSubject,
      action: 'work.edit', scope: `work:edit:${intent.work}`, idempotencyKey: input.idempotencyKey,
      requestDigest: digest });
    try {
      let admission = registered;
      if (registered.state !== 'sealed' && registered.dispatchEligible) {
        try { admission = await deps.access.claim(registered.id, digest, principal); }
        catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
      }
      let committed = false, failure: unknown;
      try {
        if (admission.state === 'sealed') { /* retry */ }
        else if (!admission.dispatchEligible || admission.state === 'registered') await sealMetadataWorkEditAdmission(env, admission);
        else committed = await commitEditionV2(env, admission, intent);
      } catch (error) { failure = error; }
      const terminal = await readMetadataReceipt(env, admission.id);
      if (!terminal) {
        if (failure instanceof WorkMetadataUnavailable || failure instanceof IdempotencyConflict || failure instanceof CommandRejected) throw failure;
        throw new PendingAdmittedWork(admission.id, 'work-edit');
      }
      await deps.access.recordGraphOutcome(admission.id, terminal);
      await assertNotInvalidProfileReceipt(env.fuseki, terminal.receipt);
      if (failure instanceof CommandRejected) throw failure;
      if (terminal.requestDigest !== admission.requestDigest || terminal.authorityEpoch !== admission.authorityEpoch
        || terminal.scope !== admission.scope || terminal.admissionId !== admission.id) {
        throw new IdempotencyConflict('Metadata receipt differs from admission');
      }
      if (terminal.outcome === 'cancelled') throw new StaleWorkMetadata('Edition command was cancelled; refresh its basis');
      if (terminal.work !== intent.work || terminal.component !== state.id) {
        throw new IdempotencyConflict('Metadata receipt targets another component');
      }
      await retireMetadataProof(env, terminal.receipt);
      return { work: terminal.work, component: terminal.component, revision: terminal.revision!,
        receipt: terminal.receipt, sourcePosition: { dataEpoch: terminal.dataEpoch, sequence: terminal.sequence },
        replayed: !committed };
    } catch (error) {
      if (error instanceof WorkMetadataUnavailable || error instanceof IdempotencyConflict
        || error instanceof CommandRejected || error instanceof StaleWorkMetadata) throw error;
      throw new PendingAdmittedWork(registered.id, 'work-edit');
    }
  });
}
