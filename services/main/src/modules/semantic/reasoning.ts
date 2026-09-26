import { IDENTITY_AXIOMS } from './schema.ts';
import type { ActiveModelGeneration } from './generation-guard.ts';

/** The G-048 generation profile pins rv:NoEntailment and excludes identity inference. */
export const SEMANTIC_REASONING_PROFILE = 'NoEntailment' as const;
export const REASONING_LIMITS = { inspectedAxioms: 10_000, selectedScopes: 64 } as const;
export const semanticReasoningCostContract = {
  variables: ['selectedScopes', 'facts'],
  bound: 'Scope validation and fact selection are O(selectedScopes + facts); both input collections are capped before selection.',
  limits: REASONING_LIMITS,
  retry: 'Retry only with the same exact generation and selected scopes after unavailable source data is restored.',
} as const;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL = 'http://www.w3.org/2002/07/owl#';
const OWL_FUNCTIONAL = `${OWL}FunctionalProperty`;
const OWL_INVERSE_FUNCTIONAL = `${OWL}InverseFunctionalProperty`;

export type SemanticScope = { kind: 'source'; id: string } | { kind: 'realm'; id: string };
export type ClosureState = 'complete' | 'partial' | 'unavailable';

export interface ReasoningFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  scope: SemanticScope;
}

export interface ReasoningResult {
  status: 'disabled' | 'partial' | 'unavailable';
  /** No rule profile is pinned by the active model generation, so candidates are discarded. */
  inferences: readonly never[];
  exactCount: null;
  accepted: false;
  authorizes: false;
  fallbackUsed: false;
  inspectedAxioms: number;
  modelGeneration: string;
  reasoningProfile: typeof SEMANTIC_REASONING_PROFILE;
}

export class ReasoningProfileRejected extends Error {
  constructor(readonly terms: readonly string[]) { super('reasoning profile contains excluded identity axioms'); }
}

export class ReasoningInputRejected extends Error {}

export interface ReasoningRequest {
  profile: string;
  modelGeneration: ActiveModelGeneration;
  selectedScopes: readonly SemanticScope[];
  /** Axioms and asserted facts from the selected scope are inspected; no closure runs. */
  facts: readonly ReasoningFact[];
  /** A lower layer may report its completion state; NoEntailment never accepts its output. */
  closureState?: ClosureState;
  /** Count only, so no unqualified or partially qualified candidate can escape. */
  candidateCount?: number;
}

function scopeKey(scope: SemanticScope): string { return `${scope.kind}:${scope.id}`; }

function checkedScope(scope: SemanticScope): boolean {
  return (scope.kind === 'source' || scope.kind === 'realm')
    && typeof scope.id === 'string' && scope.id.length > 0 && scope.id.length <= 256;
}

function identityAxiom(fact: ReasoningFact): boolean {
  if (IDENTITY_AXIOMS.has(fact.predicate)) return true;
  return fact.predicate === RDF_TYPE && [OWL_FUNCTIONAL, OWL_INVERSE_FUNCTIONAL].includes(fact.object);
}

function checkedIri(value: string): boolean {
  return value.length <= 2048 && /^https?:\/\/[^\s<>"{}|\\^`]+$/.test(value);
}

/**
 * Enforce the selected profile recorded by the exact model generation. Since the
 * active profile is NoEntailment, this is a bounded policy gate, not a reasoner.
 * Work is O(F) for F selected assertions, capped at 10,000; no corpus scan, rule
 * fallback, derived count or authority check is delegated to a caller.
 */
export function reasonSemanticFacts(request: ReasoningRequest): ReasoningResult {
  if (request.profile !== SEMANTIC_REASONING_PROFILE) throw new ReasoningInputRejected('reasoning profile is not admitted');
  if (!/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(request.modelGeneration.generation)
    || request.modelGeneration.entailmentProfile !== SEMANTIC_REASONING_PROFILE) {
    throw new ReasoningInputRejected('model generation is not an exact generation-head IRI');
  }
  if (!Array.isArray(request.selectedScopes) || !request.selectedScopes.length
    || request.selectedScopes.length > REASONING_LIMITS.selectedScopes
    || request.selectedScopes.some(scope => !checkedScope(scope))) {
    throw new ReasoningInputRejected('selected semantic scopes are empty or invalid');
  }
  if (!Array.isArray(request.facts) || request.facts.length > REASONING_LIMITS.inspectedAxioms) {
    throw new ReasoningInputRejected('reasoning input exceeds its bound');
  }
  const selected = new Set(request.selectedScopes.map(scopeKey));
  if (selected.size !== request.selectedScopes.length) throw new ReasoningInputRejected('selected semantic scopes repeat');
  if (!Number.isSafeInteger(request.candidateCount ?? 0) || (request.candidateCount ?? 0) < 0) {
    throw new ReasoningInputRejected('candidate count is invalid');
  }
  const facts = request.facts.filter(fact => selected.has(scopeKey(fact.scope)));
  if (facts.some(fact => !fact.id || fact.id.length > 512 || !checkedIri(fact.subject)
    || !checkedIri(fact.predicate) || !checkedIri(fact.object) || !checkedScope(fact.scope))) {
    throw new ReasoningInputRejected('reasoning fact is invalid');
  }
  const excluded = facts.filter(identityAxiom).map(fact => fact.predicate === RDF_TYPE ? fact.object : fact.predicate);
  if (excluded.length) throw new ReasoningProfileRejected([...new Set(excluded)].sort());

  const closureState = request.closureState ?? 'complete';
  return { status: closureState === 'partial' ? 'partial' : closureState === 'unavailable' ? 'unavailable' : 'disabled',
    inferences: [], exactCount: null, accepted: false, authorizes: false, fallbackUsed: false,
    inspectedAxioms: facts.length, modelGeneration: request.modelGeneration.generation,
    reasoningProfile: SEMANTIC_REASONING_PROFILE };
}

export function isIdentityProducingAxiom(fact: ReasoningFact): boolean { return identityAxiom(fact); }
