import { randomUUID } from 'node:crypto';
import { canonicalCandidate, EditorialBlocked, headsEqual, makeProposalRevision, revisionOperationKey,
  type CommandOutcome, type OwnerReceipt } from '../src/modules/editorial-review/contract.ts';
import { wikiBundleAdapter } from '../src/modules/editorial-review/wiki-bundle-adapter.ts';
import { MemoryCommandJournal } from './g-865-command-journal.ts';
import type { AdapterFixtureModule } from './g-865-conformance.ts';
const native = () => `https://rezics.com/id/${randomUUID()}`;
export const fixtureModule: AdapterFixtureModule = { kind: 'wiki-bundle',async create() {
  const work = native(), initial = native(), after = native(), proposal = randomUUID(), reviewer = native();
  const target = { resource: work,work,revision: initial,context: 'urn:rezics:context:global' as const };
  let heads = [{ component: work,head: initial }], writes = 0, lose = false;
  const retained = new Map<string,CommandOutcome>();
  const bundle = { profile: 'wiki-extraction-v1',target: work,zone: native(),continuity: native(),
    source: { representationSha256: 'a'.repeat(64),mediaType: 'text/plain',language: 'en',rightsBasis: 'public_domain',
      method: { agent: 'Holder',model: 'local',inference: 'local' } },
    units: [{ id: 'chapter1',ordinal: 1,label: 'Chapter 1',occurrence: native() }],entities: [],claims: [] };
  const adapter = wikiBundleAdapter({ validate: async (_target,candidate,expected) => {
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
      afterHeads: heads,candidate: input.revision.candidate,before: input.revision.before,owner: {} } satisfies OwnerReceipt) });
  const revision = makeProposalRevision(proposal,1,await adapter.validate(target,bundle,heads),[]);
  const reviewerKey = 'private-reviewer', proposerKey = 'private-proposer';
  return { adapter,proposal: { id: proposal,kind: 'wiki-bundle',target,proposer: native(),proposerKey,latestRevision: 1,decision: null },
    input: { target,revision,expectedHeads: revision.baseHeads,operationKey: revisionOperationKey(proposal,1),
      permit: { proof: native(),proposal,revision: 1,candidateDigest: revision.candidateDigest,decidingAgent: reviewer },
      commands: new MemoryCommandJournal() },
    reviews: [{ id: native(),proposal,revision: 1,reviewer,reviewerKey,outcome: 'approve',message: '',sequence: '1' }],
    authority: [{ reviewer,reviewerKey,eligible: true }],viewer: { agent: reviewer,principalKey: reviewerKey,eligibleReviewer: true },
    writes: () => writes,moveHead: () => { heads = [{ component: work,head: native() }]; return heads; },
    loseNextAcknowledgement: () => { lose = true; },compensationCandidate: { profile: 'wiki-retraction-v1',proposal } };
} };
