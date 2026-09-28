import { CommandRejected, fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AdmissionDenied, AdmissionExpired, type RegisteredAdmission } from '../access/admission.ts';
import { WEB_PUBLICATION_PROFILE } from '../web-publication/schema.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent, prepareWorkComponent,
  IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { workEditReceiptIri } from '../work/edit.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { languageListLiteral } from './languages.ts';
import { assertReleaseCorrection, checkedRelease, parseStoredRelease, releaseDigest, releaseLanguageLiteral,
  RELEASE_COST, RELEASE_PROFILE, InvalidRelease, ReleaseUnavailable, StaleRelease, type ReleaseRecord } from './schema.ts';

export function releaseReceiptIri(admissionId: string): string {
  return workEditReceiptIri(admissionId);
}

export interface ReleaseCommandReceipt {
  outcome: 'succeeded' | 'cancelled'; receipt: string; admissionId: string; requestDigest: string;
  authorityEpoch: string; scope: string; dataEpoch: string; sequence: string;
  work?: string; release?: string; revision?: string;
}

export async function readReleaseReceipt(env: Pick<WorkActivationEnvironment, 'fuseki'>,
  admissionId: string): Promise<ReleaseCommandReceipt | null> {
  const receipt = releaseReceiptIri(admissionId);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?outcome ?digest ?authority ?scope ?epoch ?sequence ?work ?release ?revision WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:admissionId ${lit(admissionId)} ;
        rv:outcome ?outcome ; rv:requestDigest ?digest ; rv:authorityEpoch ?authority ;
        rv:admittedScope ?scope ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(receipt)} rv:work ?work ; rv:release ?release ; rv:releaseRevision ?revision }
      } } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const outcome = row.outcome?.value === `${RV}Succeeded` ? 'succeeded'
    : row.outcome?.value === `${RV}Cancelled` ? 'cancelled' : null;
  if (rows.length !== 1 || !outcome || !row.digest || !row.authority || !row.scope || !row.epoch || !row.sequence
    || outcome === 'succeeded' && (!row.work || !row.release || !row.revision)) {
    throw new ReleaseUnavailable('Release receipt is incomplete');
  }
  return { outcome, receipt, admissionId, requestDigest: row.digest.value, authorityEpoch: row.authority.value,
    scope: row.scope.value, dataEpoch: row.epoch.value, sequence: row.sequence.value,
    ...(outcome === 'succeeded' ? { work: row.work!.value, release: row.release!.value,
      revision: row.revision!.value } : {}) };
}

async function sealRelease(env: WorkActivationEnvironment, admission: RegisteredAdmission): Promise<void> {
  const existing = await readReleaseReceipt(env, admission.id);
  if (existing) return;
  const receipt = releaseReceiptIri(admission.id);
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
    validations: [], deadlineMs: RELEASE_COST.deadlineMs }); }
  catch { /* A lost response still resolves through the receipt below. */ }
  if (!await readReleaseReceipt(env, admission.id)) throw new PendingAdmittedWork(admission.id, 'work-edit');
}

async function loadRelease(env: WorkActivationEnvironment, work: string, release: string):
  Promise<{ revision: string; record: ReleaseRecord } | null> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?revision ?state WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(release)} a rv:Release ; rv:work ${iri(work)} ; rv:releaseHead ?revision }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:component ${iri(release)} ; rv:releaseState ?state ;
        rv:modelRevision ${iri(RELEASE_PROFILE)} }
    } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.revision || !rows[0].state) throw new ReleaseUnavailable('Release head is incomplete');
  return { revision: rows[0].revision.value, record: parseStoredRelease(rows[0].state.value, work) };
}

function projection(release: string, revision: string, record: ReleaseRecord): string {
  const languages = releaseLanguageLiteral(record);
  const originals = languageListLiteral(record.originalLanguages);
  const lines = [`${iri(release)} a rv:Release ; rv:work ${iri(record.work)} ; rv:releaseKind ${lit(record.kind)} ;
    rv:releaseStatus ${lit(record.status)} ; rv:releaseHead ${iri(revision)} .`];
  if (languages) lines.push(`${iri(release)} rv:contentLanguages ${lit(languages)} .`);
  if (record.titleLanguage) lines.push(`${iri(release)} rv:titleLanguage ${lit(record.titleLanguage)} .`);
  if (record.tracklistLanguage) lines.push(`${iri(release)} rv:tracklistLanguage ${lit(record.tracklistLanguage)} .`);
  if (originals) lines.push(`${iri(release)} rv:originalLanguages ${lit(originals)} .`);
  if (record.isTranslation) lines.push(`${iri(release)} rv:isTranslation "true" .`);
  if (record.originalUrl) lines.push(`${iri(release)} rv:originalUrl ${lit(record.originalUrl)} .`);
  if (record.fixedRelease) lines.push(`${iri(release)} rv:fixedRelease ${iri(record.fixedRelease)} .`);
  if (record.coverage) lines.push(`${iri(release)} rv:coverageScope ${lit(record.coverage.scope)} ;
    rv:coverageComplete ${lit(String(record.coverage.complete))} .`);
  return lines.join('\n');
}

/** One release CAS. Logical cost is the single current head plus its JSON state, within RELEASE_COST. */
export async function commitRelease(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  record: ReleaseRecord): Promise<boolean> {
  const release = record.id;
  const digest = releaseDigest(record);
  if (admission.action !== 'work.edit' || admission.scope !== `work:edit:${record.work}`
    || admission.requestDigest !== digest) throw new IdempotencyConflict('Release admission differs');
  const receipt = releaseReceiptIri(admission.id);
  await assertNotInvalidProfileReceipt(env.fuseki, receipt);
  if (await readReleaseReceipt(env, admission.id)) return false;
  const current = await loadRelease(env, record.work, release);
  if ((current?.revision ?? null) !== record.expectedHead) {
    await sealRelease(env, admission);
    return false;
  }
  if (current) {
    try { assertReleaseCorrection(current.record, record); }
    catch (error) {
      if (error instanceof InvalidRelease) { await sealRelease(env, admission); throw error; }
      throw error;
    }
  }
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.current)} { ${iri(record.work)} a <https://schema.org/CreativeWork> }
  } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.sequence) throw new ReleaseUnavailable('Release work is unavailable');
  const revision = ID + Bun.randomUUIDv7();
  const validations = [
    ...await profileValidations(env.fuseki, 'release-v1', [
      { shape: `${RELEASE_PROFILE}/release-shape`, focus: [release], graphs: [GRAPHS.current, GRAPHS.revisions] },
      { shape: `${RELEASE_PROFILE}/revision-shape`, focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
    ]),
    ...(record.kind === 'web' ? await profileValidations(env.fuseki, 'web-publication-v1', [
      { shape: `${WEB_PUBLICATION_PROFILE}/publication-shape`, focus: [release],
        graphs: [GRAPHS.current, GRAPHS.revisions] },
    ]) : []),
  ];
  const manifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, release, { record, revision }, RELEASE_PROFILE)
    : prepareComponent(env.objectDirectory, release, { record, revision }, RELEASE_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingAdmittedWork(admission.id, 'work-edit');
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const prior = record.expectedHead;
  const update = `PREFIX rv: <${RV}>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      ${prior ? `GRAPH ${iri(GRAPHS.current)} { ${iri(release)} rv:releaseHead ${iri(prior)} ;
        rv:releaseKind ?oldKind ; rv:releaseStatus ?oldStatus .
        ${iri(release)} rv:contentLanguages ?oldLanguages .
        ${iri(release)} rv:titleLanguage ?oldTitle .
        ${iri(release)} rv:tracklistLanguage ?oldTrack .
        ${iri(release)} rv:originalLanguages ?oldOriginals .
        ${iri(release)} rv:isTranslation ?oldTranslation .
        ${iri(release)} rv:originalUrl ?oldUrl .
        ${iri(release)} rv:fixedRelease ?oldFixed .
        ${iri(release)} rv:coverageScope ?oldScope .
        ${iri(release)} rv:coverageComplete ?oldComplete . }` : ''}
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${projection(release, revision, record)} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:ReleaseRevision, rv:RevisionAnchor ;
        rv:component ${iri(release)} ; rv:releaseState ${lit(JSON.stringify(record))} ;
        ${prior ? `rv:predecessor ${iri(prior)} ;` : ''}
        ${record.evidence ? `rv:correctionEvidence ${iri(record.evidence)} ;` : ''}
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ; rv:modelRevision ${iri(RELEASE_PROFILE)} ;
        rv:shapeRevision ${iri(RELEASE_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:work ${iri(record.work)} ; rv:release ${iri(release)} ; rv:releaseRevision ${iri(revision)} ;
        rv:expectedHead ${iri(prior ?? release)} ; rv:action "work.edit" ; rv:commandFamily "release-v1" ;
        ${record.evidence ? `rv:correctionEvidence ${iri(record.evidence)} ;` : ''}
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ReleaseChangedEvent ; rv:ordinal 0 ; rv:action "work.edit" ; rv:receipt ${iri(receipt)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . FILTER(?n = ${rows[0].sequence.value}) }
      GRAPH ${iri(GRAPHS.current)} { ${iri(record.work)} a <https://schema.org/CreativeWork> .
        ${prior ? `${iri(release)} a rv:Release ; rv:work ${iri(record.work)} ; rv:releaseHead ${iri(prior)} .
          OPTIONAL { ${iri(release)} rv:releaseKind ?oldKind }
          OPTIONAL { ${iri(release)} rv:releaseStatus ?oldStatus }
          OPTIONAL { ${iri(release)} rv:contentLanguages ?oldLanguages }
          OPTIONAL { ${iri(release)} rv:titleLanguage ?oldTitle }
          OPTIONAL { ${iri(release)} rv:tracklistLanguage ?oldTrack }
          OPTIONAL { ${iri(release)} rv:originalLanguages ?oldOriginals }
          OPTIONAL { ${iri(release)} rv:isTranslation ?oldTranslation }
          OPTIONAL { ${iri(release)} rv:originalUrl ?oldUrl }
          OPTIONAL { ${iri(release)} rv:fixedRelease ?oldFixed }
          OPTIONAL { ${iri(release)} rv:coverageScope ?oldScope }
          OPTIONAL { ${iri(release)} rv:coverageComplete ?oldComplete }`
          : `FILTER NOT EXISTS { ${iri(release)} ?occupiedProperty ?occupiedValue }`} }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const result = await validatedCommand(env, { receipt, digest, update, validations,
    deadlineMs: RELEASE_COST.deadlineMs }, admission);
  if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
  if (!await readReleaseReceipt(env, admission.id)) {
    await sealRelease(env, admission);
    return false;
  }
  return true;
}

export async function setRelease(deps: MainWorkDependencies, request: Request,
  input: unknown & { work: string; idempotencyKey: string }) {
  const { work: workId, idempotencyKey, ...body } = input;
  const record = checkedRelease(body, workId);
  if (record.expectedHead) {
    const current = await loadRelease(deps.environment, record.work, record.id);
    if (!current || current.revision !== record.expectedHead) throw new StaleRelease('Release basis changed');
    assertReleaseCorrection(current.record, record);
  }
  const digest = releaseDigest(record);
  const signal = AbortSignal.timeout(RELEASE_COST.deadlineMs);
  return fusekiReadBudget.run({ signal, callsLeft: RELEASE_COST.commandGraphCalls,
    bytesLeft: RELEASE_COST.commandGraphBytes }, async () => {
    const env = deps.environment;
    await assertGraphAdmissionOpen(env.fuseki, env.lineage);
    const principal = await deps.account.verify(request, ['work:edit']);
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
        else if (!admission.dispatchEligible || admission.state === 'registered') await sealRelease(env, admission);
        else committed = await commitRelease(env, admission, record);
      } catch (error) { failure = error; }
      const terminal = await readReleaseReceipt(env, admission.id);
      if (failure instanceof InvalidRelease) throw failure;
      if (!terminal) {
        if (failure instanceof ReleaseUnavailable || failure instanceof IdempotencyConflict
          || failure instanceof CommandRejected || failure instanceof StaleRelease) throw failure;
        throw new PendingAdmittedWork(admission.id, 'work-edit');
      }
      await deps.access.recordGraphOutcome(admission.id, terminal);
      await assertNotInvalidProfileReceipt(env.fuseki, terminal.receipt);
      if (failure instanceof CommandRejected) throw failure;
      if (terminal.outcome === 'cancelled') throw new StaleRelease('Release command was cancelled; refresh its basis');
      if (terminal.work !== record.work || terminal.release !== record.id) {
        throw new IdempotencyConflict('Release receipt targets another release');
      }
      return { work: terminal.work, release: terminal.release, revision: terminal.revision!,
        receipt: terminal.receipt, sourcePosition: { dataEpoch: terminal.dataEpoch, sequence: terminal.sequence },
        replayed: !committed };
    } catch (error) {
      if (error instanceof ReleaseUnavailable || error instanceof IdempotencyConflict
        || error instanceof CommandRejected || error instanceof StaleRelease || error instanceof InvalidRelease) throw error;
      throw new PendingAdmittedWork(registered.id, 'work-edit');
    }
  });
}
