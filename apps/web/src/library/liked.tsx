import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { CollectionMemberViewerDetails } from './collection-member-row';
import { collectionViewerProjection, collectionViewerVoteCurrent } from './collection-viewer/model';
import type { CollectionViewerMember, CollectionViewerProjection } from './collection-viewer/model';
import type { CollectionPageData } from './reads';
import { formatOwnScore } from './score';

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

function likedProjectionScore(
  projection: CollectionViewerProjection,
  member: CollectionViewerMember,
): {
  units: number | null;
  question: NonNullable<Extract<CollectionViewerProjection, { state: 'current' }>['question']>;
} | undefined {
  if (projection.state !== 'current' || !member.subjectId || !projection.question) return undefined;
  const row = projection.rows.find((item) => item.rowKey === member.id && item.subjectId === member.subjectId);
  if (!row || !collectionViewerVoteCurrent(row, projection.question)) return undefined;
  return {
    units: row.vote.state === 'present' ? row.vote.units : null,
    question: projection.question,
  };
}

/** Liked keeps the shared Collection own-score overlay; this marks the builtin for the score walk. */
export function LikedMemberScore({
  collection,
  member,
  projection,
  actionHref,
}: {
  collection: { builtinKind?: string | null };
  member: CollectionViewerMember;
  projection: CollectionViewerProjection;
  actionHref?: string;
}) {
  if (!isLikedCollection(collection) || !member.subject) return null;
  const locale = getLocale();
  const own = likedProjectionScore(projection, member);
  return (
    <div data-liked-own-score="">
      {own ? (
        <p className="text-sm text-muted-foreground" title={own.question.meaning}>
          {own.units === null
            ? m.subject_rating_control_unrated({}, { locale: locale as never })
            : m.subject_ratings_yours(
                { score: formatOwnScore(own.units, own.question, locale) },
                { locale: locale as never },
              )}
        </p>
      ) : null}
      <CollectionMemberViewerDetails member={member} projection={projection} {...(actionHref ? { actionHref } : {})} />
    </div>
  );
}
