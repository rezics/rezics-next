import { profileRegistry } from '../../../../../packages/model/src/generated/profiles.ts';
import type { CommandValidation } from '../../infrastructure/fuseki.ts';
import type { ClaimedAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';

const PROFILE_ID = 'content-search-eligibility-v1';
const PROFILE = 'https://rezics.com/definition/content-search-eligibility-v1';
const DECISION_SHAPE = `${PROFILE}/decision-shape`;
const VARIANT_PROFILE_ID = 'content-publication-v1';
const VARIANT_SHAPE = 'https://rezics.com/definition/content-publication-v1/variant-shape';
const NONE = 'urn:rezics:none';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export class InvalidContentEligibility extends Error {}
export class ContentEligibilityDenied extends Error {}
export class ContentEligibilityUnavailable extends Error {}
export class ContentEligibilityStale extends Error {}
export class ContentEligibilityConflict extends Error {}
export class ContentEligibilityPending extends Error {}
export class ContentEligibilityProfileUnavailable extends Error {}

export interface ContentSearchEligibilityInput {
  resourceId: string;
  variantId: string;
  publicationDecision: string;
  expectedEligibilityHead: string | null;
  actingSubject: string;
  rightsBasis: 'original-contribution';
  disclosure: 'public';
}

export interface ContentSearchEligibilityResult {
  outcome: 'succeeded' | 'stale';
  decision: string | null;
  receipt: string;
  graphDataEpoch: string;
  graphSequence: string;
  replayed: boolean;
}

interface EligibilityReceipt extends Omit<ContentSearchEligibilityResult, 'replayed'> {
  digest: string;
  admissionId: string;
  authorityEpoch: string;
  scope: string;
  actingSubject: string;
  resourceId: string;
  variantId: string;
  publicationDecision: string;
  expectedHead: string | null;
}

function checkedInput(input: ContentSearchEligibilityInput): void {
  for (const value of [input.resourceId, input.variantId, input.publicationDecision,
    input.actingSubject, ...(input.expectedEligibilityHead ? [input.expectedEligibilityHead] : [])]) {
    try { iri(value); } catch { throw new InvalidContentEligibility('invalid Content eligibility IRI'); }
  }
  if (input.resourceId === input.variantId || input.rightsBasis !== 'original-contribution'
    || input.disclosure !== 'public') {
    throw new InvalidContentEligibility('explicit public original-contribution decision required');
  }
}

export function contentSearchEligibilityDigest(input: ContentSearchEligibilityInput): string {
  checkedInput(input);
  return hash(JSON.stringify({ family: PROFILE_ID, ...input }));
}

export function contentSearchEligibilityReceiptIri(admissionId: string): string {
  if (!UUID.test(admissionId)) throw new InvalidContentEligibility('invalid eligibility admission ID');
  return `urn:rezics:receipt:${hash(`${admissionId}\0content-search-eligibility`)}`;
}

export function contentSearchEligibilityDecisionIri(admissionId: string): string {
  if (!UUID.test(admissionId)) throw new InvalidContentEligibility('invalid eligibility admission ID');
  return `urn:rezics:content-search-eligibility:${hash(admissionId)}`;
}

function expected(input: ContentSearchEligibilityInput): string {
  return iri(input.expectedEligibilityHead ?? NONE);
}

function admissionMatches(admission: ClaimedAdmission, input: ContentSearchEligibilityInput,
  digest: string): void {
  if (!UUID.test(admission.id) || !DECIMAL.test(admission.authorityEpoch)
    || admission.action !== 'content.search-eligibility'
    || admission.scope !== `content:search-eligibility:${input.variantId}`
    || admission.actingSubject !== input.actingSubject
    || admission.requestDigest !== digest) {
    throw new ContentEligibilityDenied('eligibility admission does not match exact reviewer intent');
  }
}

async function validations(env: WorkActivationEnvironment, input: ContentSearchEligibilityInput,
  decision: string): Promise<CommandValidation[]> {
  const registry = profileRegistry as Record<string, { sha256: string; shapes: readonly string[] }>;
  const profile = registry[PROFILE_ID];
  const variant = registry[VARIANT_PROFILE_ID];
  if (!profile || !profile.shapes.includes(DECISION_SHAPE)
    || !variant || !variant.shapes.includes(VARIANT_SHAPE)) {
    throw new ContentEligibilityProfileUnavailable('reviewed eligibility or Content variant shape is unavailable');
  }
  const health = await env.fuseki.commandHealth();
  if (health.profiles[PROFILE_ID] !== profile.sha256
    || health.profiles[VARIANT_PROFILE_ID] !== variant.sha256) {
    throw new ContentEligibilityProfileUnavailable('Fuseki eligibility or Content variant profile differs');
  }
  return [{ profile: VARIANT_PROFILE_ID, sha256: variant.sha256, shape: VARIANT_SHAPE,
    focus: [input.variantId], graphs: [GRAPHS.current] },
  { profile: PROFILE_ID, sha256: profile.sha256, shape: DECISION_SHAPE,
    focus: [decision], graphs: [GRAPHS.revisions] }];
}

async function readReceipt(env: WorkActivationEnvironment, admissionId: string): Promise<EligibilityReceipt | null> {
  const receipt = contentSearchEligibilityReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?reason ?digest ?id ?authority ?scope ?actor ?resource ?variant
    ?publication ?expected ?decision ?rights ?disclosure ?epoch ?sequence WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:outcome ?outcome ; rv:requestDigest ?digest ; rv:admissionId ?id ;
        rv:authorityEpoch ?authority ; rv:admittedScope ?scope ;
        rv:actingSubject ?actor ; rv:resource ?resource ; rv:variant ?variant ;
        rv:publicationDecision ?publication ; rv:expectedHead ?expected ;
        rv:rightsBasis ?rights ; rv:disclosure ?disclosure ;
        rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(receipt)} rv:reason ?reason }
        OPTIONAL { ${iri(receipt)} rv:eligibilityDecision ?decision }
      }
    }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0];
  const value = (key: string) => row?.[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` && value('reason') === `${RV}StaleHead` ? 'stale' : null;
  if (rows.length !== 1 || !outcome || !value('digest') || !value('id')
    || !DECIMAL.test(value('authority') ?? '') || !value('scope') || !value('actor')
    || !value('resource') || !value('variant') || !value('publication')
    || !value('expected') || !value('epoch') || !DECIMAL.test(value('sequence') ?? '')
    || value('rights') !== `${RV}OriginalContribution` || value('disclosure') !== `${RV}Public`
    || (outcome === 'succeeded' && (!value('decision') || value('reason')))
    || (outcome === 'stale' && value('decision'))) {
    throw new ContentEligibilityConflict('eligibility receipt is incomplete');
  }
  return { outcome, receipt, decision: value('decision') ?? null,
    graphDataEpoch: value('epoch')!, graphSequence: value('sequence')!,
    digest: value('digest')!, admissionId: value('id')!, authorityEpoch: value('authority')!,
    scope: value('scope')!, actingSubject: value('actor')!, resourceId: value('resource')!,
    variantId: value('variant')!, publicationDecision: value('publication')!,
    expectedHead: value('expected') === NONE ? null : value('expected')! };
}

function checkedReceipt(receipt: EligibilityReceipt, env: WorkActivationEnvironment,
  admission: ClaimedAdmission, input: ContentSearchEligibilityInput,
  digest: string): ContentSearchEligibilityResult {
  if (receipt.digest !== digest || receipt.admissionId !== admission.id
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope
    || receipt.actingSubject !== input.actingSubject || receipt.resourceId !== input.resourceId
    || receipt.variantId !== input.variantId || receipt.publicationDecision !== input.publicationDecision
    || receipt.expectedHead !== input.expectedEligibilityHead
    || receipt.graphDataEpoch !== env.lineage.dataEpoch
    || (receipt.outcome === 'succeeded'
      && receipt.decision !== contentSearchEligibilityDecisionIri(admission.id))) {
    throw new ContentEligibilityConflict('eligibility receipt differs from exact admitted request');
  }
  return { outcome: receipt.outcome, decision: receipt.decision, receipt: receipt.receipt,
    graphDataEpoch: receipt.graphDataEpoch, graphSequence: receipt.graphSequence, replayed: true };
}

async function currentHead(env: WorkActivationEnvironment,
  input: ContentSearchEligibilityInput): Promise<string | null> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.resourceId)} a schema:CreativeWork .
        ${iri(input.variantId)} a rv:ContentVariant ; rv:resource ${iri(input.resourceId)} ;
          rv:contentPublicationHead ${iri(input.publicationDecision)} .
        OPTIONAL { ${iri(input.variantId)} rv:publicSearchEligibilityHead ?head }
      }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(input.publicationDecision)}
        a rv:ContentPublicationDecision, rv:RevisionAnchor ;
        rv:component ${iri(input.variantId)} ; rv:resource ${iri(input.resourceId)} ;
        rv:modelRevision ${iri('https://rezics.com/definition/content-publication-v1')} . }
    }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1) throw new ContentEligibilityUnavailable('exact active Content publication is unavailable');
  return rows[0]?.head?.value ?? null;
}

function receiptTriples(env: WorkActivationEnvironment, admission: ClaimedAdmission,
  input: ContentSearchEligibilityInput, digest: string, outcome: 'succeeded' | 'stale',
  decision: string): string {
  return `a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
    rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
    rv:admittedScope ${lit(admission.scope)} ; rv:actingSubject ${iri(input.actingSubject)} ;
    rv:resource ${iri(input.resourceId)} ; rv:variant ${iri(input.variantId)} ;
    rv:publicationDecision ${iri(input.publicationDecision)} ; rv:expectedHead ${expected(input)} ;
    rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public ;
    ${outcome === 'succeeded' ? `rv:eligibilityDecision ${iri(decision)} ; rv:outcome rv:Succeeded ;`
      : 'rv:reason rv:StaleHead ; rv:outcome rv:Cancelled ;'}
    rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next`;
}

/** The update is guarded by the exact publication and expected eligibility head. */
export function buildContentEligibilityUpdate(env: WorkActivationEnvironment,
  admission: ClaimedAdmission, input: ContentSearchEligibilityInput): string {
  const digest = contentSearchEligibilityDigest(input);
  const receipt = contentSearchEligibilityReceiptIri(admission.id);
  const decision = contentSearchEligibilityDecisionIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0eligibility`)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0eligibility`)}`;
  return `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> DELETE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
    GRAPH ${iri(GRAPHS.current)} { ${iri(input.variantId)} rv:publicSearchEligibilityHead ?prior }
  } INSERT {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
    GRAPH ${iri(GRAPHS.current)} { ${iri(input.variantId)} rv:publicSearchEligibilityHead ${iri(decision)} }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} a rv:ContentSearchEligibilityDecision, rv:RevisionAnchor ;
      rv:component ${iri(input.variantId)} ; rv:variant ${iri(input.variantId)} ;
      rv:resource ${iri(input.resourceId)} ;
      rv:publicationDecision ${iri(input.publicationDecision)} ;
      rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public ;
      rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
      rv:admittedScope ${lit(admission.scope)} ; rv:actingSubject ${iri(input.actingSubject)} ;
      rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:sequence ?next . }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ${receiptTriples(env, admission, input, digest, 'succeeded', decision)} . }
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
      rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
      rv:eventCount 1 ; rv:event ${iri(event)} .
      ${iri(event)} a rv:ContentSearchEligibilityEvent ; rv:ordinal 0 ;
        rv:action "content.search-eligibility" ; rv:receipt ${iri(receipt)} ;
        rv:variant ${iri(input.variantId)} ; rv:publicationDecision ${iri(input.publicationDecision)} . }
  } WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
    GRAPH ${iri(GRAPHS.current)} { ${iri(input.resourceId)} a schema:CreativeWork .
      ${iri(input.variantId)} a rv:ContentVariant ; rv:resource ${iri(input.resourceId)} ;
        rv:contentPublicationHead ${iri(input.publicationDecision)} .
      OPTIONAL { ${iri(input.variantId)} rv:publicSearchEligibilityHead ?prior }
    }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(input.publicationDecision)}
      a rv:ContentPublicationDecision, rv:RevisionAnchor ;
      rv:component ${iri(input.variantId)} ; rv:resource ${iri(input.resourceId)} ;
      rv:modelRevision ${iri('https://rezics.com/definition/content-publication-v1')} . }
    FILTER(COALESCE(?prior, ${iri(NONE)}) = ${expected(input)})
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} ?p ?o } }
    BIND(?n + 1 AS ?next)
  }`;
}

function staleUpdate(env: WorkActivationEnvironment, admission: ClaimedAdmission,
  input: ContentSearchEligibilityInput, digest: string): string {
  const receipt = contentSearchEligibilityReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0stale`)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0stale`)}`;
  return `PREFIX rv: <${RV}> DELETE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
  } INSERT {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ${receiptTriples(env, admission, input,
      digest, 'stale', contentSearchEligibilityDecisionIri(admission.id))} . }
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
      rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
      rv:eventCount 1 ; rv:event ${iri(event)} .
      ${iri(event)} a rv:ContentSearchEligibilityRejectedEvent ; rv:ordinal 0 ;
        rv:action "content.search-eligibility" ; rv:receipt ${iri(receipt)} ;
        rv:variant ${iri(input.variantId)} . }
  } WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
    GRAPH ${iri(GRAPHS.current)} { ${iri(input.variantId)} rv:resource ${iri(input.resourceId)} ;
      rv:contentPublicationHead ${iri(input.publicationDecision)} .
      OPTIONAL { ${iri(input.variantId)} rv:publicSearchEligibilityHead ?prior }
    }
    FILTER(COALESCE(?prior, ${iri(NONE)}) != ${expected(input)})
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
    BIND(?n + 1 AS ?next)
  }`;
}

/** Caller must pass the fresh result of AccessAdmissionRegistry.claim for the exact reviewer request. */
export async function selectPublicContentSearch(env: WorkActivationEnvironment,
  admission: ClaimedAdmission, input: ContentSearchEligibilityInput): Promise<ContentSearchEligibilityResult> {
  const digest = contentSearchEligibilityDigest(input);
  admissionMatches(admission, input, digest);
  const prior = await readReceipt(env, admission.id);
  if (prior) {
    const checked = checkedReceipt(prior, env, admission, input, digest);
    if (checked.outcome === 'stale') throw new ContentEligibilityStale('eligibility head is stale');
    return checked;
  }
  if (!admission.dispatchEligible || admission.state !== 'claimed'
    || !Number.isFinite(Date.parse(admission.expiresAt))
    || Date.parse(admission.expiresAt) <= Date.now()) {
    throw new ContentEligibilityDenied('eligibility admission is ineligible or expired');
  }
  const decision = contentSearchEligibilityDecisionIri(admission.id);
  const candidate = await validations(env, input, decision);
  const head = await currentHead(env, input);
  const receipt = contentSearchEligibilityReceiptIri(admission.id);
  if (head !== input.expectedEligibilityHead) {
    try { await env.fuseki.commandWithReceipt({ receipt, digest,
      update: staleUpdate(env, admission, input, digest), validations: [], deadlineMs: 10_000 }); }
    catch { /* resolve the exact receipt below */ }
    const terminal = await readReceipt(env, admission.id);
    if (terminal) {
      const checked = checkedReceipt(terminal, env, admission, input, digest);
      if (checked.outcome === 'stale') throw new ContentEligibilityStale('eligibility head is stale');
      return checked;
    }
    throw new ContentEligibilityPending('stale eligibility outcome is unknown');
  }
  let commandStatus: string | undefined;
  try {
    const result = await env.fuseki.commandWithReceipt({ receipt, digest,
      update: buildContentEligibilityUpdate(env, admission, input),
      validations: candidate, deadlineMs: 10_000 });
    commandStatus = result.status;
  } catch { /* transport outcome is resolved only from this graph receipt */ }
  const committed = await readReceipt(env, admission.id);
  if (committed) {
    const checked = checkedReceipt(committed, env, admission, input, digest);
    if (checked.outcome === 'stale') throw new ContentEligibilityStale('eligibility head is stale');
    return { ...checked, replayed: false };
  }
  if (commandStatus === 'guard-unmatched') {
    const now = await currentHead(env, input);
    if (now !== input.expectedEligibilityHead) {
      try { await env.fuseki.commandWithReceipt({ receipt, digest,
        update: staleUpdate(env, admission, input, digest), validations: [], deadlineMs: 10_000 }); }
      catch { /* resolve below */ }
      const terminal = await readReceipt(env, admission.id);
      if (terminal) {
        const checked = checkedReceipt(terminal, env, admission, input, digest);
        if (checked.outcome === 'stale') throw new ContentEligibilityStale('eligibility head is stale');
        return checked;
      }
    }
  }
  if (commandStatus === 'invalid' || commandStatus === 'unknown-profile') {
    throw new ContentEligibilityProfileUnavailable(`eligibility command ${commandStatus}`);
  }
  if (commandStatus === 'conflict') throw new ContentEligibilityConflict('eligibility receipt key conflicts');
  throw new ContentEligibilityPending('eligibility graph receipt is unavailable');
}
