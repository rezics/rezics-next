import { settle } from '../feed/types.ts';
import type { Loaded, MainClient, ProposalFilter, ProposalPage, ProposalRead, TargetName } from './types.ts';

/** One proposal as the viewer sees it, with its allowed actions. */
export function readProposal(main: MainClient, proposal: string, actingSubject: string | undefined):
  Promise<Loaded<ProposalRead>> {
  return settle(() => main.v1.editorial.proposals({ proposal }).get({
    query: { ...actingSubject ? { actingSubject } : {} } }));
}

/** One page of the viewer's proposals, or those awaiting their review. */
export function readProposals(main: MainClient, filter: Exclude<ProposalFilter, 'target'>, actingSubject: string,
  cursor: string | null): Promise<Loaded<ProposalPage>> {
  return settle(() => main.v1.editorial.proposals.get({ query: { filter, actingSubject, limit: 20,
    ...cursor ? { cursor } : {} } }));
}

/** The names of the resources a page of proposals is about, in one read. */
export async function readTargetNames(main: MainClient, actingSubject: string | undefined,
  resources: readonly string[], language: string): Promise<Record<string, TargetName>> {
  const wanted = [...new Set(resources)].slice(0, 50);
  if (!wanted.length) return {};
  const batch = await settle(() => main.v1.resources.summaries.post({ profile: 'resource-summary-batch-v1',
    resources: wanted, language, ...actingSubject ? { actingSubject } : {} }));
  if (!batch.ok) return {};
  return Object.fromEntries(batch.data.summaries.flatMap(summary => summary.status === 'available'
    ? [[summary.reference, { value: summary.name.value, language: summary.name.language,
      ...summary.name.direction ? { direction: summary.name.direction } : {} }]] : []));
}
