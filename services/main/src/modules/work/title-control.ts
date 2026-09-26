import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry, type RegisteredAdmission } from '../access/admission.ts';
import type { TitleAction } from '../access/title-admission.ts';
import { CommandRejected, type CommandEnvelope } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { CONTINUITY, DATASET, GRAPHS, ID, PROFILE, RV, hash, iri, lit, metadataWorkRequestDigest,
  normalizeWorkSemanticTypes, prepareComponent, prepareWorkComponent, workMetadataValidations,
  IdempotencyConflict, type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';

export const TITLE_PROFILE = 'https://rezics.com/definition/work-title-control-v1';
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export interface TitleControlBasis { head: string | null; epoch: string; protection: null }
export interface TitleSourceBasis {
  binding: string; record: string; observation: string; conversion: string; proposal: string;
  mapping: 'open-library-work-map-v1'; initialHead: string;
}
export interface TitleControlIntent {
  work: string; expectedHead: string; basis: TitleControlBasis;
  action: TitleAction; title: string; source: TitleSourceBasis | null;
}
export interface TitleControlState {
  work: string; contentHead: string; basis: TitleControlBasis;
  mode: 'unestablished' | 'human-controlled' | 'source-managed';
  source: TitleSourceBasis | null;
}
export interface TitleControlReceipt {
  outcome: 'succeeded' | 'cancelled'; action: TitleAction;
  receipt: string; admissionId: string; requestDigest: string; authorityEpoch: string; scope: string;
  dataEpoch: string; sequence: string; work?: string; revision?: string; control?: string;
  controlManifest?: string; workManifest?: string; operation?: string; intent?: TitleControlIntent;
  replayed: boolean;
}
export class TitleControlConflict extends Error {
  constructor(message: string, readonly terminal?: TitleControlReceipt) { super(message); }
}
export class TitleControlInvalid extends Error {}
export class TitleControlUnavailable extends Error {}
export const titleControlReceiptIri = (admission: string) => `urn:rezics:receipt:${hash(`${admission}\0edit-metadata-work`)}`;

export function titleControlDigest(intent: TitleControlIntent): string {
  if (!NATIVE.test(intent.work) || !NATIVE.test(intent.expectedHead) || !intent.basis
    || !Object.hasOwn(intent.basis, 'head') || !Object.hasOwn(intent.basis, 'protection')
    || intent.basis.protection !== null || !/^(0|[1-9][0-9]{0,18})$/.test(intent.basis.epoch)
    || (intent.basis.head === null ? intent.basis.epoch !== '0' : !NATIVE.test(intent.basis.head))) {
    throw new TitleControlInvalid('exact title control and absent protection expectations are required');
  }
  metadataWorkRequestDigest(intent.title);
  if (!['work.edit', 'work.title.apply', 'work.title.return'].includes(intent.action)
    || (intent.action === 'work.edit' ? intent.source !== null : !intent.source)) {
    throw new TitleControlInvalid('title origin differs from the admitted operation');
  }
  if (intent.source && (intent.source.mapping !== 'open-library-work-map-v1'
    || ![intent.source.binding, intent.source.record, intent.source.observation,
      intent.source.conversion, intent.source.proposal, intent.source.initialHead].every(value => NATIVE.test(value)))) {
    throw new TitleControlInvalid('exact source basis is required');
  }
  // Canonicalize explicitly: JSON property order from an HTTP client is not an identity.
  return hash(JSON.stringify({ profile: 'work-title-control-v1', work: intent.work,
    expectedHead: intent.expectedHead, basis: { head: intent.basis.head, epoch: intent.basis.epoch, protection: null },
    action: intent.action, title: intent.title, source: intent.source ? {
      binding: intent.source.binding, record: intent.source.record, observation: intent.source.observation,
      conversion: intent.source.conversion, proposal: intent.source.proposal,
      mapping: intent.source.mapping, initialHead: intent.source.initialHead } : null }));
}

export async function readTitleControl(env: WorkActivationEnvironment, work: string): Promise<TitleControlState> {
  if (!NATIVE.test(work)) throw new TitleControlInvalid('invalid Work');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?content ?control ?protection ?intent ?epoch ?mode WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a <https://schema.org/CreativeWork> ; rv:head ?content .
      OPTIONAL { ${iri(work)} rv:titleControlHead ?control }
      OPTIONAL { ${iri(work)} rv:protectionHead ?protection } }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:titleControlHead ?control }
      GRAPH ${iri(GRAPHS.revisions)} { ?control a rv:EditorialControlRevision ;
      rv:component ${iri(work)} ; rv:controlEpoch ?epoch ; rv:controlMode ?mode ; rv:controlIntent ?intent . }
    }
  } LIMIT 2`, 16_384);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.content || row.protection) throw new TitleControlUnavailable('title basis is unavailable or protected');
  if (!row.control) return { work, contentHead: row.content.value,
    basis: { head: null, epoch: '0', protection: null }, mode: 'unestablished', source: null };
  if (!row.intent || !row.epoch || !row.mode) throw new TitleControlUnavailable('title control revision is unavailable');
  const intent = JSON.parse(row.intent.value) as TitleControlIntent;
  titleControlDigest(intent);
  if (intent.work !== work || BigInt(row.epoch.value) !== BigInt(intent.basis.epoch) + 1n) {
    throw new TitleControlUnavailable('title control basis differs');
  }
  const mode = row.mode.value === `${RV}SourceManaged` ? 'source-managed'
    : row.mode.value === `${RV}HumanControlled` ? 'human-controlled' : null;
  if (!mode || (mode === 'human-controlled') !== (intent.action === 'work.edit')) {
    throw new TitleControlUnavailable('title control mode differs from its origin');
  }
  return { work, contentHead: row.content.value,
    basis: { head: row.control.value, epoch: row.epoch.value, protection: null },
    mode, source: intent.source };
}

export async function readTitleControlReceipt(env: Pick<WorkActivationEnvironment, 'fuseki'>, admissionId: string): Promise<TitleControlReceipt | null> {
  const receipt = titleControlReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?outcome ?action ?digest ?authority ?scope ?epoch ?sequence ?work ?revision ?control ?operation ?intent ?manifest ?workManifest WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:admissionId ${lit(admissionId)} ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:authorityEpoch ?authority ; rv:admittedScope ?scope ;
        rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(receipt)} rv:action ?action }
      }
      OPTIONAL { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:work ?work ; rv:workRevision ?revision ; rv:titleControl ?control ; rv:operation ?operation . }
        GRAPH ${iri(GRAPHS.revisions)} { ?control rv:controlIntent ?intent ; rv:manifest ?manifest .
          ?revision rv:manifest ?workManifest . } }
    } LIMIT 2`, 20_000);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.digest || !row.authority || !row.scope || !row.epoch || !row.sequence) {
    throw new TitleControlUnavailable('ambiguous title control receipt');
  }
  const succeeded = row.outcome?.value === `${RV}Succeeded`;
  if (succeeded && (!row.work || !row.revision || !row.control || !row.operation || !row.intent || !row.manifest || !row.workManifest)) {
    throw new TitleControlUnavailable('title effect is incomplete');
  }
  return { outcome: succeeded ? 'succeeded' : 'cancelled', action: (row.action?.value ?? 'work.edit') as TitleAction,
    receipt, admissionId, requestDigest: row.digest.value, authorityEpoch: row.authority.value,
    scope: row.scope.value, dataEpoch: row.epoch.value, sequence: row.sequence.value, replayed: true,
    ...(succeeded ? { work: row.work!.value, revision: row.revision!.value, control: row.control!.value,
      operation: row.operation!.value, intent: JSON.parse(row.intent!.value),
      controlManifest: row.manifest!.value, workManifest: row.workManifest!.value } : {}) };
}

export async function cancelTitleControl(env: WorkActivationEnvironment, admission: RegisteredAdmission) {
  const receipt = titleControlReceiptIri(admission.id), batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Cancelled ;
        rv:admissionId ${lit(admission.id)} ; rv:action ${lit(admission.action)} ; rv:requestDigest ${lit(admission.requestDigest)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} . ${iri(event)} a rv:WorkTitleControlEvent ;
        rv:ordinal 0 ; rv:action ${lit(admission.action)} ; rv:receipt ${iri(receipt)} . } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } } BIND(?n + 1 AS ?next) }`;
  await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest, update, validations: [], deadlineMs: 10_000 });
  const terminal = await readTitleControlReceipt(env, admission.id);
  if (!terminal) throw new PendingAdmittedWork(admission.id, 'work-edit');
  return terminal;
}

export async function titleControlCommand(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  intent: TitleControlIntent, retained?: TitleControlReceipt): Promise<CommandEnvelope> {
  const digest = titleControlDigest(intent);
  if (digest !== admission.requestDigest || intent.action !== admission.action) throw new IdempotencyConflict('title admission differs');
  const current = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?main ?type WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:mainVersion ?main ; a ?type . } } LIMIT 10`, 4096);
  const rows = current.results?.bindings ?? [];
  const main = rows[0]?.main?.value;
  if (!main || rows.some(row => row.main?.value !== main)) throw new TitleControlUnavailable('Work is unavailable');
  const semanticTypes = normalizeWorkSemanticTypes(rows.map(row => row.type!.value).filter(type => type !== 'https://schema.org/CreativeWork'));
  const control = retained?.control ?? ID + Bun.randomUUIDv7(), operation = retained?.operation ?? ID + Bun.randomUUIDv7();
  const revision = retained?.revision ?? (intent.action === 'work.title.return' ? intent.expectedHead : ID + Bun.randomUUIDv7());
  const receipt = titleControlReceiptIri(admission.id), batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const put = (state: object, profile: string) => env.workObjects
    ? prepareWorkComponent(env.workObjects, intent.work, state, profile)
    : Promise.resolve(prepareComponent(env.objectDirectory, intent.work, state, profile));
  const manifest = retained?.controlManifest?.slice(-64) ?? await put({ intent, control, revision, operation }, TITLE_PROFILE);
  const workManifest = intent.action === 'work.title.return' ? null : retained?.workManifest?.slice(-64) ?? await put({ mainVersion: main,
    continuityProfile: CONTINUITY, title: intent.title, language: 'en', ...(semanticTypes.length ? { semanticTypes } : {}) }, PROFILE);
  const expected = intent.basis.head ? iri(intent.basis.head) : 'rv:Absent';
  let update = `PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:titleControlHead ?oldControl .
        ${workManifest ? `${iri(intent.work)} rv:head ${iri(intent.expectedHead)} ; rdfs:label ?oldTitle .` : ''} } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:titleControlHead ${iri(control)} .
        ${workManifest ? `${iri(intent.work)} rv:head ${iri(revision)} ; rdfs:label ${lit(intent.title)}@en .` : ''} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(control)} a rv:RevisionAnchor, rv:EditorialControlRevision ;
        rv:component ${iri(intent.work)} ; rv:controlField "title:en" ; rv:controlMode rv:${intent.action === 'work.edit' ? 'HumanControlled' : 'SourceManaged'} ;
        rv:controlEpoch ${BigInt(intent.basis.epoch) + 1n} ; rv:workRevision ${iri(revision)} ; rv:operation ${iri(operation)} ;
        ${intent.basis.head ? `rv:predecessor ${iri(intent.basis.head)} ;` : ''}
        rv:controlIntent ${lit(JSON.stringify(intent))} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
        rv:modelRevision ${iri(TITLE_PROFILE)} ; rv:shapeRevision ${iri(TITLE_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        ${workManifest ? `${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(intent.work)} ; rv:predecessor ${iri(intent.expectedHead)} ;
          rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${workManifest}`)} ; rv:modelRevision ${iri(PROFILE)} ;
          rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .` : ''} }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:action ${lit(intent.action)} ; rv:admissionId ${lit(admission.id)} ; rv:requestDigest ${lit(digest)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:work ${iri(intent.work)} ; rv:workRevision ${iri(revision)} ; rv:expectedHead ${iri(intent.expectedHead)} ;
        rv:titleControl ${iri(control)} ; rv:expectedControl ${expected} ; rv:expectedControlEpoch ${intent.basis.epoch} ;
        rv:expectedProtection rv:Absent ; rv:operation ${iri(operation)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} . ${iri(event)} a rv:WorkTitleControlEvent ;
        rv:ordinal 0 ; rv:action ${lit(intent.action)} ; rv:receipt ${iri(receipt)} . } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:head ${iri(intent.expectedHead)} ; rdfs:label ?oldTitle .
        OPTIONAL { ${iri(intent.work)} rv:titleControlHead ?oldControl } }
      FILTER(${intent.basis.head ? `?oldControl = ${iri(intent.basis.head)}` : '!BOUND(?oldControl)'})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:protectionHead ?protection } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } } BIND(?n + 1 AS ?next) }`;
  if (retained) {
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const ordinary = `GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;\n      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }`;
    if (!update.includes(ordinary)) throw new Error('title recovery template differs');
    update = update.replace(`GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }`,
      `GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }`)
      .replace(`GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }`,
        `GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${retained.sequence} }`)
      .replace(ordinary, `GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ; rv:restoreHold true ; rv:restoreCutover ${iri(marker)} .
        ${iri(marker)} rv:priorDataEpoch ${lit(retained.dataEpoch)} ; rv:priorSequence ?saved .
        OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
        BIND(COALESCE(?last, ?saved) AS ?previous) FILTER(?previous + 1 = ${retained.sequence}) }`)
      .replace(`FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`, '')
      .replaceAll(`rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next`, `rv:dataEpoch ${lit(retained.dataEpoch)} ; rv:sequence ${retained.sequence}`)
      .replaceAll(`rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;\n        rv:sequence ?next`, `rv:dataEpoch ${lit(retained.dataEpoch)} ; rv:sequence ${retained.sequence}`)
      .replace('BIND(?n + 1 AS ?next)', '');
    if (update.includes('?next')) throw new Error('title recovery position was not fully substituted');
  }
  const validations = await workMetadataValidations(env, intent.work, main);
  validations.push(...await profileValidations(env.fuseki, 'work-title-control-v1', [
    { shape: `${TITLE_PROFILE}/control-shape`, focus: [control], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]));
  return { receipt, digest, update, validations, deadlineMs: 10_000 };
}

export async function changeTitleControl(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome' | 'issueTitleAdmission'>,
  request: Request, input: TitleControlIntent & { actingSubject: string; idempotencyKey: string }): Promise<TitleControlReceipt> {
  // Do not retain transport identities in the public control record.
  const { work, expectedHead, basis, action, title, source } = input;
  const intent: TitleControlIntent = { work, expectedHead, basis, action, title, source };
  const digest = titleControlDigest(intent);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const scope = `${action === 'work.edit' ? 'work:edit' : action === 'work.title.apply' ? 'work:title:apply' : 'work:title:return'}:${work}`;
  const registered = await access.register({ principal, actingSubject: input.actingSubject, scope, action,
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  let terminal = await readTitleControlReceipt(env, registered.id);
  const wasTerminal = !!terminal;
  if (!terminal && registered.state !== 'sealed') {
    let admission = registered;
    try { if (admission.dispatchEligible) admission = await access.claim(admission.id, digest); }
    catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
    if (admission.state === 'claimed' && admission.dispatchEligible) {
      const command = await titleControlCommand(env, admission, intent);
      command.titleAdmission = await access.issueTitleAdmission(admission, command);
      try {
        const result = await env.fuseki.commandWithReceipt(command);
        if (['guard-unmatched', 'invalid'].includes(result.status)) await cancelTitleControl(env, admission);
        else if (result.status === 'unknown-profile') throw new CommandRejected(result);
      } catch (error) { if (error instanceof CommandRejected) throw error; /* original receipt resolves lost response */ }
    } else { await cancelTitleControl(env, admission); }
    terminal = await readTitleControlReceipt(env, registered.id);
  }
  if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-edit');
  if (terminal.requestDigest !== digest || terminal.action !== action || terminal.scope !== registered.scope
    || terminal.authorityEpoch !== registered.authorityEpoch) throw new IdempotencyConflict('title receipt differs');
  await access.recordGraphOutcome(registered.id, terminal);
  if (terminal.outcome === 'cancelled') throw new TitleControlConflict('title content, control, protection or source basis changed', terminal);
  return { ...terminal, replayed: wasTerminal };
}
