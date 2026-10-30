import type { KernelClient } from '@rezics/client';
import type { TypeDefinition } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import type { Release } from '../subject/definitions';
import { getLocale } from '../paraglide/runtime.js';
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
  presentations: Readonly<Record<string, NonNullable<TypeDefinition['listPresentation']>>> = {},
): CoverRatio {
  if (!subject) return '1:1';
  const aspect = presentations[subject.type]?.imageAspect;
  if (aspect) return aspect === 'portrait' ? '3:4' : aspect === 'landscape' ? '16:9' : '1:1';
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

type NativeCollection = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['collections']>['get']>>['data']
>['collection'];
export type CollectionPresentationData = Partial<
  Pick<NativeCollection, 'presentationKind' | 'presentationKindSource' | 'cover' | 'coverSource'>
>;
export type CollectionTypeOption = { id: string; label: string };
export type CollectionListPresentations = Record<string, NonNullable<TypeDefinition['listPresentation']>>;

/** Keep the one shell filter protocol intact when following a native signed page cursor. */
export function collectionPageAddress(
  locale: string,
  id: string,
  cursor: string,
  search: Record<string, string | string[]> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (key !== 'type' && !/^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key)) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  params.set('cursor', cursor);
  return `/${locale}/collections/${encodeURIComponent(id)}?${params}`;
}

/** Copy only public presentation, never configured media identity or private editor data. */
export function collectionPresentationOf(collection: CollectionPresentationData): CollectionPresentationData {
  return {
    ...(collection.presentationKindSource === undefined
      ? {}
      : {
          presentationKind: collection.presentationKind ?? null,
          presentationKindSource: collection.presentationKindSource,
        }),
    ...(collection.coverSource === undefined ? {} : { coverSource: collection.coverSource }),
    ...(collection.cover ? { cover: collection.cover } : {}),
  };
}

export function readCollectionTypeOptions(release: Release): CollectionTypeOption[] {
  return Object.entries(release.types)
    .map(([id, type]) => ({
      id,
      label: type.labels ? pickText(type.labels, getLocale()).text || id : id,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
