import { createHash } from 'node:crypto';

// Owner schema for shared interpretation Contexts (docs/contracts/context.md).
// Contexts, their semantic/preference revisions and public Realm/entry
// selections are graph-owned (model/definitions/context-v1.ts and
// context-selection-v1.ts). Private personal selections are Access-owned; see
// ./private-selection-schema.ts. Commands reuse the existing graph receipt,
// outbox batch, RevisionAnchor, prepareComponent manifest and dataset
// epoch/sequence fences; this module adds no second model of any of them.

export const CONTEXT_PROFILE = 'https://rezics.com/definition/context-v1';
export const CONTEXT_SELECTION_PROFILE = 'https://rezics.com/definition/context-selection-v1';
export const CONTEXT_SELECTION_SCOPE_PROFILE = 'https://rezics.com/definition/context-selection-scope-v1';
/** The public baseline. Distinct from the v1 acceptance `urn:rezics:classification-context:global`. */
export const GLOBAL_SEMANTIC_CONTEXT = 'urn:rezics:semantic-context:global';

/** Declared bounds; overflow is rejected or returned as an explicit partial result. */
export const CONTEXT_LIMITS = {
  entries: 256,
  applicability: 8,
  inheritanceDepth: 8,
  preferences: 256,
  domainCandidates: 8,
  /** object-relation + object + domains + default. */
  scopeCandidates: 11,
  manifestBytes: 262_144,
} as const;

/**
 * Cost contract per request, independent of how many Contexts, selections, Statements or
 * consumers exist. Graph queries include the admission-open lineage check.
 */
export const CONTEXT_COST = {
  contextRead: { graphQueries: 2 },
  /** Speaker selection, Global head and one pinned-chain read; plus one Access proof per Private Context. */
  interpretation: { graphQueries: 3, accessQueriesPerPrivateContext: 1 },
  /** One exact head read, one sealed manifest read and one guarded graph command. */
  stateTransition: { graphQueries: 3, manifestReads: 1, consumerScans: 0 },
  preferenceWrite: { graphQueries: 3, labels: 256, consumerScans: 0 },
  skosRead: { graphQueries: 5, manifestReads: 2, labels: 256,
    dependencyRows: 2304, consumerScans: 0 },
  definitionState: { graphQueries: 3, consumerScans: 0 },
  equivalenceReview: { graphQueries: 2, contextEntries: 256, consumerScans: 0 },
  meaningComparison: { graphQueries: 6, statementReads: 2, mappingReads: 1 },
  statementRead: { graphQueries: 2 },
  /** Lineage, scope and one read of the local and Global slots. */
  statementResolution: { graphQueries: 3 },
} as const;

/** Existing Access scope gates and grants authorize Context work; no new authority table. */
export const CONTEXT_AUTHORITY = {
  create: { action: 'context.create', scope: 'context:create:root' },
  change: (context: string) => ({ action: 'context.change', scope: `context:change:${context}` }),
  /** Only a Private Context needs a read grant; Public use needs no creator membership. */
  read: (context: string) => ({ action: 'context.read', scope: `context:read:${context}` }),
  realmSelection: (realm: string) => ({ action: 'context.select', scope: `context:select:${realm}` }),
  entryDefault: (entry: string) => ({ action: 'context.entry-default', scope: `context:entry-default:${entry}` }),
} as const;

/** Outbox event types the relay must register before the first Context command. */
export const CONTEXT_EVENT_TYPES = [
  'ContextCreatedEvent', 'ContextSemanticRevisedEvent', 'ContextPreferenceRevisedEvent',
  'ContextStateChangedEvent', 'ContextStateStaleEvent', 'ContextStateCancelledEvent',
  'ContextDefinitionStateChangedEvent', 'ContextDefinitionStateStaleEvent',
  'ContextDefinitionStateCancelledEvent',
  'ContextPreferenceStaleEvent', 'ContextPreferenceCancelledEvent',
  'ContextEquivalenceReviewedEvent', 'ContextEquivalenceStaleEvent', 'ContextEquivalenceCancelledEvent',
  'ContextCreateStaleEvent', 'ContextCreateCancelledEvent',
  'ContextChangeStaleEvent', 'ContextChangeCancelledEvent',
  'ContextSelectionChangedEvent', 'ContextSelectionStaleEvent', 'ContextSelectionCancelledEvent',
] as const;

export class InvalidContextSchemaInput extends Error {}

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reference = /^https?:\/\/[^\s<>"{}|\\^`]{1,2040}$/;
const contextId = (value: string) => value === GLOBAL_SEMANTIC_CONTEXT || nativeId.test(value);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export type ContextRole = 'global-interpretation' | 'shared-interpretation';
export type ContextState = 'active' | 'retired';
export type ContextDisclosure = 'public' | 'private';
export type ContextEntryState = 'defined' | 'unresolved' | 'disabled';

/** Current-graph header: independent semantic and preference CAS heads, no Realm parent. */
export interface SemanticContextRecord {
  id: string;
  role: ContextRole;
  state: ContextState;
  disclosure: ContextDisclosure;
  semanticHead: string;
  preferenceHead: string | null;
}

/**
 * One sparse interpretation entry. `defined` pins an exact DefinitionRef;
 * `unresolved` and `disabled` are explicit states that never inherit as absence.
 */
export interface ContextEntryRecord {
  target: string;
  relation: string | null;
  state: ContextEntryState;
  definition: string | null;
  applicability: string[];
}

/** Common immutable anchor fields written with the command receipt. */
export interface ContextAnchorFields {
  id: string;
  context: string;
  predecessor: string | null;
  authoredBy: string;
  operation: string;
  manifest: string;
  dataEpoch: string;
  sequence: string;
}

export interface ContextSemanticRevisionRecord extends ContextAnchorFields {
  /** Pinned base semantic revision of another Context; never a moving head. */
  base: string | null;
  /** 0 without a base, otherwise the base revision's depth + 1. */
  inheritanceDepth: number;
  entries: ContextEntryRecord[];
}

/** Preference entries live only in the sealed manifest; the graph holds the anchor and count. */
export interface ContextPreferenceRevisionRecord extends ContextAnchorFields {
  preferenceCount: number;
}

export type ContextSelectionScope =
  | { kind: 'default' }
  | { kind: 'domain'; domain: string }
  | { kind: 'object'; object: string }
  | { kind: 'object-relation'; object: string; relation: string };

export type ContextSelectionRole = 'speaker' | 'entry-default';

/** Public graph selection by a Realm speaker or an entry point. */
export interface ContextSelectionRecord {
  id: string;
  consumer: string;
  role: ContextSelectionRole;
  scope: ContextSelectionScope;
  key: string;
  head: string;
}

export interface ContextSelectionRevisionRecord {
  id: string;
  selection: string;
  predecessor: string | null;
  state: 'selected' | 'cleared';
  context: string | null;
  semanticRevision: string | null;
  preferenceRevision: string | null;
  selectedBy: string;
  operation: string;
  manifest: string;
  dataEpoch: string;
  sequence: string;
}

function checkReferences(values: readonly string[], label: string, limit: number): string[] {
  const unique = [...new Set(values)].sort();
  if (unique.length !== values.length || unique.length > limit || unique.some(value => !reference.test(value))) {
    throw new InvalidContextSchemaInput(`invalid ${label}`);
  }
  return unique;
}

export function canonicalContextEntry(entry: ContextEntryRecord): ContextEntryRecord {
  if (!reference.test(entry.target) || (entry.relation !== null && !reference.test(entry.relation))
    || !['defined', 'unresolved', 'disabled'].includes(entry.state)
    || (entry.state === 'defined') !== (entry.definition !== null)
    || (entry.definition !== null && !reference.test(entry.definition))) {
    throw new InvalidContextSchemaInput('invalid Context entry');
  }
  return { target: entry.target, relation: entry.relation, state: entry.state,
    definition: entry.definition,
    applicability: checkReferences(entry.applicability, 'Context entry applicability', CONTEXT_LIMITS.applicability) };
}

/**
 * Content-addressed immutable entry IRI. Unchanged entries keep their identity
 * across revisions and Contexts without copying their triples.
 */
export function contextEntryIri(entry: ContextEntryRecord): string {
  const canonical = canonicalContextEntry(entry);
  return `urn:rezics:context-entry:${sha256(JSON.stringify(['context-entry-v1', canonical.target,
    canonical.relation, canonical.state, canonical.definition, canonical.applicability]))}`;
}

/** Validate one complete revision's sparse entries: bounded and unique per target/relation. */
export function canonicalContextEntries(entries: readonly ContextEntryRecord[]): ContextEntryRecord[] {
  if (entries.length > CONTEXT_LIMITS.entries) throw new InvalidContextSchemaInput('too many Context entries');
  const canonical = entries.map(canonicalContextEntry);
  const keys = new Set(canonical.map(entry => `${entry.target}\n${entry.relation ?? ''}`));
  if (keys.size !== canonical.length) throw new InvalidContextSchemaInput('duplicate Context entry slot');
  return canonical.sort((a, b) => a.target.localeCompare(b.target)
    || (a.relation ?? '').localeCompare(b.relation ?? ''));
}

/** A new semantic revision's depth; exceeding the bound is rejected at write, not at read. */
export function nextInheritanceDepth(baseDepth: number | null): number {
  const depth = baseDepth === null ? 0 : baseDepth + 1;
  if (!Number.isInteger(depth) || depth < 0 || depth > CONTEXT_LIMITS.inheritanceDepth) {
    throw new InvalidContextSchemaInput('Context inheritance depth exceeds its bound');
  }
  return depth;
}

export function checkContextSelectionScope(scope: ContextSelectionScope): ContextSelectionScope {
  const ok = scope.kind === 'default'
    || (scope.kind === 'domain' && nativeId.test(scope.domain))
    || (scope.kind === 'object' && nativeId.test(scope.object))
    || (scope.kind === 'object-relation' && nativeId.test(scope.object) && reference.test(scope.relation));
  if (!ok) throw new InvalidContextSchemaInput('invalid Context selection scope');
  return scope;
}

/** Same canonical form as the generated `access.context_selection.scope_key` column. */
export function contextSelectionScopeKey(scope: ContextSelectionScope): string {
  checkContextSelectionScope(scope);
  const object = scope.kind === 'object' || scope.kind === 'object-relation' ? scope.object : '';
  const relation = scope.kind === 'object-relation' ? scope.relation : '';
  const domain = scope.kind === 'domain' ? scope.domain : '';
  return `${scope.kind}|${object}|${relation}|${domain}`;
}

/** Deterministic uniqueness key for one public consumer/role/scope selection slot. */
export function contextSelectionKey(consumer: string, role: ContextSelectionRole,
  scope: ContextSelectionScope): string {
  if (!nativeId.test(consumer) || !['speaker', 'entry-default'].includes(role)) {
    throw new InvalidContextSchemaInput('invalid Context selection consumer');
  }
  return `urn:rezics:context-selection:${sha256(JSON.stringify(['context-selection-scope-v1',
    consumer, role, contextSelectionScopeKey(scope)]))}`;
}

/**
 * The versioned scope profile's precedence for one interpretation slot:
 * object-relation, object, admitted domains (equal priority), then default.
 * Explicit requests precede and the entry default and Global follow this list.
 */
export function contextSelectionCandidates(object: string, relation: string | null,
  domains: readonly string[]): ContextSelectionScope[][] {
  if (!nativeId.test(object) || (relation !== null && !reference.test(relation))
    || domains.length > CONTEXT_LIMITS.domainCandidates || new Set(domains).size !== domains.length
    || domains.some(domain => !nativeId.test(domain))) {
    throw new InvalidContextSchemaInput('invalid Context selection candidates');
  }
  return [
    ...(relation === null ? [] : [[{ kind: 'object-relation' as const, object, relation }]]),
    [{ kind: 'object' as const, object }],
    ...(domains.length ? [[...domains].sort().map(domain => ({ kind: 'domain' as const, domain }))] : []),
    [{ kind: 'default' as const }],
  ];
}

export function checkSelectedContext(context: string, semanticRevision: string,
  preferenceRevision: string | null): void {
  if (!contextId(context) || !nativeId.test(semanticRevision)
    || (preferenceRevision !== null && !nativeId.test(preferenceRevision))) {
    throw new InvalidContextSchemaInput('invalid selected Context revision');
  }
}
