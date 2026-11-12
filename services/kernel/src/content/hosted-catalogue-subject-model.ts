import { HOSTED_PAGE_LIMIT } from './hosted-chapters-model.ts';

export { HOSTED_PAGE_LIMIT };

export type HostedSubjectCatalogueItem = Readonly<{
  catalogueId: string;
  revisionId: string;
  kind: 'publication';
  sourceRevisionId: string | null;
  threadId: string;
}>;

export type HostedSubjectCataloguePage = Readonly<{
  subjectId: string;
  items: readonly HostedSubjectCatalogueItem[];
  nextCursor: string | null;
}>;

export type HostedSubjectCatalogueQuery = Readonly<{
  limit?: number;
  cursor?: string;
}>;

export type HostedSubjectCatalogueRow = Readonly<{
  route: number;
  catalogue_id: string;
  thread_id: string;
  publication_id: string;
}>;

/** A current public selection is a published catalogue Post with a non-empty publication. */
export function isCurrentPublicCatalogueCandidate(row: HostedSubjectCatalogueRow): boolean {
  return typeof row.publication_id === 'string' && row.publication_id.length > 0;
}

export function hostedSubjectPageLimit(limit: number | undefined): number {
  const value = limit ?? HOSTED_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > HOSTED_PAGE_LIMIT) return -1;
  return value;
}
