import { canonicalCandidate, type ApplyInput, type BaseHead, type CommandOutcome,
  type EditorialAdapter, type EditorialAdapterModule, type EditorialCommand, type EditorialTarget,
  type OwnerReceipt, type ProposalRevision, type ValidatedCandidate } from './contract.ts';
import { applyOrderedCommands } from './ordered.ts';
import type { EditorialRuntime } from './runtime.ts';
import { extractionCandidate, wikiSnapshot } from '../wiki/apply-snapshot.ts';
import { completeWikiBundle, wikiCommands } from '../wiki/apply.ts';
import { compensateWikiReceipt, isWikiRetraction, validateWikiRetraction, wikiRetractionCommands } from '../wiki/apply-compensation.ts';
import { evidenceId, withholdPassage } from '../wiki/evidence.ts';

export interface WikiAdapterOwners {
  validate(target: EditorialTarget, candidate: unknown, expected: BaseHead[]): Promise<ValidatedCandidate>;
  commands(input: ApplyInput): Promise<EditorialCommand[]>;
  complete(input: ApplyInput, outcomes: readonly CommandOutcome[]): Promise<OwnerReceipt>;
  disclose?(revision: ProposalRevision): Promise<ProposalRevision>;
}
export function wikiBundleAdapter(owners: WikiAdapterOwners): EditorialAdapter {
  const adapter: EditorialAdapter = { kind: 'wiki-bundle',requiredApprovals: 1,
    validate: owners.validate,commands: owners.commands,complete: owners.complete,disclose: owners.disclose,
    apply: input => applyOrderedCommands(adapter,input),compensate: async receipt => compensateWikiReceipt(receipt),
    async preview(revision) {
      const visible = owners.disclose ? await owners.disclose(revision) : revision;
      if (isWikiRetraction(visible.candidate)) return [{ path: 'retraction',before: visible.before,after: visible.candidate }];
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
      validate: (target,candidate,expected) => isWikiRetraction(candidate)
        ? validateWikiRetraction(runtime,target,candidate,expected) : wikiSnapshot(runtime,target,candidate,expected),
      commands: input => isWikiRetraction(input.revision.candidate) ? wikiRetractionCommands(runtime,input) : wikiCommands(runtime,input),
      complete: completeWikiBundle,
      async disclose(revision) {
        if (isWikiRetraction(revision.candidate)) return revision;
        const bundle = extractionCandidate(revision.candidate);
        const ids = bundle.claims.flatMap((claim,c) => claim.evidence.map((_e,e) => evidenceId(revision.proposal,revision.n,c,e)));
        const withheld = await runtime.work.wikiEvidence?.withheld(ids,runtime.work.rights?.store) ?? new Set(ids);
        const candidate = { ...bundle,claims: bundle.claims.map((claim,c) => ({ ...claim,evidence: claim.evidence.map((evidence,e) =>
          withheld.has(evidenceId(revision.proposal,revision.n,c,e)) ? withholdPassage(evidence) : evidence) })) };
        return { ...revision,candidate: canonicalCandidate(candidate).candidate };
      },
    });
  } } satisfies EditorialAdapterModule<WikiAdapterOwners | EditorialRuntime & { actingSubject: string }>;
