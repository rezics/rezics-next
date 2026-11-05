import { CollectionMemberViewerDetails } from './collection-member-row';
import type { CollectionViewerMember, CollectionViewerProjection } from './collection-viewer/model';
import { isLikedCollection } from './liked';

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
  return (
    <div data-liked-own-score="">
      <CollectionMemberViewerDetails member={member} projection={projection} {...(actionHref ? { actionHref } : {})} />
    </div>
  );
}
