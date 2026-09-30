import { CommandRejected, fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AdmissionDenied, AdmissionExpired, type RegisteredAdmission } from '../access/admission.ts';
import { term } from '../context/command.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent, prepareWorkComponent,
  IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { workEditReceiptIri } from '../work/edit.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { assertRealizationCorrection, checkedRealization, parseStoredRealization, realizationDigest, 
  REALIZATION_COST, REALIZATION_PROFILE, InvalidRealization, RealizationUnavailable, StaleRealization, type RealizationRecord } from './schema.ts';

export function realizationReceiptIri(admissionId: string): string {
  return workEditReceiptIri(admissionId);
}

export interface RealizationCommandReceipt {
  outcome: 'succeeded' | 'cancelled'; receipt: string; admissionId: string; requestDigest: string;
  authorityEpoch: string; scope: string; dataEpoch: string; sequence: string;
  work?: string; realization?: string; revision?: string;
}

export async function readRealizationReceipt(env: Pick<WorkActivationEnvironment, 'fuseki'>,
  admissionId: string): Promise<RealizationCommandReceipt | null> {
  const receipt = realizationReceiptIri(admissionId);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?outcome ?digest ?authority ?scope ?epoch ?sequence ?work ?realization ?revision WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:admissionId ${lit(admissionId)} ;
        rv:outcome ?outcome ; rv:requestDigest ?digest ; rv:authorityEpoch ?authority ;
        rv:admittedScope ?scope ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(receipt)} rv:work ?work ; rv:realization ?realization ; rv:realizationRevision ?revision }
      } } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const outcome = row.outcome?.value === `${RV}Succeeded` ? 'succeeded'
    : row.outcome?.value === `${RV}Cancelled` ? 'cancelled' : null;
  if (rows.length !== 1 || !outcome || !row.digest || !row.authority || !row.scope || !row.epoch || !row.sequence
    || outcome === 'succeeded' && (!row.work || !row.realization || !row.revision)) {
    throw new RealizationUnavailable('Realization receipt is incomplete');
  }
  return { outcome, receipt, admissionId, requestDigest: row.digest.value, authorityEpoch: row.authority.value,
    scope: row.scope.value, dataEpoch: row.epoch.value, sequence: row.sequence.value,
    ...(outcome === 'succeeded' ? { work: row.work!.value, realization: row.realization!.value,
      revision: row.revision!.value } : {}) };
}

async function sealRealization(env: WorkActivationEnvironment, admission: RegisteredAdmission): Promise<void> {
  const existing = await readRealizationReceipt(env, admission.id);
  if (existing) return;
  const receipt = realizationReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:outcome rv:Cancelled ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:AdmissionCancelledEvent ; rv:ordinal 0 ; rv:action "work.edit" ;
          rv:receipt ${iri(receipt)} ; rv:admissionId ${lit(admission.id)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest, update,
    validations: [], deadlineMs: REALIZATION_COST.deadlineMs }); }
  catch { /* A lost response still resolves through the receipt below. */ }
  if (!await readRealizationReceipt(env, admission.id)) throw new PendingAdmittedWork(admission.id, 'work-edit');
}

async function loadRealization(env: WorkActivationEnvironment, work: string, realization: string, basis?: string):
  Promise<{ revision: string; record: RealizationRecord } | null> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?revision ?state WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(realization)} a rv:Realization ; rv:work ${iri(work)} .
        ${basis ? '' : `${iri(realization)} rv:head ?revision`} }
      ${basis ? `BIND(${iri(basis)} AS ?revision)` : ''}
      GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:component ${iri(realization)} ; rv:realizationState ?state ;
        rv:modelRevision ${iri(REALIZATION_PROFILE)} }
    } LIMIT 2`, REALIZATION_COST.stateBytes * 2)).results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.revision || !rows[0].state) throw new RealizationUnavailable('Realization head is incomplete');
  return { revision: rows[0].revision.value, record: parseStoredRealization(rows[0].state.value, work) };
}

function projection(realization: string, revision: string, record: RealizationRecord): string {
  return `${iri(realization)} a rv:Realization ; rv:work ${iri(record.work)} ; rv:head ${iri(revision)} ;
    rv:contentLanguage ${lit(record.language)} ; rv:realizationKind ${lit(record.kind)} ;
    rv:realizationStatus ${lit(record.status)} ; rv:verification ${lit(record.verification)} .
    ${record.translators.map(agent => `${iri(realization)} rv:translator ${iri(agent)} .`).join(' ')}
    ${record.publishers.map(agent => `${iri(realization)} rv:publisher ${iri(agent)} .`).join(' ')}`;
}

/** Exact retained sources do not follow a newer head. */
function sourcePattern(record: RealizationRecord): string {
  const source = record.source;
  if (source.kind === 'unresolved') return '';
  const component = source.kind === 'realization' ? source.realization : source.mainVersion;
  const type = source.kind === 'realization' ? 'rv:Realization' : 'rv:MainVersion';
  return `GRAPH ${iri(GRAPHS.current)} { ${iri(component)} a ${type} ; rv:work ${iri(record.work)} }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(source.revision)} a rv:RevisionAnchor ; rv:component ${iri(component)} }`;
}

/** One realization CAS. Logical cost is the single current head plus its JSON state, within REALIZATION_COST. */
export async function commitRealization(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  record: RealizationRecord): Promise<boolean> {
  const realization = record.id;
  const digest = realizationDigest(record);
  if (admission.action !== 'work.edit' || admission.scope !== `work:edit:${record.work}`
    || admission.requestDigest !== digest) throw new IdempotencyConflict('Realization admission differs');
  const receipt = realizationReceiptIri(admission.id);
  await assertNotInvalidProfileReceipt(env.fuseki, receipt);
  if (await readRealizationReceipt(env, admission.id)) return false;
  const current = await loadRealization(env, record.work, realization);
  if ((current?.revision ?? null) !== record.expectedHead) {
    await sealRealization(env, admission);
    return false;
  }
  if (current) {
    try { assertRealizationCorrection(current.record, record); }
    catch (error) {
      if (error instanceof InvalidRealization) { await sealRealization(env, admission); throw error; }
      throw error;
    }
  }
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.current)} { ${iri(record.work)} a <https://schema.org/CreativeWork> }
    ${sourcePattern(record)}
  } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.sequence) throw new RealizationUnavailable('Realization work is unavailable');
  const revision = ID + Bun.randomUUIDv7();
  const validations = [
    ...await profileValidations(env.fuseki, 'realization-v1', [
      { shape: `${REALIZATION_PROFILE}/realization-shape`, focus: [realization], graphs: [GRAPHS.current, GRAPHS.revisions] },
      { shape: `${REALIZATION_PROFILE}/revision-shape`, focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
    ], { realization, revision }),
  ];
  const manifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, realization, { record, revision }, REALIZATION_PROFILE)
    : prepareComponent(env.objectDirectory, realization, { record, revision }, REALIZATION_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingAdmittedWork(admission.id, 'work-edit');
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const prior = record.expectedHead;
  const update = `PREFIX rv: <${RV}>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      ${prior ? `GRAPH ${iri(GRAPHS.current)} { ${iri(realization)} rv:head ${iri(prior)} ;
        ?oldPredicate ?oldValue }` : ''}
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${projection(realization, revision, record)} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RealizationRevision, rv:RevisionAnchor ;
        rv:sourceWork ${iri(record.source.work)} ; rv:sourceStatus ${lit(record.source.kind)} ;
        ${record.source.kind !== 'unresolved' ? `rv:sourceRevision ${iri(record.source.revision)} ;` : ''}
        ${record.evidence ? `rv:evidence ${term(record.evidence)} ;` : ''}
        rv:component ${iri(realization)} ; rv:realizationState ${lit(JSON.stringify(record))} ;
        ${prior ? `rv:predecessor ${iri(prior)} ;` : ''}
        ${record.evidence ? `rv:correctionEvidence ${term(record.evidence)} ;` : ''}
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ; rv:modelRevision ${iri(REALIZATION_PROFILE)} ;
        rv:shapeRevision ${iri(REALIZATION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:work ${iri(record.work)} ; rv:realization ${iri(realization)} ; rv:realizationRevision ${iri(revision)} ;
        rv:component ${iri(realization)} ; rv:revision ${iri(revision)} ;
        rv:expectedHead ${iri(prior ?? realization)} ; rv:action "work.edit" ; rv:commandFamily "realization-v1" ;
        ${record.evidence ? `rv:correctionEvidence ${term(record.evidence)} ;` : ''}
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:RealizationChangedEvent ; rv:ordinal 0 ; rv:action "work.edit" ; rv:receipt ${iri(receipt)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . FILTER(?n = ${rows[0].sequence.value}) }
      GRAPH ${iri(GRAPHS.current)} { ${iri(record.work)} a <https://schema.org/CreativeWork> .
        ${prior ? `${iri(realization)} a rv:Realization ; rv:work ${iri(record.work)} ; rv:head ${iri(prior)} .
          ${iri(realization)} ?oldPredicate ?oldValue .
          VALUES ?oldPredicate { rv:contentLanguage rv:realizationKind rv:realizationStatus rv:verification rv:translator rv:publisher }`
          : `FILTER NOT EXISTS { ${iri(realization)} ?occupiedProperty ?occupiedValue }`} }
      ${sourcePattern(record)}
      ${prior ? '' : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(realization)} ?identityProperty ?identityValue } }`}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const result = await validatedCommand(env, { receipt, digest, update, validations,
    deadlineMs: REALIZATION_COST.deadlineMs }, admission);
  if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
  if (!await readRealizationReceipt(env, admission.id)) {
    await sealRealization(env, admission);
    return false;
  }
  return true;
}

export async function setRealization(deps: MainWorkDependencies, request: Request,
  input: unknown & { work: string; idempotencyKey: string }) {
  const { work: workId, idempotencyKey, ...body } = input;
  const record = checkedRealization(body, workId);
  const digest = realizationDigest(record);
  const signal = AbortSignal.timeout(REALIZATION_COST.deadlineMs);
  return fusekiReadBudget.run({ signal, callsLeft: REALIZATION_COST.commandGraphCalls,
    bytesLeft: REALIZATION_COST.commandGraphBytes }, async () => {
    const env = deps.environment;
    await assertGraphAdmissionOpen(env.fuseki, env.lineage);
    const principal = await deps.account.verify(request, ['work:edit']);
    if (!await deps.access.canEditWork(principal, record.actingSubject, record.work)) {
      throw new AdmissionDenied('Realization Work edit is not admitted');
    }
    if (record.expectedHead) {
      // Immutable-basis validation rejects invalid corrections before admission
      // while preserving replay of a successful correction after later writes.
      const basis = await loadRealization(env, record.work, record.id, record.expectedHead);
      if (!basis) throw new StaleRealization('Realization basis is unavailable');
      assertRealizationCorrection(basis.record, record);
    }
    const registered = await deps.access.register({ principal, actingSubject: record.actingSubject,
      action: 'work.edit', scope: `work:edit:${record.work}`, idempotencyKey,
      requestDigest: digest });
    try {
      let admission = registered;
      if (registered.state !== 'sealed' && registered.dispatchEligible) {
        try { admission = await deps.access.claim(registered.id, digest, principal); }
        catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
      }
      let committed = false, failure: unknown;
      try {
        if (admission.state === 'sealed') { /* A retry resolves the exact receipt below. */ }
        else if (!admission.dispatchEligible || admission.state === 'registered') await sealRealization(env, admission);
        else committed = await commitRealization(env, admission, record);
      } catch (error) { failure = error; }
      const terminal = await readRealizationReceipt(env, admission.id);
      if (!terminal) {
        if (failure instanceof InvalidRealization || failure instanceof RealizationUnavailable || failure instanceof IdempotencyConflict
          || failure instanceof CommandRejected || failure instanceof StaleRealization) throw failure;
        throw new PendingAdmittedWork(admission.id, 'work-edit');
      }
      await deps.access.recordGraphOutcome(admission.id, terminal);
      if (failure instanceof InvalidRealization) throw failure;
      await assertNotInvalidProfileReceipt(env.fuseki, terminal.receipt);
      if (failure instanceof CommandRejected) throw failure;
      if (terminal.outcome === 'cancelled') throw new StaleRealization('Realization command was cancelled; refresh its basis');
      if (terminal.work !== record.work || terminal.realization !== record.id) {
        throw new IdempotencyConflict('Realization receipt targets another realization');
      }
      return { work: terminal.work, realization: terminal.realization, revision: terminal.revision!,
        receipt: terminal.receipt, sourcePosition: { dataEpoch: terminal.dataEpoch, sequence: terminal.sequence },
        replayed: !committed };
    } catch (error) {
      if (error instanceof RealizationUnavailable || error instanceof IdempotencyConflict
        || error instanceof CommandRejected || error instanceof StaleRealization || error instanceof InvalidRealization) throw error;
      throw new PendingAdmittedWork(registered.id, 'work-edit');
    }
  });
}
