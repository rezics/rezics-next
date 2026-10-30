import { parseCoverRatio, type CoverRatio } from '@rezics/ui/cover';
import type { LibrarySubject } from './reads';

const listRatios: Readonly<Record<string, CoverRatio>> = {
  'schema:Book': '3:4',
  'bf:Instance': '3:4',
  'schema:ComicSeries': '3:4',
  'schema:PublicationVolume': '3:4',
  'schema:Movie': '16:9',
  'schema:TVSeries': '16:9',
  'schema:TVSeason': '16:9',
  'schema:Episode': '16:9',
  'rezics:AnimeRelease': '16:9',
  'schema:Recipe': '16:9',
  'schema:MusicAlbum': '1:1',
};

/** Exact actual-Type fallback until definitions delivers listPresentation. Never classify by a label or substring. */
export function collectionMemberRatio(
  subject: Pick<LibrarySubject, 'type'> | null,
  typeRatios: Readonly<Record<string, string>> = {},
): CoverRatio {
  if (!subject) return '1:1';
  return listRatios[subject.type] ?? parseCoverRatio(typeRatios[subject.type] ?? '') ?? '1:1';
}

/** Reorder only loaded occurrences. A later page cannot claim the Collection's first position. */
export function reorderCollectionMembers<Member extends { id: string }>(
  members: readonly Member[],
  memberId: string,
  after: string | null,
  firstPage: boolean,
): Member[] {
  if (after === memberId || (!firstPage && (after === null || memberId === members[0]?.id))) return [...members];
  const moved = members.find((member) => member.id === memberId);
  if (!moved) return [...members];
  const remaining = members.filter((member) => member.id !== memberId);
  const position = after === null ? 0 : remaining.findIndex((member) => member.id === after) + 1;
  if (after !== null && position === 0) return [...members];
  return [...remaining.slice(0, position), moved, ...remaining.slice(position)];
}
