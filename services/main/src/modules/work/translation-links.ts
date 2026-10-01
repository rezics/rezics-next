import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import type { RightsStore } from '../rights/store.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
// Translation links currently use the installed native-text tag syntax;
// WORK02's reviewed BCP 47 and missingness policy remains pending.
const language = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const evidenceUrl = /^https:\/\/[^\s<>"{}|\\^`]{1,2040}$/;
const PROFILE = 'https://rezics.com/definition/translation-link-v1';

export class InvalidTranslationLink extends Error {}
export class TranslationSourceUnavailable extends Error {}
export class TranslationTargetUnavailable extends Error {}
export class TranslationLinkConflict extends Error {}
export class TranslationBasisRequired extends Error {
  readonly code = 'translation_basis_required';
  constructor() { super('A translation of another author’s Work requires a recorded public rights basis'); }
}

/** Authorship is the native author credit, not custody, a translator credit or
 * the Agent who certifies an official link. Pin the live credit to its revision. */
function sourceAuthorPattern(source: string, actor: string): string {
  return `GRAPH ${iri(GRAPHS.current)} {
    ?basisCredit a rv:NativeAgentCredit ; rv:work ${source} ; rv:agent ${actor} ;
      <https://schema.org/roleName> "author" ; rv:creditRevision ?basisCreditRevision . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?basisCreditRevision a rv:NativeAgentCreditRevision ; rv:component ?basisCredit ;
        rv:work ${source} ; rv:agent ${actor} ; <https://schema.org/roleName> "author" .
      FILTER NOT EXISTS { ?basisCreditRevision a rv:ErasedRevision }
    }`;
}

/** Follow the published Work's ancestors, including itself, then their retained
 * translation links. Cost is O(ancestor links), independent of the catalogue.
 * A chapter cannot evade its translated book's source rights. */
export function translationOriginalBasisConflictPattern(work: string, actor: string,
  publicDomain: readonly TranslationSourcePublicDomainBasis[] = []): string {
  return `GRAPH ${iri(GRAPHS.current)} {
    ${iri(work)} <https://schema.org/isPartOf>* ?basisTarget . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?basisLink a rv:TranslationLink ; rv:targetWork ?basisTarget ; rv:sourceWork ?basisSource . }
    FILTER NOT EXISTS { ${sourceAuthorPattern('?basisSource', iri(actor))} }
    ${publicDomain.length ? `FILTER NOT EXISTS {
      ${publicDomain.map(basis => `{
        FILTER(?basisSource = ${iri(basis.source)})
        ${sourcePublicDomainPattern(basis.source, basis)}
      }`).join(' UNION ')}
    }` : ''}`;
}

export async function assertTranslationOriginalBasis(env: WorkActivationEnvironment,
  work: string, actor: string, publicDomain: readonly TranslationSourcePublicDomainBasis[] = []): Promise<void> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    ${translationOriginalBasisConflictPattern(work, actor, publicDomain)}
  }`);
  if (result.boolean === true) throw new TranslationBasisRequired();
}

interface SourcePublicDomainBasis { variant: string; decision: string; assessment: string }
export interface TranslationSourcePublicDomainBasis extends SourcePublicDomainBasis { source: string }

function sourcePublicDomainPattern(source: string, basis: SourcePublicDomainBasis): string {
  return `GRAPH ${iri(GRAPHS.current)} {
    ${iri(basis.variant)} rv:resource ${iri(source)} ; rv:contentPublicationHead ?basisSourcePublication ;
      rv:publicSearchEligibilityHead ${iri(basis.decision)} . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(basis.decision)} a rv:ContentSearchEligibilityDecision ; rv:resource ${iri(source)} ;
        rv:publicationDecision ?basisSourcePublication ; rv:rightsBasis rv:PublicDomain ;
        rv:disclosure rv:Public ; rv:rightsAssessment ${iri(basis.assessment)} . }`;
}

async function sourcePublicDomainBasis(env: WorkActivationEnvironment, source: string,
  rights?: Pick<RightsStore, 'currentPublicDomainAssessment'>): Promise<SourcePublicDomainBasis | undefined> {
  if (!rights) return undefined;
  // Choose the newest recorded basis, independent of the number of languages.
  // The rights owner's current head must still support that exact assessment.
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?variant ?decision ?assessment WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?variant rv:resource ${iri(source)} ; rv:contentPublicationHead ?publication ;
        rv:publicSearchEligibilityHead ?decision . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?decision a rv:ContentSearchEligibilityDecision ; rv:resource ${iri(source)} ;
        rv:publicationDecision ?publication ; rv:rightsBasis rv:PublicDomain ;
        rv:disclosure rv:Public ; rv:rightsAssessment ?assessment ; rv:sequence ?basisSequence . }
  } ORDER BY DESC(?basisSequence) LIMIT 1`)).results?.bindings ?? [];
  const row = rows.length === 1 ? rows[0] : undefined;
  const assessmentId = /^urn:rezics:rights:assessment:([0-9a-f-]{36})$/i.exec(row?.assessment?.value ?? '')?.[1];
  if (!row?.variant || !row.decision || !row.assessment || !assessmentId
    || !await rights.currentPublicDomainAssessment(source, assessmentId)) return undefined;
  return { variant: row.variant.value, decision: row.decision.value, assessment: row.assessment.value };
}

/** Resolve every distinct non-author source before the eligibility graph command. One
 * ancestor-link query and one source-head/rights-head probe per distinct source;
 * no candidate limit turns a sampled set into permission for omitted sources. */
export async function resolveTranslationOriginalPublicDomainBases(env: WorkActivationEnvironment,
  work: string, actor: string, rights?: Pick<RightsStore, 'currentPublicDomainAssessment'>,
): Promise<TranslationSourcePublicDomainBasis[]> {
  if (!rights) return [];
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?basisSource WHERE {
    ${translationOriginalBasisConflictPattern(work, actor)}
  }`)).results?.bindings ?? [];
  const bases: TranslationSourcePublicDomainBasis[] = [];
  for (const row of rows) {
    const source = row.basisSource?.value;
    if (!source) throw new TranslationBasisRequired();
    const basis = await sourcePublicDomainBasis(env, source, rights);
    if (!basis) throw new TranslationBasisRequired();
    bases.push({ source, ...basis });
  }
  return bases;
}

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
  // Retained events carry values, not the caller's JSON key order. The replay
  // digest must reconstruct exactly the same admission from those values.
  return hash(JSON.stringify({ family: 'translation-link-v1',
    targetWork: input.targetWork, targetMainVersion: input.targetMainVersion,
    targetMainRevision: input.targetMainRevision, sourceWork: input.sourceWork,
    sourceMainVersion: input.sourceMainVersion, sourceMainRevision: input.sourceMainRevision,
    status: input.status, contentLanguage: input.contentLanguage,
    translator: input.translator, publisher: input.publisher, evidence: input.evidence,
    actingSubject: input.actingSubject, idempotencyKey: input.idempotencyKey }));
}

export function translationLinkReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0translation-link-v1`)}`;
}

export function translationAuthorizationScope(input: TranslationLinkInput): string {
  validateTranslationLink(input);
  if (!input.sourceMainRevision) throw new InvalidTranslationLink('exact source revision is required');
  return `translation:authorize:${input.sourceWork}:${input.sourceMainRevision}`;
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
  rejectionKind?: string;
}

export async function readTranslationLinkTerminal(env: WorkActivationEnvironment,
  admissionId: string): Promise<TerminalLink | null> {
  const receipt = translationLinkReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?link ?digest ?admission ?scope ?authorityEpoch ?epoch ?sequence ?rejectionKind WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} rv:outcome ?outcome ; rv:requestDigest ?digest ;
        rv:admissionId ?admission ; rv:admittedScope ?scope ;
        rv:authorityEpoch ?authorityEpoch ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:translationLink ?link }
      OPTIONAL { ${iri(receipt)} rv:rejectionKind ?rejectionKind }
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
    sequence: row.sequence.value, receipt,
    ...(row.rejectionKind ? { rejectionKind: row.rejectionKind.value } : {}) };
}

async function sealCancelled(env: WorkActivationEnvironment, registered: RegisteredAdmission,
  translationBasisRequired = false): Promise<void> {
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
          ${translationBasisRequired ? 'rv:rejectionKind rv:TranslationBasisRequired ;' : ''}
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
