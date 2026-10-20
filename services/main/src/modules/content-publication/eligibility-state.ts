import type { SparqlResult } from '../../infrastructure/fuseki.ts';
import { profileRegistry } from '../../../../../packages/model/src/generated/profiles.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { contentSearchEligibilityDecisionIri, contentSearchEligibilityDigest,
  contentSearchEligibilityReceiptIri, RETAINED_DIGEST_FORMS, type ContentSearchEligibilityInput }
  from './eligibility.ts';

const NONE = 'urn:rezics:none';
const REVISION_PREFIX = 'urn:rezics:content:revision:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const CONTENT_ELIGIBILITY_STATE_PAGE = 64;
export const CONTENT_ELIGIBILITY_STATE_MAX = 50_000;

type Row = NonNullable<NonNullable<SparqlResult['results']>['bindings']>[number];
export type ContentEligibilityRdfTerm = NonNullable<Row[string]>;

export class ContentEligibilityStateUnavailable extends Error {}

export interface ContentEligibilityOwnerPosition {
  dataEpoch: string;
  sequence: string;
}

export interface ContentEligibilitySnapshot {
  dataEpoch: string;
  routingEpoch: string;
  sequence: string;
}

export interface ContentEligibilityStateOptions {
  maxUnits?: number;
  pageSize?: number;
  expectedGraphSequence?: string;
  read?: (step: string, sparql: string) => Promise<SparqlResult>;
}

export interface ContentEligibilityPublicationProof {
  id: string;
  variant: string;
  resource: string;
  revision: string;
  digest: string;
  preparationId?: string;
  ownerDataEpoch: string;
  ownerSequence: string;
  graphSequence: string;
}

export interface ContentEligibilityDecisionProof {
  id: string;
  variant: string;
  resource: string;
  publicationDecision: string;
  graphSequence: string;
  rightsBasis: string;
  withdrawnEligibilityHead?: string;
  sourceReceiptId?: string;
  requestDigest?: string;
}

export interface RetainedContentEligibilitySource {
  eligibility: ContentEligibilityDecisionProof & { sourceReceiptId: string; requestDigest: string };
  publication: ContentEligibilityPublicationProof & { preparationId: string };
  revisionId: string;
}

export type ContentEligibilityState =
  | (ContentEligibilityPublicationProof & { kind: 'public-current'; eligibilityDecision: string;
    rightsBasis: string })
  | (ContentEligibilityPublicationProof & { kind: 'closed-absent' })
  | (ContentEligibilityPublicationProof & { kind: 'closed-withdrawn'; eligibilityDecision: string; withdrawnEligibilityHead: string })
  | (ContentEligibilityPublicationProof & { kind: 'closed-superseded-approval'; eligibilityDecision: string;
    approvedPublicationDecision: string })
  | { kind: 'unresolved'; variant: string; reason: string };

export interface ContentEligibilityStateEvidence {
  snapshot: ContentEligibilitySnapshot;
  owner: ContentEligibilityOwnerPosition;
  variant: string;
  resourceCount: number;
  resource?: ContentEligibilityRdfTerm;
  publicationCount: number;
  publication?: ContentEligibilityRdfTerm;
  eligibilityCount: number;
  eligibility?: ContentEligibilityRdfTerm;
  currentPublication?: ContentEligibilityPublicationProof;
  eligibilityProof?: ContentEligibilityDecisionProof;
  approvedPublication?: ContentEligibilityPublicationProof;
  restoreOpen: boolean;
}

function bindingValue(row: Row | undefined, key: string): string | undefined {
  return row?.[key]?.value;
}

function count(row: Row, field: string): number | undefined {
  const raw = bindingValue(row, `${field}Count`);
  if (!raw || !/^(0|[1-9][0-9]*)$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function exact(row: Row, field: string, kind: 'uri' | 'literal'): string | undefined {
  if (count(row, field) !== 1) return undefined;
  const term = row[field];
  if (!term || (kind === 'uri' ? term.type !== 'uri' : term.type === 'uri')) return undefined;
  return term.value;
}

function optionalExact(row: Row, field: string, kind: 'uri' | 'literal'): string | undefined | null {
  const cardinality = count(row, field);
  if (cardinality === 0) return null;
  if (cardinality !== 1) return undefined;
  const term = row[field];
  if (!term || (kind === 'uri' ? term.type !== 'uri' : term.type === 'uri')) return undefined;
  return term.value;
}

function isIri(value: string | undefined): value is string {
  if (!value) return false;
  try { iri(value); return true; } catch { return false; }
}

function publicationDecisionIri(admissionId: string): string {
  return `urn:rezics:content-publication:${hash(admissionId)}`;
}

function publicationReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0publish-content-revision`)}`;
}

function unresolved(variant: string, reason: string): ContentEligibilityState {
  return { kind: 'unresolved', variant, reason };
}

/** Classify one current Content variant from its unfiltered owner records. */
export function classifyContentEligibilityState(
  evidence: ContentEligibilityStateEvidence,
): ContentEligibilityState {
  const { variant, snapshot, owner } = evidence;
  if (!evidence.restoreOpen) return unresolved(variant, 'graph restore gate is closed');
  if (!isIri(variant) || !DECIMAL.test(snapshot.sequence)
    || owner.dataEpoch.length === 0 || !DECIMAL.test(owner.sequence)) {
    return unresolved(variant, 'owner snapshot is malformed');
  }
  if (evidence.resourceCount !== 1 || !evidence.resource || evidence.resource.type !== 'uri'
    || evidence.publicationCount !== 1 || !evidence.publication || evidence.publication.type !== 'uri') {
    return unresolved(variant, 'current publication or resource head is ambiguous');
  }
  const resource = evidence.resource.value;
  const publication = evidence.publication.value;
  if (!isIri(resource) || !isIri(publication)) {
    return unresolved(variant, 'current publication or resource head is not an IRI');
  }
  const current = evidence.currentPublication;
  if (!current || current.id !== publication || current.variant !== variant || current.resource !== resource) {
    return unresolved(variant, 'current publication owner proof is absent or mismatched');
  }
  if (current.ownerDataEpoch !== owner.dataEpoch
    || BigInt(current.ownerSequence) > BigInt(owner.sequence)) {
    return unresolved(variant, 'current publication is outside the Content owner position');
  }
  if (evidence.eligibilityCount === 0) return { kind: 'closed-absent', ...current };
  if (evidence.eligibilityCount !== 1 || !evidence.eligibility || evidence.eligibility.type !== 'uri'
    || !isIri(evidence.eligibility.value)) {
    return unresolved(variant, 'eligibility head cardinality is invalid');
  }
  const eligibility = evidence.eligibility.value;
  const proof = evidence.eligibilityProof;
  if (!proof || proof.id !== eligibility || proof.variant !== variant || proof.resource !== resource) {
    return unresolved(variant, 'eligibility decision or succeeded owner receipt is unproven');
  }
  const approved = evidence.approvedPublication;
  if (!approved || approved.id !== proof.publicationDecision || approved.variant !== variant
    || approved.resource !== resource || approved.ownerDataEpoch !== owner.dataEpoch) {
    return unresolved(variant, 'eligibility approval publication proof is absent or mismatched');
  }
  if (BigInt(proof.graphSequence) <= BigInt(approved.graphSequence)) {
    return unresolved(variant, 'eligibility decision does not follow its approved publication');
  }
  if (proof.withdrawnEligibilityHead) return { kind: 'closed-withdrawn', ...current,
    eligibilityDecision: eligibility, withdrawnEligibilityHead: proof.withdrawnEligibilityHead };
  if (proof.publicationDecision === publication) {
    if (BigInt(proof.graphSequence) <= BigInt(current.graphSequence)) {
      return unresolved(variant, 'current eligibility decision does not follow the current publication');
    }
    return { kind: 'public-current', ...current, eligibilityDecision: eligibility,
      rightsBasis: proof.rightsBasis };
  }
  if (BigInt(approved.graphSequence) < BigInt(current.graphSequence)
    && BigInt(proof.graphSequence) < BigInt(current.graphSequence)) {
    return { kind: 'closed-superseded-approval', ...current,
      eligibilityDecision: eligibility, approvedPublicationDecision: approved.id };
  }
  return unresolved(variant, 'eligibility head does not approve the current publication or a proved predecessor');
}

interface FieldSpec {
  variable: string;
  predicate: string;
}

function aggregateFields(fields: readonly FieldSpec[]): string {
  return fields.map(({ variable }) =>
    `(COUNT(DISTINCT ?${variable}) AS ?${variable}Count) (SAMPLE(?${variable}) AS ?${variable})`).join('\n');
}

function optionalFields(graph: string, subject: string, fields: readonly FieldSpec[],
  decision?: 'publication' | 'eligibility'): string {
  return fields.map(({ variable, predicate }) => `OPTIONAL {
    GRAPH ${iri(graph)} { ${subject} ${decision ? `rv:${decision}Decision ?${decision} ;` : ''}
      ${predicate} ?${variable} } }`).join('\n');
}

const publicationDecisionFields: readonly FieldSpec[] = [
  { variable: 'dComponent', predicate: 'rv:component' },
  { variable: 'dResource', predicate: 'rv:resource' },
  { variable: 'dRevision', predicate: 'rv:contentRevision' },
  { variable: 'dDigest', predicate: 'rv:byteDigest' },
  { variable: 'dOwnerEpoch', predicate: 'rv:ownerDataEpoch' },
  { variable: 'dOwnerSequence', predicate: 'rv:ownerSequence' },
  { variable: 'dDataEpoch', predicate: 'rv:dataEpoch' },
  { variable: 'dSequence', predicate: 'rv:sequence' },
  { variable: 'dModel', predicate: 'rv:modelRevision' },
  { variable: 'dShape', predicate: 'rv:shapeRevision' },
  { variable: 'dDataset', predicate: 'rv:datasetId' },
  { variable: 'dPreparation', predicate: 'rv:contentPreparation' },
];

const publicationReceiptFields: readonly FieldSpec[] = [
  { variable: 'rOutcome', predicate: 'rv:outcome' },
  { variable: 'rReason', predicate: 'rv:reason' },
  { variable: 'rRequestDigest', predicate: 'rv:requestDigest' },
  { variable: 'rAdmissionId', predicate: 'rv:admissionId' },
  { variable: 'rAuthorityEpoch', predicate: 'rv:authorityEpoch' },
  { variable: 'rScope', predicate: 'rv:admittedScope' },
  { variable: 'rPreparation', predicate: 'rv:contentPreparation' },
  { variable: 'rRevision', predicate: 'rv:contentRevision' },
  { variable: 'rVariant', predicate: 'rv:variant' },
  { variable: 'rResource', predicate: 'rv:resource' },
  { variable: 'rByteDigest', predicate: 'rv:byteDigest' },
  { variable: 'rOwnerEpoch', predicate: 'rv:ownerDataEpoch' },
  { variable: 'rOwnerSequence', predicate: 'rv:ownerSequence' },
  { variable: 'rExpectedHead', predicate: 'rv:expectedHead' },
  { variable: 'rDataset', predicate: 'rv:datasetId' },
  { variable: 'rDataEpoch', predicate: 'rv:dataEpoch' },
  { variable: 'rSequence', predicate: 'rv:sequence' },
  { variable: 'rDecision', predicate: 'rv:publicationDecision' },
];

const eligibilityDecisionFields: readonly FieldSpec[] = [
  { variable: 'dWithdrawn', predicate: 'rv:withdrawnEligibilityHead' },
  { variable: 'dComponent', predicate: 'rv:component' },
  { variable: 'dVariant', predicate: 'rv:variant' },
  { variable: 'dResource', predicate: 'rv:resource' },
  { variable: 'dPublication', predicate: 'rv:publicationDecision' },
  { variable: 'dRightsBasis', predicate: 'rv:rightsBasis' },
  { variable: 'dAssessment', predicate: 'rv:rightsAssessment' },
  { variable: 'dDisclosure', predicate: 'rv:disclosure' },
  { variable: 'dAdmissionId', predicate: 'rv:admissionId' },
  { variable: 'dAuthorityEpoch', predicate: 'rv:authorityEpoch' },
  { variable: 'dScope', predicate: 'rv:admittedScope' },
  { variable: 'dActor', predicate: 'rv:actingSubject' },
  { variable: 'dModel', predicate: 'rv:modelRevision' },
  { variable: 'dShape', predicate: 'rv:shapeRevision' },
  { variable: 'dDataset', predicate: 'rv:datasetId' },
  { variable: 'dDataEpoch', predicate: 'rv:dataEpoch' },
  { variable: 'dSequence', predicate: 'rv:sequence' },
];

const eligibilityReceiptFields: readonly FieldSpec[] = [
  { variable: 'rWithdrawn', predicate: 'rv:withdrawnEligibilityHead' },
  { variable: 'rOutcome', predicate: 'rv:outcome' },
  { variable: 'rReason', predicate: 'rv:reason' },
  { variable: 'rRequestDigest', predicate: 'rv:requestDigest' },
  { variable: 'rAdmissionId', predicate: 'rv:admissionId' },
  { variable: 'rAuthorityEpoch', predicate: 'rv:authorityEpoch' },
  { variable: 'rScope', predicate: 'rv:admittedScope' },
  { variable: 'rActor', predicate: 'rv:actingSubject' },
  { variable: 'rResource', predicate: 'rv:resource' },
  { variable: 'rVariant', predicate: 'rv:variant' },
  { variable: 'rPublication', predicate: 'rv:publicationDecision' },
  { variable: 'rExpectedHead', predicate: 'rv:expectedHead' },
  { variable: 'rRightsBasis', predicate: 'rv:rightsBasis' },
  { variable: 'rAssessment', predicate: 'rv:rightsAssessment' },
  { variable: 'rDisclosure', predicate: 'rv:disclosure' },
  { variable: 'rDataset', predicate: 'rv:datasetId' },
  { variable: 'rDataEpoch', predicate: 'rv:dataEpoch' },
  { variable: 'rSequence', predicate: 'rv:sequence' },
  { variable: 'rEligibility', predicate: 'rv:eligibilityDecision' },
];

function values(terms: readonly string[]): string {
  return terms.map(term => iri(term)).join(' ');
}

function controlPattern(snapshot: ContentEligibilitySnapshot): string {
  return `GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(snapshot.dataEpoch)} ;
    rv:routingEpoch ${lit(snapshot.routingEpoch)} ; rv:sequence ${snapshot.sequence} . }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`;
}

function candidatePageQuery(snapshot: ContentEligibilitySnapshot, after: string | undefined,
  pageSize: number, variants?: readonly string[]): string {
  const valuesPattern = variants ? `VALUES ?variant { ${values(variants)} }` : '';
  const afterPattern = after ? `FILTER(STR(?variant) > ${lit(after)})` : '';
  return `PREFIX rv: <${RV}> SELECT ?variant
    (COUNT(DISTINCT ?resource) AS ?resourceCount) (SAMPLE(?resource) AS ?resource)
    (COUNT(DISTINCT ?publication) AS ?publicationCount) (SAMPLE(?publication) AS ?publication)
    (COUNT(DISTINCT ?eligibility) AS ?eligibilityCount) (SAMPLE(?eligibility) AS ?eligibility)
    WHERE {
      ${controlPattern(snapshot)}
      ${valuesPattern}
      GRAPH ${iri(GRAPHS.current)} {
        ?variant a rv:ContentVariant .
        { { ?variant rv:contentPublicationHead ?candidate }
          UNION { ?variant rv:publicSearchEligibilityHead ?candidate } }
        OPTIONAL { ?variant rv:resource ?resource }
        OPTIONAL { ?variant rv:contentPublicationHead ?publication }
        OPTIONAL { ?variant rv:publicSearchEligibilityHead ?eligibility }
      }
      ${afterPattern}
    } GROUP BY ?variant ORDER BY STR(?variant) LIMIT ${pageSize}`;
}

function snapshotQuery(): string {
  return `PREFIX rv: <${RV}> SELECT ?epoch ?routing ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ;
      rv:routingEpoch ?routing ; rv:sequence ?sequence . }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
  }`;
}

function publicationProofQuery(ids: readonly string[]): string {
  return `PREFIX rv: <${RV}> SELECT ?publication
    (COUNT(DISTINCT ?decisionType) AS ?decisionTypeCount)
    (COUNT(DISTINCT ?anchorType) AS ?anchorTypeCount)
    (COUNT(DISTINCT ?receipt) AS ?receiptCount) (SAMPLE(?receipt) AS ?receipt)
    (COUNT(DISTINCT ?receiptType) AS ?receiptTypeCount)
    ${aggregateFields(publicationDecisionFields)} ${aggregateFields(publicationReceiptFields)}
    WHERE {
      VALUES ?publication { ${values(ids)} }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?publication a rv:ContentPublicationDecision }
        BIND(1 AS ?decisionType) }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?publication a rv:RevisionAnchor }
        BIND(1 AS ?anchorType) }
      ${optionalFields(GRAPHS.revisions, '?publication', publicationDecisionFields)}
      # Eligibility receipts also name this publication, but have no preparation.
      # Count every publication claimant before validating its proof fields:
      # an incomplete or failed duplicate must not disappear from the inventory.
      OPTIONAL { GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:publicationDecision ?publication ;
        rv:contentPreparation ?publicationPreparation . } }
      OPTIONAL { GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:publicationDecision ?publication ; a rv:OperationReceipt }
        BIND(1 AS ?receiptType) }
      ${optionalFields(GRAPHS.receipts, '?receipt', publicationReceiptFields, 'publication')}
    } GROUP BY ?publication`;
}

function eligibilityProofQuery(ids: readonly string[]): string {
  return `PREFIX rv: <${RV}> SELECT ?eligibility
    (COUNT(DISTINCT ?decisionType) AS ?decisionTypeCount)
    (COUNT(DISTINCT ?anchorType) AS ?anchorTypeCount)
    (COUNT(DISTINCT ?receipt) AS ?receiptCount) (SAMPLE(?receipt) AS ?receipt)
    (COUNT(DISTINCT ?receiptType) AS ?receiptTypeCount)
    ${aggregateFields(eligibilityDecisionFields)} ${aggregateFields(eligibilityReceiptFields)}
    WHERE {
      VALUES ?eligibility { ${values(ids)} }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?eligibility a ?decisionType .
        VALUES ?decisionType { rv:ContentSearchEligibilityDecision rv:ContentSearchEligibilityWithdrawalDecision } } }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?eligibility a rv:RevisionAnchor }
        BIND(1 AS ?anchorType) }
      ${optionalFields(GRAPHS.revisions, '?eligibility', eligibilityDecisionFields)}
      OPTIONAL { GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:eligibilityDecision ?eligibility } }
      OPTIONAL { GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:eligibilityDecision ?eligibility ; a rv:OperationReceipt }
        BIND(1 AS ?receiptType) }
      ${optionalFields(GRAPHS.receipts, '?receipt', eligibilityReceiptFields, 'eligibility')}
    } GROUP BY ?eligibility`;
}

function readSnapshot(env: WorkActivationEnvironment, row: Row | undefined,
  expected?: string): ContentEligibilitySnapshot {
  const epoch = row?.epoch?.value;
  const routingEpoch = row?.routing?.value;
  const sequence = row?.sequence?.value;
  if (!row || epoch !== env.lineage.dataEpoch || routingEpoch !== env.lineage.routingEpoch
    || !sequence || !DECIMAL.test(sequence) || expected !== undefined && sequence !== expected) {
    throw new ContentEligibilityStateUnavailable('Content eligibility graph snapshot is unavailable');
  }
  return { dataEpoch: epoch, routingEpoch, sequence };
}

function exactRowId(row: Row, field: string): string | undefined {
  return row[field]?.type === 'uri' ? row[field]?.value : undefined;
}

function parsePublicationProof(row: Row | undefined, id: string, snapshot: ContentEligibilitySnapshot,
  owner: ContentEligibilityOwnerPosition, variant: string, resource: string,
  issues?: string[]): ContentEligibilityPublicationProof | undefined {
  if (!row) { issues?.push('row'); return undefined; }
  const invalid: string[] = [];
  if (exactRowId(row, 'publication') !== id) invalid.push('identity');
  if (count(row, 'decisionType') !== 1) invalid.push('decision-type');
  if (count(row, 'anchorType') !== 1) invalid.push('anchor-type');
  if (count(row, 'receipt') !== 1) invalid.push('receipt');
  if (count(row, 'receiptType') !== 1) invalid.push('receipt-type');
  const dComponent = exact(row, 'dComponent', 'uri');
  const dResource = exact(row, 'dResource', 'uri');
  const revision = exact(row, 'dRevision', 'uri');
  const digest = exact(row, 'dDigest', 'literal');
  const ownerDataEpoch = exact(row, 'dOwnerEpoch', 'literal');
  const ownerSequence = exact(row, 'dOwnerSequence', 'literal');
  const dDataEpoch = exact(row, 'dDataEpoch', 'literal');
  const dSequence = exact(row, 'dSequence', 'literal');
  const dModel = exact(row, 'dModel', 'uri');
  const dShape = exact(row, 'dShape', 'uri');
  const dDataset = exact(row, 'dDataset', 'uri');
  const dPreparation = exact(row, 'dPreparation', 'literal');
  const receipt = exact(row, 'receipt', 'uri');
  const rOutcome = exact(row, 'rOutcome', 'uri');
  const rReason = optionalExact(row, 'rReason', 'uri');
  const requestDigest = exact(row, 'rRequestDigest', 'literal');
  const admissionId = exact(row, 'rAdmissionId', 'literal');
  const authorityEpoch = exact(row, 'rAuthorityEpoch', 'literal');
  const scope = exact(row, 'rScope', 'literal');
  const rPreparation = exact(row, 'rPreparation', 'literal');
  const rRevision = exact(row, 'rRevision', 'uri');
  const rVariant = exact(row, 'rVariant', 'uri');
  const rResource = exact(row, 'rResource', 'uri');
  const rDigest = exact(row, 'rByteDigest', 'literal');
  const rOwnerEpoch = exact(row, 'rOwnerEpoch', 'literal');
  const rOwnerSequence = exact(row, 'rOwnerSequence', 'literal');
  const expectedHead = exact(row, 'rExpectedHead', 'uri');
  const rDataset = exact(row, 'rDataset', 'uri');
  const rDataEpoch = exact(row, 'rDataEpoch', 'literal');
  const rSequence = exact(row, 'rSequence', 'literal');
  const rDecision = exact(row, 'rDecision', 'uri');
  const expectedRevision = revision && new RegExp(`^${REVISION_PREFIX}([0-9a-f-]{36})$`, 'i').test(revision);
  if (!dComponent || dComponent !== variant) invalid.push('component');
  if (dResource !== resource) invalid.push('resource');
  if (!revision || !expectedRevision) invalid.push('revision');
  if (!digest || !SHA256.test(digest)) invalid.push('digest');
  if (!ownerDataEpoch || ownerDataEpoch !== owner.dataEpoch) invalid.push('owner-epoch');
  if (!ownerSequence || !DECIMAL.test(ownerSequence)
    || DECIMAL.test(ownerSequence) && BigInt(ownerSequence) > BigInt(owner.sequence)) invalid.push('owner-sequence');
  if (dDataEpoch !== snapshot.dataEpoch) invalid.push('graph-epoch');
  if (!dSequence || !DECIMAL.test(dSequence) || DECIMAL.test(dSequence)
    && (BigInt(dSequence) === 0n || BigInt(dSequence) > BigInt(snapshot.sequence))) invalid.push('graph-sequence');
  if (dModel !== 'https://rezics.com/definition/content-publication-v1') invalid.push('model');
  if (dShape !== dModel) invalid.push('shape');
  if (dDataset !== DATASET) invalid.push('dataset');
  if (!dPreparation) invalid.push('preparation');
  if (!receipt) invalid.push('receipt-identity');
  if (rOutcome !== `${RV}Succeeded` || rReason !== null) invalid.push('receipt-outcome');
  if (!requestDigest || !SHA256.test(requestDigest)) invalid.push('request-digest');
  if (!admissionId || !UUID.test(admissionId)) invalid.push('admission');
  if (!authorityEpoch || !DECIMAL.test(authorityEpoch)) invalid.push('authority-epoch');
  if (!scope || scope !== `content:publish:${variant}` && scope !== `content:publish:${resource}`) invalid.push('scope');
  if (rPreparation !== dPreparation) invalid.push('receipt-preparation');
  if (rRevision !== revision) invalid.push('receipt-revision');
  if (rVariant !== variant) invalid.push('receipt-variant');
  if (rResource !== resource) invalid.push('receipt-resource');
  if (rDigest !== digest) invalid.push('receipt-digest');
  if (rOwnerEpoch !== ownerDataEpoch) invalid.push('receipt-owner-epoch');
  if (rOwnerSequence !== ownerSequence) invalid.push('receipt-owner-sequence');
  if (!expectedHead || !isIri(expectedHead)) invalid.push('expected-head');
  if (rDataset !== DATASET) invalid.push('receipt-dataset');
  if (rDataEpoch !== snapshot.dataEpoch) invalid.push('receipt-graph-epoch');
  if (rSequence !== dSequence) invalid.push('receipt-graph-sequence');
  if (rDecision !== id) invalid.push('receipt-decision');
  if (!admissionId || publicationDecisionIri(admissionId) !== id) invalid.push('decision-derivation');
  if (!receipt || !admissionId || publicationReceiptIri(admissionId) !== receipt) invalid.push('receipt-derivation');
  if (invalid.length) { issues?.push(...invalid); return undefined; }
  return { id, variant, resource, revision: revision!, digest: digest!, preparationId: dPreparation!,
    ownerDataEpoch: ownerDataEpoch!, ownerSequence: ownerSequence!, graphSequence: dSequence! };
}

function profileForRights(rightsBasis: string): { id: string; shape: string } | undefined {
  const name = rightsBasis === `${RV}OriginalContribution` ? 'content-search-eligibility-v1'
    : rightsBasis === `${RV}PublicDomain` ? 'content-search-eligibility-v2' : undefined;
  if (!name) return undefined;
  const profile = profileRegistry as Record<string, { sha256: string; shapes: readonly string[] }>;
  const shape = `https://rezics.com/definition/${name}/decision-shape`;
  if (!profile[name]?.shapes.includes(shape)) return undefined;
  return { id: `https://rezics.com/definition/${name}`, shape };
}

function eligibilityDigestMatches(record: {
  resource: string; variant: string; publicationDecision: string; expectedHead: string | null;
  actor: string; rightsBasis: 'original-contribution' | 'public-domain'; assessmentId?: string;
  digest: string;
}): boolean {
  const base: ContentSearchEligibilityInput = { resourceId: record.resource, variantId: record.variant,
    publicationDecision: record.publicationDecision, expectedEligibilityHead: record.expectedHead,
    actingSubject: record.actor, rightsBasis: record.rightsBasis, disclosure: 'public',
    ...(record.rightsBasis === 'public-domain'
      ? { profile: 'content-search-eligibility-v2' as const, assessmentId: record.assessmentId } : {}) };
  try {
    if (contentSearchEligibilityDigest(base) === record.digest) return true;
    return RETAINED_DIGEST_FORMS.some(form => form.rightsBasis === base.rightsBasis
      && contentSearchEligibilityDigest(base, form.name) === record.digest);
  } catch { return false; }
}

function parseEligibilityProof(row: Row | undefined, id: string, snapshot: ContentEligibilitySnapshot,
  variant: string, resource: string): ContentEligibilityDecisionProof | undefined {
  if (!row || exactRowId(row, 'eligibility') !== id
    || count(row, 'decisionType') !== 1 || count(row, 'anchorType') !== 1
    || count(row, 'receipt') !== 1 || count(row, 'receiptType') !== 1) return undefined;
  const withdrawal = optionalExact(row, 'dWithdrawn', 'uri');
  if (withdrawal) return parseEligibilityWithdrawal(row, id, snapshot, variant, resource, withdrawal);
  const dComponent = exact(row, 'dComponent', 'uri');
  const dVariant = exact(row, 'dVariant', 'uri');
  const dResource = exact(row, 'dResource', 'uri');
  const publicationDecision = exact(row, 'dPublication', 'uri');
  const rights = exact(row, 'dRightsBasis', 'uri');
  const assessment = optionalExact(row, 'dAssessment', 'uri');
  const disclosure = exact(row, 'dDisclosure', 'uri');
  const admissionId = exact(row, 'dAdmissionId', 'literal');
  const authorityEpoch = exact(row, 'dAuthorityEpoch', 'literal');
  const scope = exact(row, 'dScope', 'literal');
  const actor = exact(row, 'dActor', 'uri');
  const model = exact(row, 'dModel', 'uri');
  const shape = exact(row, 'dShape', 'uri');
  const dataset = exact(row, 'dDataset', 'uri');
  const dataEpoch = exact(row, 'dDataEpoch', 'literal');
  const sequence = exact(row, 'dSequence', 'literal');
  const receipt = exact(row, 'receipt', 'uri');
  const rOutcome = exact(row, 'rOutcome', 'uri');
  const rReason = optionalExact(row, 'rReason', 'uri');
  const digest = exact(row, 'rRequestDigest', 'literal');
  const rAdmissionId = exact(row, 'rAdmissionId', 'literal');
  const rAuthorityEpoch = exact(row, 'rAuthorityEpoch', 'literal');
  const rScope = exact(row, 'rScope', 'literal');
  const rActor = exact(row, 'rActor', 'uri');
  const rResource = exact(row, 'rResource', 'uri');
  const rVariant = exact(row, 'rVariant', 'uri');
  const rPublication = exact(row, 'rPublication', 'uri');
  const expectedHeadIri = exact(row, 'rExpectedHead', 'uri');
  const rRights = exact(row, 'rRightsBasis', 'uri');
  const rAssessment = optionalExact(row, 'rAssessment', 'uri');
  const rDisclosure = exact(row, 'rDisclosure', 'uri');
  const rDataset = exact(row, 'rDataset', 'uri');
  const rDataEpoch = exact(row, 'rDataEpoch', 'literal');
  const rSequence = exact(row, 'rSequence', 'literal');
  const rEligibility = exact(row, 'rEligibility', 'uri');
  const profile = rights ? profileForRights(rights) : undefined;
  const rightsBasis = rights === `${RV}OriginalContribution` ? 'original-contribution'
    : rights === `${RV}PublicDomain` ? 'public-domain' : undefined;
  const assessmentMatch = assessment ? /^urn:rezics:rights:assessment:([0-9a-f-]{36})$/i.exec(assessment) : null;
  if (!expectedHeadIri || !isIri(expectedHeadIri)) return undefined;
  const expectedHead = expectedHeadIri === NONE ? null : expectedHeadIri;
  if (assessment === undefined || rAssessment === undefined || assessment !== rAssessment
    || !dComponent || dComponent !== variant || dVariant !== variant || dResource !== resource
    || !publicationDecision || !profile || !rightsBasis || disclosure !== `${RV}Public`
    || !admissionId || !UUID.test(admissionId) || !authorityEpoch || !DECIMAL.test(authorityEpoch)
    || !scope || scope !== `content:search-eligibility:${variant}`
      && scope !== `content:search-eligibility:${resource}`
    || !actor || !isIri(actor) || model !== profile.id || shape !== profile.id
    || !dataset || dataset !== DATASET || dataEpoch !== snapshot.dataEpoch
    || !sequence || !DECIMAL.test(sequence) || BigInt(sequence) === 0n
    || BigInt(sequence) > BigInt(snapshot.sequence) || !receipt || !rOutcome
    || rOutcome !== `${RV}Succeeded` || rReason !== null || !digest || !SHA256.test(digest)
    || rAdmissionId !== admissionId || rAuthorityEpoch !== authorityEpoch || rScope !== scope
    || rActor !== actor || rResource !== resource || rVariant !== variant
    || rPublication !== publicationDecision
    || rRights !== rights || rDisclosure !== disclosure || rDataset !== DATASET
    || rDataEpoch !== dataEpoch || rSequence !== sequence || rEligibility !== id
    || contentSearchEligibilityDecisionIri(admissionId) !== id
    || contentSearchEligibilityReceiptIri(admissionId) !== receipt
    || !rightsBasis || (rightsBasis === 'original-contribution' && assessment !== null)
    || (rightsBasis === 'public-domain' && !assessmentMatch)
    || !eligibilityDigestMatches({ resource, variant, publicationDecision, expectedHead,
      actor, rightsBasis, ...(assessmentMatch ? { assessmentId: assessmentMatch[1]! } : {}), digest })) {
    return undefined;
  }
  return { id, variant, resource, publicationDecision, graphSequence: sequence,
    rightsBasis: rightsBasis === 'public-domain' ? `${RV}PublicDomain` : `${RV}OriginalContribution`,
    sourceReceiptId: receipt, requestDigest: digest };
}

function parseEligibilityWithdrawal(row: Row, id: string, snapshot: ContentEligibilitySnapshot,
  variant: string, resource: string, withdrawnHead: string): ContentEligibilityDecisionProof | undefined {
  const val = (field: string, kind: 'uri' | 'literal' = 'uri') => exact(row, field, kind);
  const admission = val('dAdmissionId', 'literal');
  const actor = val('dActor');
  const publication = val('dPublication');
  const sequence = val('dSequence', 'literal');
  const scope = val('dScope', 'literal');
  const authority = val('dAuthorityEpoch', 'literal');
  const receipt = val('receipt');
  const digest = val('rRequestDigest', 'literal');
  const profile = 'https://rezics.com/definition/content-search-eligibility-withdrawal-v1';
  if (!admission || !UUID.test(admission) || !actor || !isIri(actor) || !publication || !isIri(publication)
    || !isIri(withdrawnHead) || !sequence || !DECIMAL.test(sequence) || BigInt(sequence) === 0n
    || BigInt(sequence) > BigInt(snapshot.sequence) || !authority || !DECIMAL.test(authority)
    || val('dComponent') !== variant || val('dVariant') !== variant || val('dResource') !== resource
    || val('dModel') !== profile || val('dShape') !== profile || val('dDataset') !== DATASET
    || val('dDataEpoch', 'literal') !== snapshot.dataEpoch
    || scope !== `content:search-eligibility:${resource}` && scope !== `content:search-eligibility:${variant}`
    || val('rOutcome') !== `${RV}Succeeded` || optionalExact(row, 'rReason', 'uri') !== null
    || val('rWithdrawn') !== withdrawnHead || val('rExpectedHead') !== withdrawnHead
    || val('rEligibility') !== id || !digest || !SHA256.test(digest)
    || contentSearchEligibilityDecisionIri(admission, true) !== id
    || contentSearchEligibilityReceiptIri(admission) !== receipt) return undefined;
  for (const field of ['RightsBasis', 'Disclosure', 'Assessment']) {
    if (optionalExact(row, `d${field}`, 'uri') !== null || optionalExact(row, `r${field}`, 'uri') !== null) return undefined;
  }
  for (const [field, kind] of [['AdmissionId', 'literal'], ['AuthorityEpoch', 'literal'], ['Scope', 'literal'],
    ['Actor', 'uri'], ['Resource', 'uri'], ['Variant', 'uri'], ['Publication', 'uri'], ['Dataset', 'uri'],
    ['DataEpoch', 'literal'], ['Sequence', 'literal']] as const) {
    if (val(`d${field}`, kind) !== val(`r${field}`, kind)) return undefined;
  }
  if (contentSearchEligibilityDigest({ profile: 'content-search-eligibility-withdrawal-v1',
    resourceId: resource, variantId: variant, publicationDecision: publication,
    expectedEligibilityHead: withdrawnHead, actingSubject: actor }) !== digest) return undefined;
  return { id, variant, resource, publicationDecision: publication, graphSequence: sequence,
    rightsBasis: '', withdrawnEligibilityHead: withdrawnHead, sourceReceiptId: receipt, requestDigest: digest };
}

/** Resolve one retained Public approval to its immutable Content publication pin. */
export async function readRetainedContentEligibilitySource(env: WorkActivationEnvironment,
  owner: ContentEligibilityOwnerPosition, source: {
    eligibilityDecision: string;
    publicationDecision: string;
    variant: string;
    resource: string;
    receiptId: string;
    requestDigest: string;
    graphDataEpoch: string;
    graphSequence: string;
  }): Promise<RetainedContentEligibilitySource> {
  if (source.graphDataEpoch !== env.lineage.dataEpoch || !DECIMAL.test(source.graphSequence)
    || BigInt(source.graphSequence) === 0n) {
    throw new ContentEligibilityStateUnavailable('retained eligibility source epoch or position is invalid');
  }
  const snapshotRows = (await env.fuseki.query(snapshotQuery(), 1_048_576)).results?.bindings ?? [];
  const snapshot = readSnapshot(env, snapshotRows.length === 1 ? snapshotRows[0] : undefined);
  const eligibilityRows = (await env.fuseki.query(eligibilityProofQuery([source.eligibilityDecision]),
    1_048_576)).results?.bindings ?? [];
  const eligibility = parseEligibilityProof(eligibilityRows.length === 1 ? eligibilityRows[0] : undefined,
    source.eligibilityDecision, snapshot, source.variant, source.resource);
  if (!eligibility || !eligibility.sourceReceiptId || !eligibility.requestDigest) {
    const row = eligibilityRows.length === 1 ? eligibilityRows[0] : undefined;
    let predicate = 'field predicate (owner decision or receipt binding)';
    const invalidCount = row && ['decisionType', 'anchorType', 'receipt', 'receiptType']
      .find(field => count(row, field) !== 1);
    if (!row) predicate = 'count predicate (eligibility owner rows)';
    else if (exactRowId(row, 'eligibility') !== source.eligibilityDecision) {
      predicate = 'type or identity predicate (eligibility)';
    } else if (invalidCount) predicate = `type or count predicate (${invalidCount})`;
    else {
      const invalidField = [
        ['dComponent', exact(row, 'dComponent', 'uri') === source.variant],
        ['dVariant', exact(row, 'dVariant', 'uri') === source.variant],
        ['dResource', exact(row, 'dResource', 'uri') === source.resource],
        ['rOutcome', exact(row, 'rOutcome', 'uri') === `${RV}Succeeded`],
        ['rReason', optionalExact(row, 'rReason', 'uri') === null],
      ] as const;
      const fieldMismatch = invalidField.find(([, matches]) => !matches)?.[0];
      const publicationDecision = exact(row, 'dPublication', 'uri');
      const expectedHead = exact(row, 'rExpectedHead', 'uri');
      const actor = exact(row, 'dActor', 'uri');
      const rights = exact(row, 'dRightsBasis', 'uri');
      const rightsBasis = rights === `${RV}OriginalContribution` ? 'original-contribution'
        : rights === `${RV}PublicDomain` ? 'public-domain' : undefined;
      const assessment = optionalExact(row, 'dAssessment', 'uri');
      const assessmentId = assessment && /^urn:rezics:rights:assessment:([0-9a-f-]{36})$/i.exec(assessment)?.[1];
      const digest = exact(row, 'rRequestDigest', 'literal');
      if (fieldMismatch) predicate = `field predicate (${fieldMismatch})`;
      else if (publicationDecision && isIri(publicationDecision) && expectedHead && isIri(expectedHead)
        && actor && isIri(actor) && rightsBasis && digest && SHA256.test(digest)
        && source.resource !== source.variant && isIri(source.resource) && isIri(source.variant)
        && (rightsBasis === 'original-contribution' ? assessment === null : assessmentId && UUID.test(assessmentId))) {
        const diagnosticDigest = contentSearchEligibilityDigest({ resourceId: source.resource,
          variantId: source.variant, publicationDecision,
          expectedEligibilityHead: expectedHead === NONE ? null : expectedHead,
          actingSubject: actor, rightsBasis, disclosure: 'public',
          ...(rightsBasis === 'public-domain'
            ? { profile: 'content-search-eligibility-v2' as const, assessmentId: assessmentId! } : {}) });
        // Only attribute failure to the digest when the same parser accepts all
        // other predicates. This diagnostic copy never becomes a verified source.
        if (parseEligibilityProof({ ...row, rRequestDigest: { ...row.rRequestDigest!, value: diagnosticDigest } },
          source.eligibilityDecision, snapshot, source.variant, source.resource)) predicate = 'digest predicate';
      }
    }
    throw new ContentEligibilityStateUnavailable(
      `retained eligibility proof did not resolve: not a verified Main owner proof (${predicate})`);
  }
  const differences = [
    ['publicationDecision', eligibility.publicationDecision, source.publicationDecision],
    ['sourceReceiptId', eligibility.sourceReceiptId, source.receiptId],
    ['requestDigest', eligibility.requestDigest, source.requestDigest],
    ['graphSequence', eligibility.graphSequence, source.graphSequence],
  ].filter(([, proof, event]) => proof !== event).map(([field]) => field);
  if (differences.length) {
    throw new ContentEligibilityStateUnavailable(
      `retained eligibility proof resolved but differs from retained event (${differences.join(', ')})`);
  }
  const publicationRows = (await env.fuseki.query(publicationProofQuery([source.publicationDecision]),
    1_048_576)).results?.bindings ?? [];
  const publicationIssues: string[] = [];
  const publication = parsePublicationProof(publicationRows.length === 1 ? publicationRows[0] : undefined,
    source.publicationDecision, snapshot, owner, source.variant, source.resource, publicationIssues);
  const revision = publication?.revision && /^urn:rezics:content:revision:([0-9a-f-]{36})$/i.exec(publication.revision);
  if (!publication) throw new ContentEligibilityStateUnavailable(
    `retained eligibility publication owner proof is unavailable (${publicationIssues.join(',') || 'cardinality'})`);
  if (!publication.preparationId) throw new ContentEligibilityStateUnavailable('retained eligibility publication has no preparation pin');
  if (!revision) throw new ContentEligibilityStateUnavailable('retained eligibility publication revision is malformed');
  if (!eligibility || BigInt(eligibility.graphSequence) <= BigInt(publication.graphSequence)) {
    throw new ContentEligibilityStateUnavailable('retained eligibility approval does not follow its publication');
  }
  return { eligibility: { ...eligibility, sourceReceiptId: eligibility.sourceReceiptId,
    requestDigest: eligibility.requestDigest },
  publication: { ...publication, preparationId: publication.preparationId }, revisionId: revision[1]! };
}

function stateCandidate(row: Row): {
  variant: string; resourceCount: number; resource?: ContentEligibilityRdfTerm; publicationCount: number;
  publication?: ContentEligibilityRdfTerm; eligibilityCount: number; eligibility?: ContentEligibilityRdfTerm;
} | undefined {
  const variant = exactRowId(row, 'variant');
  const resourceCount = count(row, 'resource');
  const publicationCount = count(row, 'publication');
  const eligibilityCount = count(row, 'eligibility');
  if (!variant || resourceCount === undefined || publicationCount === undefined || eligibilityCount === undefined) return undefined;
  return { variant, resourceCount, resource: row.resource, publicationCount, publication: row.publication,
    eligibilityCount, eligibility: row.eligibility };
}

function rowMap(rows: readonly Row[], idField: string): Map<string, Row> {
  const result = new Map<string, Row>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const id = exactRowId(row, idField);
    if (!id || duplicates.has(id)) continue;
    if (result.has(id)) { result.delete(id); duplicates.add(id); }
    else result.set(id, row);
  }
  return result;
}

export async function readContentEligibilityInventory(env: WorkActivationEnvironment,
  owner: ContentEligibilityOwnerPosition, options: ContentEligibilityStateOptions = {}) {
  return readStates(env, owner, options);
}

export async function readContentEligibilityStatesForVariants(env: WorkActivationEnvironment,
  variants: readonly string[], owner: ContentEligibilityOwnerPosition,
  options: ContentEligibilityStateOptions = {}): Promise<ContentEligibilityState[]> {
  const unique = [...new Set(variants)];
  if (unique.length !== variants.length || unique.length > CONTENT_ELIGIBILITY_STATE_PAGE
    || unique.some(variant => !isIri(variant))) {
    throw new ContentEligibilityStateUnavailable('Content eligibility variant page is invalid');
  }
  const inventory = await readStates(env, owner, options, unique);
  const found = new Map(inventory.states.map(state => [state.variant, state]));
  return unique.map(variant => found.get(variant)
    ?? unresolved(variant, 'variant has no current publication or eligibility head'));
}

async function readStates(env: WorkActivationEnvironment, owner: ContentEligibilityOwnerPosition,
  options: ContentEligibilityStateOptions, variants?: readonly string[]) {
  const pageSize = options.pageSize ?? CONTENT_ELIGIBILITY_STATE_PAGE;
  const maxUnits = options.maxUnits ?? CONTENT_ELIGIBILITY_STATE_MAX;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > CONTENT_ELIGIBILITY_STATE_PAGE
    || !Number.isSafeInteger(maxUnits) || maxUnits < 0 || !DECIMAL.test(owner.sequence)) {
    throw new ContentEligibilityStateUnavailable('Content eligibility inventory bound is invalid');
  }
  const read = options.read ?? (async (_step: string, sparql: string) =>
    env.fuseki.query(sparql, 1_048_576));
  const beforeRows = (await read('snapshot before', snapshotQuery())).results?.bindings ?? [];
  const snapshot = readSnapshot(env, beforeRows.length === 1 ? beforeRows[0] : undefined,
    options.expectedGraphSequence);
  const states: ContentEligibilityState[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  let offset = 0;
  while (true) {
    const pageVariants = variants ? variants.slice(offset, offset + pageSize) : undefined;
    if (variants && pageVariants?.length === 0) break;
    const rows = (await read(`candidate page ${offset / pageSize}`,
      candidatePageQuery(snapshot, variants ? undefined : after, pageSize, pageVariants))).results?.bindings ?? [];
    if (!rows.length) {
      if (!variants) break;
      offset += pageSize;
      if (offset >= variants.length) break;
      continue;
    }
    const candidates = rows.map(stateCandidate);
    if (candidates.some(candidate => !candidate)) {
      throw new ContentEligibilityStateUnavailable('Content eligibility candidate page is malformed');
    }
    const validCandidates = candidates as NonNullable<(typeof candidates)[number]>[];
    for (const candidate of validCandidates) {
      if (seen.has(candidate.variant) || !variants && after !== undefined && candidate.variant <= after) {
        throw new ContentEligibilityStateUnavailable('Content eligibility inventory page is ambiguous');
      }
      seen.add(candidate.variant);
    }
    states.push(...await resolveCandidatePage(env, snapshot, owner, validCandidates, read));
    if (states.length > maxUnits) {
      throw new ContentEligibilityStateUnavailable('Content eligibility inventory exceeds fixed bound');
    }
    after = validCandidates.at(-1)!.variant;
    if (variants) {
      offset += pageSize;
      if (offset >= variants.length) break;
    } else if (rows.length < pageSize) break;
  }
  const afterRows = (await read('snapshot after', snapshotQuery())).results?.bindings ?? [];
  const finalSnapshot = readSnapshot(env, afterRows.length === 1 ? afterRows[0] : undefined, snapshot.sequence);
  if (finalSnapshot.dataEpoch !== snapshot.dataEpoch || finalSnapshot.routingEpoch !== snapshot.routingEpoch
    || owner.dataEpoch.length === 0 || !isIri(DATASET)) {
    throw new ContentEligibilityStateUnavailable('Content eligibility graph moved during inventory');
  }
  if (variants) {
    for (const variant of variants) {
      if (!seen.has(variant)) states.push(unresolved(variant, 'variant has no current publication or eligibility head'));
    }
  }
  return { snapshot, states };
}

async function resolveCandidatePage(env: WorkActivationEnvironment, snapshot: ContentEligibilitySnapshot,
  owner: ContentEligibilityOwnerPosition,
  candidates: readonly NonNullable<ReturnType<typeof stateCandidate>>[],
  read: (step: string, sparql: string) => Promise<SparqlResult>): Promise<ContentEligibilityState[]> {
  const rawEligibilityIds = candidates.flatMap(candidate => candidate.eligibilityCount === 1
    && candidate.eligibility?.type === 'uri' && isIri(candidate.eligibility.value)
    ? [candidate.eligibility.value] : []);
  const eligibilityRows = rawEligibilityIds.length
    ? (await read('eligibility owner records', eligibilityProofQuery([...new Set(rawEligibilityIds)]))).results?.bindings ?? []
    : [];
  const eligibilityById = rowMap(eligibilityRows, 'eligibility');
  const rawPublicationIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.publicationCount === 1 && candidate.publication?.type === 'uri'
      && isIri(candidate.publication.value)) rawPublicationIds.add(candidate.publication.value);
  }
  for (const row of eligibilityRows) {
    const approved = exact(row, 'dPublication', 'uri');
    if (approved && isIri(approved)) rawPublicationIds.add(approved);
  }
  const publicationRows = rawPublicationIds.size
    ? (await read('publication owner records', publicationProofQuery([...rawPublicationIds]))).results?.bindings ?? []
    : [];
  const publicationsById = rowMap(publicationRows, 'publication');
  return candidates.map(candidate => {
    const resource = candidate.resourceCount === 1 && candidate.resource?.type === 'uri'
      ? candidate.resource.value : undefined;
    const publication = candidate.publicationCount === 1 && candidate.publication?.type === 'uri'
      ? candidate.publication.value : undefined;
    const eligibility = candidate.eligibilityCount === 1 && candidate.eligibility?.type === 'uri'
      ? candidate.eligibility.value : undefined;
    const currentPublication = publication && resource
      ? parsePublicationProof(publicationsById.get(publication), publication, snapshot, owner,
        candidate.variant, resource) : undefined;
    const eligibilityRow = eligibilityById.get(eligibility ?? '');
    const eligibilityProof = eligibility && resource
      ? parseEligibilityProof(eligibilityRow, eligibility, snapshot, candidate.variant, resource) : undefined;
    const approvedId = eligibilityProof?.publicationDecision;
    const approvedPublication = approvedId && resource
      ? parsePublicationProof(publicationsById.get(approvedId), approvedId, snapshot, owner,
        candidate.variant, resource) : undefined;
    return classifyContentEligibilityState({ snapshot, owner, variant: candidate.variant,
      resourceCount: candidate.resourceCount, ...(candidate.resource ? { resource: candidate.resource } : {}),
      publicationCount: candidate.publicationCount,
      ...(candidate.publication ? { publication: candidate.publication } : {}),
      eligibilityCount: candidate.eligibilityCount,
      ...(candidate.eligibility ? { eligibility: candidate.eligibility } : {}),
      ...(currentPublication ? { currentPublication } : {}),
      ...(eligibilityProof ? { eligibilityProof } : {}),
      ...(approvedPublication ? { approvedPublication } : {}), restoreOpen: true });
  });
}
