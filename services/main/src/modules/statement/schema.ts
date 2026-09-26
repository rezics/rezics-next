import { createHash } from 'node:crypto';
import { CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';

// Owner schema for Statements and their acceptance decisions
// (docs/contracts/classification.md, model/definitions/statement-v1.ts and
// statement-decision-v1.ts). Graph-owned; commands reuse the existing receipt,
// outbox batch, RevisionAnchor, manifest and epoch/sequence fences.
//
// Transition decision: migrate v1 classification decisions at cutover; do not
// wrap two live decision models. The migration remains unimplemented. Each v1
// curated Application must become one Statement (rv:migratedFrom), and each v1
// decision slot must become one qualified-fact DecisionSlot whose first decision
// references the exact retained v1 head (rv:convertedFrom). The v1
// Application/Decision/Sense records remain immutable history resolvable through
// their exact old profiles; their writers retire at cutover. The v1
// ClassificationContext records are reused only as acceptance scopes and are
// never relabelled as interpretation Contexts.

export const STATEMENT_PROFILE = 'https://rezics.com/definition/statement-v1';
export const STATEMENT_DECISION_PROFILE = 'https://rezics.com/definition/statement-decision-v1';
export const CLASSIFIED_AS = 'https://rezics.com/vocab/classifiedAs';
const RV = 'https://rezics.com/vocab/';

export const STATEMENT_LIMITS = {
  interpretationDefinitions: 8,
  applicability: 8,
  evidence: 16,
  support: 32,
} as const;

/**
 * Existing Access scope gates. Deciding reuses the v1 acceptance scope names, so
 * a Global or Realm manager's scope gate stays the same; the action is new so a
 * pending v1 admission can never be sealed by the Statement writer.
 */
export const STATEMENT_AUTHORITY = {
  speak: (speaker: string) => ({ action: 'statement.record', scope: `statement:speak:${speaker}` }),
  decide: (acceptance: { kind: 'global' } | { kind: 'realm'; realm: string }) => ({
    action: 'statement.decide',
    scope: acceptance.kind === 'global' ? 'classification:decide:global' : `classification:decide:${acceptance.realm}` }),
} as const;

/** Outbox event types the relay must register before the first Statement command. */
export const STATEMENT_EVENT_TYPES = [
  'StatementRecordedEvent', 'StatementWithdrawnEvent', 'StatementChangeStaleEvent',
  'StatementChangeCancelledEvent', 'StatementDecisionChangedEvent', 'StatementDecisionStaleEvent',
  'StatementDecisionCancelledEvent', 'StatementMigratedEvent',
] as const;

export class InvalidStatementSchemaInput extends Error {}

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reference = /^https?:\/\/[^\s<>"{}|\\^`]{1,2040}$/;
const meaningKeyIri = /^urn:rezics:meaning:[0-9a-f]{64}$/;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** rdf:object: a resource reference, a typed literal, or an explicit value state. */
export type StatementValue =
  | { kind: 'resource'; iri: string }
  | { kind: 'literal'; lexical: string; datatype: string; language: string | null }
  | { kind: 'some-value' }
  | { kind: 'no-value' };

/** Meaning-bearing fields. Fixed for the Statement ID; a changed meaning is a new Statement. */
export interface StatementMeaning {
  subject: string;
  predicate: string;
  relationDefinition: string;
  interpretationDefinitions: string[];
  value: StatementValue;
  applicability: string[];
}

export interface StatementRecord extends StatementMeaning {
  id: string;
  speaker: string;
  /** The Context semantic revision through which interpretation was selected, where used. */
  semanticContextRevision: string | null;
  meaningKey: string;
  state: 'active' | 'withdrawn';
  head: string;
  source: string | null;
  migratedFrom: string | null;
}

export interface StatementRevisionRecord {
  id: string;
  statement: string;
  predecessor: string | null;
  state: 'active' | 'withdrawn';
  evidence: string[];
  recordedBy: string;
  operation: string;
  manifest: string;
  dataEpoch: string;
  sequence: string;
}

export type DecisionTarget =
  | { kind: 'statement'; statement: string }
  | { kind: 'qualified-fact'; meaningKey: string };

export interface DecisionSlotRecord {
  id: string;
  target: DecisionTarget;
  /** Retained ClassificationContext used as the acceptance scope. */
  acceptanceContext: string;
  decisionHead: string;
}

export type DecisionOutcome = 'accepted' | 'rejected' | 'withdrawn';
export interface StatementDecisionRecord {
  id: string;
  slot: string;
  predecessor: string | null;
  outcome: DecisionOutcome;
  basis: 'global-curator-review' | 'realm-manager-review';
  decidedBy: string;
  /** Acceptance-context revision for Realm scopes, as in v1. */
  contextRevision: string | null;
  targetRevision: string | null;
  support: string[];
  evidence: string[];
  convertedFrom: string | null;
  operation: string;
  manifest: string;
  dataEpoch: string;
  sequence: string;
}

/** Decision fields known before the command assigns its operation, manifest and position. */
export type PreparedStatementDecision = Omit<StatementDecisionRecord,
  'operation' | 'manifest' | 'dataEpoch' | 'sequence'>;

function checkReferences(values: readonly string[], label: string, limit: number): string[] {
  const unique = [...new Set(values)].sort();
  if (unique.length !== values.length || unique.length > limit || unique.some(value => !reference.test(value))) {
    throw new InvalidStatementSchemaInput(`invalid ${label}`);
  }
  return unique;
}

function canonicalValue(value: StatementValue): unknown[] {
  if (value.kind === 'resource' && reference.test(value.iri)) return ['resource', value.iri];
  if (value.kind === 'literal' && value.lexical.length <= 4096 && reference.test(value.datatype)
    && (value.language === null || /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(value.language))) {
    // Value-profile normalization (units, numeric lexical forms) happens before this key.
    return ['literal', value.lexical, value.datatype, value.language?.toLowerCase() ?? null];
  }
  if (value.kind === 'some-value' || value.kind === 'no-value') return [value.kind];
  throw new InvalidStatementSchemaInput('invalid Statement value');
}

/**
 * Canonical meaning key over the exact target grain, relation meaning, applied
 * interpretation definitions, normalized value and meaning-bearing qualifiers.
 * Speaker, Context identity/revision, preference revision, labels and support
 * count are deliberately excluded.
 */
export function statementMeaningKey(meaning: StatementMeaning): string {
  if (!reference.test(meaning.subject) || !reference.test(meaning.predicate)
    || !reference.test(meaning.relationDefinition)) {
    throw new InvalidStatementSchemaInput('invalid Statement meaning');
  }
  return `urn:rezics:meaning:${sha256(JSON.stringify(['statement-meaning-v1', meaning.subject,
    meaning.predicate, meaning.relationDefinition,
    checkReferences(meaning.interpretationDefinitions, 'interpretation definitions',
      STATEMENT_LIMITS.interpretationDefinitions),
    canonicalValue(meaning.value),
    checkReferences(meaning.applicability, 'Statement applicability', STATEMENT_LIMITS.applicability)]))}`;
}

/** One decision head per exact target and acceptance scope. */
export function decisionSlotIri(target: DecisionTarget, acceptanceContext: string): string {
  const targetKey = target.kind === 'statement' ? target.statement : target.meaningKey;
  if ((target.kind === 'statement' && !nativeId.test(target.statement))
    || (target.kind === 'qualified-fact' && !meaningKeyIri.test(target.meaningKey))
    || (acceptanceContext !== GLOBAL_CLASSIFICATION_CONTEXT && !nativeId.test(acceptanceContext))) {
    throw new InvalidStatementSchemaInput('invalid decision slot');
  }
  return `urn:rezics:decision-slot:${sha256(JSON.stringify(['statement-decision-v1', target.kind,
    targetKey, acceptanceContext]))}`;
}

/** Retained v1 inputs for one curated Application and its current decision head. */
export interface V1ClassificationSlot {
  application: string;
  mainVersion: string;
  senseRevision: string;
  concept: string;
  acceptanceContext: string;
  contextRevision: string | null;
  proposer: string;
  headDecision: string;
  headOutcome: 'accepted' | 'rejected';
  headBasis: 'global-curator-review' | 'realm-manager-review';
  headDecidedBy: string;
}

export interface V1ConversionIds {
  statement: string;
  statementRevision: string;
  decision: string;
}

/**
 * Pure, lossless mapping of one v1 slot. It infers no new definition, hair
 * colour, character or narrower relation: the exact v1 Sense revision is the
 * applied interpretation DefinitionRef and the v1 proposition profile is the
 * relation definition. Command-time fields (operation, manifest, epoch,
 * sequence) are added by the migrating command.
 */
export function convertV1ClassificationSlot(slot: V1ClassificationSlot, ids: V1ConversionIds) {
  for (const value of [slot.application, slot.mainVersion, slot.senseRevision, slot.concept,
    slot.proposer, slot.headDecision, slot.headDecidedBy, ids.statement, ids.statementRevision, ids.decision]) {
    if (!nativeId.test(value)) throw new InvalidStatementSchemaInput('invalid v1 conversion reference');
  }
  if ((slot.acceptanceContext === GLOBAL_CLASSIFICATION_CONTEXT) !== (slot.contextRevision === null)
    || (slot.acceptanceContext === GLOBAL_CLASSIFICATION_CONTEXT)
      !== (slot.headBasis === 'global-curator-review')) {
    throw new InvalidStatementSchemaInput('v1 acceptance scope and basis disagree');
  }
  const meaning: StatementMeaning = { subject: slot.mainVersion, predicate: CLASSIFIED_AS,
    relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
    interpretationDefinitions: [slot.senseRevision],
    value: { kind: 'resource', iri: slot.concept }, applicability: [] };
  const meaningKey = statementMeaningKey(meaning);
  const target: DecisionTarget = { kind: 'qualified-fact', meaningKey };
  const slotId = decisionSlotIri(target, slot.acceptanceContext);
  return {
    statement: { ...meaning, id: ids.statement, speaker: slot.proposer, semanticContextRevision: null,
      meaningKey, state: 'active', head: ids.statementRevision, source: null,
      migratedFrom: slot.application } satisfies StatementRecord,
    slot: { id: slotId, target, acceptanceContext: slot.acceptanceContext,
      decisionHead: ids.decision } satisfies DecisionSlotRecord,
    decision: { id: ids.decision, slot: slotId, predecessor: null, outcome: slot.headOutcome,
      basis: slot.headBasis, decidedBy: slot.headDecidedBy, contextRevision: slot.contextRevision,
      targetRevision: null, support: [ids.statement], evidence: [],
      convertedFrom: slot.headDecision } satisfies PreparedStatementDecision,
    policy: (slot.acceptanceContext === GLOBAL_CLASSIFICATION_CONTEXT
      ? CLASSIFICATION_ISOLATE_POLICY : CLASSIFICATION_INHERIT_POLICY) as AcceptancePolicy,
  };
}

/** What one complete, fenced read observed for one slot. */
export type SlotReading =
  | { state: 'decided'; slot: string; decision: string; outcome: DecisionOutcome }
  | { state: 'absent' }
  | { state: 'unavailable' };

export type AcceptanceResolution =
  | { state: 'accepted' | 'rejected'; source: 'local' | 'inherited-global' | 'global';
    slot: string; decision: string }
  | { state: 'absent'; source: 'none' }
  | { state: 'unavailable' };

/** The retained v1 acceptance policies, reused unchanged for the migrated slots. */
export type AcceptancePolicy = typeof CLASSIFICATION_INHERIT_POLICY | typeof CLASSIFICATION_ISOLATE_POLICY;

export type AcceptanceRequest =
  | { scope: 'global'; global: SlotReading }
  | { scope: 'local'; policy: typeof CLASSIFICATION_INHERIT_POLICY; local: SlotReading; global?: SlotReading }
  | { scope: 'local'; policy: typeof CLASSIFICATION_ISOLATE_POLICY; local: SlotReading };

/**
 * Acceptance for one exact qualified meaning (docs/contracts/context.md,
 * effective statements). Local rejection suppresses; confirmed local absence or
 * withdrawal may inherit under the pinned policy; unreadable state never
 * becomes absence. Both slots must address the same meaning key.
 */
export function resolveAcceptance(request: AcceptanceRequest): AcceptanceResolution {
  const decided = (reading: SlotReading, source: 'local' | 'inherited-global' | 'global') =>
    reading.state === 'decided' && reading.outcome !== 'withdrawn'
      ? { state: reading.outcome, source, slot: reading.slot, decision: reading.decision } : null;
  if (request.scope === 'global') {
    if (request.global.state === 'unavailable') return { state: 'unavailable' };
    return decided(request.global, 'global') ?? { state: 'absent', source: 'none' };
  }
  if (request.local.state === 'unavailable') return { state: 'unavailable' };
  const local = decided(request.local, 'local');
  if (local) return local;
  if (request.policy === CLASSIFICATION_ISOLATE_POLICY) return { state: 'absent', source: 'none' };
  if (!request.global) throw new InvalidStatementSchemaInput('inherit policy requires the Global slot reading');
  if (request.global.state === 'unavailable') return { state: 'unavailable' };
  return decided(request.global, 'inherited-global') ?? { state: 'absent', source: 'none' };
}

/** RDF terms for a decision outcome, shared by command and resolver adapters. */
export const DECISION_OUTCOME_TERMS: Record<DecisionOutcome, string> = {
  accepted: `${RV}Accepted`, rejected: `${RV}Rejected`, withdrawn: `${RV}Withdrawn`,
};
