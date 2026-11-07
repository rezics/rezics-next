import type { DiscoveryOwnerKind, DiscoveryOwnerMetadataSummary } from '../discovery.ts';

export type OwnerCurrentAccepted<Candidate> = Readonly<{
  candidate: Candidate;
  kind: DiscoveryOwnerKind;
  id: string;
  value: DiscoveryOwnerMetadataSummary;
}>;

export { OwnerCurrentRestartRequired } from '../discovery-errors.ts';
export { ownerSummaryUnchanged, revalidateOwnerCurrentSummaries } from '../disclosure-application.ts';
