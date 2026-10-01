import { expect, test } from 'bun:test';
import { AdmissionDenied } from '../src/modules/access/admission.ts';
import { componentOwners } from '../src/modules/editorial-review/runtime.ts';
import { commandRefusal } from '../src/modules/editorial-review/ordered.ts';
import { reviewState } from '../src/modules/editorial-review/lifecycle.ts';
import type { Json } from '../src/modules/editorial-review/contract.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { componentFixture } from './g-865-component-correction-fixture.ts';

test('G927: component owner denials retain the refused operation instead of becoming pending', async () => {
  for (const kind of ['work-metadata','semantic-change'] as const) {
    const f = await componentFixture(kind);
    const runtime = { work: { account: { verify: async () => ({ issuer: 'test',subject: 'reviewer' }) },
      access: { register: async () => { throw new AdmissionDenied('Owner authority changed'); },
        canReadSemanticResource: async () => true,canReadWork: async () => true },
      environment: { lineage: { dataEpoch: 'test-data',routingEpoch: 'test-routing' },
        fuseki: { query: async () => ({ boolean: true }) } } } as unknown as MainWorkDependencies,
    request: new Request('http://main.local') };
    const owners = componentOwners(runtime), candidate = f.input.revision.candidate as { state: never };
    const result = kind === 'work-metadata' ? await owners.commitMetadata(f.input,candidate.state)
      : await owners.commitSemantic(f.input,candidate.state);
    expect(result).toEqual({ outcome: 'refused',blocker: { code: 'owner_command_refused',
      key: f.input.operationKey,reason: 'owner_authority_required' } });
  }
});

test('G927: refusal diagnostics retain only the bounded machine code, never owner result bytes', () => {
  expect(commandRefusal({ key: 'owner:0',outcome: 'rejected',receipt: null,
    result: { code: 'owner_authority_required',privatePrincipal: 'secret' } }))
    .toEqual({ code: 'owner_command_refused',key: 'owner:0',reason: 'owner_authority_required' });
  const results: Json[] = [null,{}, { code: 'secret personal details' },{ code: 'x'.repeat(129) }];
  for (const result of results) {
    expect(commandRefusal({ key: 'owner:0',outcome: 'dependency_rejected',receipt: null,result }))
      .toEqual({ code: 'owner_command_refused',key: 'owner:0',reason: 'dependency_rejected' });
  }
});

test('G927: another Agent controlled by the same operator gains no proposer actions', async () => {
  const f = await componentFixture();
  const state = reviewState(f.proposal,f.reviews,f.authority,1,
    { ...f.viewer,principalKey: f.proposal.proposerKey,ownsProposal: false });
  expect(state.allowedActions).toEqual([]);
  expect(state.blockers).toContainEqual({ code: 'self_review' });
  expect(reviewState(f.proposal,f.reviews,f.authority,1,
    { ...f.viewer,principalKey: f.proposal.proposerKey }).allowedActions).toEqual([]);
  const replacement = reviewState(f.proposal,f.reviews,f.authority,1,
    { ...f.viewer,agent: f.proposal.proposer,principalKey: 'replacement-credential',ownsProposal: true });
  expect(replacement.allowedActions).toEqual(['revise','withdraw']);
});
