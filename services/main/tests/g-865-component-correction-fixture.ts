import { randomUUID } from 'node:crypto';
import { adapterModule, type ComponentCorrectionOwners }
  from '../src/modules/editorial-review/component-correction-adapter.ts';
import { canonicalCandidate, headsEqual, makeProposalRevision, revisionOperationKey,
  type ApplyInput, type ApplyOutcome, type BaseHead, type EditorialTarget, type OwnerReceipt, type Proposal }
  from '../src/modules/editorial-review/contract.ts';
import { metadataComponent, type MetadataState } from '../src/modules/work/metadata-schema.ts';
import type { ComponentInput } from '../src/modules/semantic/change.ts';
import type { AdapterFixture, AdapterFixtureModule } from './g-865-conformance.ts';

export const native = () => `https://rezics.com/id/${randomUUID()}`;
const header = (description: string): MetadataState => ({ kind: 'header', originalTitle: null,
  completionStatus: null, localized: [{ language: 'en', title: 'A title', description, mainVersionLabel: null, tagline: null }] });
const semantic = (day: string): ComponentInput => ({ component: 'resource', lifecycle: 'active',
  types: ['https://schema.org/Person'], properties: [{ predicate: 'https://schema.org/birthDate',
    value: { kind: 'temporal', lexical: day, precision: 'day', calendar: 'gregorian', timeZone: 'Asia/Tokyo' } }] });

export async function componentFixture(command: 'work-metadata' | 'semantic-change' = 'work-metadata'): Promise<AdapterFixture> {
  const resource = native(), oldHead = native(), afterHead = native();
  const target: EditorialTarget = { resource, work: command === 'work-metadata' ? resource : null,
    context: 'urn:rezics:context:global', revision: native() };
  const before = command === 'work-metadata' ? header('Before synopsis') : semantic('2026-09-01');
  const candidate = command === 'work-metadata' ? header('Corrected synopsis') : semantic('2026-09-02');
  const component = command === 'work-metadata' ? metadataComponent(resource, before as MetadataState) : resource;
  let heads: BaseHead[] = [{ component, head: oldHead }];
  let state: unknown = before;
  let writes = 0, loseAcknowledgement = false;
  const receipts = new Map<string, OwnerReceipt>();
  const commit = async (input: ApplyInput, next: MetadataState | ComponentInput): Promise<ApplyOutcome> => {
    const prior = receipts.get(input.operationKey);
    if (prior) return { outcome: 'applied', receipt: prior };
    if (!headsEqual(heads, input.expectedHeads)) return { outcome: 'stale_base', actualHeads: heads };
    // Deterministic owner fixture, not the missing production permit validator.
    const after = [{ component, head: afterHead }];
    const receipt: OwnerReceipt = { receipt: `urn:test:editorial:${randomUUID()}`,
      proposal: input.revision.proposal, revision: input.revision.n, candidateDigest: input.revision.candidateDigest,
      operationKey: input.operationKey, beforeHeads: heads, afterHeads: after,
      candidate: input.revision.candidate, before: input.revision.before, owner: canonicalCandidate(next).candidate };
    state = next; heads = after; writes++;
    receipts.set(input.operationKey, receipt);
    if (loseAcknowledgement) { loseAcknowledgement = false; return { outcome: 'pending' }; }
    return { outcome: 'applied', receipt };
  };
  const owners: ComponentCorrectionOwners = { readMetadata: async () => ({ state, heads }),
    readSemantic: async () => ({ state, heads }), commitMetadata: commit, commitSemantic: commit };
  const adapter = adapterModule.create(owners), id = randomUUID();
  const validated = await adapter.validate(target, { command, state: candidate }, heads);
  const revision = makeProposalRevision(id, 2, validated,
    [{ resource: 'https://example.test/edition', revision: 'edition-1', locator: 'page:2' }]);
  const proposal: Proposal = { id, kind: adapter.kind, target, proposer: native(),
    proposerKey: 'private-proposer-key', latestRevision: 2, decision: null };
  const reviewer = native(), reviewerKey = 'private-reviewer-key';
  return { adapter, proposal, input: { target, revision, expectedHeads: revision.baseHeads,
    operationKey: revisionOperationKey(id, 2), permit: { proof: 'test-owner-permit', proposal: id,
      revision: 2, candidateDigest: revision.candidateDigest, decidingAgent: reviewer } },
    viewer: { agent: reviewer, principalKey: reviewerKey, eligibleReviewer: true },
    reviews: [{ id: randomUUID(), proposal: id, revision: 2, reviewer, reviewerKey,
      outcome: 'approve', message: 'Checked the source', sequence: '1' }],
    authority: [{ reviewer, reviewerKey, eligible: true }],
    writes: () => writes, moveHead: () => { heads = [{ component, head: native() }]; return heads; },
    loseNextAcknowledgement: () => { loseAcknowledgement = true; } };
}

export const fixtureModule: AdapterFixtureModule = { kind: 'component-correction', create: componentFixture };
