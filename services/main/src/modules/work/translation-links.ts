import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, IdempotencyConflict,
  type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const language = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const evidenceUrl = /^https:\/\/[^\s<>"{}|\\^`]{1,2040}$/;
const PROFILE = 'https://rezics.com/definition/translation-link-v1';
const LINK_SHAPE = `${PROFILE}/link-shape`;

export class InvalidTranslationLink extends Error {}
export class TranslationSourceUnavailable extends Error {}
export class TranslationTargetUnavailable extends Error {}
export class TranslationLinkConflict extends Error {}

export interface TranslationLinkInput {
  targetWork: string;
  targetMainVersion: string;
  targetMainRevision: string;
  sourceWork: string;
  sourceMainVersion: string;
  sourceMainRevision: string | null;
  status: 'official' | 'third-party';
  contentLanguage: string;
  translator: string;
  publisher: string;
  evidence: string;
  actingSubject: string;
}

export interface TranslationLink extends Omit<TranslationLinkInput, 'actingSubject'> {
  link: string;
  sourceVersionStatus: 'exact' | 'unresolved';
  authorizingParty: string | null;
  authorizationScope: string | null;
  authorizationEpoch: string | null;
}

export interface TranslationLinkReceipt {
  link: string;
  receipt: string;
  dataEpoch: string;
  sequence: string;
  replayed: boolean;
}

export function validateTranslationLink(input: TranslationLinkInput): void {
  if (![input.targetWork, input.targetMainVersion, input.targetMainRevision,
    input.sourceWork, input.sourceMainVersion, input.translator, input.publisher,
    input.actingSubject].every(value => nativeId.test(value))
    || (input.sourceMainRevision !== null && !nativeId.test(input.sourceMainRevision))
    || input.targetWork === input.sourceWork
    || !language.test(input.contentLanguage) || !evidenceUrl.test(input.evidence)
    || !['official', 'third-party'].includes(input.status)) {
    throw new InvalidTranslationLink('invalid translation identities or provenance');
  }
  if (input.status === 'official' && input.sourceMainRevision === null) {
    throw new InvalidTranslationLink('official provenance requires an exact source revision');
  }
}

export function translationLinkDigest(input: TranslationLinkInput & { idempotencyKey?: string }): string {
  validateTranslationLink(input);
  return hash(JSON.stringify({ family: 'translation-link-v1', ...input }));
}

export function translationLinkReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0translation-link-v1`)}`;
}

export function translationAuthorizationScope(input: TranslationLinkInput): string {
  validateTranslationLink(input);
  if (!input.sourceMainRevision) throw new InvalidTranslationLink('exact source revision is required');
  return `translation:authorize:${input.sourceWork}:${input.sourceMainRevision}`;
}

async function sourceAndTargetExist(env: WorkActivationEnvironment, input: TranslationLinkInput): Promise<{
  target: boolean; source: boolean; linked: boolean;
}> {
  const target = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.targetWork)} rv:mainVersion ${iri(input.targetMainVersion)} .
      ${iri(input.targetMainVersion)} a rv:MainVersion ; rv:work ${iri(input.targetWork)} ;
        rv:head ${iri(input.targetMainRevision)} .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(input.targetMainRevision)} a rv:RevisionAnchor ;
        rv:component ${iri(input.targetMainVersion)} .
    }
  }`);
  const source = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.sourceWork)} rv:mainVersion ${iri(input.sourceMainVersion)} .
      ${iri(input.sourceMainVersion)} a rv:MainVersion ; rv:work ${iri(input.sourceWork)} .
    }
    ${input.sourceMainRevision ? `GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(input.sourceMainRevision)} a rv:RevisionAnchor ;
        rv:component ${iri(input.sourceMainVersion)} .
    }` : ''}
  }`);
  const linked = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.revisions)} {
      ?link a rv:TranslationLink ; rv:targetMainRevision ${iri(input.targetMainRevision)} .
    }
  }`);
  return { target: target.boolean === true, source: source.boolean === true,
    linked: linked.boolean === true };
}

export interface TerminalLink {
  outcome: 'succeeded' | 'cancelled';
  link: string | null;
  requestDigest: string;
  admissionId: string;
  scope: string;
  authorityEpoch: string;
  dataEpoch: string;
  sequence: string;
  receipt: string;
}

export async function readTranslationLinkTerminal(env: WorkActivationEnvironment,
  admissionId: string): Promise<TerminalLink | null> {
  const receipt = translationLinkReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?link ?digest ?admission ?scope ?authorityEpoch ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} rv:outcome ?outcome ; rv:requestDigest ?digest ;
        rv:admissionId ?admission ; rv:admittedScope ?scope ;
        rv:authorityEpoch ?authorityEpoch ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:translationLink ?link }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0];
  if (rows.length !== 1 || !row?.outcome || !row.digest || !row.admission
    || !row.scope || !row.authorityEpoch || !row.epoch || !row.sequence) {
    throw new Error('translation link receipt is incomplete');
  }
  const outcome = row.outcome.value === `${RV}Succeeded` ? 'succeeded'
    : row.outcome.value === `${RV}Cancelled` ? 'cancelled' : null;
  if (!outcome || (outcome === 'succeeded') !== !!row.link) {
    throw new Error('translation link receipt outcome is inconsistent');
  }
  return { outcome, link: row.link?.value ?? null, requestDigest: row.digest.value,
    admissionId: row.admission.value, scope: row.scope.value,
    authorityEpoch: row.authorityEpoch.value, dataEpoch: row.epoch.value,
    sequence: row.sequence.value, receipt };
}

function checkedTerminal(terminal: TerminalLink, registered: RegisteredAdmission,
  digest: string): TranslationLinkReceipt {
  if (terminal.requestDigest !== digest || terminal.admissionId !== registered.id
    || terminal.scope !== registered.scope || terminal.authorityEpoch !== registered.authorityEpoch) {
    throw new IdempotencyConflict('translation link receipt differs from admission');
  }
  if (terminal.outcome !== 'succeeded' || !terminal.link) {
    throw new TranslationLinkConflict('translation link admission was cancelled');
  }
  return { link: terminal.link, receipt: terminal.receipt,
    dataEpoch: terminal.dataEpoch, sequence: terminal.sequence, replayed: registered.replayed };
}

async function sealCancelled(env: WorkActivationEnvironment, registered: RegisteredAdmission): Promise<void> {
  const receipt = translationLinkReceiptIri(registered.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0cancel`)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(registered.requestDigest)} ;
          rv:admissionId ${lit(registered.id)} ; rv:authorityEpoch ${lit(registered.authorityEpoch)} ;
          rv:admittedScope ${lit(registered.scope)} ; rv:outcome rv:Cancelled ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  await env.fuseki.commandWithReceipt({ receipt, digest: registered.requestDigest,
    update, validations: [], deadlineMs: 10_000 });
}

/** Strong scope/principal closure races this cancellation against the link command. */
export async function sealTranslationLinkAdmission(env: WorkActivationEnvironment,
  registered: RegisteredAdmission): Promise<TerminalLink> {
  if (registered.action !== 'translation.link' && registered.action !== 'translation.authorize') {
    throw new Error('unsupported translation link admission');
  }
  const existing = await readTranslationLinkTerminal(env, registered.id);
  if (!existing) await sealCancelled(env, registered);
  const terminal = await readTranslationLinkTerminal(env, registered.id);
  if (!terminal || terminal.admissionId !== registered.id
    || terminal.requestDigest !== registered.requestDigest || terminal.scope !== registered.scope
    || terminal.authorityEpoch !== registered.authorityEpoch) {
    throw new Error('translation link cancellation outcome is unavailable');
  }
  return terminal;
}

async function activateLink(env: WorkActivationEnvironment, registered: RegisteredAdmission,
  input: TranslationLinkInput, digest: string): Promise<void> {
  const link = ID + Bun.randomUUIDv7();
  const receipt = translationLinkReceiptIri(registered.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0translation-linked`)}`;
  const sourceRevision = input.sourceMainRevision
    ? `; rv:sourceMainRevision ${iri(input.sourceMainRevision)}` : '';
  const authorizing = input.status === 'official'
    ? `; rv:authorizingParty ${iri(input.actingSubject)} ;
        rv:authorizationScope ${lit(registered.scope)} ;
        rv:authorizationEpoch ${lit(registered.authorityEpoch)}` : '';
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(link)} a rv:TranslationLink ; rv:targetWork ${iri(input.targetWork)} ;
          rv:targetMainVersion ${iri(input.targetMainVersion)} ;
          rv:targetMainRevision ${iri(input.targetMainRevision)} ;
          rv:sourceWork ${iri(input.sourceWork)} ;
          rv:sourceMainVersion ${iri(input.sourceMainVersion)} ${sourceRevision} ;
          rv:sourceVersionStatus rv:${input.sourceMainRevision ? 'Exact' : 'Unresolved'} ;
          rv:translationStatus rv:${input.status === 'official' ? 'Official' : 'ThirdParty'} ;
          rv:contentLanguage ${lit(input.contentLanguage)} ;
          rv:translator ${iri(input.translator)} ; rv:publisher ${iri(input.publisher)} ;
          rv:evidence ${lit(input.evidence)} ; rv:linkedBy ${iri(input.actingSubject)}
          ${authorizing} ; rv:modelRevision ${iri(PROFILE)} ;
          rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
          rv:admissionId ${lit(registered.id)} ; rv:admittedScope ${lit(registered.scope)} ;
          rv:authorityEpoch ${lit(registered.authorityEpoch)} ; rv:outcome rv:Succeeded ;
          rv:translationLink ${iri(link)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:TranslationLinkedEvent ; rv:ordinal 0 ;
          rv:action ${lit(registered.action)} ; rv:receipt ${iri(receipt)} ;
          rv:translationLink ${iri(link)} .
      }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.targetWork)} rv:mainVersion ${iri(input.targetMainVersion)} .
        ${iri(input.targetMainVersion)} a rv:MainVersion ; rv:work ${iri(input.targetWork)} ;
          rv:head ${iri(input.targetMainRevision)} .
        ${iri(input.sourceWork)} rv:mainVersion ${iri(input.sourceMainVersion)} .
        ${iri(input.sourceMainVersion)} a rv:MainVersion ; rv:work ${iri(input.sourceWork)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(input.targetMainRevision)} a rv:RevisionAnchor ;
          rv:component ${iri(input.targetMainVersion)} .
        ${input.sourceMainRevision ? `${iri(input.sourceMainRevision)} a rv:RevisionAnchor ;
          rv:component ${iri(input.sourceMainVersion)} .` : ''}
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
        ?prior a rv:TranslationLink ; rv:targetMainRevision ${iri(input.targetMainRevision)} . } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      BIND(?n + 1 AS ?next)
    }`;
  const validations = await profileValidations(env.fuseki, 'translation-link-v1', [{
    shape: LINK_SHAPE, focus: [link],
    graphs: [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.control],
  }], {
    link, 'target-work': input.targetWork, 'target-main': input.targetMainVersion,
    'target-revision': input.targetMainRevision, 'source-work': input.sourceWork,
    'source-main': input.sourceMainVersion,
    ...(input.sourceMainRevision ? { 'source-revision': input.sourceMainRevision } : {}),
    status: input.status, language: input.contentLanguage,
    translator: input.translator, publisher: input.publisher,
    evidence: input.evidence, actor: input.actingSubject, receipt,
    scope: registered.scope, epoch: registered.authorityEpoch,
  });
  const result = await validatedCommand(env, { receipt, digest, update,
    validations, deadlineMs: 10_000 }, registered);
  if (result.status === 'invalid' || result.status === 'unknown-profile'
    || result.status === 'conflict') throw new CommandRejected(result);
}

/** A source-specific Access admission is the official authority witness. */
export async function createAdmittedTranslationLink(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'
    | 'canLinkTranslation'>,
  request: Request, input: TranslationLinkInput & { idempotencyKey: string },
): Promise<TranslationLinkReceipt> {
  const digest = translationLinkDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  if (input.status === 'official'
    && !await access.canLinkTranslation(principal, input.actingSubject, input.targetWork)) {
    throw new AdmissionDenied('target Work translation permission is not granted');
  }
  const scope = input.status === 'official'
    ? translationAuthorizationScope(input) : `translation:link:${input.targetWork}`;
  const action = input.status === 'official' ? 'translation.authorize' : 'translation.link';
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope, action, idempotencyKey: input.idempotencyKey, requestDigest: digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealTranslationLinkAdmission(env, admission);
      } else {
        const state = await sourceAndTargetExist(env, input);
        if (!state.target || !state.source || state.linked) {
          await sealTranslationLinkAdmission(env, admission);
          const cancelled = await readTranslationLinkTerminal(env, registered.id);
          if (cancelled) await access.recordGraphOutcome(registered.id, cancelled);
          if (!state.target) throw new TranslationTargetUnavailable('target Main Version revision is unavailable');
          if (!state.source) throw new TranslationSourceUnavailable('source Main Version revision is unavailable');
          throw new TranslationLinkConflict('target revision already has a translation link');
        }
        try { await activateLink(env, admission, input, digest); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          const state = await sourceAndTargetExist(env, input);
          if (!state.target || !state.source || state.linked) {
            await sealTranslationLinkAdmission(env, admission);
          }
        }
      }
    }
    const terminal = await readTranslationLinkTerminal(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'translation-link');
    await access.recordGraphOutcome(registered.id, terminal);
    return checkedTerminal(terminal, registered, digest);
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof TranslationLinkConflict
      || error instanceof TranslationSourceUnavailable || error instanceof TranslationTargetUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'translation-link');
  }
}

/** Exact revision query: a newer target head never inherits this provenance. */
export async function readTranslationLinks(env: WorkActivationEnvironment,
  mainVersion: string, mainRevision: string): Promise<TranslationLink[]> {
  if (!nativeId.test(mainVersion) || !nativeId.test(mainRevision)) {
    throw new InvalidTranslationLink('invalid Main Version revision');
  }
  const available = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} { ${iri(mainVersion)} a rv:MainVersion ; rv:work ?work . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(mainRevision)} a rv:RevisionAnchor ; rv:component ${iri(mainVersion)} .
    }
  }`);
  if (available.boolean !== true) {
    throw new TranslationTargetUnavailable('Main Version revision is unavailable');
  }
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?link ?targetWork ?sourceWork ?sourceMain ?sourceRevision ?sourceStatus ?status
    ?language ?translator ?publisher ?evidence ?linkedBy ?authorizer ?scope ?epoch WHERE {
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(mainRevision)} a rv:RevisionAnchor ; rv:component ${iri(mainVersion)} .
      ?link a rv:TranslationLink ; rv:targetWork ?targetWork ;
        rv:targetMainVersion ${iri(mainVersion)} ; rv:targetMainRevision ${iri(mainRevision)} ;
        rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
        rv:sourceWork ?sourceWork ; rv:sourceMainVersion ?sourceMain ;
        rv:sourceVersionStatus ?sourceStatus ; rv:translationStatus ?status ;
        rv:contentLanguage ?language ; rv:translator ?translator ;
        rv:publisher ?publisher ; rv:evidence ?evidence ; rv:linkedBy ?linkedBy .
      OPTIONAL { ?link rv:sourceMainRevision ?sourceRevision }
      OPTIONAL { ?link rv:authorizingParty ?authorizer ; rv:authorizationScope ?scope ;
        rv:authorizationEpoch ?epoch }
    }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length > 1) throw new TranslationLinkConflict('target revision has ambiguous translation links');
  return rows.map(row => {
    if (!row.link || !row.targetWork || !row.sourceWork || !row.sourceMain
      || !row.sourceStatus || !row.status || !row.language || !row.translator
      || !row.publisher || !row.evidence || !row.linkedBy) {
      throw new TranslationLinkConflict('translation link is incomplete');
    }
    const status = row.status.value === `${RV}Official` ? 'official'
      : row.status.value === `${RV}ThirdParty` ? 'third-party' : null;
    const sourceVersionStatus = row.sourceStatus.value === `${RV}Exact` ? 'exact'
      : row.sourceStatus.value === `${RV}Unresolved` ? 'unresolved' : null;
    if (!status || !sourceVersionStatus
      || (sourceVersionStatus === 'exact') !== !!row.sourceRevision
      || (status === 'official') !== !!(row.authorizer && row.scope && row.epoch)) {
      throw new TranslationLinkConflict('translation provenance is inconsistent');
    }
    return { link: row.link.value, targetWork: row.targetWork.value,
      targetMainVersion: mainVersion, targetMainRevision: mainRevision,
      sourceWork: row.sourceWork.value, sourceMainVersion: row.sourceMain.value,
      sourceMainRevision: row.sourceRevision?.value ?? null, sourceVersionStatus,
      status, contentLanguage: row.language.value, translator: row.translator.value,
      publisher: row.publisher.value, evidence: row.evidence.value,
      authorizingParty: row.authorizer?.value ?? null,
      authorizationScope: row.scope?.value ?? null,
      authorizationEpoch: row.epoch?.value ?? null };
  });
}
