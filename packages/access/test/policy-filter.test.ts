import { expect, test } from 'bun:test';
import vectors from '../conformance/policy-filter.json';
import {
  compilePolicyCatalogue,
  decidePolicy,
  evaluatePolicyResidual,
  qualifyTemporalEvidence,
  specializePolicy,
  type PolicyCatalogueInput,
  type PolicyFacts,
  type PolicyRequest,
} from '../src/index.ts';

const result = compilePolicyCatalogue(vectors.catalogue as PolicyCatalogueInput);
if (!result.ok) throw new Error('Residual conformance catalogue is invalid');

for (const vector of vectors.cases) {
  test(`scalar and residual agree: ${vector.id}`, () => {
    const request = vector.request as PolicyRequest;
    const facts = vector.facts as PolicyFacts;
    const scalarFacts = { ...facts, ...(vector.resourceFacts['public.floor'] === undefined ? {} : { publicFloor: vector.resourceFacts['public.floor'] }) };
    const scalar = decidePolicy(result.catalogue, request, scalarFacts as PolicyFacts);
    const residual = specializePolicy(
      result.catalogue,
      request,
      facts,
      request.mode === 'ordinary' ? ['public.floor'] : [],
    );
    expect(residual.status).toBe('ready');
    if (residual.status !== 'ready') return;
    expect(evaluatePolicyResidual(residual.residual, vector.resourceFacts).decision).toBe(scalar.decision);
  });
}

for (const vector of vectors.incomplete) {
  test(`specialization distinguishes ${vector.id}`, () => {
    const facts = vector.facts as PolicyFacts;
    const request: PolicyRequest = {
      action: 'collection:read',
      resourceType: 'library.collection',
      mode: 'ordinary',
      anonymous: true,
      hasPrincipal: false,
    };
    expect(decidePolicy(result.catalogue, request, { ...facts, publicFloor: false }).decision).toBe('unavailable');
    const specialized = specializePolicy(result.catalogue, request, facts, ['public.floor']);
    expect(specialized).toMatchObject({ status: 'unavailable', reason: vector.expected });
  });
}

test('a missing or malformed row value remains unavailable', () => {
  const request: PolicyRequest = {
    action: 'collection:read',
    resourceType: 'library.collection',
    mode: 'ordinary',
    anonymous: true,
    hasPrincipal: false,
  };
  const facts = {
    standing: true,
    assignment: true,
    deadlineLive: true,
    scope: false,
    localDenial: false,
    actor: { actionGrant: false, resourceRoleGrant: false, ownAccount: false, authenticatedBenefit: false },
  } as unknown as PolicyFacts;
  const residual = specializePolicy(result.catalogue, request, facts, ['public.floor']);
  expect(residual.status).toBe('ready');
  if (residual.status !== 'ready') return;
  expect(evaluatePolicyResidual(residual.residual, {})).toMatchObject({ decision: 'unavailable', reason: 'missing-evidence' });
  expect(
    evaluatePolicyResidual(residual.residual, { 'public.floor': null }),
  ).toMatchObject({ decision: 'unavailable', reason: 'unknown-evidence' });
  expect(
    evaluatePolicyResidual(residual.residual, { 'public.floor': 1 } as never),
  ).toMatchObject({ decision: 'unavailable', reason: 'malformed-evidence' });
});

test('half-open temporal boundaries agree after qualification', () => {
  const request: PolicyRequest = {
    action: 'collection:read',
    resourceType: 'library.collection',
    mode: 'ordinary',
    anonymous: true,
    hasPrincipal: false,
  };
  for (const atMicros of ['100', '199', '200']) {
    const deadlineLive = qualifyTemporalEvidence(
      { complete: true, intervals: [{ fromMicros: '100', untilMicros: '200' }] },
      atMicros,
    );
    const facts = {
      standing: true,
      assignment: true,
      deadlineLive,
      scope: false,
      localDenial: false,
      actor: { actionGrant: false, resourceRoleGrant: false, ownAccount: false, authenticatedBenefit: false },
    } as PolicyFacts;
    const scalar = decidePolicy(result.catalogue, request, { ...facts, publicFloor: true });
    const residual = specializePolicy(result.catalogue, request, facts, ['public.floor']);
    expect(residual.status).toBe('ready');
    if (residual.status !== 'ready') return;
    expect(evaluatePolicyResidual(residual.residual, { 'public.floor': true }).decision).toBe(scalar.decision);
  }
});
