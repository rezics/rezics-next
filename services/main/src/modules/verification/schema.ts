// Typed declarations for the Content-DB `verification` schema (migrations
// 090-096). SQL migrations remain the DDL owner; the schema test compares these
// column lists and enumerations with the installed catalog so they cannot drift.
// Claims, claim revisions and assessment anchors are Jena-owned (claim-v1,
// assessment-v1); rows here reference them by exact IRI only.

/** Admission ceilings shared with the protection profile and the contract. */
export const verificationLimits = {
  evidenceItems: 32,
  derivationInputs: 32,
  sourceAssessments: 32,
  summaryDependencies: 128,
  reasonCodes: 16,
} as const;

const receiptActions = ['origin.record', 'derivation.record', 'lineage.record',
  'lineage.retract', 'evidence.record', 'challenge.submit', 'challenge.resolve',
  'source-disposition.record', 'correction-subscription.set'] as const;
const originKinds = ['publication', 'dataset', 'statement', 'native'] as const;
const derivationKinds = ['ai-extraction', 'ai-generation', 'tool-extraction',
  'human-transcription', 'syndication-import'] as const;
const lineageRelations = ['copy-of', 'quotation-of', 'derived-from', 'publishes-origin'] as const;
const lineageBases = ['declared-by-source', 'detected', 'reviewer-asserted'] as const;
const evidencePurposes = ['claim-head', 'challenge', 'correction-proposal'] as const;
const evidenceStances = ['supports', 'contradicts', 'uncertain'] as const;
const evidenceAvailability = ['available', 'inaccessible', 'withdrawn', 'erased'] as const;
const challengeOutcomes = ['material-conflict', 'not-established', 'superseded', 'withdrawn'] as const;
const summarySupport = ['supported', 'contradicted', 'material-conflict',
  'insufficient', 'unknown', 'abstained'] as const;
const summaryReview = ['unreviewed', 'reviewed'] as const;
const summaryDispute = ['none', 'challenge-pending', 'disputed', 'resolved'] as const;
const summaryCoverage = ['complete', 'partial', 'incomplete'] as const;
const summaryDependence = ['established', 'unknown', 'circular', 'over-budget'] as const;
const dependencyOwners = ['graph', 'content'] as const;
const dependencyKinds = ['claim', 'evidence-set', 'source-assessment', 'source-observation',
  'source-disposition', 'challenge', 'policy', 'rule', 'acceptance', 'adopted-revision'] as const;
const invalidationProducers = ['graph', 'content'] as const;

type Of<T extends readonly string[]> = T[number];

interface ReceiptRow {
  id: string; principal_id: string; action: Of<typeof receiptActions>; idempotency_key: string;
  request_digest: string; outcome: 'succeeded' | 'rejected'; result_id: string | null;
  reason: string | null; created_at: Date;
}
interface OriginRow {
  id: string; kind: Of<typeof originKinds>; locator: string; operation_id: string;
  principal_id: string; created_at: Date;
}
interface DerivationRow {
  id: string; output_observation_id: string | null; output_reference: string | null;
  kind: Of<typeof derivationKinds>; method: string; model: string | null; tool_version: string | null;
  profile_revision: string | null; limitations: string; input_count: number; operation_id: string;
  principal_id: string; created_at: Date;
}
interface DerivationInputRow {
  derivation_id: string; ordinal: number; input_observation_id: string | null;
  input_origin_id: string | null; input_reference: string | null;
}
interface LineageEdgeRow {
  id: string; observation_id: string; relation: Of<typeof lineageRelations>;
  target_observation_id: string | null; target_origin_id: string | null; target_reference: string | null;
  basis: Of<typeof lineageBases>; method: string | null; operation_id: string; principal_id: string;
  created_at: Date;
}
interface LineageRetractionRow {
  edge_id: string; reason: string; operation_id: string; principal_id: string; created_at: Date;
}
interface EvidenceSetRevisionRow {
  id: string; claim: string; claim_revision: string; purpose: Of<typeof evidencePurposes>;
  predecessor: string | null; item_count: number; manifest_digest: string; operation_id: string;
  principal_id: string; created_at: Date;
}
interface EvidenceItemRow {
  revision_id: string; ordinal: number; stance: Of<typeof evidenceStances>; observation_id: string | null;
  content_revision_id: string | null; graph_reference: string | null; selector: Record<string, unknown>;
  availability: Of<typeof evidenceAvailability>;
}
interface EvidenceHeadRow {
  claim: string; head: string; head_purpose: 'claim-head'; updated_at: Date;
}
interface ObservationDispositionRow {
  id: string; observation_id: string; predecessor: string | null;
  state: 'available' | 'inaccessible' | 'withdrawn'; reason: string;
  operation_id: string; principal_id: string; created_at: Date;
}
interface ObservationDispositionHeadRow { observation_id: string; head: string }
interface CorrectionSubscriptionRevisionRow {
  id: string; claim: string; context: string; principal_id: string; predecessor: string | null;
  state: 'subscribed' | 'unsubscribed'; operation_id: string; created_at: Date;
}
interface CorrectionSubscriptionHeadRow { claim: string; context: string; principal_id: string; head: string }
interface CorrectionDeliveryCursorRow {
  generation_id: string; cursor_principal: string | null; complete: boolean;
  lease_owner: string | null; lease_until: Date | null; updated_at: Date;
}
interface ChallengeRow {
  id: string; claim: string; claim_revision: string; adopted_revision: string | null; context: string;
  reason: string; counterevidence: string | null; counterevidence_purpose: 'challenge';
  acting_subject: string; operation_id: string; principal_id: string; created_at: Date;
}
interface ChallengeResolutionRow {
  challenge_id: string; outcome: Of<typeof challengeOutcomes>; assessment: string | null; reason: string;
  acting_subject: string; operation_id: string; principal_id: string; created_at: Date;
}
interface ChallengePendingRow { challenge_id: string; claim: string; created_at: Date }
interface ChallengeHeadRow { claim: string; revision: string; open_count: number; updated_at: Date }
interface SummaryGenerationRow {
  id: string; target: string; context: string; generation: string; predecessor: string | null;
  claim: string; claim_revision: string; adopted_revision: string | null; assessment: string | null;
  policy_revision: string; support: Of<typeof summarySupport>; review: Of<typeof summaryReview>;
  dispute: Of<typeof summaryDispute>; coverage: Of<typeof summaryCoverage>;
  dependence: Of<typeof summaryDependence>; reason_codes: string[]; dependency_count: number;
  dependency_digest: string; owner_positions: Record<string, unknown>; operation_key: string;
  created_at: Date;
}
interface SummaryDependencyRow {
  generation_id: string; ordinal: number; owner: Of<typeof dependencyOwners>;
  kind: Of<typeof dependencyKinds>; reference: string; expected_head: string | null;
}
interface SummaryHeadRow {
  target: string; context: string; active_generation: string; generation: string; updated_at: Date;
}
interface ActiveDependencyRow {
  kind: Of<typeof dependencyKinds>; reference: string; target: string; context: string;
  generation_id: string; expected_head: string | null;
}
interface InvalidationRow {
  id: string; producer: Of<typeof invalidationProducers>; event_key: string; kind: Of<typeof dependencyKinds>;
  reference: string; changed_head: string | null; producer_epoch: string | null;
  producer_sequence: string | null; state: 'pending' | 'complete'; cursor_target: string | null;
  cursor_context: string | null; marked: string; pages: number; lease_owner: string | null;
  lease_until: Date | null; created_at: Date; completed_at: Date | null;
}
interface ReassessmentRequestRow {
  target: string; context: string; first_invalidation: string; latest_invalidation: string;
  marks: string; lease_owner: string | null; lease_until: Date | null; created_at: Date; updated_at: Date;
}

interface LineageHeadRow { observation_id: string; revision: string; updated_at: Date }
interface CorrectionNoticeRow {
  generation_id: string; target: string; context: string; previous_generation: string;
  previous_support: Of<typeof summarySupport>; support: Of<typeof summarySupport>;
  previous_dispute: Of<typeof summaryDispute>; dispute: Of<typeof summaryDispute>; created_at: Date;
}

/** Row types keyed by table, as pg returns them (snake_case, bigint as string). */
export interface VerificationRows {
  receipt: ReceiptRow; origin: OriginRow; derivation: DerivationRow; derivation_input: DerivationInputRow;
  lineage_edge: LineageEdgeRow; lineage_retraction: LineageRetractionRow;
  evidence_set_revision: EvidenceSetRevisionRow; evidence_item: EvidenceItemRow; evidence_head: EvidenceHeadRow;
  observation_disposition: ObservationDispositionRow; observation_disposition_head: ObservationDispositionHeadRow;
  correction_subscription_revision: CorrectionSubscriptionRevisionRow;
  correction_subscription_head: CorrectionSubscriptionHeadRow;
  correction_delivery_cursor: CorrectionDeliveryCursorRow;
  challenge: ChallengeRow; challenge_resolution: ChallengeResolutionRow; challenge_pending: ChallengePendingRow;
  challenge_head: ChallengeHeadRow; summary_generation: SummaryGenerationRow;
  summary_dependency: SummaryDependencyRow; summary_head: SummaryHeadRow; active_dependency: ActiveDependencyRow;
  invalidation: InvalidationRow; reassessment_request: ReassessmentRequestRow;
  lineage_head: LineageHeadRow; correction_notice: CorrectionNoticeRow;
}

/** Physical column order per table; `satisfies` ties each list to its row type. */
export const verificationColumns = {
  receipt: ['id', 'principal_id', 'action', 'idempotency_key', 'request_digest', 'outcome',
    'result_id', 'reason', 'created_at'] satisfies (keyof ReceiptRow)[],
  origin: ['id', 'kind', 'locator', 'operation_id', 'principal_id', 'created_at'] satisfies (keyof OriginRow)[],
  derivation: ['id', 'output_observation_id', 'output_reference', 'kind', 'method', 'model', 'tool_version',
    'profile_revision', 'limitations', 'input_count', 'operation_id', 'principal_id',
    'created_at'] satisfies (keyof DerivationRow)[],
  derivation_input: ['derivation_id', 'ordinal', 'input_observation_id', 'input_origin_id',
    'input_reference'] satisfies (keyof DerivationInputRow)[],
  lineage_edge: ['id', 'observation_id', 'relation', 'target_observation_id', 'target_origin_id',
    'target_reference', 'basis', 'method', 'operation_id', 'principal_id',
    'created_at'] satisfies (keyof LineageEdgeRow)[],
  lineage_retraction: ['edge_id', 'reason', 'operation_id', 'principal_id',
    'created_at'] satisfies (keyof LineageRetractionRow)[],
  evidence_set_revision: ['id', 'claim', 'claim_revision', 'purpose', 'predecessor', 'item_count',
    'manifest_digest', 'operation_id', 'principal_id', 'created_at'] satisfies (keyof EvidenceSetRevisionRow)[],
  evidence_item: ['revision_id', 'ordinal', 'stance', 'observation_id', 'content_revision_id',
    'graph_reference', 'selector', 'availability'] satisfies (keyof EvidenceItemRow)[],
  evidence_head: ['claim', 'head', 'head_purpose', 'updated_at'] satisfies (keyof EvidenceHeadRow)[],
  observation_disposition: ['id', 'observation_id', 'predecessor', 'state', 'reason',
    'operation_id', 'principal_id', 'created_at'] satisfies (keyof ObservationDispositionRow)[],
  observation_disposition_head: ['observation_id', 'head'] satisfies (keyof ObservationDispositionHeadRow)[],
  correction_subscription_revision: ['id', 'claim', 'context', 'principal_id', 'predecessor',
    'state', 'operation_id', 'created_at'] satisfies (keyof CorrectionSubscriptionRevisionRow)[],
  correction_subscription_head: ['claim', 'context', 'principal_id', 'head'] satisfies
    (keyof CorrectionSubscriptionHeadRow)[],
  correction_delivery_cursor: ['generation_id', 'cursor_principal', 'complete', 'lease_owner',
    'lease_until', 'updated_at'] satisfies (keyof CorrectionDeliveryCursorRow)[],
  challenge: ['id', 'claim', 'claim_revision', 'adopted_revision', 'context', 'reason', 'counterevidence',
    'counterevidence_purpose', 'acting_subject', 'operation_id', 'principal_id',
    'created_at'] satisfies (keyof ChallengeRow)[],
  challenge_resolution: ['challenge_id', 'outcome', 'assessment', 'reason', 'acting_subject', 'operation_id',
    'principal_id', 'created_at'] satisfies (keyof ChallengeResolutionRow)[],
  challenge_pending: ['challenge_id', 'claim', 'created_at'] satisfies (keyof ChallengePendingRow)[],
  challenge_head: ['claim', 'revision', 'open_count', 'updated_at'] satisfies (keyof ChallengeHeadRow)[],
  summary_generation: ['id', 'target', 'context', 'generation', 'predecessor', 'claim', 'claim_revision',
    'adopted_revision', 'assessment', 'policy_revision', 'support', 'review', 'dispute', 'coverage',
    'dependence', 'reason_codes', 'dependency_count', 'dependency_digest', 'owner_positions',
    'operation_key', 'created_at'] satisfies (keyof SummaryGenerationRow)[],
  summary_dependency: ['generation_id', 'ordinal', 'owner', 'kind', 'reference',
    'expected_head'] satisfies (keyof SummaryDependencyRow)[],
  summary_head: ['target', 'context', 'active_generation', 'generation',
    'updated_at'] satisfies (keyof SummaryHeadRow)[],
  active_dependency: ['kind', 'reference', 'target', 'context', 'generation_id',
    'expected_head'] satisfies (keyof ActiveDependencyRow)[],
  invalidation: ['id', 'producer', 'event_key', 'kind', 'reference', 'changed_head', 'producer_epoch',
    'producer_sequence', 'state', 'cursor_target', 'cursor_context', 'marked', 'pages', 'lease_owner',
    'lease_until', 'created_at', 'completed_at'] satisfies (keyof InvalidationRow)[],
  reassessment_request: ['target', 'context', 'first_invalidation', 'latest_invalidation', 'marks',
    'lease_owner', 'lease_until', 'created_at', 'updated_at'] satisfies (keyof ReassessmentRequestRow)[],
  lineage_head: ['observation_id', 'revision', 'updated_at'] satisfies (keyof LineageHeadRow)[],
  correction_notice: ['generation_id', 'target', 'context', 'previous_generation', 'previous_support',
    'support', 'previous_dispute', 'dispute', 'created_at'] satisfies (keyof CorrectionNoticeRow)[],
} as const satisfies { [T in keyof VerificationRows]: readonly (keyof VerificationRows[T])[] };

/** CHECK-constrained text columns whose allowed values the TypeScript unions mirror. */
export const verificationEnumerations = [
  ['receipt', 'action', receiptActions],
  ['origin', 'kind', originKinds],
  ['derivation', 'kind', derivationKinds],
  ['lineage_edge', 'relation', lineageRelations],
  ['lineage_edge', 'basis', lineageBases],
  ['evidence_set_revision', 'purpose', evidencePurposes],
  ['evidence_item', 'stance', evidenceStances],
  ['evidence_item', 'availability', evidenceAvailability],
  ['observation_disposition', 'state', ['available', 'inaccessible', 'withdrawn']],
  ['correction_subscription_revision', 'state', ['subscribed', 'unsubscribed']],
  ['challenge_resolution', 'outcome', challengeOutcomes],
  ['summary_generation', 'support', summarySupport],
  ['summary_generation', 'review', summaryReview],
  ['summary_generation', 'dispute', summaryDispute],
  ['summary_generation', 'coverage', summaryCoverage],
  ['summary_generation', 'dependence', summaryDependence],
  ['summary_dependency', 'owner', dependencyOwners],
  ['summary_dependency', 'kind', dependencyKinds],
  ['invalidation', 'producer', invalidationProducers],
  ['invalidation', 'kind', dependencyKinds],
] as const satisfies readonly (readonly [keyof typeof verificationColumns, string, readonly string[]])[];
