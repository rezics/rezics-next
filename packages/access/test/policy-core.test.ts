import { expect, test } from 'bun:test';
import vectors from '../conformance/policy-core.json';
import {
  compilePolicyCatalogue,
  decidePolicy,
  describeRequiredOperands,
  MAX_POLICY_EXPLANATION_BYTES,
  MAX_POLICY_EXPLANATION_NODES,
  MAX_POLICY_TEMPORAL_INTEGER_CHARS,
  qualifyTemporalEvidence,
  type PolicyCatalogueInput,
  type PolicyFacts,
  type PolicyRequest,
} from '../src/index.ts';

const compiled = compilePolicyCatalogue(vectors.catalogue as PolicyCatalogueInput);
if (!compiled.ok)
  throw new Error(`Conformance catalogue failed: ${compiled.errors.map((error) => error.code).join(',')}`);

for (const vector of vectors.cases) {
  test(`policy vector: ${vector.id}`, () => {
    const decision = decidePolicy(compiled.catalogue, vector.request as PolicyRequest, vector.facts as PolicyFacts);
    expect(String(decision.decision)).toBe(vector.expected);
    expect(String(decision.reason)).toBe(vector.reason);
  });
}

test('catalogue rejects duplicates and unknown role actions before evaluation', () => {
  const duplicate = compilePolicyCatalogue({
    ...vectors.catalogue,
    actions: [...vectors.catalogue.actions, vectors.catalogue.actions[0]!],
  } as PolicyCatalogueInput);
  expect(duplicate).toMatchObject({ ok: false, errors: [{ code: 'duplicate-action' }] });

  const unknown = compilePolicyCatalogue({
    ...vectors.catalogue,
    roles: [...vectors.catalogue.roles, { role: 'missing.role', actions: ['missing:read'] }],
  } as PolicyCatalogueInput);
  expect(unknown).toMatchObject({ ok: false, errors: [{ code: 'unknown-role-action' }] });

  const unsupported = compilePolicyCatalogue({
    actions: [{ action: 'test:read', anonymous: false, authority: 'delegated', resourceTypes: [], globalReach: false }],
    roles: [],
    resourceTypes: [],
  } as unknown as PolicyCatalogueInput);
  expect(unsupported).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'invalid-profile' })] });
});

test('invalid requests differ from missing evidence', () => {
  expect(decidePolicy(compiled.catalogue, null as unknown as PolicyRequest, {} as PolicyFacts).decision).toBe(
    'invalid',
  );
  expect(
    decidePolicy(compiled.catalogue, vectors.cases[0]!.request as PolicyRequest, null as unknown as PolicyFacts),
  ).toMatchObject({ decision: 'unavailable', reason: 'evidence' });
});

test('required operand descriptions and explanations have stable bounded data', () => {
  const request = vectors.cases[0]!.request as PolicyRequest;
  const required = describeRequiredOperands(compiled.catalogue, request);
  expect(required.map((item) => item.name)).toContain('actor.action-grant');
  expect(required.map((item) => item.name)).toContain('principal.action-grant');
  expect(required.find((item) => item.name === 'public.floor')).toMatchObject({ independentOfScope: true });
  const decision = decidePolicy(compiled.catalogue, request, vectors.cases[0]!.facts as PolicyFacts);
  expect(decision).toEqual(decidePolicy(compiled.catalogue, request, vectors.cases[0]!.facts as PolicyFacts));
  expect(Object.isFrozen(decision.explanation)).toBe(true);
  expect(decision.explanation.length).toBeLessThanOrEqual(MAX_POLICY_EXPLANATION_NODES);
  expect(JSON.stringify(decision.explanation).length).toBeLessThanOrEqual(MAX_POLICY_EXPLANATION_BYTES);
});

test('temporal conformance uses exact half-open integer-microsecond intervals', () => {
  for (const vector of vectors.intervals) {
    const complete = vector.complete !== false;
    const result = qualifyTemporalEvidence(
      {
        complete,
        intervals: [{ fromMicros: vector.fromMicros, untilMicros: vector.untilMicros }],
      },
      vector.atMicros,
    );
    expect(result).toBe(vector.expected);
  }
  expect(qualifyTemporalEvidence({ complete: true, intervals: [] }, '100')).toBe(false);
  expect(qualifyTemporalEvidence({ complete: false, intervals: [] }, '100')).toBeNull();
  expect(
    qualifyTemporalEvidence({ complete: true, intervals: [] }, '1'.repeat(MAX_POLICY_TEMPORAL_INTEGER_CHARS + 1)),
  ).toBeNull();
});
