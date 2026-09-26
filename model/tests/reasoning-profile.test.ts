import { expect, test } from 'bun:test';
import { ReasoningInputRejected, ReasoningProfileRejected, reasonSemanticFacts, REASONING_LIMITS, SEMANTIC_REASONING_PROFILE,
  type ReasoningFact, type SemanticScope } from '../../services/main/src/modules/semantic/reasoning.ts';

const generation = { generation: `urn:rezics:model-generation:${'a'.repeat(64)}`,
  manifest: `urn:rezics:sha256:${'b'.repeat(64)}`, generationNumber: '1', predecessor: null,
  entailmentProfile: 'NoEntailment' as const, receipt: `urn:rezics:receipt:${'c'.repeat(64)}` };
const source = { kind: 'source', id: 'source:catalogue-a' } as const;
const realm = { kind: 'realm', id: 'https://rezics.com/id/00000000-0000-7000-8000-000000000001' } as const;
const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const owl = 'http://www.w3.org/2002/07/owl#';
const fact = (id: string, subject: string, predicate: string, object: string, scope: SemanticScope = source): ReasoningFact =>
  ({ id, subject, predicate, object, scope });

test('MODEL19: finite reasoning rejects identity-producing OWL axioms and keeps native IDs distinct', () => {
  const alice = 'https://rezics.com/id/00000000-0000-7000-8000-000000000011';
  const bob = 'https://rezics.com/id/00000000-0000-7000-8000-000000000012';
  const email = 'https://example.org/vocab/email';
  const candidate = [fact('alice-email', alice, email, 'https://example.org/id/value-1'),
    fact('bob-email', bob, email, 'https://example.org/id/value-1'),
    fact('functional-email', email, rdfType, `${owl}FunctionalProperty`)];
  expect(() => reasonSemanticFacts({ profile: SEMANTIC_REASONING_PROFILE, modelGeneration: generation,
    selectedScopes: [source], facts: candidate })).toThrow(ReasoningProfileRejected);
  expect(candidate.map(item => item.subject)).toContain(alice);
  expect(candidate.map(item => item.subject)).toContain(bob);

  for (const axiom of [fact('same-as', alice, `${owl}sameAs`, bob),
    fact('key', 'https://example.org/vocab/Person', `${owl}hasKey`, 'https://example.org/vocab/email'),
    fact('inverse-functional', email, rdfType, `${owl}InverseFunctionalProperty`)]) {
    expect(() => reasonSemanticFacts({ profile: SEMANTIC_REASONING_PROFILE, modelGeneration: generation,
      selectedScopes: [source], facts: [axiom] })).toThrow(ReasoningProfileRejected);
  }
});

test('MODEL20: NoEntailment rejects union and partial closure outputs without fallback, counts or authority', () => {
  const person = 'https://example.org/vocab/Person';
  const alice = 'https://rezics.com/id/00000000-0000-7000-8000-000000000021';
  const complete = reasonSemanticFacts({ profile: SEMANTIC_REASONING_PROFILE, modelGeneration: generation,
    selectedScopes: [source], candidateCount: 2, facts: [fact('alice-type', alice, rdfType, person)] });
  expect(complete.status).toBe('disabled');
  expect(complete.inferences).toEqual([]);
  expect(complete.exactCount).toBeNull();
  expect(complete).toMatchObject({ accepted: false, authorizes: false, fallbackUsed: false,
    modelGeneration: generation.generation });

  const union = reasonSemanticFacts({ profile: SEMANTIC_REASONING_PROFILE, modelGeneration: generation,
    selectedScopes: [source, realm], candidateCount: 2,
    facts: [fact('alice-type', alice, rdfType, person), fact('realm-type', alice, rdfType, person, realm)] });
  expect(union.status).toBe('disabled');
  expect(union.inferences).toEqual([]);
  expect(union.exactCount).toBeNull();
  expect(union).toMatchObject({ accepted: false, authorizes: false, fallbackUsed: false });

  const partial = reasonSemanticFacts({ profile: SEMANTIC_REASONING_PROFILE, modelGeneration: generation,
    selectedScopes: [source], candidateCount: 1, closureState: 'partial',
    facts: [fact('alice-type', alice, rdfType, person)] });
  expect(partial.status).toBe('partial');
  expect(partial.exactCount).toBeNull();
  expect(partial.inferences).toEqual([]);
  expect(partial).toMatchObject({ accepted: false, authorizes: false, fallbackUsed: false });
});

test('MODEL20: unavailable selection does not become absence, fallback or authorization', () => {
  const unavailable = reasonSemanticFacts({ profile: SEMANTIC_REASONING_PROFILE, modelGeneration: generation,
    selectedScopes: [source], facts: [], closureState: 'unavailable' });
  expect(unavailable).toMatchObject({ status: 'unavailable', inferences: [], exactCount: null,
    accepted: false, authorizes: false, fallbackUsed: false });
});

test('MODEL20: reasoning inputs stop at the declared scope and fact bounds', () => {
  const facts = Array.from({ length: REASONING_LIMITS.inspectedAxioms + 1 }, (_, index) =>
    fact(`fact-${index}`, 'https://example.org/id/item', rdfType, 'https://example.org/vocab/Item'));
  expect(() => reasonSemanticFacts({ profile: SEMANTIC_REASONING_PROFILE, modelGeneration: generation,
    selectedScopes: [source], facts })).toThrow(ReasoningInputRejected);
  expect(() => reasonSemanticFacts({ profile: SEMANTIC_REASONING_PROFILE, modelGeneration: generation,
    selectedScopes: Array.from({ length: REASONING_LIMITS.selectedScopes + 1 }, (_, index) =>
      ({ kind: 'source', id: `source:${index}` })), facts: [] })).toThrow(ReasoningInputRejected);
});
