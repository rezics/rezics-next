import { m } from '../../paraglide/messages.js';
import type { MineFollow, MineFollowingPage } from '../mine-following';
import { displayLibraryTitle } from '../title';
import { suppliedDestination } from './destinations';

export function followingKind(follow: MineFollow): string {
  return follow.targetType === 'subject'
    ? (follow.target?.typeLabel ?? m.library_following_subjects())
    : follow.targetType === 'collection'
      ? m.library_following_kind_collection()
      : m.library_following_kind_space();
}
export function followingReason(follow: MineFollow): string {
  return follow.reason === 'library'
    ? m.library_follow_reason_library()
    : follow.reason === 'membership'
      ? m.library_follow_reason_membership()
      : m.following_reading_reason_explicit();
}

/** One native page in native order, one exact-ID index. No point reads or accumulated pages. */
export function prepareFollowing(page: MineFollowingPage, locale: string) {
  const rows = page.signedIn
    ? page.follows
        .filter((follow) => follow.state === 'following')
        .map((follow) => {
          const title = follow.target
            ? displayLibraryTitle(follow.target.label, locale)
            : { text: m.library_subject_unavailable(), lang: undefined };
          return {
            follow,
            title,
            kind: followingKind(follow),
            reason: followingReason(follow),
            destination: suppliedDestination(follow, title.text, locale),
          };
        })
    : [];
  return { rows, byId: new Map(rows.map((row) => [row.follow.targetId, row])) };
}
export type FollowingRow = ReturnType<typeof prepareFollowing>['rows'][number];
