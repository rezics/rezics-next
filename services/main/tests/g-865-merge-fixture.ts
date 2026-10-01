import { randomUUID } from 'node:crypto';
import { canonicalCandidate, EditorialBlocked, headsEqual, makeProposalRevision, revisionOperationKey,
  type CommandOutcome, type OwnerReceipt } from '../src/modules/editorial-review/contract.ts';
import { reviewedMergeAdapter } from '../src/modules/editorial-review/merge-adapter.ts';
import { MemoryCommandJournal } from './g-865-command-journal.ts';
import type { AdapterFixtureModule } from './g-865-conformance.ts';
const native = () => `https://rezics.com/id/${randomUUID()}`;
export const fixtureModule: AdapterFixtureModule = { kind: 'merge',async create() {
  const work = native(), initial = native(), after = native(), proposal = randomUUID(), reviewer = native();
  const target = { resource: work,work,revision: initial,context: 'urn:rezics:context:global' as const };
  let heads = [{ component: work,head: initial }], writes = 0, lose = false;
  const retained = new Map<string,CommandOutcome>();
  const bundle = { operation: 'merge',source: { resource: work,revision: initial },
    survivor: { resource: native(),revision: native() },evidence: [{ resource: work,revision: initial,locator: 'page:1' }] };
  const inverse = { ...bundle,operation: 'unmerge',original: `editorial:${proposal}:1` };
  const adapter = reviewedMergeAdapter({ validate: async (_target,candidate,expected) => {
    if (!headsEqual(heads,expected)) throw new EditorialBlocked({ code: 'stale_base',expectedHeads: expected,actualHeads: heads });
    return { candidate: canonicalCandidate(candidate).candidate,before: {},baseHeads: heads };
  },commands: async input => [{ key: input.operationKey,
    prepare: async () => {
      if (!headsEqual(heads,input.expectedHeads)) throw new EditorialBlocked({ code: 'stale_base',expectedHeads: input.expectedHeads,actualHeads: heads });
      return { action: 'wiki.test',scope: `wiki:${work}`,digest: input.revision.candidateDigest };
    },resolve: async delivery => retained.get(delivery.key) ?? null,
    execute: async delivery => {
      writes++; heads = [{ component: work,head: after }];
      const outcome: CommandOutcome = { key: delivery.key,outcome: 'applied',receipt: 'urn:test:wiki-owner',result: {} };
      retained.set(delivery.key,outcome);
      if (lose) { lose = false; return null; }
      return outcome;
    } }],complete: async input => ({ receipt: 'urn:test:wiki',proposal,revision: input.revision.n,
      candidateDigest: input.revision.candidateDigest,operationKey: input.operationKey,beforeHeads: input.expectedHeads,
      afterHeads: heads,candidate: input.revision.candidate,before: input.revision.before,owner: {} } satisfies OwnerReceipt),compensate: async () => ({ candidate: canonicalCandidate(inverse).candidate,before: {},baseHeads: heads }) });
  const revision = makeProposalRevision(proposal,1,await adapter.validate(target,bundle,heads),[]);
  const reviewerKey = 'private-reviewer', proposerKey = 'private-proposer',secondReviewer = native(),secondKey = 'independent-human';
  return { adapter,proposal: { id: proposal,kind: 'merge',target,proposer: native(),proposerKey,latestRevision: 1,decision: null },
    input: { target,revision,expectedHeads: revision.baseHeads,operationKey: revisionOperationKey(proposal,1),
      permit: { proof: native(),proposal,revision: 1,candidateDigest: revision.candidateDigest,decidingAgent: reviewer },
      commands: new MemoryCommandJournal() },
    reviews: [{ id: native(),proposal,revision: 1,reviewer,reviewerKey,outcome: 'approve',message: '',sequence: '1' },{ id: native(),proposal,revision: 1,reviewer: secondReviewer,reviewerKey: secondKey,outcome: 'approve',message: '',sequence: '2' }],
    authority: [{ reviewer,reviewerKey,eligible: true,kind: 'person',controllerKeys: [reviewerKey] },{ reviewer: secondReviewer,reviewerKey: secondKey,eligible: true,kind: 'person',controllerKeys: [secondKey] }],viewer: { agent: reviewer,principalKey: reviewerKey,eligibleReviewer: true },
    writes: () => writes,moveHead: () => { heads = [{ component: work,head: native() }]; return heads; },
    loseNextAcknowledgement: () => { lose = true; },compensationCandidate: canonicalCandidate(inverse).candidate };
} };
