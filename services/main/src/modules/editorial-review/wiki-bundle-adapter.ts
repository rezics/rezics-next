import { canonicalCandidate, type ApplyInput, type BaseHead, type CommandOutcome,
  type EditorialAdapter, type EditorialAdapterModule, type EditorialCommand, type EditorialTarget,
  type OwnerReceipt, type ProposalRevision, type ValidatedCandidate } from './contract.ts';
import { applyOrderedCommands } from './ordered.ts';
import type { EditorialRuntime } from './runtime.ts';
import { extractionCandidate, wikiSnapshot } from '../wiki/apply-snapshot.ts';
import { completeWikiBundle, wikiCommands } from '../wiki/apply.ts';
import { compensateWikiReceipt, isWikiRetraction, validateWikiRetraction, wikiRetractionCommands } from '../wiki/apply-compensation.ts';
import { evidenceId, withholdPassage } from '../wiki/evidence.ts';
import { isWikiDelta } from '../wiki/delta.ts';
import { isDeltaRevert, validateWikiDelta, validateDeltaRevert, wikiDeltaCommands,
  wikiDeltaRevertCommands, wikiDeliveryFence } from '../wiki/delta-runtime.ts';

export interface WikiAdapterOwners {
  validate(target: EditorialTarget, candidate: unknown, expected: BaseHead[]): Promise<ValidatedCandidate>;
  commands(input: ApplyInput): Promise<EditorialCommand[]>;
  complete(input: ApplyInput, outcomes: readonly CommandOutcome[]): Promise<OwnerReceipt>;
  disclose?(revision: ProposalRevision): Promise<ProposalRevision>;
  compensate?(receipt: OwnerReceipt): Promise<ValidatedCandidate>;
}
export function wikiBundleAdapter(owners: WikiAdapterOwners): EditorialAdapter {
  const adapter: EditorialAdapter = { kind: 'wiki-bundle',requiredApprovals: 1,
    validate: owners.validate,commands: owners.commands,complete: owners.complete,disclose: owners.disclose,
    apply: input => applyOrderedCommands(adapter,input),compensate: async receipt => owners.compensate
      ? owners.compensate(receipt) : compensateWikiReceipt(receipt),
    async preview(revision) {
      const visible = owners.disclose ? await owners.disclose(revision) : revision;
      if (isWikiRetraction(visible.candidate)) return [{ path: 'retraction',before: visible.before,after: visible.candidate }];
      if (isWikiDelta(visible.candidate) || isDeltaRevert(visible.candidate)) {
        return [{ path: 'delta', before: visible.before, after: visible.candidate }];
      }
      const bundle = visible.candidate as Record<string,unknown>;
      const entries = ['entities','claims','units','source'].map(path => ({ path,before: null,after: canonicalCandidate(bundle[path]).candidate }));
      const before = visible.before as Record<string,unknown>;
      if (before.quotations) entries.push({ path: 'quotations',before: null,after: canonicalCandidate(before.quotations).candidate });
      return entries;
    } };
  return adapter;
}
export const adapterModule = { kind: 'wiki-bundle',
  create(dependencies: WikiAdapterOwners | EditorialRuntime & { actingSubject: string }): EditorialAdapter {
    if (!('work' in dependencies)) return wikiBundleAdapter(dependencies);
    const runtime = dependencies;
    return wikiBundleAdapter({
      validate: (target,candidate,expected) => isWikiDelta(candidate) ? validateWikiDelta(runtime,target,candidate,expected)
        : isDeltaRevert(candidate) ? validateDeltaRevert(runtime,target,candidate.proposal,expected)
          : isWikiRetraction(candidate) ? validateWikiRetraction(runtime,target,candidate,expected) : wikiSnapshot(runtime,target,candidate,expected),
      commands: async input => {
        await wikiDeliveryFence(runtime,input);
        return isWikiDelta(input.revision.candidate)
        ? wikiDeltaCommands(runtime,input) : isDeltaRevert(input.revision.candidate) ? wikiDeltaRevertCommands(runtime,input)
          : isWikiRetraction(input.revision.candidate) ? wikiRetractionCommands(runtime,input) : wikiCommands(runtime,input);
      },
      complete: completeWikiBundle,
      compensate: async receipt => isWikiDelta(receipt.candidate)
        ? { candidate: canonicalCandidate({ profile: 'wiki-delta-revert-v1',proposal: receipt.proposal }).candidate,
          before: {},baseHeads: receipt.afterHeads } : compensateWikiReceipt(receipt),
      async disclose(revision) {
        if (isWikiRetraction(revision.candidate) || isDeltaRevert(revision.candidate)) return revision;
        const delta = isWikiDelta(revision.candidate) ? revision.candidate : null;
        const bundle = delta ? delta.bundle : extractionCandidate(revision.candidate);
        const ids = bundle.claims.flatMap((claim,c) => claim.evidence.map((_e,e) => evidenceId(revision.proposal,revision.n,c,e)));
        const withheld = await runtime.work.wikiEvidence?.withheld(ids,runtime.work.rights?.store) ?? new Set(ids);
        const candidate = { ...bundle,claims: bundle.claims.map((claim,c) => ({ ...claim,evidence: claim.evidence.map((evidence,e) =>
          withheld.has(evidenceId(revision.proposal,revision.n,c,e)) ? withholdPassage(evidence) : evidence) })) };
        // The snapshot carries removed claims for compensation. Those citations
        // need the same current rights gate as the proposed replacement.
        const before = revision.before as Record<string, import('./contract.ts').Json>;
        let disclosedBefore = before;
        if (Array.isArray(before.removed)) {
          const { discloseWikiHistory } = await import('../wiki/history.ts');
          const removed = before.removed as unknown as import('../wiki/history.ts').WikiHistoryClaim[];
          if (runtime.work.wikiEvidence) {
            const disclosed = await discloseWikiHistory({ profile: 'wiki-history-v1',work: bundle.target,
              revisions: [],claims: removed,entities: [],units: [] },runtime.work.wikiEvidence,runtime.work.rights?.store);
            disclosedBefore = { ...before,removed: canonicalCandidate(disclosed.claims).candidate };
          } else disclosedBefore = { ...before,removed: withholdPassage(before.removed) as import('./contract.ts').Json };
        }
        return { ...revision,before: canonicalCandidate(disclosedBefore).candidate,
          candidate: canonicalCandidate(delta ? { ...delta,bundle: candidate } : candidate).candidate };
      },
    });
  } } satisfies EditorialAdapterModule<WikiAdapterOwners | EditorialRuntime & { actingSubject: string }>;
