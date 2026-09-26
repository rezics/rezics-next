// Jena-owned verification records (claim-v1, assessment-v1). Each write is one
// guarded command with its receipt, sequence advance and one outbox batch, in
// the classification-proposition template's shape. SQL never runs inside it.
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, ID, RV, hash, lit, IdempotencyConflict, PendingActivation,
  CancelledActivation, type WorkActivationEnvironment } from '../work/activate.ts';

export const CLAIM_PROFILE = 'https://rezics.com/definition/claim-v1';
export const ASSESSMENT_PROFILE = 'https://rezics.com/definition/assessment-v1';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const READ_GRAPHS = [GRAPHS.current, GRAPHS.revisions];

// A claim may cite an external predicate or referent. The Work helper accepts
// only native IRIs, so validate the admitted verification reference grammar here.
function iri(value: string): string {
  if (value.length < 1 || value.length > 300
    || !/^(?:https:\/\/[^/]+(?:\/[^\s<>"{}|\\^`]+)?|urn:[^\s<>"{}|\\^`]+)$/.test(value)) {
    throw new InvalidVerificationInput('verification reference is not an admitted IRI');
  }
  return `<${value}>`;
}

export class InvalidVerificationInput extends Error {}
export class VerificationGraphStale extends Error {}

export type Family = 'claim-create' | 'reliability-assess' | 'claim-assess';
const CANCEL_EVENTS: Record<Family, string> = {
  'claim-create': 'ClaimCreationCancelledEvent',
  'reliability-assess': 'SourceReliabilityAssessmentCancelledEvent',
  'claim-assess': 'ClaimAssessmentCancelledEvent',
};
export const ADMISSIONS: Record<Family, { scope: string; action: string; accountScope: string }> = {
  'claim-create': { scope: 'verification:claim:global', action: 'verification.claim-create',
    accountScope: 'claim:create' },
  'reliability-assess': { scope: 'verification:reliability:global',
    action: 'verification.reliability-assess', accountScope: 'claim:reliability' },
  'claim-assess': { scope: 'verification:assess:global', action: 'verification.claim-assess',
    accountScope: 'claim:assess' },
};

export interface GraphReceipt {
  outcome: 'succeeded' | 'cancelled'; receipt: string; admissionId: string; requestDigest: string;
  authorityEpoch: string; scope: string; dataEpoch: string; sequence: string;
  result: Record<string, string>;
}

export function native(value: string, name: string): string {
  if (!NATIVE.test(value)) throw new InvalidVerificationInput(`${name} is not a native identity`);
  return value;
}

export function receiptIri(admissionId: string, family: Family): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0${family}`)}`;
}

const dateTime = (value: string) => `${lit(value)}^^<${XSD}dateTime>`;
const integer = (value: number) => `${lit(String(value))}^^<${XSD}integer>`;

/** Read one receipt with its declared result predicates; null when absent. */
export async function readReceipt(env: Pick<WorkActivationEnvironment, 'fuseki'>, admissionId: string, family: Family,
  results: readonly string[]): Promise<GraphReceipt | null> {
  const receipt = receiptIri(admissionId, family);
  const response = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?digest ?id ?epoch ?scope
    ?dataEpoch ?sequence ?key ?value WHERE { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ; rv:requestDigest ?digest ;
        rv:admissionId ?id ; rv:authorityEpoch ?epoch ; rv:admittedScope ?scope ;
        rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { VALUES ?key { ${results.map(name => `rv:${name}`).join(' ')} }
        ${iri(receipt)} ?key ?value }
    } }`);
  const rows = response.results?.bindings ?? [];
  if (!rows.length) return null;
  const first = rows[0]!;
  const outcome = first.outcome?.value === `${RV}Succeeded` ? 'succeeded'
    : first.outcome?.value === `${RV}Cancelled` ? 'cancelled' : null;
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (row.key && row.value) {
      const name = row.key.value.slice(RV.length);
      if (result[name] !== undefined && result[name] !== row.value.value) {
        throw new Error('verification receipt result is ambiguous');
      }
      result[name] = row.value.value;
    }
  }
  if (!outcome || (outcome === 'succeeded' && results.some(name => result[name] === undefined))) {
    throw new Error('verification receipt is incomplete');
  }
  return { outcome, receipt, admissionId: first.id!.value, requestDigest: first.digest!.value,
    authorityEpoch: first.epoch!.value, scope: first.scope!.value, dataEpoch: first.dataEpoch!.value,
    sequence: first.sequence!.value, result };
}

export function checkedReceipt(receipt: GraphReceipt, admission: RegisteredAdmission, digest: string): GraphReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== digest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new IdempotencyConflict('verification admission differs from graph receipt');
  }
  if (receipt.outcome === 'cancelled') throw new CancelledActivation('verification command was cancelled');
  return receipt;
}

interface Command {
  family: Family; admission: RegisteredAdmission; digest: string; results: readonly string[];
  profile: 'claim-v1' | 'assessment-v1';
  validations: { shape: string; focus: string }[];
  /** Triples per graph plus WHERE guards; control, receipt and outbox are added here. */
  current?: string; revisions: string; receiptFields: string; where: string; deletes?: string;
  event: string;
}

async function run(env: WorkActivationEnvironment, command: Command): Promise<GraphReceipt> {
  const receipt = receiptIri(command.admission.id, command.family);
  await assertNotInvalidProfileReceipt(env.fuseki, receipt);
  const existing = await readReceipt(env, command.admission.id, command.family, command.results);
  if (existing) return checkedReceipt(existing, command.admission, command.digest);
  if (Date.parse(command.admission.expiresAt) <= Date.now()) throw new PendingActivation('admission expired');
  const profileIri = command.profile === 'claim-v1' ? CLAIM_PROFILE : ASSESSMENT_PROFILE;
  const validations = await profileValidations(env.fuseki, command.profile, command.validations.map(entry => ({
    shape: `${profileIri}/${entry.shape}-shape`, focus: [entry.focus], graphs: READ_GRAPHS })));
  const operation = ID + Bun.randomUUIDv7();
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  let updateError: unknown;
  try {
    const result = await validatedCommand(env, { receipt, digest: command.digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        ${command.deletes ? `GRAPH ${iri(GRAPHS.current)} { ${command.deletes} }` : ''} }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        ${command.current ? `GRAPH ${iri(GRAPHS.current)} { ${command.current} }` : ''}
        GRAPH ${iri(GRAPHS.revisions)} { ${command.revisions} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(command.digest)} ; rv:admissionId ${lit(command.admission.id)} ;
            rv:authorityEpoch ${lit(command.admission.authorityEpoch)} ;
            rv:admittedScope ${lit(command.admission.scope)} ; rv:outcome rv:Succeeded ;
            ${command.receiptFields} rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a ${command.event} ; rv:ordinal 0 ; rv:action ${lit(command.admission.action)} ;
            rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?rp ?ro } }
        ${command.where}
        BIND(?n + 1 AS ?next)
      }` }, command.admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') throw new InvalidVerificationInput('verification record violates its profile');
  } catch (error) {
    if (error instanceof InvalidVerificationInput || error instanceof CommandRejected) throw error;
    updateError = error;
  }
  const committed = await readReceipt(env, command.admission.id, command.family, command.results);
  if (committed) return checkedReceipt(committed, command.admission, command.digest);
  throw new PendingActivation(updateError ? 'verification command outcome unknown'
    : 'verification command guard did not match');
}

/** Record a terminal cancellation when the admission cannot be dispatched. */
export async function sealVerificationAdmission(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  family: Family, results: readonly string[]): Promise<GraphReceipt> {
  const existing = await readReceipt(env, admission.id, family, results);
  if (existing) return existing;
  const receipt = receiptIri(admission.id, family);
  const marker = hash(`${receipt}\0cancel`);
  let updateError: unknown;
  try {
    await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest, validations: [],
      deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
            rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
            rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(`urn:rezics:outbox:${marker}`)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(`urn:rezics:event:${marker}`)} .
          ${iri(`urn:rezics:event:${marker}`)} a rv:${CANCEL_EVENTS[family]} ; rv:ordinal 0 ;
            rv:action ${lit(admission.action)} ; rv:receipt ${iri(receipt)} ;
            rv:admissionId ${lit(admission.id)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next)
      }` });
  } catch (error) { updateError = error; }
  const committed = await readReceipt(env, admission.id, family, results);
  if (!committed || committed.requestDigest !== admission.requestDigest) {
    throw new PendingActivation(updateError ? 'verification cancellation outcome unknown'
      : 'verification cancellation guard did not match');
  }
  return committed;
}

// ---------------------------------------------------------------- claims

export type PropositionValue = { kind: 'iri'; iri: string }
  | { kind: 'literal'; lexical: string; datatype: 'string' | 'date' | 'dateTime' | 'integer' };

export interface CreateClaimInput {
  referent: string; interpretationContext: string; propositionPredicate: string;
  value: PropositionValue; valuePrecision: 'exact' | 'approximate' | 'uncertain';
  valueQualifiers: readonly ('disputed-attribution' | 'inferred')[];
  validFrom: string | null; validUntil: string | null; editionScope: string | null;
  actingSubject: string;
}

const PRECISION = { exact: 'ExactValue', approximate: 'ApproximateValue', uncertain: 'UncertainValue' } as const;
const QUALIFIER = { 'disputed-attribution': 'DisputedAttribution', inferred: 'InferredValue' } as const;

function canonicalInstant(value: string | null, name: string): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) || Number.isNaN(parsed)) {
    throw new InvalidVerificationInput(`${name} must be a UTC instant`);
  }
  return new Date(parsed).toISOString();
}

export function normalizeClaim(input: CreateClaimInput): CreateClaimInput {
  for (const [name, value] of [['referent', input.referent], ['interpretationContext', input.interpretationContext],
    ['propositionPredicate', input.propositionPredicate], ...(input.editionScope ? [['editionScope', input.editionScope]] : []),
    ...(input.value.kind === 'iri' ? [['value', input.value.iri]] : [])] as const) {
    try { iri(value); } catch { throw new InvalidVerificationInput(`${name} is not an admitted IRI`); }
  }
  native(input.actingSubject, 'actingSubject');
  if (input.value.kind === 'literal') {
    const { lexical, datatype } = input.value;
    const valid = datatype === 'string' ? lexical.length >= 1 && lexical.length <= 2000 && !/[\u0000-\u001f]/.test(lexical)
      : datatype === 'date' ? /^\d{4}-\d{2}-\d{2}$/.test(lexical) && !Number.isNaN(Date.parse(lexical))
        : datatype === 'integer' ? /^-?(0|[1-9][0-9]{0,17})$/.test(lexical)
          : canonicalInstant(lexical, 'value') === lexical;
    if (!valid) throw new InvalidVerificationInput('proposition value does not match its datatype');
  }
  const validFrom = canonicalInstant(input.validFrom, 'validFrom');
  const validUntil = canonicalInstant(input.validUntil, 'validUntil');
  if (validFrom && validUntil && Date.parse(validFrom) >= Date.parse(validUntil)) {
    throw new InvalidVerificationInput('valid time interval is empty');
  }
  if (new Set(input.valueQualifiers).size !== input.valueQualifiers.length) {
    throw new InvalidVerificationInput('value qualifiers repeat');
  }
  return { ...input, validFrom, validUntil, valueQualifiers: [...input.valueQualifiers].sort() };
}

export function claimDigest(input: CreateClaimInput): string {
  return hash(JSON.stringify({ family: 'claim-create-v1', ...normalizeClaim(input) }));
}

function valueTerm(value: PropositionValue): string {
  return value.kind === 'iri' ? iri(value.iri) : `${lit(value.lexical)}^^<${XSD}${value.datatype}>`;
}

export async function createClaim(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: CreateClaimInput): Promise<GraphReceipt> {
  const claim = normalizeClaim(input);
  const digest = claimDigest(input);
  const { scope, action } = ADMISSIONS['claim-create'];
  if (admission.action !== action || admission.scope !== scope || admission.requestDigest !== digest
    || admission.actingSubject !== claim.actingSubject) {
    throw new IdempotencyConflict('claim admission differs from intent');
  }
  const id = ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7();
  const identity = `rv:referent ${iri(claim.referent)} ; rv:interpretationContext ${iri(claim.interpretationContext)} ;
    rv:propositionPredicate ${iri(claim.propositionPredicate)} ;`;
  return run(env, { family: 'claim-create', admission, digest, results: ['claim', 'claimRevision'],
    profile: 'claim-v1', event: 'rv:ClaimCreatedEvent',
    validations: [{ shape: 'claim', focus: id }, { shape: 'revision', focus: revision }],
    current: `${iri(id)} a rv:Claim ; ${identity} rv:claimHead ${iri(revision)} ; rv:claimState rv:Active .`,
    revisions: `${iri(revision)} a rv:ClaimRevision, rv:RevisionAnchor ; rv:component ${iri(id)} ; ${identity}
      rv:propositionValue ${valueTerm(claim.value)} ; rv:valuePrecision rv:${PRECISION[claim.valuePrecision]} ;
      ${claim.valueQualifiers.map(item => `rv:valueQualifier rv:${QUALIFIER[item]} ;`).join(' ')}
      ${claim.validFrom ? `rv:validFrom ${dateTime(claim.validFrom)} ;` : ''}
      ${claim.validUntil ? `rv:validUntil ${dateTime(claim.validUntil)} ;` : ''}
      ${claim.editionScope ? `rv:editionScope ${iri(claim.editionScope)} ;` : ''}
      rv:claimStatus rv:Asserted ; rv:statedBy ${iri(claim.actingSubject)} ;
      rv:recordedAt ${dateTime(new Date().toISOString())} ;
      rv:modelRevision ${iri(CLAIM_PROFILE)} ; rv:shapeRevision ${iri(CLAIM_PROFILE)} ;`,
    receiptFields: `rv:claim ${iri(id)} ; rv:claimRevision ${iri(revision)} ;`,
    where: `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(id)} ?cp ?co } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?vp ?vo } }` });
}

export interface ClaimRecord {
  claim: string; head: string; referent: string; interpretationContext: string;
  propositionPredicate: string; value: PropositionValue; valuePrecision: string;
  valueQualifiers: string[]; validFrom: string | null; validUntil: string | null;
  editionScope: string | null; claimStatus: string; statedBy: string; recordedAt: string;
  dataEpoch: string; sequence: string;
}

const local = (value: string) => value.startsWith(RV) ? value.slice(RV.length) : value;
const PRECISION_NAME: Record<string, string> = { ExactValue: 'exact', ApproximateValue: 'approximate',
  UncertainValue: 'uncertain' };
const QUALIFIER_NAME: Record<string, string> = { DisputedAttribution: 'disputed-attribution', InferredValue: 'inferred' };

/** Exact claim revisions with their claim; `head` is the claim's current head. */
export async function readClaimRevisions(env: WorkActivationEnvironment,
  revisions: readonly string[]): Promise<Map<string, ClaimRecord>> {
  const found = new Map<string, ClaimRecord>();
  if (!revisions.length) return found;
  if (revisions.length > 64) throw new InvalidVerificationInput('too many claim revisions');
  const response = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?revision ?claim ?head ?referent ?context
    ?predicate ?value ?precision ?qualifier ?from ?until ?edition ?status ?statedBy ?recordedAt ?epoch ?sequence WHERE {
    VALUES ?revision { ${revisions.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ClaimRevision ; rv:component ?claim ; rv:referent ?referent ;
      rv:interpretationContext ?context ; rv:propositionPredicate ?predicate ; rv:propositionValue ?value ;
      rv:valuePrecision ?precision ; rv:claimStatus ?status ; rv:statedBy ?statedBy ;
      rv:recordedAt ?recordedAt ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ?revision rv:valueQualifier ?qualifier } OPTIONAL { ?revision rv:validFrom ?from }
      OPTIONAL { ?revision rv:validUntil ?until } OPTIONAL { ?revision rv:editionScope ?edition } }
    GRAPH ${iri(GRAPHS.current)} { ?claim a rv:Claim ; rv:claimHead ?head }
  }`);
  for (const row of response.results?.bindings ?? []) {
    const revision = row.revision!.value;
    const value = row.value!;
    const previous = found.get(revision);
    const qualifier = row.qualifier ? QUALIFIER_NAME[local(row.qualifier.value)] : undefined;
    if (previous) {
      if (qualifier && !previous.valueQualifiers.includes(qualifier)) previous.valueQualifiers.push(qualifier);
      continue;
    }
    found.set(revision, { claim: row.claim!.value, head: row.head!.value, referent: row.referent!.value,
      interpretationContext: row.context!.value, propositionPredicate: row.predicate!.value,
      value: value.type === 'uri' ? { kind: 'iri', iri: value.value } : { kind: 'literal', lexical: value.value,
        datatype: (value.datatype?.slice(XSD.length) ?? 'string') as 'string' },
      valuePrecision: PRECISION_NAME[local(row.precision!.value)] ?? 'uncertain',
      valueQualifiers: qualifier ? [qualifier] : [], validFrom: row.from?.value ?? null,
      validUntil: row.until?.value ?? null, editionScope: row.edition?.value ?? null,
      claimStatus: local(row.status!.value) === 'Withdrawn' ? 'withdrawn' : 'asserted',
      statedBy: row.statedBy!.value, recordedAt: row.recordedAt!.value,
      dataEpoch: row.epoch!.value, sequence: row.sequence!.value });
  }
  for (const record of found.values()) record.valueQualifiers.sort();
  return found;
}

export async function readClaimHead(env: WorkActivationEnvironment, claim: string): Promise<ClaimRecord | null> {
  const head = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(claim)} a rv:Claim ; rv:claimHead ?head } }`);
  const rows = head.results?.bindings ?? [];
  if (rows.length !== 1) return null;
  return (await readClaimRevisions(env, [rows[0]!.head!.value])).get(rows[0]!.head!.value) ?? null;
}

// ------------------------------------------------------ source reliability

export type ReliabilityResult = 'ReliableForDomain' | 'MixedReliability' | 'UnreliableForDomain' | 'UntestedForDomain';

export interface ReliabilityInput {
  source: string; domainDefinition: string; evaluationContext: string; expectedHead: string | null;
  result: ReliabilityResult; method: string; methodRevision: string; calibration: string | null;
  applicableFrom: string | null; applicableUntil: string | null; inputDigest: string; inputCount: number;
  limitations: string; rationale: string | null; assessorKind: 'human' | 'automated'; actingSubject: string;
}

export function reliabilityScope(source: string, domain: string, context: string): string {
  return `urn:rezics:reliability-scope:${hash(JSON.stringify([source, domain, context]))}`;
}

export function reliabilityDigest(input: ReliabilityInput): string {
  native(input.source, 'source');
  native(input.actingSubject, 'actingSubject');
  if (input.expectedHead !== null) native(input.expectedHead, 'expectedHead');
  for (const value of [input.domainDefinition, input.evaluationContext, input.method, input.methodRevision,
    ...(input.calibration ? [input.calibration] : [])]) iri(value);
  if (!/^[0-9a-f]{64}$/.test(input.inputDigest) || !Number.isInteger(input.inputCount)
    || input.inputCount < 0 || input.inputCount > 32 || !input.limitations.trim()
    || input.limitations.length > 2000 || (input.rationale !== null && input.rationale.length > 4000)) {
    throw new InvalidVerificationInput('source reliability assessment fields are invalid');
  }
  canonicalInstant(input.applicableFrom, 'applicableFrom');
  canonicalInstant(input.applicableUntil, 'applicableUntil');
  return hash(JSON.stringify({ family: 'source-reliability-v1', ...input }));
}

export async function recordReliability(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: ReliabilityInput): Promise<GraphReceipt> {
  const digest = reliabilityDigest(input);
  const { scope, action } = ADMISSIONS['reliability-assess'];
  if (admission.action !== action || admission.scope !== scope || admission.requestDigest !== digest
    || admission.actingSubject !== input.actingSubject) {
    throw new IdempotencyConflict('reliability admission differs from intent');
  }
  const node = reliabilityScope(input.source, input.domainDefinition, input.evaluationContext);
  const current = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(node)} rv:reliabilityHead ?head } }`);
  const head = current.results?.bindings?.[0]?.head?.value ?? null;
  const existing = await readReceipt(env, admission.id, 'reliability-assess', ['reliabilityScope', 'reliabilityRevision']);
  if (!existing && head !== input.expectedHead) throw new VerificationGraphStale('reliability head is stale');
  const revision = ID + Bun.randomUUIDv7();
  const scopeFields = `rv:assessedSource ${iri(input.source)} ; rv:domainDefinition ${iri(input.domainDefinition)} ;
    rv:evaluationContext ${iri(input.evaluationContext)} ;`;
  return run(env, { family: 'reliability-assess', admission, digest,
    results: ['reliabilityScope', 'reliabilityRevision'], profile: 'assessment-v1',
    event: 'rv:SourceReliabilityAssessedEvent',
    validations: [{ shape: 'reliability-scope', focus: node }, { shape: 'reliability', focus: revision }],
    deletes: input.expectedHead ? `${iri(node)} rv:reliabilityHead ${iri(input.expectedHead)} .` : undefined,
    current: input.expectedHead ? `${iri(node)} rv:reliabilityHead ${iri(revision)} .`
      : `${iri(node)} a rv:SourceReliabilityScope ; ${scopeFields} rv:reliabilityHead ${iri(revision)} .`,
    revisions: `${iri(revision)} a rv:SourceReliabilityAssessment, rv:RevisionAnchor ; rv:component ${iri(node)} ;
      ${input.expectedHead ? `rv:predecessor ${iri(input.expectedHead)} ;` : ''} ${scopeFields}
      ${input.applicableFrom ? `rv:applicableFrom ${dateTime(input.applicableFrom)} ;` : ''}
      ${input.applicableUntil ? `rv:applicableUntil ${dateTime(input.applicableUntil)} ;` : ''}
      rv:reliabilityResult rv:${input.result} ; rv:inputManifestDigest ${lit(input.inputDigest)} ;
      rv:inputCount ${integer(input.inputCount)} ;
      ${input.rationale ? `rv:rationale ${lit(input.rationale)} ;` : ''}
      rv:method ${iri(input.method)} ; rv:methodRevision ${iri(input.methodRevision)} ;
      ${input.calibration ? `rv:calibration ${iri(input.calibration)} ;` : ''}
      rv:limitations ${lit(input.limitations)} ; rv:assessor ${iri(input.actingSubject)} ;
      rv:assessorKind rv:${input.assessorKind === 'human' ? 'HumanAssessor' : 'AutomatedAssessor'} ;
      rv:assessedAt ${dateTime(new Date().toISOString())} ;
      rv:modelRevision ${iri(ASSESSMENT_PROFILE)} ; rv:shapeRevision ${iri(ASSESSMENT_PROFILE)} ;`,
    receiptFields: `rv:reliabilityScope ${iri(node)} ; rv:reliabilityRevision ${iri(revision)} ;
      ${input.expectedHead ? `rv:expectedHead ${iri(input.expectedHead)} ;` : ''}`,
    where: input.expectedHead
      ? `GRAPH ${iri(GRAPHS.current)} { ${iri(node)} rv:reliabilityHead ${iri(input.expectedHead)} }`
      : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(node)} ?sp ?so } }` });
}

export interface ReliabilityRecord {
  assessment: string; scope: string; source: string; domain: string; context: string;
  result: string; current: boolean;
}

export async function readReliability(env: WorkActivationEnvironment,
  assessments: readonly string[]): Promise<Map<string, ReliabilityRecord>> {
  const found = new Map<string, ReliabilityRecord>();
  if (!assessments.length) return found;
  const response = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?assessment ?scope ?source ?domain
    ?context ?result ?head WHERE {
    VALUES ?assessment { ${assessments.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.revisions)} { ?assessment a rv:SourceReliabilityAssessment ; rv:component ?scope ;
      rv:assessedSource ?source ; rv:domainDefinition ?domain ; rv:evaluationContext ?context ;
      rv:reliabilityResult ?result }
    GRAPH ${iri(GRAPHS.current)} { ?scope rv:reliabilityHead ?head }
  }`);
  for (const row of response.results?.bindings ?? []) {
    found.set(row.assessment!.value, { assessment: row.assessment!.value, scope: row.scope!.value,
      source: row.source!.value, domain: row.domain!.value, context: row.context!.value,
      result: local(row.result!.value), current: row.head!.value === row.assessment!.value });
  }
  return found;
}

// ------------------------------------------------------- claim assessments

export interface AssessmentRecordInput {
  claim: string; claimRevision: string; evidenceSetRevision: string; sourceAssessments: readonly string[];
  method: string; methodRevision: string; policyRevision: string; evaluationContext: string;
  coverage: 'complete' | 'partial' | 'incomplete';
  support: 'supported' | 'contradicted' | 'material-conflict' | 'insufficient' | 'abstained';
  dependence: 'established' | 'unknown' | 'circular' | 'over-budget'; independentOrigins: number | null;
  scorePerMillion: number | null; calibration: string | null; limitations: string;
  assessorKind: 'human' | 'automated'; actingSubject: string;
}

const COVERAGE = { complete: 'CompleteCoverage', partial: 'PartialCoverage', incomplete: 'IncompleteCoverage' } as const;
const SUPPORT = { supported: 'Supported', contradicted: 'Contradicted', 'material-conflict': 'MaterialConflict',
  insufficient: 'InsufficientSupport', abstained: 'Abstained' } as const;
const DEPENDENCE = { established: 'DependenceEstablished', unknown: 'DependenceUnknown',
  circular: 'DependenceCircular', 'over-budget': 'DependenceOverBudget' } as const;

/** Record one immutable assessment; guards the exact claim head and source-assessment heads. */
export async function recordAssessment(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  digest: string, input: AssessmentRecordInput): Promise<GraphReceipt> {
  const { scope, action } = ADMISSIONS['claim-assess'];
  if (admission.action !== action || admission.scope !== scope || admission.requestDigest !== digest
    || admission.actingSubject !== input.actingSubject) {
    throw new IdempotencyConflict('assessment admission differs from intent');
  }
  const assessment = ID + Bun.randomUUIDv7();
  return run(env, { family: 'claim-assess', admission, digest, results: ['assessment'],
    profile: 'assessment-v1', event: 'rv:ClaimAssessedEvent',
    validations: [{ shape: 'assessment', focus: assessment }],
    revisions: `${iri(assessment)} a rv:ClaimAssessment, rv:RevisionAnchor ; rv:component ${iri(input.claim)} ;
      rv:claimRevision ${iri(input.claimRevision)} ; rv:evidenceSetRevision ${iri(input.evidenceSetRevision)} ;
      ${input.sourceAssessments.map(item => `rv:sourceAssessment ${iri(item)} ;`).join(' ')}
      rv:policyRevision ${iri(input.policyRevision)} ; rv:evaluationContext ${iri(input.evaluationContext)} ;
      rv:coverage rv:${COVERAGE[input.coverage]} ; rv:supportResult rv:${SUPPORT[input.support]} ;
      rv:dependenceStatus rv:${DEPENDENCE[input.dependence]} ;
      ${input.independentOrigins === null ? '' : `rv:independentOriginCount ${integer(input.independentOrigins)} ;`}
      rv:method ${iri(input.method)} ; rv:methodRevision ${iri(input.methodRevision)} ;
      ${input.scorePerMillion === null ? '' : `rv:scorePerMillion ${integer(input.scorePerMillion)} ;
        rv:scoreCalibration rv:${input.calibration ? 'CalibratedScore' : 'UncalibratedScore'} ;`}
      ${input.calibration ? `rv:calibration ${iri(input.calibration)} ;` : ''}
      rv:limitations ${lit(input.limitations)} ; rv:assessor ${iri(input.actingSubject)} ;
      rv:assessorKind rv:${input.assessorKind === 'human' ? 'HumanAssessor' : 'AutomatedAssessor'} ;
      rv:assessedAt ${dateTime(new Date().toISOString())} ;
      rv:modelRevision ${iri(ASSESSMENT_PROFILE)} ; rv:shapeRevision ${iri(ASSESSMENT_PROFILE)} ;`,
    receiptFields: `rv:assessment ${iri(assessment)} ;`,
    where: `GRAPH ${iri(GRAPHS.current)} { ${iri(input.claim)} a rv:Claim ; rv:claimHead ${iri(input.claimRevision)} }
      ${input.sourceAssessments.map((item, index) => `GRAPH ${iri(GRAPHS.current)} {
        ?reliability${index} rv:reliabilityHead ${iri(item)} }`).join('\n')}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(assessment)} ?ap ?ao } }` });
}

export interface AssessmentRecord extends AssessmentRecordInput {
  assessment: string; assessedAt: string; dataEpoch: string; sequence: string;
}

const inverse = <T extends Record<string, string>>(map: T) =>
  Object.fromEntries(Object.entries(map).map(([key, value]) => [value, key])) as Record<string, keyof T>;

export async function readAssessment(env: WorkActivationEnvironment, assessment: string): Promise<AssessmentRecord | null> {
  const response = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?claim ?claimRevision ?evidence ?source
    ?method ?methodRevision ?policy ?context ?coverage ?support ?dependence ?origins ?score ?calibration
    ?limitations ?assessor ?kind ?assessedAt ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(assessment)} a rv:ClaimAssessment ; rv:component ?claim ;
      rv:claimRevision ?claimRevision ; rv:evidenceSetRevision ?evidence ; rv:method ?method ;
      rv:methodRevision ?methodRevision ; rv:policyRevision ?policy ; rv:evaluationContext ?context ;
      rv:coverage ?coverage ; rv:supportResult ?support ; rv:dependenceStatus ?dependence ;
      rv:limitations ?limitations ; rv:assessor ?assessor ; rv:assessorKind ?kind ;
      rv:assessedAt ?assessedAt ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(assessment)} rv:sourceAssessment ?source }
      OPTIONAL { ${iri(assessment)} rv:independentOriginCount ?origins }
      OPTIONAL { ${iri(assessment)} rv:scorePerMillion ?score }
      OPTIONAL { ${iri(assessment)} rv:calibration ?calibration } }
  }`);
  const rows = response.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  return { assessment, claim: row.claim!.value, claimRevision: row.claimRevision!.value,
    evidenceSetRevision: row.evidence!.value,
    sourceAssessments: [...new Set(rows.flatMap(item => item.source ? [item.source.value] : []))].sort(),
    method: row.method!.value, methodRevision: row.methodRevision!.value, policyRevision: row.policy!.value,
    evaluationContext: row.context!.value, coverage: inverse(COVERAGE)[local(row.coverage!.value)]!,
    support: inverse(SUPPORT)[local(row.support!.value)]!, dependence: inverse(DEPENDENCE)[local(row.dependence!.value)]!,
    independentOrigins: row.origins ? Number(row.origins.value) : null,
    scorePerMillion: row.score ? Number(row.score.value) : null, calibration: row.calibration?.value ?? null,
    limitations: row.limitations!.value, actingSubject: row.assessor!.value,
    assessorKind: local(row.kind!.value) === 'HumanAssessor' ? 'human' : 'automated',
    assessedAt: row.assessedAt!.value, dataEpoch: row.epoch!.value, sequence: row.sequence!.value };
}

/** Current graph heads for pinned graph dependencies plus the observed dataset position. */
export async function graphHeads(env: WorkActivationEnvironment, dependencies: readonly {
  kind: string; reference: string }[]): Promise<{ heads: Map<string, string | null>;
    position: { datasetId: 'product'; dataEpoch: string; sequence: string } }> {
  const predicate = (kind: string) => kind === 'claim' ? 'rv:claimHead' : 'rv:reliabilityHead';
  const values = dependencies.filter(item => item.kind === 'claim' || item.kind === 'source-assessment')
    .map(item => `(${iri(item.reference)} ${predicate(item.kind)})`);
  const response = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?reference ?head ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence }
    ${values.length ? `OPTIONAL { VALUES (?reference ?predicate) { ${values.join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?reference ?predicate ?head } }` : ''}
  }`);
  const rows = response.results?.bindings ?? [];
  if (!rows.length) throw new PendingActivation('graph position is unavailable');
  const heads = new Map<string, string | null>();
  for (const item of dependencies) if (item.kind === 'claim' || item.kind === 'source-assessment') heads.set(item.reference, null);
  for (const row of rows) if (row.reference && row.head) heads.set(row.reference.value, row.head.value);
  return { heads, position: { datasetId: 'product', dataEpoch: rows[0]!.epoch!.value,
    sequence: rows[0]!.sequence!.value } };
}
