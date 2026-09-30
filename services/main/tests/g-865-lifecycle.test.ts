import { expect, test } from 'bun:test';
import { canonicalCandidate, checkedHeads, EDITORIAL_COST, EditorialBlocked, EditorialInvalid,
  makeProposalRevision, revisionOperationKey, type EvidenceRef, type ProposalReview, type Json }
  from '../src/modules/editorial-review/contract.ts';
import { applyReviewedRevision, reviewState } from '../src/modules/editorial-review/lifecycle.ts';
import { componentCorrectionAdapter } from '../src/modules/editorial-review/component-correction-adapter.ts';
import { InvalidWorkMetadata } from '../src/modules/work/metadata-schema.ts';
import { SemanticChangeRejected } from '../src/modules/semantic/command.ts';
import { componentFixture, native } from './g-865-component-correction-fixture.ts';
import { adapterModule } from '../src/modules/editorial-review/component-correction-adapter.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

test('G865: candidate canonicalization binds exact bytes and preserves null/omitted/empty', () => {
  expect(canonicalCandidate({ b: 1, a: [null, ''] })).toEqual(canonicalCandidate({ a: [null, ''], b: 1 }));
  const inputs = [{}, { a: null }, { a: '' }, { a: [] }];
  expect(new Set(inputs.map(input => canonicalCandidate(input).digest)).size).toBe(inputs.length);
  for (const input of [undefined, NaN, Infinity, { a: undefined }, new Date(), new Array(1)]) {
    expect(() => canonicalCandidate(input)).toThrow(EditorialInvalid);
  }
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  expect(() => canonicalCandidate(cycle)).toThrow(EditorialInvalid);
  expect(() => canonicalCandidate('a'.repeat(EDITORIAL_COST.candidateBytes - 2))).not.toThrow();
  expect(() => canonicalCandidate('a'.repeat(EDITORIAL_COST.candidateBytes - 1))).toThrow(EditorialInvalid);
  // Bound bytes, not JavaScript code units.
  expect(() => canonicalCandidate('界'.repeat(EDITORIAL_COST.candidateBytes / 3))).toThrow(EditorialInvalid);
});

test('G865: absent heads, duplicate components and 32/33 dependencies stay explicit', () => {
  expect(checkedHeads([{ component: 'one', head: null }])).toEqual([{ component: 'one', head: null }]);
  expect(() => checkedHeads([{ component: 'one', head: null }, { component: 'one', head: 'head' }])).toThrow(EditorialInvalid);
  expect(() => checkedHeads([{ component: 'one', head: undefined! }])).toThrow(EditorialInvalid);
  expect(() => checkedHeads(Array.from({ length: 32 }, (_, n) => ({ component: String(n), head: null })))).not.toThrow();
  expect(() => checkedHeads(Array.from({ length: 33 }, (_, n) => ({ component: String(n), head: null })))).toThrow(EditorialInvalid);
});

test('G865: revision construction checks 32/33 evidence refs and stable owner operation keys', async () => {
  const f = await componentFixture();
  const evidence: EvidenceRef[] = Array.from({ length: 32 }, () => ({ resource: 'source', revision: 'edition-1', locator: null }));
  const validated = { candidate: f.input.revision.candidate, before: f.input.revision.before, baseHeads: f.input.expectedHeads };
  expect(makeProposalRevision(f.proposal.id, 3, validated, evidence).evidence).toHaveLength(32);
  expect(() => makeProposalRevision(f.proposal.id, 3, validated, [...evidence, evidence[0]!])).toThrow(EditorialInvalid);
  expect(() => revisionOperationKey(f.proposal.id, 0)).toThrow(EditorialInvalid);
  expect(revisionOperationKey(f.proposal.id, 2)).not.toBe(revisionOperationKey(f.proposal.id, 3));
});

test('G865: two Agents of one operator count once under the two-approval adapter policy', async () => {
  const f = await componentFixture();
  const review = f.reviews[0]!;
  const other: ProposalReview = { ...review, id: native(), reviewer: native(), sequence: '2' };
  const authority = [...f.authority, { reviewer: other.reviewer, reviewerKey: other.reviewerKey, eligible: true }];
  const state = reviewState(f.proposal, [review, other], authority, 2, f.viewer);
  expect(state.approvalIds).toEqual([other.id]);
  expect(state.blockers).toContainEqual({ code: 'required_approvals', required: 2, received: 1 });
  const independent = { ...other, reviewerKey: 'second-independent-operator' };
  expect(reviewState(f.proposal, [review, independent], [...authority,
    { reviewer: independent.reviewer, reviewerKey: independent.reviewerKey, eligible: true }], 2, f.viewer).approvalIds)
    .toHaveLength(2);
});

test('G865: request_changes replaces a stance; a comment does not discard an approval', async () => {
  const f = await componentFixture();
  const review = f.reviews[0]!;
  const comment: ProposalReview = { ...review, id: native(), outcome: 'comment', sequence: '2' };
  expect(reviewState(f.proposal, [comment, review], f.authority, 1, f.viewer).state).toBe('approved');
  const changes: ProposalReview = { ...comment, outcome: 'request_changes', sequence: '3' };
  expect(reviewState(f.proposal, [changes, comment, review], f.authority, 1, f.viewer).state).toBe('changes_requested');
  expect(reviewState(f.proposal, [changes, comment, review], f.authority, 1, f.viewer).allowedActions).not.toContain('apply');
});

test('G865: viewer actions and blockers contain no private operator keys', async () => {
  const f = await componentFixture();
  const own = { agent: native(), principalKey: f.proposal.proposerKey, eligibleReviewer: true };
  const state = reviewState(f.proposal, f.reviews, f.authority, 1, own);
  expect(state.allowedActions).toEqual(['revise', 'withdraw']);
  expect(JSON.stringify(state)).not.toContain(f.proposal.proposerKey);
  expect(JSON.stringify(state)).not.toContain(f.viewer.principalKey);
  const anonymous = reviewState(f.proposal, f.reviews, f.authority, 1,
    { agent: native(), principalKey: 'unprivileged', eligibleReviewer: false });
  expect(anonymous.allowedActions).toEqual([]);
});

test('G865: altered candidate, operation key, target and owner permit never dispatch an effect', async () => {
  const f = await componentFixture();
  const badInputs = [
    { ...f.input, operationKey: 'a-new-client-retry-key' },
    { ...f.input, target: { ...f.input.target, context: native() } },
    { ...f.input, permit: { ...f.input.permit, revision: 1 } },
    { ...f.input, revision: { ...f.input.revision, candidate: {} } },
  ];
  for (const input of badInputs) await expect(applyReviewedRevision(f.adapter, f.proposal, input,
    f.reviews, f.authority, f.viewer)).rejects.toBeInstanceOf(EditorialInvalid);
  expect(f.writes()).toBe(0);
});

test('G865: applied, rejected and withdrawn proposals refuse implicit second decisions', async () => {
  const f = await componentFixture();
  for (const outcome of ['applied', 'rejected', 'withdrawn'] as const) {
    const proposal = { ...f.proposal, decision: { proposal: f.proposal.id,
      revision: 2, actor: f.viewer.agent, outcome, receipt: null, reverts: null } };
    await expect(applyReviewedRevision(f.adapter, proposal, f.input,
      f.reviews, f.authority, f.viewer)).rejects.toBeInstanceOf(EditorialBlocked);
    expect(reviewState(proposal, f.reviews, f.authority, 1, f.viewer).allowedActions)
      .toEqual(outcome === 'applied' ? ['revert'] : []);
  }
  expect(f.writes()).toBe(0);
});

test('G865: component validation retains owner fields and refuses unsupported Work dates', async () => {
  const f = await componentFixture();
  const validated = await f.adapter.validate(f.proposal.target, f.input.revision.candidate, f.input.expectedHeads);
  expect(validated.candidate).toEqual(f.input.revision.candidate);
  const raw = f.input.revision.candidate as { command: string; state: object };
  await expect(f.adapter.validate(f.proposal.target, { ...raw, state: { ...raw.state, datePublished: '2026-01-01' } },
    f.input.expectedHeads)).rejects.toBeInstanceOf(InvalidWorkMetadata);
  const semantic = await componentFixture('semantic-change');
  const state = (semantic.input.revision.candidate as { state: object }).state;
  await expect(semantic.adapter.validate(semantic.proposal.target,
    { command: 'semantic-change', state: { ...state, types: ['https://schema.org/CreativeWork'] } },
    semantic.input.expectedHeads)).rejects.toBeInstanceOf(SemanticChangeRejected);
});

test('G865: owner snapshot nodes do not leak into submitted semantic assertion input', async () => {
  const f = await componentFixture('semantic-change');
  const candidate = f.input.revision.candidate as { command: string;
    state: { component: string; properties: Array<{ predicate: string; value: Json }> } };
  const adapter = componentCorrectionAdapter({
    readSemantic: async () => ({ heads: f.input.expectedHeads, state: { ...candidate.state,
      properties: candidate.state.properties.map(property => ({ ...property, node: native() })) } }),
    readMetadata: async () => { throw new Error('Wrong owner'); },
    commitSemantic: async () => { throw new Error('Unexpected write'); },
    commitMetadata: async () => { throw new Error('Unexpected write'); },
  });
  const validated = await adapter.validate(f.proposal.target, candidate, f.input.expectedHeads);
  expect(validated.before).toEqual(candidate);
  await expect(adapter.validate(f.proposal.target, { ...candidate, state: { ...candidate.state,
    properties: candidate.state.properties.map(property => ({ ...property, node: native() })) } },
  f.input.expectedHeads)).rejects.toBeInstanceOf(SemanticChangeRejected);
});

test('G865: first Work description uses the live Work head and refuses reserved owner fields', async () => {
  const resource = native(), currentHead = native(), pinnedRevision = native();
  const deps = { environment: { fuseki: { query: async (query: string) => ({ results: { bindings:
    query.includes('SELECT ?head ?manifest') ? [] : [{ head: { type: 'uri',value: currentHead } }] } }) } },
  account: { verify: async () => { throw new Error('Validation does not dispatch'); } } } as unknown as MainWorkDependencies;
  const adapter = adapterModule.create({ work: deps,request: new Request('http://main.local') });
  const target = { resource,work: resource,context: 'urn:rezics:context:global' as const,revision: pinnedRevision };
  const state = { component: 'resource',types: [],lifecycle: 'active',properties:
    [{ predicate: 'https://example.test/catalogue/fact',value: { kind: 'string',lexical: 'A fact' } }] };
  const heads = [{ component: resource,head: currentHead }];
  const candidate = await adapter.validate(target,{ command: 'semantic-change',state },heads);
  expect(candidate.baseHeads).toEqual(heads); expect(candidate.ownerCommand?.scope).toBe(`semantic:edit:${resource}`);
  await expect(adapter.validate(target,{ command: 'semantic-change',state },[{ component: resource,head: pinnedRevision }]))
    .rejects.toBeInstanceOf(EditorialBlocked);
  await expect(adapter.validate(target,{ command: 'semantic-change',state: { ...state,properties:
    [{ predicate: 'https://schema.org/description',value: { kind: 'string',lexical: 'Not the semantic owner' } }] } },heads))
    .rejects.toBeInstanceOf(EditorialInvalid);
});
