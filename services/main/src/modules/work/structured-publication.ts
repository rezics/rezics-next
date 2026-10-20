import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { profileValidations, type ProfileId } from '../../infrastructure/profile.ts';
import { AdmissionDenied, type RegisteredAdmission } from '../access/admission.ts';
import { readCompositionHeader, structureIri } from '../structure/graph.ts';
import { workPublicationProfileFor } from '../structure/profiles.ts';
import { PublicationUnavailable, StalePublicationHead, InvalidPublicationInput }
  from '../contribution/publish.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from './activate.ts';
import { WORK_STRUCTURE_PUBLICATION_RECEIPT_FAMILY, WORK_STRUCTURE_WITHDRAWAL_RECEIPT_FAMILY }
  from './receipt-family.ts';
import type { VerifiedPublicationAttribution } from './sourced-structure-publication.ts';
import { validManualPublicationCitation, type ManualPublicationCitation } from './sourced-structure-publication.ts';
import { instructionAdoptionTriples, type InstructionAdoption } from './instruction-adoption.ts';

export const WORK_STRUCTURE_PUBLICATION_PROFILE = 'https://rezics.com/definition/work-structure-publication-v1';
export const WORK_STRUCTURE_PUBLICATION_OPERATION = 'work-structure-publication-v1';
const NONE = 'urn:rezics:none';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const sourceRoot = /^urn:rezics:sha256:[0-9a-f]{64}$/;

export type WorkStructurePublicationInput = ({
  profile: typeof WORK_STRUCTURE_PUBLICATION_OPERATION;
  operation: 'publish';
  work: string;
  actingSubject: string;
  expectedWorkHead: string;
  expectedMainVersion: string;
  structure: string;
  expectedStructureHead: string;
  expectedPublicationHead: string | null;
  disclosure: 'public';
} & ({ rightsBasis: 'original-contribution'; sourceObservation?: never; citation?: never; rightsAssessmentId?: never }
  | { rightsBasis: 'public-domain'; sourceObservation: string; citation?: never; rightsAssessmentId?: never }
  | { rightsBasis: 'public-domain'; sourceObservation?: never; citation: ManualPublicationCitation;
    rightsAssessmentId: string })) | {
  profile: typeof WORK_STRUCTURE_PUBLICATION_OPERATION;
  operation: 'withdraw';
  work: string;
  actingSubject: string;
  expectedPublicationHead: string;
};

export type WorkStructurePublicationAction = 'work.publish' | 'work.withdraw-publication';
export type WorkStructurePublicationReason = 'stale-head' | 'source-unavailable' | 'rights-unavailable'
  | 'unsupported-profile' | 'authority-denied';

export interface WorkStructurePublicationReceipt {
  action: WorkStructurePublicationAction;
  outcome: 'succeeded' | 'cancelled';
  reason?: WorkStructurePublicationReason;
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  work: string;
  attestedBy?: string;
  mainVersion?: string;
  structure?: string;
  structureProfile?: string;
  structureRevision?: string;
  selectedGeneration?: string;
  sourceRoot?: string;
  publicationDecision?: string;
  predecessor?: string | null;
}

export class WorkStructurePublicationUnavailable extends PublicationUnavailable {}
export class WorkStructurePublicationStale extends StalePublicationHead {}
export class WorkStructurePublicationRightsDenied extends Error {}

const cancellationReasons: Record<WorkStructurePublicationReason, string> = {
  'stale-head': 'StaleHead',
  'source-unavailable': 'SourceUnavailable',
  'rights-unavailable': 'RightsUnavailable',
  'unsupported-profile': 'UnsupportedProfile',
  'authority-denied': 'AuthorityDenied',
};

function actionFor(input: WorkStructurePublicationInput): WorkStructurePublicationAction {
  return input.operation === 'publish' ? 'work.publish' : 'work.withdraw-publication';
}

function familyFor(action: WorkStructurePublicationAction): string {
  return action === 'work.publish' ? WORK_STRUCTURE_PUBLICATION_RECEIPT_FAMILY
    : WORK_STRUCTURE_WITHDRAWAL_RECEIPT_FAMILY;
}

function checkInput(input: WorkStructurePublicationInput): void {
  if (input.profile !== WORK_STRUCTURE_PUBLICATION_OPERATION
    || !nativeId.test(input.work) || !nativeId.test(input.actingSubject)) {
    throw new InvalidPublicationInput('invalid Work publication input');
  }
  if (input.operation === 'publish') {
    if (!nativeId.test(input.expectedWorkHead) || !nativeId.test(input.expectedMainVersion)
      || !nativeId.test(input.structure) || !nativeId.test(input.expectedStructureHead)
      || input.expectedPublicationHead !== null && !nativeId.test(input.expectedPublicationHead)
      || input.disclosure !== 'public'
      || (input.rightsBasis === 'public-domain' ? input.sourceObservation !== undefined
        ? !nativeId.test(input.sourceObservation) || input.citation !== undefined || input.rightsAssessmentId !== undefined
        : !validManualPublicationCitation(input.citation)
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.rightsAssessmentId)
        : input.rightsBasis !== 'original-contribution' || input.sourceObservation !== undefined
          || input.citation !== undefined || input.rightsAssessmentId !== undefined)) {
      throw new InvalidPublicationInput('invalid structured Work publication source');
    }
  } else if (!nativeId.test(input.expectedPublicationHead)) {
    throw new InvalidPublicationInput('a withdrawal requires its exact publication head');
  }
}

export function workStructurePublicationDigest(input: WorkStructurePublicationInput): string {
  checkInput(input);
  return hash(JSON.stringify(input.operation === 'publish'
    ? { family: WORK_STRUCTURE_PUBLICATION_OPERATION, operation: input.operation,
      work: input.work, actor: input.actingSubject, expectedWorkHead: input.expectedWorkHead,
      expectedMainVersion: input.expectedMainVersion, structure: input.structure,
      expectedStructureHead: input.expectedStructureHead,
      expectedPublicationHead: input.expectedPublicationHead,
      disclosure: input.disclosure, rightsBasis: input.rightsBasis,
      ...(input.rightsBasis === 'public-domain' ? input.sourceObservation !== undefined
        ? { sourceObservation: input.sourceObservation }
        : { citation: { url: input.citation.url, license: input.citation.license, author: input.citation.author },
          rightsAssessmentId: input.rightsAssessmentId } : {}) }
    : { family: WORK_STRUCTURE_PUBLICATION_OPERATION, operation: input.operation,
      work: input.work, actor: input.actingSubject,
      expectedPublicationHead: input.expectedPublicationHead }));
}

export function workStructurePublicationReceiptIri(admissionId: string,
  action: WorkStructurePublicationAction): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0${familyFor(action)}`)}`;
}

function reasonFromIri(value: string | undefined): WorkStructurePublicationReason | undefined {
  if (value === `${RV}StaleHead`) return 'stale-head';
  if (value === `${RV}SourceUnavailable`) return 'source-unavailable';
  if (value === `${RV}RightsUnavailable`) return 'rights-unavailable';
  if (value === `${RV}UnsupportedProfile`) return 'unsupported-profile';
  if (value === `${RV}AuthorityDenied`) return 'authority-denied';
  return undefined;
}

export async function readWorkStructurePublicationReceipt(env: Pick<WorkActivationEnvironment, 'fuseki'>,
  admissionId: string, action: WorkStructurePublicationAction): Promise<WorkStructurePublicationReceipt | null> {
  const receipt = workStructurePublicationReceiptIri(admissionId, action);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?outcome ?reason ?action ?family ?digest ?id ?epoch ?scope ?dataEpoch ?sequence
      ?work ?attestedBy ?main ?structure ?profile ?revision ?generation ?root ?decision ?predecessor WHERE {
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ; rv:action ?action ;
          rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
          rv:admittedScope ?scope ; rv:commandFamily ?family ;
          rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(receipt)} rv:reason ?reason }
        OPTIONAL { ${iri(receipt)} rv:work ?work }
        OPTIONAL { ${iri(receipt)} rv:attestedBy ?attestedBy }
        OPTIONAL { ${iri(receipt)} rv:mainVersion ?main }
        OPTIONAL { ${iri(receipt)} rv:structure ?structure }
        OPTIONAL { ${iri(receipt)} rv:structureProfile ?profile }
        OPTIONAL { ${iri(receipt)} rv:structureRevision ?revision }
        OPTIONAL { ${iri(receipt)} rv:selectedGeneration ?generation }
        OPTIONAL { ${iri(receipt)} rv:sourceRoot ?root }
        OPTIONAL { ${iri(receipt)} rv:publicationDecision ?decision }
        OPTIONAL { ${iri(receipt)} rv:expectedHead ?predecessor }
      }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new Error('Work publication receipt cardinality violation');
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const reason = reasonFromIri(value('reason'));
  if (!outcome || value('action') !== action || value('family') !== familyFor(action)
    || !value('digest') || !value('id')
    || !value('epoch') || !value('scope') || !value('dataEpoch')
    || !/^[0-9]+$/.test(value('sequence') ?? '') || value('reason') && !reason
    || !value('work') || !value('attestedBy')
    || outcome === 'succeeded' && (!value('decision') || reason)
    || outcome === 'succeeded' && action === 'work.publish'
      && (!value('main') || !value('structure') || !value('profile') || !value('revision')
        || !value('generation') || !sourceRoot.test(value('root') ?? ''))
    || outcome === 'succeeded' && action === 'work.withdraw-publication' && !value('predecessor')
    || outcome === 'cancelled' && (value('decision') || value('main') || value('structure')
      || value('profile') || value('revision') || value('generation') || value('root'))) {
    throw new Error('Work publication receipt is incomplete');
  }
  return { action, outcome, ...(reason ? { reason } : {}), receipt,
    admissionId: value('id')!, requestDigest: value('digest')!, authorityEpoch: value('epoch')!,
    scope: value('scope')!, dataEpoch: value('dataEpoch')!, sequence: value('sequence')!,
    work: value('work')!,
    ...(value('attestedBy') ? { attestedBy: value('attestedBy')! } : {}),
    ...(value('main') ? { mainVersion: value('main')! } : {}),
    ...(value('structure') ? { structure: value('structure')! } : {}),
    ...(value('profile') ? { structureProfile: value('profile')! } : {}),
    ...(value('revision') ? { structureRevision: value('revision')! } : {}),
    ...(value('generation') ? { selectedGeneration: value('generation')! } : {}),
    ...(value('root') ? { sourceRoot: value('root')! } : {}),
    ...(value('decision') ? { publicationDecision: value('decision')! } : {}),
    predecessor: value('predecessor') ?? null };
}

function matches(receipt: WorkStructurePublicationReceipt, admission: RegisteredAdmission,
  action: WorkStructurePublicationAction, digest: string): boolean {
  return receipt.action === action && receipt.admissionId === admission.id
    && receipt.requestDigest === digest && receipt.authorityEpoch === admission.authorityEpoch
    && receipt.scope === admission.scope;
}

export function checkedWorkStructurePublicationReceipt(receipt: WorkStructurePublicationReceipt,
  admission: RegisteredAdmission, input: WorkStructurePublicationInput,
  digest: string): WorkStructurePublicationReceipt {
  const action = actionFor(input);
  if (!matches(receipt, admission, action, digest)) {
    throw new IdempotencyConflict('Work publication receipt differs from Access admission');
  }
  if (receipt.work !== input.work || receipt.attestedBy !== input.actingSubject) {
    throw new IdempotencyConflict('Work publication receipt targets another intent');
  }
  if (receipt.outcome === 'cancelled') {
    if (receipt.reason === 'stale-head') throw new WorkStructurePublicationStale('Work publication head is stale');
    if (receipt.reason === 'rights-unavailable') {
      throw new WorkStructurePublicationRightsDenied('Work publication rights are not established');
    }
    if (receipt.reason === 'source-unavailable' || receipt.reason === 'unsupported-profile') {
      throw new WorkStructurePublicationUnavailable('Work publication source is unavailable');
    }
    throw new AdmissionDenied('Work publication was not admitted for dispatch');
  }
  if ((receipt.predecessor ?? null) !== input.expectedPublicationHead
    || input.operation === 'publish' && (receipt.mainVersion !== input.expectedMainVersion
      || receipt.structure !== input.structure || receipt.structureRevision !== input.expectedStructureHead)) {
    throw new IdempotencyConflict('Work publication receipt targets another intent');
  }
  return receipt;
}

interface CurrentWorkState {
  workHead: string;
  mainVersion: string;
  publicationHead: string | null;
}

async function currentWorkState(env: WorkActivationEnvironment, work: string): Promise<CurrentWorkState | null> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?workHead ?mainVersion ?publicationHead WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(work)} a schema:CreativeWork ; rv:head ?workHead ; rv:mainVersion ?mainVersion .
        OPTIONAL { ${iri(work)} rv:workStructurePublicationHead ?publicationHead }
      }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.workHead || !rows[0]?.mainVersion) {
    throw new WorkStructurePublicationUnavailable('Work publication basis is ambiguous');
  }
  return { workHead: rows[0].workHead.value, mainVersion: rows[0].mainVersion.value,
    publicationHead: rows[0].publicationHead?.value ?? null };
}

async function decisionIsPublished(env: WorkActivationEnvironment, work: string, decision: string): Promise<boolean> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    ASK { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(decision)} a rv:WorkStructurePublicationDecision ; rv:component ${iri(work)} ;
        rv:publicationOutcome rv:Published ; rv:publicSource ?source .
      ?source a rv:WorkStructurePublicSource ; rv:work ${iri(work)} .
    } }`, 1024);
  return result.boolean === true;
}

const MAX_ORIGINAL_CONTRIBUTOR_REVISIONS = 128;

/** The public attestation is valid only for a complete, local source authored by this actor. */
export async function verifyOriginalWorkStructureContribution(env: Pick<WorkActivationEnvironment, 'fuseki'>,
  source: { structure: string; revision: string; generation: string; manifest: string;
    placementCount: number; actingSubject: string; adoptions?: readonly InstructionAdoption[] }, admittedActingSubject: (id: string) => Promise<string>)
  : Promise<boolean> {
  const exactRoot = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    ASK {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(source.revision)} a rv:StructureRevision ; rv:component ${iri(source.structure)} ;
          rv:generation ${iri(source.generation)} ; rv:manifest ${iri(source.manifest)} .
        FILTER NOT EXISTS { ${iri(source.revision)} rv:importSource ?importSource }
        FILTER NOT EXISTS { ${iri(source.revision)} rv:importSourceRevision ?importRevision }
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ?placement rv:generation ${iri(source.generation)} ; rv:sourceKey ?sourceKey .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
      } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ?placement rv:generation ${iri(source.generation)} ; rv:qualifier ?qualifier .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
        ?qualifier rv:media ?media .
      } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ?placement rv:generation ${iri(source.generation)} ; rv:occurrence ?occurrence ;
          schema:item ?item .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
        OPTIONAL { ?placement rv:qualifier ?qualifier }
        FILTER(?item != ?occurrence && (!BOUND(?qualifier) || ?item != ?qualifier)
          ${source.adoptions?.length ? `&& ?occurrence NOT IN (${source.adoptions.map(item => iri(item.occurrence)).join(',')})` : ''})
      } }
    }`);
  if (exactRoot.boolean !== true) return false;

  const missingAuthor = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} {
      ?placement rv:generation ${iri(source.generation)} ; rv:occurrence ?occurrence .
      FILTER NOT EXISTS {
        ?occurrence rv:introducedBy ?introducedBy .
        GRAPH ${iri(GRAPHS.revisions)} { ?introducedBy a rv:StructureRevision ;
          rv:component ${iri(source.structure)} . }
        GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ;
          rv:structureRevision ?introducedBy ; rv:admissionId ?admission . }
      }
    }
  }`);
  if (missingAuthor.boolean === true) return false;

  const contributors = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?admission WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?placement rv:generation ${iri(source.generation)} ; rv:occurrence ?occurrence .
      ?occurrence rv:introducedBy ?introducedBy .
    }
    GRAPH ${iri(GRAPHS.revisions)} { ?introducedBy a rv:StructureRevision ;
      rv:component ${iri(source.structure)} . }
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ;
      rv:structureRevision ?introducedBy ; rv:admissionId ?admission . }
  } LIMIT ${MAX_ORIGINAL_CONTRIBUTOR_REVISIONS + 1}`);
  const rows = contributors.results?.bindings ?? [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (rows.length > MAX_ORIGINAL_CONTRIBUTOR_REVISIONS
    || rows.some(row => !uuid.test(row.admission?.value ?? '')
      || !row.admission || typeof row.admission.value !== 'string')
    || source.placementCount > 0 && rows.length === 0) return false;
  const admissions = [...new Set(rows.map(row => row.admission!.value))];
  for (let offset = 0; offset < admissions.length; offset += 16) {
    const subjects = await Promise.all(admissions.slice(offset, offset + 16)
      .map(async id => {
        try { return await admittedActingSubject(id); }
        catch (error) {
          if (error instanceof AdmissionDenied) return null;
          throw error;
        }
      }));
    if (subjects.some(subject => subject !== source.actingSubject)) return false;
  }
  return true;
}

function operationIri(admission: RegisteredAdmission, action: WorkStructurePublicationAction): string {
  return `urn:rezics:operation:${hash(`${admission.id}\0${action}\0${admission.requestDigest}`)}`;
}

function eventTriples(env: WorkActivationEnvironment, receipt: string,
  action: WorkStructurePublicationAction, work: string, decision?: string, predecessor?: string | null): string {
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const kind = action === 'work.publish' ? 'WorkStructurePublicationEvent' : 'WorkStructureWithdrawalEvent';
  return `${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
    ${iri(event)} a rv:${kind} ; rv:ordinal 0 ; rv:action ${lit(action)} ;
      rv:receipt ${iri(receipt)} ; rv:work ${iri(work)}${decision ? ` ; rv:publicationDecision ${iri(decision)}` : ''}
      ${predecessor ? `; rv:predecessor ${iri(predecessor)}` : ''} .`;
}

async function cancel(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: WorkStructurePublicationInput, reason?: WorkStructurePublicationReason,
  recordExpectedHead = true): Promise<WorkStructurePublicationReceipt> {
  const action = actionFor(input);
  const receipt = workStructurePublicationReceiptIri(admission.id, action);
  try {
    await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
      validations: [], deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
          rv:action ${lit(action)} ; rv:commandFamily ${lit(familyFor(action))} ;
          rv:outcome rv:Cancelled ; ${reason ? `rv:reason rv:${cancellationReasons[reason]} ;` : ''}
          rv:work ${iri(input.work)} ; rv:attestedBy ${iri(input.actingSubject)} ;
          ${recordExpectedHead && input.operation === 'publish' && input.expectedPublicationHead
            ? `rv:expectedHead ${iri(input.expectedPublicationHead)} ;` : input.operation === 'withdraw'
              && recordExpectedHead ? `rv:expectedHead ${iri(input.expectedPublicationHead)} ;` : ''}
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.outbox)} { ${eventTriples(env, receipt, action, input.work)} }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next)
      }` });
  } catch { /* resolve an ambiguous seal from its immutable receipt */ }
  const terminal = await readWorkStructurePublicationReceipt(env, admission.id, action);
  if (!terminal) throw new PendingActivation('Work publication cancellation outcome is unknown');
  return terminal;
}

export async function sealWorkStructurePublicationAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<WorkStructurePublicationReceipt> {
  if (admission.action !== 'work.publish' && admission.action !== 'work.withdraw-publication') {
    throw new Error('unsupported Work publication admission');
  }
  const existing = await readWorkStructurePublicationReceipt(env, admission.id, admission.action);
  if (existing) {
    if (!matches(existing, admission, admission.action, admission.requestDigest)) {
      throw new IdempotencyConflict('Work publication receipt differs from Access admission');
    }
    return existing;
  }
  const input: WorkStructurePublicationInput = admission.action === 'work.publish'
    ? { profile: WORK_STRUCTURE_PUBLICATION_OPERATION, operation: 'publish', work: admission.scope.slice('work:publish:'.length),
      actingSubject: admission.actingSubject, expectedWorkHead: ID, expectedMainVersion: ID,
      structure: ID, expectedStructureHead: ID, expectedPublicationHead: null,
      disclosure: 'public', rightsBasis: 'original-contribution' }
    : { profile: WORK_STRUCTURE_PUBLICATION_OPERATION, operation: 'withdraw',
      work: admission.scope.slice('work:publish:'.length), actingSubject: admission.actingSubject,
      expectedPublicationHead: `${ID}00000000-0000-4000-8000-000000000000` };
  if (!nativeId.test(input.work)) throw new IdempotencyConflict('Work publication scope is invalid');
  return cancel(env, admission, input, undefined, false);
}

async function sealForReason(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: WorkStructurePublicationInput, reason: WorkStructurePublicationReason) {
  return cancel(env, admission, input, reason);
}

export async function denyWorkStructurePublicationAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: WorkStructurePublicationInput): Promise<WorkStructurePublicationReceipt> {
  checkInput(input);
  const digest = workStructurePublicationDigest(input);
  const action = actionFor(input);
  if (admission.action !== action || admission.scope !== `work:publish:${input.work}`
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('Work publication admission differs from intent');
  }
  return sealForReason(env, admission, input, 'authority-denied');
}

async function publish(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: Extract<WorkStructurePublicationInput, { operation: 'publish' }>,
  admittedActingSubject: (id: string) => Promise<string>, adoptions: readonly InstructionAdoption[] = [],
  attribution?: VerifiedPublicationAttribution, verifyAttribution?: () => Promise<void>): Promise<WorkStructurePublicationReceipt> {
  const header = await readCompositionHeader(env, input.structure);
  if (!header) return sealForReason(env, admission, input, 'source-unavailable');
  let reviewed;
  try { reviewed = workPublicationProfileFor(header.profile); }
  catch { return sealForReason(env, admission, input, 'unsupported-profile'); }
  if (header.owner !== input.work
    || header.component !== input.expectedMainVersion || header.head !== input.expectedStructureHead) {
    return sealForReason(env, admission, input,
      header.owner !== input.work || header.component !== input.expectedMainVersion
        ? 'source-unavailable' : 'stale-head');
  }
  if (!sourceRoot.test(header.manifest)) return sealForReason(env, admission, input, 'source-unavailable');
  const sourced = input.rightsBasis === 'public-domain';
  if (sourced && (!attribution || attribution.structure !== input.structure
    || attribution.structureRevision !== input.expectedStructureHead
    || attribution.transcriber !== input.actingSubject
    || (input.sourceObservation !== undefined
      ? !('record' in attribution) || attribution.observation !== input.sourceObservation
      : !('kind' in attribution) || attribution.kind !== 'manual-citation'
        || attribution.rightsAssessmentId !== input.rightsAssessmentId
        || attribution.url !== input.citation.url || attribution.license !== input.citation.license
        || attribution.author !== input.citation.author || !verifyAttribution)))
    return sealForReason(env, admission, input, 'rights-unavailable');
  let originalContribution = sourced;
  try {
    if (!sourced) {
      originalContribution = await verifyOriginalWorkStructureContribution(env, {
        structure: input.structure, revision: header.head, generation: header.generation,
        manifest: header.manifest, placementCount: header.placementCount,
        actingSubject: input.actingSubject,
        adoptions,
      }, admittedActingSubject);
    }
  } catch (error) {
    if (!(error instanceof AdmissionDenied)) throw error;
  }
  if (!originalContribution) return sealForReason(env, admission, input, 'rights-unavailable');
  const state = await currentWorkState(env, input.work);
  if (!state) return sealForReason(env, admission, input, 'source-unavailable');
  if (state.workHead !== input.expectedWorkHead || state.mainVersion !== input.expectedMainVersion
    || state.publicationHead !== input.expectedPublicationHead) {
    return sealForReason(env, admission, input, 'stale-head');
  }
  const action = actionFor(input);
  const receipt = workStructurePublicationReceiptIri(admission.id, action);
  const decision = `${ID}${Bun.randomUUIDv7()}`;
  const source = `urn:rezics:work-source:${hash(`${decision}\0source`)}`;
  const operation = operationIri(admission, action);
  const sourceTerm = iri(source);
  const profile = sourced ? 'https://rezics.com/definition/work-structure-publication-v2' : WORK_STRUCTURE_PUBLICATION_PROFILE;
  const basis = sourced ? 'PublicDomain' : 'OriginalContribution';
  const sourceObservation = sourced && input.sourceObservation !== undefined
    ? `rv:sourceObservation ${iri(input.sourceObservation)} ;` : '';
  const rightsAssessment = sourced && input.rightsAssessmentId !== undefined
    ? `rv:rightsAssessment ${iri(`urn:rezics:rights:assessment:${input.rightsAssessmentId}`)} ;` : '';
  const predecessor = input.expectedPublicationHead
    ? `rv:predecessor ${iri(input.expectedPublicationHead)} ;` : '';
  const receiptPredecessor = input.expectedPublicationHead
    ? `rv:expectedHead ${iri(input.expectedPublicationHead)} ;` : '';
  const manifest = prepareComponent(env.objectDirectory, decision, {
    format: 'work-structure-publication-manifest-v1', operation: input.operation,
    work: input.work, mainVersion: input.expectedMainVersion, workHead: input.expectedWorkHead,
    structure: input.structure, structureProfile: reviewed.graphProfile,
    structureRevision: input.expectedStructureHead, selectedGeneration: header.generation,
    sourceRoot: header.manifest, rightsBasis: input.rightsBasis, disclosure: input.disclosure,
    dependencies: adoptions, ...(attribution ? { attribution } : {}),
    attestation: { actingSubject: input.actingSubject, action, scope: admission.scope,
      admissionId: admission.id, authorityEpoch: admission.authorityEpoch,
      requestDigest: admission.requestDigest },
  }, profile);
  const validations = await profileValidations(env.fuseki, (sourced ? 'work-structure-publication-v2' : 'work-structure-publication-v1') as ProfileId, [
    { shape: `${profile}/work-shape`, focus: [input.work],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${profile}/decision-shape`, focus: [decision],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${profile}/source-shape`, focus: [source],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:workStructurePublicationHead ?prior }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:workStructurePublicationHead ${iri(decision)} }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${instructionAdoptionTriples(source, adoptions, reviewed)}
        ${sourceTerm} a rv:WorkStructurePublicSource ; rv:work ${iri(input.work)} ;
          rv:structureProfile ${structureIri(reviewed.graphProfile)} ; rv:structure ${iri(input.structure)} ;
          rv:component ${iri(input.expectedMainVersion)} ;
          rv:structureRevision ${iri(input.expectedStructureHead)} ;
          rv:selectedGeneration ${iri(header.generation)} ; ${sourceObservation} ${rightsAssessment}
          ${sourced ? `rv:modelRevision ${iri(profile)} ;` : ''}
          ${attribution ? `<https://schema.org/citation> ${lit(JSON.stringify(attribution))} ;` : ''}
          rv:sourceRoot ${iri(header.manifest)} .
        ${iri(decision)} a rv:WorkStructurePublicationDecision, rv:RevisionAnchor ;
          rv:component ${iri(input.work)} ; ${predecessor}
          rv:operation ${iri(operation)} ; rv:publicationOutcome rv:Published ;
          rv:publicSource ${sourceTerm} ; ${sourceObservation} ${rightsAssessment} rv:rightsBasis rv:${basis} ;
          rv:disclosure rv:Public ; rv:attestedBy ${iri(input.actingSubject)} ;
          rv:admissionId ${lit(admission.id)} ; rv:admittedScope ${lit(admission.scope)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:requestDigest ${lit(admission.requestDigest)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(profile)} ;
          rv:shapeRevision ${iri(profile)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:action ${lit(action)} ; rv:commandFamily ${lit(familyFor(action))} ; rv:outcome rv:Succeeded ;
        rv:work ${iri(input.work)} ; rv:attestedBy ${iri(input.actingSubject)} ;
        rv:mainVersion ${iri(input.expectedMainVersion)} ; rv:structure ${iri(input.structure)} ;
        rv:structureProfile ${structureIri(reviewed.graphProfile)} ; rv:structureRevision ${iri(input.expectedStructureHead)} ;
        rv:selectedGeneration ${iri(header.generation)} ; rv:sourceRoot ${iri(header.manifest)} ;
        rv:publicationDecision ${iri(decision)} ; ${receiptPredecessor}
        ${sourceObservation} ${rightsAssessment} rv:rightsBasis rv:${basis} ; rv:disclosure rv:Public ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:WorkStructurePublicationEvent ; rv:ordinal 0 ;
          rv:action ${lit(action)} ; rv:receipt ${iri(receipt)} ; rv:work ${iri(input.work)} ;
          rv:publicationDecision ${iri(decision)}${input.expectedPublicationHead
            ? ` ; rv:predecessor ${iri(input.expectedPublicationHead)}` : ''} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.work)} a schema:CreativeWork ; rv:head ${iri(input.expectedWorkHead)} ;
          rv:mainVersion ${iri(input.expectedMainVersion)} .
        ${iri(input.expectedMainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
        ${iri(input.structure)} a rv:Structure ; rv:structureOf ${iri(input.expectedMainVersion)} ;
          rv:structureProfile ${structureIri(reviewed.graphProfile)} ; rv:structureHead ${iri(input.expectedStructureHead)} ;
          rv:selectedGeneration ${iri(header.generation)} .
        ${iri(header.generation)} a rv:StructureGeneration ; rv:structure ${iri(input.structure)} ;
          rv:generationState rv:Active ; rv:placementCount ${header.placementCount} .
        OPTIONAL { ${iri(input.work)} rv:workStructurePublicationHead ?prior }
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(input.expectedStructureHead)} a rv:StructureRevision ; rv:component ${iri(input.structure)} ;
          rv:generation ${iri(header.generation)} ; rv:manifest ${iri(header.manifest)} .
      }
      FILTER(COALESCE(?prior, ${iri(NONE)}) = ${input.expectedPublicationHead
        ? iri(input.expectedPublicationHead) : iri(NONE)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  // Rights is a separate owner: recheck immediately before the atomic graph CAS.
  await verifyAttribution?.();
  try {
    const result = await validatedCommand(env, { receipt, digest: admission.requestDigest,
      validations, deadlineMs: 10_000, update }, admission);
    if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'conflict') throw new IdempotencyConflict('Work publication receipt differs');
  } catch (error) {
    if (error instanceof CommandRejected || error instanceof IdempotencyConflict) throw error;
    /* Resolve a lost command response from its receipt before deciding pending. */
  }
  const committed = await readWorkStructurePublicationReceipt(env, admission.id, action);
  if (committed) return committed;
  const latest = await currentWorkState(env, input.work);
  if (!latest || latest.workHead !== input.expectedWorkHead || latest.mainVersion !== input.expectedMainVersion
    || latest.publicationHead !== input.expectedPublicationHead) {
    return sealForReason(env, admission, input, 'stale-head');
  }
  throw new PendingActivation('Work publication result is unknown');
}

async function withdraw(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: Extract<WorkStructurePublicationInput, { operation: 'withdraw' }>): Promise<WorkStructurePublicationReceipt> {
  const state = await currentWorkState(env, input.work);
  if (!state) return sealForReason(env, admission, input, 'source-unavailable');
  if (state.publicationHead !== input.expectedPublicationHead) {
    return sealForReason(env, admission, input, 'stale-head');
  }
  if (!await decisionIsPublished(env, input.work, input.expectedPublicationHead)) {
    return sealForReason(env, admission, input, 'source-unavailable');
  }
  const action = actionFor(input);
  const receipt = workStructurePublicationReceiptIri(admission.id, action);
  const decision = `${ID}${Bun.randomUUIDv7()}`;
  const operation = operationIri(admission, action);
  const manifest = prepareComponent(env.objectDirectory, decision, {
    format: 'work-structure-publication-manifest-v1', operation: input.operation,
    work: input.work, predecessor: input.expectedPublicationHead,
    attestation: { actingSubject: input.actingSubject, action, scope: admission.scope,
      admissionId: admission.id, authorityEpoch: admission.authorityEpoch,
      requestDigest: admission.requestDigest },
  }, WORK_STRUCTURE_PUBLICATION_PROFILE);
  const validations = await profileValidations(env.fuseki, 'work-structure-publication-v1' as ProfileId, [
    { shape: `${WORK_STRUCTURE_PUBLICATION_PROFILE}/work-shape`, focus: [input.work],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${WORK_STRUCTURE_PUBLICATION_PROFILE}/decision-shape`, focus: [decision],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:workStructurePublicationHead ${iri(input.expectedPublicationHead)} }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:workStructurePublicationHead ${iri(decision)} }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(decision)} a rv:WorkStructurePublicationDecision, rv:RevisionAnchor ;
          rv:component ${iri(input.work)} ; rv:predecessor ${iri(input.expectedPublicationHead)} ;
          rv:operation ${iri(operation)} ; rv:publicationOutcome rv:Withdrawn ;
          rv:attestedBy ${iri(input.actingSubject)} ; rv:admissionId ${lit(admission.id)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:requestDigest ${lit(admission.requestDigest)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(WORK_STRUCTURE_PUBLICATION_PROFILE)} ;
          rv:shapeRevision ${iri(WORK_STRUCTURE_PUBLICATION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:action ${lit(action)} ; rv:commandFamily ${lit(familyFor(action))} ; rv:outcome rv:Succeeded ;
        rv:work ${iri(input.work)} ; rv:attestedBy ${iri(input.actingSubject)} ;
        rv:publicationDecision ${iri(decision)} ; rv:expectedHead ${iri(input.expectedPublicationHead)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:WorkStructureWithdrawalEvent ; rv:ordinal 0 ;
          rv:action ${lit(action)} ; rv:receipt ${iri(receipt)} ; rv:work ${iri(input.work)} ;
          rv:publicationDecision ${iri(decision)} ; rv:predecessor ${iri(input.expectedPublicationHead)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.work)} a schema:CreativeWork ; rv:workStructurePublicationHead ${iri(input.expectedPublicationHead)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(input.expectedPublicationHead)} a rv:WorkStructurePublicationDecision ;
          rv:component ${iri(input.work)} ; rv:publicationOutcome rv:Published ; rv:publicSource ?source .
        ?source a rv:WorkStructurePublicSource ; rv:work ${iri(input.work)} .
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  try {
    const result = await validatedCommand(env, { receipt, digest: admission.requestDigest,
      validations, deadlineMs: 10_000, update }, admission);
    if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'conflict') throw new IdempotencyConflict('Work withdrawal receipt differs');
  } catch (error) {
    if (error instanceof CommandRejected || error instanceof IdempotencyConflict) throw error;
  }
  const committed = await readWorkStructurePublicationReceipt(env, admission.id, action);
  if (committed) return committed;
  const latest = await currentWorkState(env, input.work);
  if (!latest || latest.publicationHead !== input.expectedPublicationHead) {
    return sealForReason(env, admission, input, 'stale-head');
  }
  throw new PendingActivation('Work withdrawal result is unknown');
}

export async function changeStructuredWorkPublication(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: WorkStructurePublicationInput,
  admittedActingSubject: (id: string) => Promise<string>, adoptions: readonly InstructionAdoption[] = [],
  attribution?: VerifiedPublicationAttribution, verifyAttribution?: () => Promise<void>): Promise<WorkStructurePublicationReceipt> {
  checkInput(input);
  const digest = workStructurePublicationDigest(input);
  const action = actionFor(input);
  if (admission.action !== action || admission.scope !== `work:publish:${input.work}`
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('Work publication admission differs from intent');
  }
  await assertNotInvalidProfileReceipt(env.fuseki, workStructurePublicationReceiptIri(admission.id, action));
  const existing = await readWorkStructurePublicationReceipt(env, admission.id, action);
  if (existing) return checkedWorkStructurePublicationReceipt(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Work publication admission expired');
  return input.operation === 'publish'
    ? publish(env, admission, input, admittedActingSubject, adoptions, attribution, verifyAttribution) : withdraw(env, admission, input);
}
