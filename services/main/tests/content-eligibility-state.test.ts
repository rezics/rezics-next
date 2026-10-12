import { expect, test } from 'bun:test';
import { classifyContentEligibilityState, type ContentEligibilityDecisionProof,
  type ContentEligibilityPublicationProof, type ContentEligibilityStateEvidence }
  from '../src/modules/content-publication/eligibility-state.ts';
import { RV } from '../src/modules/work/activate.ts';
import { contentSearchEligibilityDigest }
  from '../src/modules/content-publication/eligibility.ts';

const graphEpoch = '11111111-1111-4111-8111-111111111111';
const ownerEpoch = '22222222-2222-4222-8222-222222222222';
const resource = 'https://rezics.com/id/33333333-3333-4333-8333-333333333333';
const variant = 'urn:rezics:variant:44444444-4444-4444-8444-444444444444';
const currentPublication = 'urn:rezics:content-publication:current';
const priorPublication = 'urn:rezics:content-publication:prior';
const currentEligibility = 'urn:rezics:content-search-eligibility:current';
const uri = (value: string) => ({ type: 'uri', value });

function publication(id: string, ownerSequence: string, graphSequence: string): ContentEligibilityPublicationProof {
  return { id, variant, resource, revision: `urn:rezics:content:revision:${ownerSequence.padStart(8, '0')}-0000-4000-8000-000000000001`,
    digest: 'a'.repeat(64), ownerDataEpoch: ownerEpoch, ownerSequence, graphSequence };
}

function eligibility(id: string, approvedPublication: string, graphSequence: string): ContentEligibilityDecisionProof {
  return { id, variant, resource, publicationDecision: approvedPublication, graphSequence,
    rightsBasis: `${RV}OriginalContribution`, requestDigest: contentSearchEligibilityDigest({
      resourceId: resource, variantId: variant, publicationDecision: approvedPublication,
      expectedEligibilityHead: null, actingSubject: resource, disclosure: 'public',
      rightsBasis: 'original-contribution' }) };
}

function evidence(overrides: Partial<ContentEligibilityStateEvidence> = {}): ContentEligibilityStateEvidence {
  const pub = publication(currentPublication, '8', '12');
  return { snapshot: { dataEpoch: graphEpoch, routingEpoch: '1', sequence: '20' },
    owner: { dataEpoch: ownerEpoch, sequence: '10' }, variant, resourceCount: 1, resource: uri(resource),
    publicationCount: 1, publication: uri(currentPublication), eligibilityCount: 1,
    eligibility: uri(currentEligibility), currentPublication: pub,
    eligibilityProof: eligibility(currentEligibility, currentPublication, '14'), approvedPublication: pub,
    restoreOpen: true, ...overrides };
}

test('classifies an exact current Public owner decision and a proved absence', () => {
  expect(classifyContentEligibilityState(evidence())).toMatchObject({
    kind: 'public-current', id: currentPublication,
  });
  expect(classifyContentEligibilityState(evidence({ eligibilityCount: 0, eligibility: undefined,
    eligibilityProof: undefined, approvedPublication: undefined }))).toMatchObject({
    kind: 'closed-absent', id: currentPublication,
  });
});

test('a valid retained E1/P1 approval is closed on current P2', () => {
  const p1 = publication(priorPublication, '5', '3');
  const p2 = publication(currentPublication, '8', '12');
  expect(classifyContentEligibilityState(evidence({ currentPublication: p2,
    eligibilityProof: eligibility(currentEligibility, priorPublication, '7'), approvedPublication: p1 })))
    .toMatchObject({ kind: 'closed-superseded-approval', id: currentPublication,
      eligibilityDecision: currentEligibility, approvedPublicationDecision: priorPublication });
});

test('missing, duplicate, foreign and receipt-damaged heads stay unresolved', () => {
  const unresolvedCases = [
    evidence({ eligibilityProof: undefined, approvedPublication: undefined }),
    evidence({ eligibilityCount: 2 }),
    evidence({ eligibility: uri('urn:rezics:content-search-eligibility:foreign') }),
    evidence({ eligibilityProof: undefined }),
    evidence({ currentPublication: undefined }),
  ];
  for (const testCase of unresolvedCases) {
    expect(classifyContentEligibilityState(testCase).kind).toBe('unresolved');
  }
});

test('a damaged historical publication receipt and a restore hold block completion', () => {
  const p2 = publication(currentPublication, '8', '12');
  expect(classifyContentEligibilityState(evidence({ currentPublication: p2,
    eligibilityProof: eligibility(currentEligibility, priorPublication, '7'),
    approvedPublication: undefined })).kind).toBe('unresolved');
  expect(classifyContentEligibilityState(evidence({ restoreOpen: false })).kind).toBe('unresolved');
});

test('mixed inventory keeps current approvals distinct from closed variants', () => {
  const states = [classifyContentEligibilityState(evidence()),
    classifyContentEligibilityState(evidence({ eligibilityCount: 0, eligibility: undefined,
      eligibilityProof: undefined, approvedPublication: undefined }))];
  expect(states.map(state => state.kind)).toEqual(['public-current', 'closed-absent']);
});
