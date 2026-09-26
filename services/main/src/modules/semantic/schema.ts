import { DATASET, GRAPHS, ID, RV, hash, iri } from '../work/activate.ts';

/**
 * Owner schema for the general semantic component (MODEL01/08/14/19–22).
 *
 * Reused, not redefined: the product dataset and its named graphs, control
 * epoch/routing/sequence guards, `rv:RevisionAnchor` revisions with immutable
 * `rezics-manifest-v1` objects, `rv:OperationReceipt` in the receipts graph with
 * the Access admission identity, and one `rv:OutboxBatch` per sequenced change.
 * New here: a separate `rv:semanticHead` component on any Resource, versioned
 * definitions and one model generation head that semantic commands guard.
 */
export { DATASET, GRAPHS };

export const PROFILES = {
  resource: 'https://rezics.com/definition/semantic-resource-v1',
  definition: 'https://rezics.com/definition/semantic-definition-v1',
  generation: 'https://rezics.com/definition/semantic-model-generation-v1',
  annotation: 'https://rezics.com/definition/semantic-annotation-v1',
  value: 'https://rezics.com/definition/value-exact-v1',
  relation: 'https://rezics.com/definition/relation-occurrence-v1',
} as const;

/** The dataset's model component; its head is guarded by every semantic command. */
export const MODEL_COMPONENT = 'urn:rezics:model:product';

export const SEMANTIC_TERMS = {
  semanticHead: `${RV}semanticHead`,
  semanticRevision: `${RV}SemanticRevision`,
  definition: `${RV}SemanticDefinition`,
  definitionHead: `${RV}definitionHead`,
  definitionRevision: `${RV}DefinitionRevision`,
  modelGeneration: `${RV}ModelGeneration`,
  generationHead: `${RV}generationHead`,
  nameRecord: `${RV}nameRecord`,
  active: `${RV}Active`,
  retired: `${RV}Retired`,
} as const;

export const DEFINITION_KINDS = ['relation', 'property', 'value', 'unit', 'interpretation'] as const;
export type DefinitionKind = typeof DEFINITION_KINDS[number];
export const definitionKindIri = (kind: DefinitionKind): string =>
  `${RV}${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}Definition`;

export type Lifecycle = 'active' | 'retired';

/** Bounds of one synchronous semantic change; larger work uses a bulk stage. */
export const SEMANTIC_CHANGE_LIMITS = {
  typesPerResource: 32,
  assertionsPerChange: 256,
  /** New immutable value nodes per change; the module admits at most 100 subjects. */
  valueNodesPerChange: 64,
  nameRecordsPerResource: 64,
  requestBytes: 262_144,
} as const;

/** Current head of a Resource's semantic component, read from the current graph. */
export interface SemanticResourceHead {
  resource: string;
  head: string;
  types: readonly string[];
}

/** Immutable semantic revision anchor in the revisions graph. */
export interface SemanticRevisionRecord {
  revision: string;
  resource: string;
  predecessor: string | null;
  lifecycle: Lifecycle;
  operation: string;
  manifest: string;
  modelGeneration: string;
  dataEpoch: string;
  sequence: string;
}

export interface DefinitionHeadRecord {
  definition: string;
  kind: DefinitionKind;
  head: string;
  successor: string | null;
}

/** An exact DefinitionRef. A retired head never retargets an older revision. */
export interface DefinitionRevisionRecord extends Omit<SemanticRevisionRecord, 'resource'> {
  definition: string;
  kind: DefinitionKind;
  successor: string | null;
}

export interface ModelGenerationRecord {
  generation: string;
  generationNumber: string;
  predecessor: string | null;
  /** `urn:rezics:sha256:{digest}` of the generated profile manifest bytes. */
  manifest: string;
  commandModuleVersion: string;
  entailment: 'none';
  dataEpoch: string;
  sequence: string;
}

/**
 * Types written by another owner's command. A generic semantic change can neither
 * add nor remove them; their components keep their own heads and receipts.
 */
export const RESERVED_OWNER_TYPES: ReadonlySet<string> = new Set([
  'https://schema.org/CreativeWork', `${RV}MainVersion`, `${RV}RevisionAnchor`, `${RV}OperationReceipt`,
  `${RV}OutboxBatch`, `${RV}AuthorCredit`, `${RV}AuthorCreditRevision`, `${RV}RelationOccurrence`,
  `${RV}RelationOccurrenceRevision`, `${RV}SemanticRevision`, `${RV}SemanticDefinition`,
  `${RV}DefinitionRevision`, `${RV}ModelGeneration`, `${RV}ModelComponent`, `${RV}ExternalReference`,
  `${RV}Space`, `${RV}Realm`, `${RV}ClassificationContext`, `${RV}Decision`,
]);

/** Predicates that another component owns on a shared Resource. */
export const RESERVED_OWNER_PREDICATES: ReadonlySet<string> = new Set([
  `${RV}head`, `${RV}semanticHead`, `${RV}mainVersion`, `${RV}work`, `${RV}continuityProfile`,
  `${RV}scalarValue`, `${RV}hostingPolicy`, `${RV}definitionHead`, `${RV}occurrenceHead`,
  `${RV}participation`, `${RV}generationHead`, 'http://www.w3.org/2000/01/rdf-schema#label',
]);

const OWL = 'http://www.w3.org/2002/07/owl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const SH = 'http://www.w3.org/ns/shacl#';

/** Identity-merging axioms (MODEL19); the admitted entailment profile excludes them. */
export const IDENTITY_AXIOMS: ReadonlySet<string> = new Set([
  `${OWL}sameAs`, `${OWL}hasKey`, `${OWL}FunctionalProperty`, `${OWL}InverseFunctionalProperty`,
]);

export type TermOutcome = 'admitted' | 'identity-axiom' | 'schema-axiom' | 'reserved-owner' | 'invalid';

function checkedTermIri(value: string): boolean {
  return value.length <= 2048 && /^https?:\/\/[^\s<>"{}|\\^`]+$/.test(value);
}

/**
 * Classify a requested semantic type. Admitted types are descriptive only: no
 * type, including an "administrator" or executable class, selects Access grants,
 * command capability or validation weakening (MODEL08).
 */
export function semanticTypeOutcome(type: string): TermOutcome {
  if (!checkedTermIri(type)) return 'invalid';
  if (IDENTITY_AXIOMS.has(type)) return 'identity-axiom';
  if ([OWL, RDF, RDFS, SH].some(namespace => type.startsWith(namespace))) return 'schema-axiom';
  if (RESERVED_OWNER_TYPES.has(type)) return 'reserved-owner';
  return 'admitted';
}

const DESCRIPTIVE_SCHEMA_PREDICATES: ReadonlySet<string> = new Set([
  `${RDF}type`, `${RDFS}comment`, `${RDFS}seeAlso`,
]);

export function semanticPredicateOutcome(predicate: string): TermOutcome {
  if (!checkedTermIri(predicate)) return 'invalid';
  if (IDENTITY_AXIOMS.has(predicate)) return 'identity-axiom';
  if (RESERVED_OWNER_PREDICATES.has(predicate)) return 'reserved-owner';
  if (DESCRIPTIVE_SCHEMA_PREDICATES.has(predicate)) return 'admitted';
  if ([OWL, RDF, RDFS, SH].some(namespace => predicate.startsWith(namespace))) return 'schema-axiom';
  return 'admitted';
}

/**
 * Typed outcomes of the planned `semantic-change-v1` family. Unavailable references
 * never distinguish private from missing targets (MODEL10).
 */
export type SemanticChangeOutcome =
  | 'committed' | 'replayed' | 'denied' | 'stale-head' | 'generation-changed' | 'retired-definition'
  | 'invalid' | 'unsupported' | 'identity-axiom' | 'schema-axiom' | 'reserved-owner'
  | 'unavailable-reference' | 'too-large' | 'conflict';

/** Receipt identity follows the Work families: one receipt per Access admission. */
export function semanticChangeReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0semantic-change`)}`;
}

export function relationChangeReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0relation-change`)}`;
}

export function modelGenerationReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0model-generation`)}`;
}

/** New native identities are UUIDv7 and never derived from content (MODEL05). */
export function allocateNativeIri(): string {
  return `${ID}${Bun.randomUUIDv7()}`;
}

export function checkedNativeIri(value: string): string {
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new Error('invalid native identity');
  }
  iri(value);
  return value;
}
