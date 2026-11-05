import { collectionViewerProjection, collectionViewerVoteCurrent } from './collection-viewer/model';
import type { CollectionPageData } from './reads';

export function isLikedCollection(collection: { builtinKind?: string | null }): boolean {
  return collection.builtinKind === 'liked';
}

/** Current own standard-question units for a Liked member, or undefined when the overlay is not current. */
export function likedMemberScore(
  page: Pick<CollectionPageData, 'viewerFacts'>,
  member: { id: string; subjectId?: string },
  provenance: { mode: 'anonymous' | 'session'; viewerId: string | null } | undefined,
  viewerId: string | null,
  current: boolean,
): { units: number | null } | undefined {
  const projection = collectionViewerProjection(page.viewerFacts, provenance, viewerId, current);
  if (projection.state !== 'current' || !member.subjectId) return undefined;
  const row = projection.rows.find((item) => item.rowKey === member.id && item.subjectId === member.subjectId);
  if (!row || !collectionViewerVoteCurrent(row, projection.question)) return undefined;
  return { units: row.vote.state === 'present' ? row.vote.units : null };
}
